/**
 * Proto message types, in one precedence order: the SDK's generated namespace (proven against the
 * firmware by this app), the V3 message variants the SDK's protos predate (goto_only, rotation,
 * use_calibration, an empty request), and finally the schemas recovered from the APK's own
 * descriptors — which is how the commands the SDK never registered (device anti-tangle, lens defog,
 * guide camera exposure/gain, …) get encoded at all.
 */
import protobuf from 'protobufjs';
import { proto } from '@alikh/dwarflab-sdk';
import { hasRecoveredType, recoveredType } from '../wire/generated/recovered.generated.js';

export interface ProtoType {
  encode(message: unknown): { finish(): Uint8Array };
  decode(reader: Uint8Array): unknown;
  create(properties?: unknown): unknown;
  toObject?(message: unknown, options?: unknown): Record<string, unknown>;
}

const EXTRA_PROTO = `
syntax = "proto3";
package dwarflab.extra;
message ReqGotoDSO {
  double ra = 1;
  double dec = 2;
  string target_name = 3;
  bool goto_only = 4;
  optional int32 rotation = 5;
}
message ReqOneClickGotoDSO {
  double ra = 1;
  double dec = 2;
  string target_name = 3;
  double lon = 4;
  double lat = 5;
  int32 shooting_mode = 6;
  bool goto_only = 7;
  optional int32 rotation = 8;
}
message ReqStartEqSolving {
  double lon = 1;
  double lat = 2;
  optional bool use_calibration = 3;
}
message Empty {}
`;

const extraRoot = protobuf.parse(EXTRA_PROTO, { keepCase: false }).root;
const sdk = proto as unknown as Record<string, Record<string, ProtoType> | undefined>;

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * Rename keys to the spelling a recovered `Type` declares. The APK's `.proto` files use snake_case and
 * the descriptor root loads with `keepCase: false`, so protobufjs knows only the camelCase spelling
 * and would silently drop a `goto_only`-style key; callers may use either. Keys the message does not
 * declare pass through, as protobufjs itself would leave them.
 */
function normalizeKeys(type: protobuf.Type, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
  const field = type.fields[key] ?? type.fields[camel(key)];
  out[field?.name ?? key] = field && v != null && typeof v === 'object' ? normalizeValue(field, v) : v;
  }
  return out;
}

function normalizeValue(field: protobuf.Field, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeValue(field, v));
  const nested = field.resolvedType;
  return nested instanceof protobuf.Type ? normalizeKeys(nested, value as Record<string, unknown>) : value;
}

/** Recovered descriptors adapted to the SDK's `ProtoType` shape, built once per reference. */
const recoveredCache = new Map<string, ProtoType>();

function recoveredProtoType(ref: string): ProtoType | undefined {
  if (!hasRecoveredType(ref)) return undefined;
  const cached = recoveredCache.get(ref);
  if (cached) return cached;
  const type = recoveredType(ref);
  const adapted: ProtoType = {
  create: (properties) => type.create(normalizeKeys(type, (properties ?? {}) as Record<string, unknown>)),
  decode: (reader) => type.decode(reader),
  encode: (message) => type.encode(message as protobuf.Message<Record<string, unknown>>),
  toObject: (message, options) => type.toObject(message as protobuf.Message<Record<string, unknown>>, (options ?? { longs: String, enums: Number, defaults: false, oneofs: false }) as protobuf.IConversionOptions),
  };
  recoveredCache.set(ref, adapted);
  return adapted;
}

/**
 * The APK's own descriptor for a message, deliberately bypassing the SDK's generated class. For the
 * cases where the SDK's schema is measurably stale — it decodes only a subset of what the firmware
 * sends — and the recovered descriptor is that same schema with the missing fields present.
 */
export function apkProtoType(ref: string): ProtoType {
  const t = recoveredProtoType(ref);
  if (!t) throw new Error(`protocol: the recovered APK descriptors have no ${ref}`);
  return t;
}

/** A proto type by "pkg.Name" ("extra.Name" for the variants above). Throws on an unknown name. */
export function protoTypeByName(ref: string): ProtoType {
  const dot = ref.indexOf('.');
  if (dot <= 0 || dot === ref.length - 1) throw new Error(`protocol: "${ref}" is not a "pkg.Name" type reference`);
  const pkg = ref.slice(0, dot);
  const name = ref.slice(dot + 1);
  if (pkg === 'extra') {
    const t = extraRoot.lookup(`dwarflab.extra.${name}`);
    if (!(t instanceof protobuf.Type)) throw new Error(`protocol: unknown proto type ${ref}`);
    return t as unknown as ProtoType;
  }
  const t = sdk[pkg]?.[name];
  if (t && typeof t.decode === 'function') return t;
  // The SDK never registered this message: the APK's own descriptor is the last authority.
  const recovered = recoveredProtoType(ref);
  if (recovered) return recovered;
  throw new Error(`protocol: unknown proto type ${ref}`);
}
