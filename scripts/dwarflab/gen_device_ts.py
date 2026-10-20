#!/usr/bin/env python3
# DWARFLAB APK recovery pipeline — step 6 of 6, run in order. Inputs:
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
"""Reconstruct the DWARFLAB device-control surface (schema + command catalogue) as TypeScript."""
import json, os, pathlib, zipfile

EVIDENCE = pathlib.Path(__file__).resolve().parent / 'evidence'
REA = pathlib.Path(os.environ.get('REA_PROJECTS', '/workspace/rea/projects'))
REPO = pathlib.Path(__file__).resolve().parents[2]
from google.protobuf import descriptor_pb2

OUT = REPO / 'src' / 'dwarf' / 'wire' / 'generated'
REC = REA / 'dwarflab' / 'recovered'
APK = str(REA / 'dwarflab' / 'DWARFLAB.apk')

T = {1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32',
     8: 'bool', 9: 'string', 11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum',
     15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64'}
TOTS = {'double': 'number', 'float': 'number', 'int64': 'string', 'uint64': 'string', 'int32': 'number',
        'fixed64': 'string', 'fixed32': 'number', 'uint32': 'number', 'bool': 'boolean', 'string': 'string',
        'bytes': 'Uint8Array', 'sfixed32': 'number', 'sfixed64': 'string', 'sint32': 'number', 'sint64': 'string'}
NS = {'motor_control': 'motor', 'shooting_schedule': 'schedule', 'voice_assistant': 'voice'}

fds = descriptor_pb2.FileDescriptorSet()
fds.ParseFromString((REC / 'dwarflab.proto.bin').read_bytes())
enums = json.load(open(EVIDENCE / 'ws-enums.json'))
cmds = enums['WsCmd']
reqmap = json.load(open(EVIDENCE / 'proto-map.json'))['request']
respmap = json.load(open(EVIDENCE / 'resp-map.json'))
beans = json.load(open(EVIDENCE / 'device-beans.json'))

def ns_stem(filename):
    stem = filename[:-6]
    return NS.get(stem, stem)

# full schema: every message in every file, keyed "namespace.Message"
schema = {}
def walk(m, prefix, ns, maps):
    for n in m.nested_type:
        if not (n.HasField('options') and n.options.map_entry):
            walk(n, f'{prefix}.{n.name}', ns, maps)
def collect(m, maps):
    for n in m.nested_type:
        if n.HasField('options') and n.options.map_entry:
            maps[f'{m.name}.{n.name}'] = n
        collect(n, maps)

def fields_of(m, maps, ns):
    out = []
    synth = set()
    for i in range(len(m.oneof_decl)):
        fs = [f for f in m.field if f.HasField('oneof_index') and f.oneof_index == i]
        if len(fs) == 1 and fs[0].HasField('proto3_optional'):
            synth.add(i)
    for f in m.field:
        oi = f.oneof_index if f.HasField('oneof_index') else None
        if oi is not None and oi not in synth:
            continue
        kind = T.get(f.type, 'unknown')
        tname = None
        if kind in ('message', 'enum') or (f.type == 14 and not f.type_name) is False and kind in ('message',):
            pass
        if kind == 'message':
            base = f.type_name.lstrip('.')
            parts = base.split('.')
            tname = parts[-1] if len(parts) == 1 else '.'.join(parts[-2:])
            # qualify with the owning namespace when the owner file shipped no package
            tname = resolve(f.type_name)
        elif kind == 'enum':
            tname = resolve(f.type_name) if f.type_name else None
            if tname is None:
                kind = 'int32'
        rep = f.label == 3
        if kind == 'map' or (kind == 'message' and map_key(f.type_name) in maps):
            entry = maps[map_key(f.type_name)]
            k = next(x for x in entry.field if x.name == 'key'); v = next(x for x in entry.field if x.name == 'value')
            out.append(dict(name=f.name, number=f.number, kind='map',
                            key=TOTS.get(T.get(k.type, ''), 'unknown'),
                            value=TOTS.get(T.get(v.type, ''), 'message'), ts='Record<string, unknown>',
                            optional=False, repeated=False, oneof=False))
            continue
        ts = TOTS.get(kind, 'unknown') if kind not in ('message', 'enum') else 'unknown'
        out.append(dict(name=f.name, number=f.number, kind=kind, type=tname, ts=ts,
                        optional=f.HasField('proto3_optional') or (oi is not None and oi in synth),
                        repeated=rep, oneof=(oi is not None and oi not in synth)))
    return out

OWNER = {}; SHIPPED = {}
for fdp in fds.file:
    SHIPPED[fdp.name] = fdp.package
    base = f'.{fdp.package}' if fdp.package else ''
    def idx(prefix, m, fn):
        for n in m.nested_type:
            OWNER[f'{prefix}.{n.name}'] = fn; idx(f'{prefix}.{n.name}', n, fn)
        for e in m.enum_type:
            OWNER[f'{prefix}.{e.name}'] = fn
    for m in fdp.message_type:
        OWNER[f'{base}.{m.name}'] = fdp.name; idx(f'{base}.{m.name}', m, fdp.name)
    for e in fdp.enum_type:
        OWNER[f'{base}.{e.name}'] = fdp.name

def map_key(tn):
    return '.'.join(tn.lstrip('.').split('.')[-2:])

def resolve(tname):
    base = tname.lstrip('.')
    owner = OWNER.get(tname)
    if owner is None or SHIPPED.get(owner):
        return base
    return f'{ns_stem(owner)}.{base}'

for fdp in fds.file:
    ns = ns_stem(fdp.name)
    def rec(m, prefix):
        maps = {}; collect(m, maps)
        schema[f'{ns}.{prefix}'] = fields_of(m, maps, ns)
        for n in m.nested_type:
            if not (n.HasField('options') and n.options.map_entry):
                rec(n, f'{prefix}.{n.name}')
    for m in fdp.message_type:
        rec(m, m.name)

bean_by_cmd = {}
for b in beans:
    if len(b['cmds']) == 1:
        bean_by_cmd[b['cmds'][0]] = b

MODULES = [(10000,10500,'CAMERA_TELE'),(11000,11500,'ASTRO'),(12000,12500,'CAMERA_WIDE'),
           (13000,13300,'SYSTEM'),(13500,13800,'RGB_POWER'),(14000,14500,'MOTOR'),
           (14800,14900,'TRACK'),(15000,15200,'FOCUS'),(15200,15500,'NOTIFY'),
           (15500,15600,'PANORAMA'),(15700,15800,'ITIPS'),(15800,15900,'FACTORY_TEST'),
           (16100,16400,'SHOOTING_SCHEDULE'),(16400,16600,'TASK_CENTER'),(16700,16800,'PARAM'),
           (16800,16900,'VOICE_ASSISTANT'),(16900,17000,'CAMERA_GUIDE'),(17000,17100,'DEVICE')]
def module_of(c):
    for lo, hi, m in MODULES:
        if lo <= c < hi: return m
    return 'NONE'

by_short = {}
for _k in schema:
    by_short.setdefault(_k.split('.')[-1], []).append(_k)

QREF = {'fixed': [], 'ambiguous': []}

def qref(spec):                       # "AstroProto.ReqX" -> "astro.ReqX"
    cls, name = spec.split('.')
    guess = f'{NS.get(cls[:-5].lower(), cls[:-5].lower())}.{name}'
    if guess in schema:
        return guess
    # The bean's Java outer class need not match the .proto package: `MotorcontrolProto` lives in
    # motor.proto, so a namespace taken from the class name would name a type that does not exist.
    # Fall back to the schema's own definition when exactly one message carries that name.
    cands = by_short.get(name, [])
    if len(cands) == 1:
        QREF['fixed'].append(f'{guess} -> {cands[0]}')
        return cands[0]
    QREF['ambiguous'].append(f'{spec} -> {guess} ({len(cands)} candidates)')
    return guess

catalog = {}
for name, cid in cmds.items():
    e = {'id': cid, 'module': module_of(cid)}
    r = reqmap.get(name); p = respmap.get(name)
    if r: e['request'] = qref(r[0])
    if p: e['response'] = qref(p[0][0])
    b = bean_by_cmd.get(name)
    if b:
        e['bean'] = b['bean']
    catalog[name] = e

OUT.mkdir(parents=True, exist_ok=True)

# ---- payloads.generated.ts ----
L = ['/**',
     ' * Device message schemas recovered from the DWARFLAB APK protobuf descriptors:',
     ' * every field number, wire type, cardinality and presence flag the firmware ships.',
     ' * `ts` is the decoded shape protobufjs yields for scalars; "unknown" means a nested',
     ' * message (see `type`) or an enum whose name the APK omitted from its descriptor.',
     ' * Generated from the artifact by gen_device_ts.py; do not hand-edit.',
     ' */', '',
     'export interface FieldSpec {',
     '  readonly name: string;', '  readonly number: number;',
     "  readonly kind: 'double' | 'float' | 'int64' | 'uint64' | 'int32' | 'fixed64' | 'fixed32' | 'bool'",
     "    | 'string' | 'bytes' | 'message' | 'enum' | 'int32' | 'sfixed32' | 'sfixed64' | 'sint32' | 'sint64' | 'map';",
     '  /** Declared type for message/enum fields, as "namespace.Type"; null for enums the APK left unnamed. */',
     '  readonly type: string | null;',
     '  readonly ts: string;',
     '  readonly optional: boolean;', '  readonly repeated: boolean;', '  readonly oneof: boolean;',
     '  readonly key?: string;', '  readonly value?: string;', '}', '',
     'export const DWARF_PAYLOAD_FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = Object.freeze({']
for ref in sorted(schema):
    fs = schema[ref]
    L.append(f'  {ref!r}: [')
    for f in fs:
        L.append('    ' + json.dumps({k: f[k] for k in
                                      ('name', 'number', 'kind', 'type', 'ts', 'optional', 'repeated', 'oneof')
                                      if f[k] is not None or k == 'type'}, separators=(', ', ':')) + ',')
    L.append('  ],')
L.append('});')
(OUT / 'payloads.generated.ts').write_text('\n'.join(L) + '\n')

# ---- catalog.generated.ts ----
L2 = ['/**',
      ' * The complete device command catalogue: every command the APK knows, its module,',
      ' * its request/response payload types, and the app bean that builds it.',
      ' * Ids come from `WsCmd` smali immediates; payload links from the `Ws*Req` beans and the',
      ' * `*WsResponse` handler generics. Generated by gen_device_ts.py; do not hand-edit.',
      ' */', '',
      "import type { CmdPayload } from './commands.generated.js';", '',
      'export interface CommandSpec extends CmdPayload {',
      '  readonly id: number;',
      "  readonly module: string;",
      '  readonly bean?: string;',
      '}', '',
      'export const DWARF_COMMANDS: Readonly<Record<string, CommandSpec>> = Object.freeze({']
for name in sorted(catalog, key=lambda n: (catalog[n]['id'], n)):
    L2.append(f'  {name}: {json.dumps(catalog[name], separators=(", ", ":"))},')
L2.append('});')
L2.append('')
L2.append('/** Command ids keyed by id (first name wins where the APK reuses an id). */')
L2.append('export const DWARF_COMMANDS_BY_ID: Readonly<Record<number, string>> = Object.freeze({')
byid = {}
for n, e in sorted(catalog.items(), key=lambda kv: (kv[1]['id'], kv[0])):
    byid.setdefault(e['id'], n)
for i in sorted(byid):
    L2.append(f'  {i}: {byid[i]!r},')
L2.append('});')
(OUT / 'catalog.generated.ts').write_text('\n'.join(L2) + '\n')

# ---- params.generated.ts (device camera parameter tables shipped in assets/) ----
z = zipfile.ZipFile(APK); asset = json.loads(z.read('assets/params_range.json'))
L3 = ['/**',
      ' * Device camera parameter tables, shipped verbatim in the APK at assets/params_range.json.',
      ' * These map human-readable settings to the raw indices the firmware expects.',
      ' */', '',
      'export const PARAMS_RANGE = ' + json.dumps(asset, indent=2).replace('\n', '\n') + ' as const;', '',
      'export type ExposureName = (typeof PARAMS_RANGE.expValues)[number]["name"];',
      '',
      '/** The raw shutter index the firmware expects for a label like "1/1000", or null if unknown. */',
      'export function exposureIndex(name: string): number | null {',
      '  return PARAMS_RANGE.expValues.find((e) => e.name === name)?.value ?? null;',
      '}', '']
(OUT / 'params.generated.ts').write_text('\n'.join(L3))

print(f'schema messages={len(schema)}  catalogue commands={len(catalog)}')
print(f'  with request proto={sum(1 for e in catalog.values() if "request" in e)}  with response proto={sum(1 for e in catalog.values() if "response" in e)}')
print(f'  with app bean={sum(1 for e in catalog.values() if "bean" in e)}')
print(f'  payload refs repaired to the schema namespace={len(QREF["fixed"])}  unresolved={len(QREF["ambiguous"])}')
for m in QREF['fixed'][:6]:
    print(f'    repaired: {m}')
for m in QREF['ambiguous'][:6]:
    print(f'    unresolved: {m}')
for f in ('payloads.generated.ts', 'catalog.generated.ts', 'params.generated.ts'):
    print(f'  {f}: {(OUT/f).stat().st_size/1000:.1f} KB')
