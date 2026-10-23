/**
 * The reconstructed DWARFLAB device-control surface: build a command exactly as the app does,
 * and decode what the device sends back.
 *
 * Everything here is derived from the APK — command ids from `WsCmd` smali immediates, payload
 * schemas from the protobuf descriptors the APK ships, payload links from the `Ws*Req` beans and
 * the `*WsResponse` handler generics, and framing from `BaseProto.WsPacket` / `MyWsManager`.
 * Where the APK left a payload unknown, this reports it rather than guessing.
 */
import { recoveredType } from './generated/recovered.generated.js';
import type protobuf from 'protobufjs';
import { DWARF_COMMANDS, DWARF_COMMANDS_BY_ID, type CommandSpec } from './generated/catalog.generated.js';
import { DWARF_PAYLOAD_FIELDS, type FieldSpec } from './generated/payloads.generated.js';
import { DWARF_MODULE_ID } from './generated/commands.generated.js';
import { MESSAGE_TYPE, decodePacket, encodePacket, type MessageType, type WsPacketView } from './transport.js';

// Framing is owned here: callers take the packet codec from this module, never from the SDK.
export { MESSAGE_TYPE, encodePacket, decodePacket, headerFor, type MessageType, type ProtocolHeader, type WsPacketView } from './transport.js';

/**
 * 64-bit fields decode to strings so a large counter never loses precision through a JS number,
 * and `oneofs` stays off so the decoded object carries only declared fields (protobufjs would
 * otherwise add a synthetic `<oneofName>: "<fieldName>"` case marker).
 */
const DECODE_OPTIONS = {
  longs: String,
  enums: Number,
  defaults: false,
  oneofs: false,
} as const;

/** A command plus everything the APK tells us about it. Throws for an unknown name. */
export function commandInfo(name: string): CommandSpec {
  const spec = (DWARF_COMMANDS as Record<string, CommandSpec>)[name];
  if (!spec) throw new Error(`device: unknown command ${name}`);
  return spec;
}

/** Field schema for a payload type, or null when the recovered descriptors do not define it. */
export function payloadFields(typeRef: string): readonly FieldSpec[] | null {
  return (DWARF_PAYLOAD_FIELDS as Record<string, readonly FieldSpec[]>)[typeRef] ?? null;
}

/** The declared fields of a command's request or response payload. */
export function commandFields(name: string, direction: 'request' | 'response'): readonly FieldSpec[] {
  const ref = commandInfo(name)[direction];
  if (!ref) return [];
  return payloadFields(ref) ?? [];
}

/**
 * Encode a payload by "namespace.Message" reference.
 *
 * Keys may be the descriptor's own names (`norm_x_tl`) or their camelCase forms (`normXTl`): the
 * root loads with `keepCase: false`, so protobufjs only knows the camelCase spelling and silently
 * drops anything else — at every nesting level. Unknown names are rejected instead of turning a
 * typo into a well-formed but empty command. Decoding always yields the camelCase spelling.
 */
export function encodePayload(typeRef: string, fields: Record<string, unknown>): Uint8Array<ArrayBufferLike> {
  const t = recoveredType(typeRef);
  const unknown: string[] = [];
  const message = normalizeMessage(t, fields, typeRef, unknown);
  if (unknown.length > 0) throw new Error(`device: ${typeRef} has no field ${unknown.join(', ')}`);
  return t.encode(t.create(message)).finish();
}

/** Map caller-supplied keys onto `t`'s own field names, descending into nested messages. */
function normalizeMessage(t: protobuf.Type, values: Record<string, unknown>, path: string, unknown: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const camel = k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    const key = k in t.fields ? k : camel in t.fields ? camel : null;
    if (key === null) {
      unknown.push(`${path}.${k}`);
      continue;
    }
    const field = t.fields[key];
    // Message fields resolve to a Type (it has `fields`); enum fields resolve to an Enum (`values`).
    const resolved = field.resolvedType as {
      fields?: Record<string, unknown>;
    } | null;
    const nested = resolved?.fields ? (resolved as unknown as protobuf.Type) : null;
    out[key] = nested && v !== null && typeof v === 'object' ? (Array.isArray(v) ? v.map((item, i) => normalizeMessage(nested, item as Record<string, unknown>, `${path}.${key}[${i}]`, unknown)) : normalizeMessage(nested, v as Record<string, unknown>, `${path}.${key}`, unknown)) : v;
  }
  return out;
}

/** Decode a payload message by "namespace.Message" reference into plain JSON-ish values. */
export function decodePayload(typeRef: string, bytes: Uint8Array<ArrayBufferLike>): Record<string, unknown> {
  const t = recoveredType(typeRef);
  return t.toObject(t.decode(bytes), DECODE_OPTIONS) as Record<string, unknown>;
}

export interface BuiltRequest {
  /** Bytes to write to the socket. */
  readonly bytes: Uint8Array<ArrayBufferLike>;
  readonly cmd: number;
  readonly name: string;
  readonly module: string;
  /** Payload type the bytes are, or null when the APK gave no request schema. */
  readonly requestType: string | null;
}

/**
 * Build a request frame for `name`. `fields` are the payload's decoded-shape keys
 * (camelCase, as protobufjs yields them). Throws when the command declares a payload
 * the recovered schemas cannot describe, or when no payload is known but fields were given.
 */
export function buildRequest(
  name: string,
  fields: Record<string, unknown> = {},
  options: {
    readonly clientId?: string;
    readonly deviceId?: number;
    readonly type?: MessageType;
  } = {},
): BuiltRequest {
  const spec = commandInfo(name);
  let data: Uint8Array<ArrayBufferLike> = new Uint8Array();
  if (spec.request) {
    if (payloadFields(spec.request) === null) {
      throw new Error(`device: ${name} declares payload ${spec.request}, which the recovered schemas do not define`);
    }
    data = encodePayload(spec.request, fields);
  } else if (Object.keys(fields).length > 0) {
    throw new Error(`device: ${name} has no recovered request payload, so fields cannot be encoded`);
  }
  return {
    bytes: encodePacket({
      cmd: spec.id,
      moduleId: moduleIdFor(spec.module),
      data,
      ...options,
    }),
    cmd: spec.id,
    name,
    module: spec.module,
    requestType: spec.request ?? null,
  };
}

/** Module name (from `WsCmd.getModuleId()` ranges) to the `MODULE_*` value the packet carries. */
export function moduleIdFor(module: string): number {
  // `rw4.d()` writes `setModuleId(wsCmd.getModuleId().ordinal())`; the APK's WsModuleId
  // constants carry that ordinal as their value, keyed MODULE_<NAME>.
  return DWARF_MODULE_ID[`MODULE_${module}`] ?? 0;
}

/** The catalogue name for a command id, or null when this APK's `WsCmd` has no such command. */
export function commandNameFor(cmd: number): string | null {
  return DWARF_COMMANDS_BY_ID[cmd] ?? null;
}

/**
 * The `WsModuleId` ordinal a command's packet must carry — `rw4.d()` writes
 * `setModuleId(wsCmd.getModuleId().ordinal())` — or `MODULE_NONE` (0) for an id the APK does not
 * declare. A command sent with the wrong module is routed to the wrong device service.
 */
export function moduleIdForCmd(cmd: number): number {
  const name = commandNameFor(cmd);
  return name ? moduleIdFor(DWARF_COMMANDS[name].module) : 0;
}

/** The payload type a command declares, or null when the APK left that direction undescribed. */
export function payloadRefFor(cmd: number, direction: 'request' | 'response'): string | null {
  const name = commandNameFor(cmd);
  if (!name) return null;
  return (DWARF_COMMANDS as Record<string, CommandSpec>)[name][direction] ?? null;
}

/** A frame from the device: header, command name, and the payload decoded when its type is known. */
export interface IncomingPacket extends WsPacketView {
  readonly commandName: string | null;
  readonly isNotification: boolean;
  /** Decoded `data`, or null when no schema is known for this direction. */
  readonly payload: Record<string, unknown> | null;
  /** Payload type used, if any. */
  readonly payloadType: string | null;
}

/** Interpret a frame received from the device. */
export function parseIncoming(bytes: Uint8Array<ArrayBufferLike>): IncomingPacket {
  const view = decodePacket(bytes);
  const commandName = DWARF_COMMANDS_BY_ID[view.cmd] ?? null;
  const isNotification = view.type === MESSAGE_TYPE.notification;
  const spec = commandName ? (DWARF_COMMANDS as Record<string, CommandSpec>)[commandName] : undefined;
  // A request echoes its request schema; a response/notification carries the response schema.
  const ref = spec ? (view.type === MESSAGE_TYPE.request ? (spec.request ?? spec.response ?? null) : (spec.response ?? spec.request ?? null)) : null;
  const payloadType = ref && payloadFields(ref) !== null ? ref : null;
  const payload = payloadType && view.data.length > 0 ? decodePayload(payloadType, view.data) : null;
  return { ...view, commandName, isNotification, payload, payloadType };
}

/** Every command name in a module, e.g. `commandsIn('MOTOR')`. */
export function commandsIn(module: string): string[] {
  return Object.entries(DWARF_COMMANDS)
    .filter(([, spec]) => spec.module === module)
    .map(([name]) => name)
    .sort((a, b) => DWARF_COMMANDS[a].id - DWARF_COMMANDS[b].id);
}

/**
 * Every notify command this APK's `WsCmd` declares, as `[id, payload type reference]`. The app's own
 * notification table predates most of them (device attitude, wide/guide focus encoders, defog,
 * auto-cooling, anti-tangle, power-sound and do-not-disturb state, …), so this is what lets the
 * decoder name and unpack a notification the SDK never heard of.
 */
export function* notificationTypes(): IterableIterator<[number, string]> {
  for (const [cmd, name] of Object.entries(DWARF_COMMANDS_BY_ID)) {
    if (!name.startsWith('NOTIFY_')) continue;
    const id = Number(cmd);
    const ref = payloadRefFor(id, 'response');
    if (ref) yield [id, ref];
  }
}
