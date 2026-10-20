/** JSON for values that come from the device: 64-bit protobuf fields decode as BigInt, which JSON.stringify refuses. */
const bigints = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

/** JSON.stringify that writes a BigInt as its decimal string (and never returns undefined). */
export function toJson(v: unknown, space?: number): string {
  return JSON.stringify(v, bigints, space) ?? 'null';
}
