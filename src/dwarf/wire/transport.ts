/**
 * Wire framing for the DWARFLAB WebSocket control plane, reconstructed from the APK:
 * `BaseProto.WsPacket` (the only message on the socket), `net.websocket.MyWsManager`
 * (endpoint and socket tuning) and `data.websocket.WsRequestHandle` (send/correlate).
 */
import { recoveredType } from './generated/recovered.generated.js';

/** `MyWsManager`: `ws://" + host + ":9900/?client_id=" + id` */
export const WS_PORT = 9900;
/** `MyWsManager`: `pingInterval(40, SECONDS)` — the socket keepalive the device expects. */
export const PING_INTERVAL_MS = 40_000;
/** `MyWsManager`: `connectTimeout(5, SECONDS)`, with `retryOnConnectionFailure(false)`. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** `MyWsManager` port fields seen in the class (`q = 4409`, `s = 4410`). */
export const AUX_PORT_LOW = 4409;
export const AUX_PORT_HIGH = 4410;

/**
 * The header the DWARFLAB app itself writes on every request: `rw4.d()` calls
 * `setMajorVersion(2).setMinorVersion(3)`. (`base.proto` declares `WS_MINOR_VERSION_NUMBER = 7`,
 * which the app never sends, so it is not the protocol version on the wire.)
 */
export const PROTOCOL_MAJOR = 2;
export const PROTOCOL_MINOR = 3;

/**
 * What `@alikh/dwarflab-sdk` writes instead (verified by encoding a packet and decoding it with the
 * recovered `base.WsPacket`). Not what the official app sends: the live control path defaults to the
 * `app` header above (`DWARF_PROTOCOL_HEADER`), and this pair is the fallback for a firmware that
 * refuses it.
 */
export const SDK_PROTOCOL_MAJOR = 1;
export const SDK_PROTOCOL_MINOR = 20;

/** Which header a request carries: what the APK writes, or what this app has always sent. */
export type ProtocolHeader = 'app' | 'sdk';

/** The `majorVersion`/`minorVersion` pair for a header choice, ready to spread into `encodePacket`. */
export function headerFor(which: ProtocolHeader): {
  majorVersion: number;
  minorVersion: number;
} {
  return which === 'app' ? { majorVersion: PROTOCOL_MAJOR, minorVersion: PROTOCOL_MINOR } : { majorVersion: SDK_PROTOCOL_MAJOR, minorVersion: SDK_PROTOCOL_MINOR };
}

/** `WsMessageType` enum values from the APK. */
export const MESSAGE_TYPE = Object.freeze({
  request: 0,
  response: 1,
  notification: 2,
  reply: 3,
});
export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

/** Decoded `base.WsPacket`; the enum-typed header fields ship without enum names. */
export interface WsPacketView {
  readonly majorVersion: number;
  readonly minorVersion: number;
  readonly deviceId: number;
  readonly moduleId: number;
  readonly cmd: number;
  readonly type: number;
  readonly data: Uint8Array<ArrayBufferLike>;
  readonly clientId: string;
}

/** Decode a socket frame into its header plus the undecrypted `data` payload. */
export function decodePacket(bytes: Uint8Array<ArrayBufferLike>): WsPacketView {
  const t = recoveredType('base.WsPacket');
  const o = t.toObject(t.decode(bytes), {
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  }) as Record<string, unknown>;
  return {
    majorVersion: Number(o['majorVersion'] ?? 0),
    minorVersion: Number(o['minorVersion'] ?? 0),
    deviceId: Number(o['deviceId'] ?? 0),
    moduleId: Number(o['moduleId'] ?? 0),
    cmd: Number(o['cmd'] ?? 0),
    type: Number(o['type'] ?? 0),
    data: (o['data'] instanceof Uint8Array ? o['data'] : new Uint8Array()) as Uint8Array<ArrayBufferLike>,
    clientId: String(o['clientId'] ?? ''),
  };
}

/** Wrap a command and its encoded payload the way the app does before writing to the socket. */
export function encodePacket(fields: { readonly cmd: number; readonly moduleId: number; readonly type?: MessageType; readonly data?: Uint8Array<ArrayBufferLike>; readonly clientId?: string; readonly deviceId?: number; readonly majorVersion?: number; readonly minorVersion?: number }): Uint8Array<ArrayBufferLike> {
  const t = recoveredType('base.WsPacket');
  const msg = t.create({
    majorVersion: fields.majorVersion ?? PROTOCOL_MAJOR,
    minorVersion: fields.minorVersion ?? PROTOCOL_MINOR,
    deviceId: fields.deviceId ?? 0,
    moduleId: fields.moduleId,
    cmd: fields.cmd,
    type: fields.type ?? MESSAGE_TYPE.request,
    data: fields.data ?? new Uint8Array(),
    clientId: fields.clientId ?? '',
  });
  return t.encode(msg).finish();
}
