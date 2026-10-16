/**
 * Proto message types: the SDK's generated namespace, plus message variants seen on V3 firmware
 * that the SDK's protos lack (goto_only, rotation, use_calibration, an empty request).
 */
import protobuf from 'protobufjs';
import { proto } from '@alikh/dwarflab-sdk';

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
  if (!t || typeof t.decode !== 'function') throw new Error(`protocol: unknown proto type ${ref}`);
  return t;
}
