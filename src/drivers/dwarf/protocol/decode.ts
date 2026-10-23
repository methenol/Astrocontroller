/** Payload decoding: typed with a proto type, or schema-less when the type is unknown or wrong. */
import type { ProtoType } from './types.js';

/** protobufjs → plain JSON with int64 as decimal strings and enums as numbers. */
export function toPlain(type: ProtoType, msg: unknown): Record<string, unknown> {
  const t = type as unknown as { toObject(m: unknown, o: unknown): Record<string, unknown> };
  return t.toObject(msg, { longs: String, enums: Number, defaults: false, oneofs: true });
}

/** Decode with `type`; a payload that does not fit it (or no type) is decoded schema-less. */
export function decodeWith(type: ProtoType | undefined, data: Uint8Array): Record<string, unknown> {
  if (!type) return rawDecode(data);
  try {
    return toPlain(type, type.decode(data));
  } catch {
    return rawDecode(data);
  }
}

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;
/** A varint is at most 10 bytes (64 bits). */
const MAX_VARINT_BYTES = 10;
const UINT64_SPAN = 0x10000000000000000n;
const INT64_MAX = 0x7fffffffffffffffn;
const PRINTABLE = /^[\x20-\x7e\s]*$/;
const utf8 = new TextDecoder('utf-8', { fatal: false });

class Truncated extends Error {}

/**
 * Schema-less protobuf decode: {f1: 3, f2: "..."}, a repeated field as an array. Used for unknown
 * payloads. Bytes it cannot read (truncated, or a wire type it does not know) end the decode, and
 * the whole payload is added as `_hex` so nothing is lost.
 */
export function rawDecode(data: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  const need = (n: number) => {
    if (i + n > data.length) throw new Truncated();
  };
  const varint = (): bigint => {
    let result = 0n;
    for (let n = 0; n < MAX_VARINT_BYTES; n++) {
      need(1);
      const b = data[i++];
      result |= BigInt(b & 0x7f) << BigInt(7 * n);
      if ((b & 0x80) === 0) return result;
    }
    throw new Truncated();
  };
  const put = (k: string, value: unknown) => {
    if (k in out) out[k] = ([] as unknown[]).concat(out[k], value);
    else out[k] = value;
  };
  try {
    while (i < data.length) {
      const key = varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (field === 0) throw new Truncated();
      let value: unknown;
      if (wire === WIRE_VARINT) {
        const v = varint();
        value = v > INT64_MAX ? Number(v - UINT64_SPAN) : v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      } else if (wire === WIRE_I64) {
        need(8);
        value = view.getFloat64(i, true);
        i += 8;
      } else if (wire === WIRE_I32) {
        need(4);
        value = view.getFloat32(i, true);
        i += 4;
      } else if (wire === WIRE_LEN) {
        const len = Number(varint());
        need(len);
        const bytes = data.subarray(i, i + len);
        i += len;
        const text = utf8.decode(bytes);
        value = PRINTABLE.test(text) ? text : Buffer.from(bytes).toString('hex');
      } else {
        throw new Truncated(); // groups (3/4) and reserved wire types: not used by this firmware
      }
      put(`f${field}`, value);
    }
  } catch {
    out._hex = Buffer.from(data).toString('hex');
  }
  return out;
}
