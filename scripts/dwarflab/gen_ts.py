#!/usr/bin/env python3
# DWARFLAB APK recovery pipeline — step 5 of 6, run in order. Inputs:
#   DWARFLAB.apk (sha256 3ac4e333cde1d22fcf4564d203616b31abf37b3a0fdaccd762bf4661958fc079),
#   by default under $REA_PROJECTS (default /workspace/rea/projects)/dwarflab/.
#   1 SmaliDump.java <dex-dir> <out>     baksmali of the 8 classes*.dex      -> $DWARFLAB_WORK/dwarflab-smali
#   2 JdxBulk.java   <apk>    <out>      JADX headless decompile             -> $DWARFLAB_WORK/dwarflab-src
#   3 proto_recover.py                   serialized FileDescriptorProtos     -> $REA_PROJECTS/dwarflab/recovered
#   4 proto_emit.py                      readable .proto from those bytes    -> .../recovered/proto
#   5 gen_ts.py                          recovered.root JSON + WsCmd ids     -> src/dwarf/wire/{generated,proto}
#   6 gen_device_ts.py                   schemas, catalogue, camera params   -> src/dwarf/wire/generated
# Steps 5 and 6 read the extracted facts from the committed evidence/ directory, so the
# TypeScript regenerates without re-running 1-4; those steps are only needed against a new APK.
# Deterministic: re-running must not change the committed files.
"""Emit the Astrocontroller protocol module from recovered APK evidence."""
import json, os, pathlib, shutil

EVIDENCE = pathlib.Path(__file__).resolve().parent / 'evidence'
REA = pathlib.Path(os.environ.get('REA_PROJECTS', '/workspace/rea/projects'))
REPO = pathlib.Path(__file__).resolve().parents[2]

OUT = REPO / 'src' / 'dwarf' / 'wire'
PROTO = OUT / 'proto'
GEN = OUT / 'generated'
enums = json.load(open(EVIDENCE / 'ws-enums.json'))
reqmap = json.load(open(EVIDENCE / 'proto-map.json'))['request']
respmap = json.load(open(EVIDENCE / 'resp-map.json'))
msgs = json.load(open(EVIDENCE / 'recovered-msgs.json'))

# SDK namespace keys differ for three files; the SDK's own proto object is the authority on those keys.
NS = {'motor_control': 'motor', 'shooting_schedule': 'schedule', 'voice_assistant': 'voice'}
def ref(proto_class: str, name: str) -> str:
    stem = proto_class[:-5].lower()                       # AstroProto -> astro
    return f'{NS.get(stem, stem)}.{name}'

MODULES = [(10000,10500,'CAMERA_TELE'),(11000,11500,'ASTRO'),(12000,12500,'CAMERA_WIDE'),
           (13000,13300,'SYSTEM'),(13500,13800,'RGB_POWER'),(14000,14500,'MOTOR'),
           (14800,14900,'TRACK'),(15000,15200,'FOCUS'),(15200,15500,'NOTIFY'),
           (15500,15600,'PANORAMA'),(15700,15800,'ITIPS'),(15800,15900,'FACTORY_TEST'),
           (16100,16400,'SHOOTING_SCHEDULE'),(16400,16600,'TASK_CENTER'),(16700,16800,'PARAM'),
           (16800,16900,'VOICE_ASSISTANT'),(16900,17000,'CAMERA_GUIDE'),(17000,17100,'DEVICE')]

cmds = enums['WsCmd']
def ts_obj(items, pad='  '):
    return '\n'.join(f'{pad}{k}: {v},' for k, v in items)

L = []
L.append('/**')
L.append(' * Command ids, module ranges and payload types recovered from the DWARFLAB APK')
L.append(' * (com.convergence.dwarflab) by static analysis. Values come from the `WsCmd` enum\'s smali')
L.append(' * `const` immediates, `WsCmd.getModuleId()` ranges, and the `Ws*Req`/`*WsResponse` bean')
L.append(' * declarations. Do not hand-edit: regenerate from the artifact.')
L.append(' */')
L.append('')
L.append('/** Every command id the APK knows, keyed by its `WsCmd` constant name. */')
L.append('export const DWARF_CMD: Readonly<Record<string, number>> = Object.freeze({')
L.append(ts_obj(sorted(cmds.items(), key=lambda x: (x[1], x[0]))))
L.append('});')
L.append('')
L.append('/** `WsCmd.getModuleId()` ranges: [lo, hi) -> module. First match wins; unmatched is NONE. */')
L.append('export const DWARF_MODULE_RANGES: readonly [number, number, string][] = Object.freeze([')
for lo, hi, m in MODULES:
    L.append(f'  [{lo}, {hi}, \'{m}\'],')
L.append(']);')
L.append('')
L.append('/** Module for a command id, mirroring the firmware enum. */')
L.append('export function moduleOfCmd(cmd: number): string {')
L.append('  for (const [lo, hi, m] of DWARF_MODULE_RANGES) if (cmd >= lo && cmd < hi) return m;')
L.append('  return \'NONE\';')
L.append('}')
L.append('')
L.append('/** `WsMessageType` enum values. */')
L.append('export const DWARF_MESSAGE_TYPE: Readonly<Record<string, number>> = Object.freeze({')
L.append(ts_obj(sorted(enums['WsMessageType'].items(), key=lambda x: x[1])))
L.append('});')
L.append('')
L.append('/** `WsModuleId` enum values. */')
L.append('export const DWARF_MODULE_ID: Readonly<Record<string, number>> = Object.freeze({')
L.append(ts_obj(sorted(enums['WsModuleId'].items(), key=lambda x: x[1])))
L.append('});')
L.append('')
L.append('/** Payload types per command, as "namespace.Message" refs into the recovered protos. */')
L.append('export interface CmdPayload { readonly request?: string; readonly response?: string; }')
L.append('')
L.append('export const DWARF_PROTO_MAP: Readonly<Record<string, CmdPayload>> = Object.freeze({')
by_name = {v: k for k, v in cmds.items()}
for cid in sorted(set(cmds.values())):
    name = by_name[cid]
    r = reqmap.get(name); p = respmap.get(name)
    parts = []
    if r: parts.append(f'request: \'{ref(r[0].split(".")[0], r[0].split(".")[1])}\'')
    if p: parts.append(f'response: \'{ref(p[0][0].split(".")[0], p[0][0].split(".")[1])}\'')
    if parts:
        L.append(f'  {name}: {{ {", ".join(parts)} }},')
L.append('});')
L.append('')
L.append('/** Message and enum names defined by each recovered .proto file, keyed by load namespace. */')
L.append('export const DWARF_PROTO_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({')
for stem in sorted(msgs):
    names = sorted(msgs[stem])
    body = ', '.join(f"'{n}'" for n in names)
    L.append(f'  {NS.get(stem, stem)}: [')
    for i in range(0, len(names), 4):
        chunk = ', '.join(f"'{n}'" for n in names[i:i + 4])
        L.append(f'    {chunk},')
    L.append('  ],')
L.append('});')
GEN.mkdir(parents=True, exist_ok=True)
(GEN / 'commands.generated.ts').write_text('\n'.join(L) + '\n')
PROTO.mkdir(parents=True, exist_ok=True)
src = REA / 'dwarflab' / 'recovered' / 'proto'
for f in sorted(src.glob('*.proto')):
    shutil.copy2(f, PROTO / f.name)
print(f'wrote {GEN/"commands.generated.ts"} ({len(L)} lines) + {len(list(PROTO.glob("*.proto")))} proto files')

# ---- runtime-loadable schema module (protobufjs JSON; .proto files are not copied by tsc) ----
import subprocess, sys
measure = subprocess.run([sys.executable, '-c', 'pass'], capture_output=True)
js = r'''
const require = (await import('module')).createRequire('__REPO__/');
const protobuf = require('protobufjs'); const fs = require('fs');
const dir = '__REPO__/src/dwarf/wire/proto';
const root = new protobuf.Root();
root.loadSync(fs.readdirSync(dir).filter(f => f.endsWith('.proto')).map(f => dir + '/' + f), { keepCase: false });
process.stdout.write(JSON.stringify(root.toJSON({ keepCaseDefaults: false })));
'''
import shutil
node = shutil.which('node')
json_text = subprocess.run([node, '--input-type=module', '-e', js.replace('__REPO__', str(REPO))], capture_output=True, text=True, check=True).stdout
L2 = []
L2.append('/**')
L2.append(' * Protobuf schemas recovered from the DWARFLAB APK, as a protobufjs root.')
L2.append(' * Derived from the 17 .proto files next to the `proto/` directory (generated by proto_emit.py')
L2.append(' * from the APK\'s shipped FileDescriptorProto blobs), so the schemas survive `tsc` packaging,')
L2.append(' * which does not copy .proto files into dist/. Regenerate with gen_ts.py; do not hand-edit.')
L2.append(' */')
L2.append("import protobuf from 'protobufjs';")
L2.append('')
L2.append(f'const RECOVERED_ROOT = JSON.parse({json.dumps(json_text)}) as unknown;')
L2.append('')
L2.append('let cached: protobuf.Root | undefined;')
L2.append('')
L2.append('/** The recovered schema root, built once on first use. */')
L2.append('export function recoveredRoot(): protobuf.Root {')
L2.append('  cached ??= protobuf.Root.fromJSON(RECOVERED_ROOT as never) as protobuf.Root;')
L2.append('  return cached;')
L2.append('}')
L2.append('')
L2.append('/** A recovered message type by "namespace.Message" (e.g. "astro.ReqGotoDSO"). */')
L2.append('export function recoveredType(ref: string): protobuf.Type {')
L2.append('  const t = recoveredRoot().lookup(ref);')
L2.append('  if (!(t instanceof protobuf.Type)) throw new Error(`protocol: no recovered type ${ref}`);')
L2.append('  return t;')
L2.append('}')
L2.append('')
L2.append('/** Whether the recovered schemas define this type. */')
L2.append('export function hasRecoveredType(ref: string): boolean {')
L2.append('  try { return recoveredType(ref) instanceof protobuf.Type; } catch { return false; }')
L2.append('}')
(GEN / 'recovered.generated.ts').write_text('\n'.join(L2) + '\n')
print(f'wrote {GEN/"recovered.generated.ts"} ({len(json_text)} bytes of schema JSON)')
