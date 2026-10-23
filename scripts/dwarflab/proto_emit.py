#!/usr/bin/env python3
# DWARFLAB APK recovery pipeline — step 4 of 6, run in order. Inputs:
#   DWARFLAB.apk (sha256 3ac4e333cde1d22fcf4564d203616b31abf37b3a0fdaccd762bf4661958fc079),
#   by default under $REA_PROJECTS (default /workspace/rea/projects)/dwarflab/.
#   1 SmaliDump.java <dex-dir> <out>     baksmali of the 8 classes*.dex      -> $DWARFLAB_WORK/dwarflab-smali
#   2 JdxBulk.java   <apk>    <out>      JADX headless decompile             -> $DWARFLAB_WORK/dwarflab-src
#   3 proto_recover.py                   serialized FileDescriptorProtos     -> $REA_PROJECTS/dwarflab/recovered
#   4 proto_emit.py                      readable .proto from those bytes    -> .../recovered/proto
#   5 gen_ts.py                          recovered.root JSON + WsCmd ids     -> src/drivers/dwarf/wire/{generated,proto}
#   6 gen_device_ts.py                   schemas, catalogue, camera params   -> src/drivers/dwarf/wire/generated
# Steps 5 and 6 read the extracted facts from the committed evidence/ directory, so the
# TypeScript regenerates without re-running 1-4; those steps are only needed against a new APK.
# Requires the python protobuf runtime (pip install protobuf).
"""Emit readable, compilable .proto source from the recovered FileDescriptorSet.

Fidelity notes:
  * Field names, numbers, scalar types, cardinality, defaults, oneofs, map entries,
    enum values and imports are taken verbatim from the shipped descriptors.
  * Each file is given a `package` (its load namespace). Packages are not encoded on
    the wire, so this changes nothing observable on the socket; four files already ship
    with a package and keep it.
  * Enum-typed fields that ship with an empty `type_name` are emitted as `int32`
    (identical varint wire type) and annotated.
"""
import os
import pathlib

REA = pathlib.Path(os.environ.get('REA_PROJECTS', '/workspace/rea/projects'))
REPO = pathlib.Path(__file__).resolve().parents[2]

from google.protobuf import descriptor_pb2

SRC = REA / 'dwarflab' / 'recovered' / 'dwarflab.proto.bin'
OUT = REA / 'dwarflab' / 'recovered' / 'proto'

SCALAR = {
    1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32',
    8: 'bool', 9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64',
}
# Namespaces the controller (and the third-party SDK) load each file under.
NS = {'motor_control': 'motor', 'shooting_schedule': 'schedule', 'voice_assistant': 'voice'}

OWNER: dict[str, str] = {}      # '.Outer.Inner' -> defining file name
SHIPPED: dict[str, str] = {}    # file name -> package as shipped ('' when the file had none)
FILE_PKG: dict[str, str] = {}   # file name -> package we emit
CUR = ''                        # file being rendered


def ns_of(filename: str) -> str:
    stem = filename[:-6] if filename.endswith('.proto') else filename
    return NS.get(stem, stem)


def index_types(prefix: str, m, filename: str) -> None:
    for n in m.nested_type:
        q = f'{prefix}.{n.name}'
        OWNER[q] = filename
        index_types(q, n, filename)
    for e in m.enum_type:
        OWNER[f'{prefix}.{e.name}'] = filename


def pkg_of(fdp) -> str:
    return fdp.package or ns_of(fdp.name)


def qualify(tname: str) -> str:
    """Render a descriptor type reference inside the file being emitted."""
    base = tname.lstrip('.')
    owner = OWNER.get(tname)
    if owner is None or owner == CUR or SHIPPED.get(owner):
        return base                              # self-reference, or already package-qualified
    return f'{ns_of(owner)}.{base}'


def is_map_entry(m) -> bool:
    return m.HasField('options') and m.options.map_entry


def map_key(tname: str) -> str:
    return '.'.join(tname.lstrip('.').split('.')[-2:])


def collect_maps(m, out: dict) -> None:
    for n in m.nested_type:
        if is_map_entry(n):
            out[f'{m.name}.{n.name}' if m.name else n.name] = n
            out[n.name] = n
        collect_maps(n, out)


def type_of(f, maps: dict):
    if f.type in SCALAR:
        return SCALAR[f.type]
    if map_key(f.type_name) in maps:
        return None
    return qualify(f.type_name)


def map_line(f, entry, indent: str) -> str:
    key = next(x for x in entry.field if x.name == 'key')
    val = next(x for x in entry.field if x.name == 'value')
    kt = SCALAR.get(key.type) or qualify(key.type_name)
    vt = SCALAR.get(val.type) or (qualify(val.type_name) if val.type_name else 'bytes')
    return f'{indent}map<{kt}, {vt}> {f.name} = {f.number};'


def field_line(f, indent: str, maps: dict, in_oneof: bool = False) -> str:
    tname = type_of(f, maps)
    if tname is None:
        return map_line(f, maps[map_key(f.type_name)], indent)
    note = ''
    if f.type == 14 and not f.type_name:
        tname, note = 'int32', '  // enum-typed: name absent from the shipped descriptor'
    lab = ('' if in_oneof else
           'repeated ' if f.label == 3 else
           'optional ' if f.HasField('proto3_optional') else '')
    extra = ''
    if f.HasField('default_value'):
        dv = f.default_value
        if f.type == 9:
            dv = '"%s"' % dv.replace('\\', '\\\\').replace('"', '\\"')
        extra = f' [default = {dv}]'
    return f'{indent}{lab}{tname} {f.name} = {f.number}{extra};{note}'


def synthetic_oneofs(m) -> set:
    """protoc models each proto3 `optional` field as a one-field synthetic oneof."""
    out = set()
    for i in range(len(m.oneof_decl)):
        fs = [f for f in m.field if f.HasField('oneof_index') and f.oneof_index == i]
        if len(fs) == 1 and fs[0].HasField('proto3_optional'):
            out.add(i)
    return out


def render_enum(e, indent: str, lines: list) -> None:
    lines.append(f'{indent}enum {e.name} {{')
    for v in e.value:
        lines.append(f'{indent}  {v.name} = {v.number};')
    lines.append(f'{indent}}}')


def render_message(m, indent: str, lines: list, maps: dict) -> None:
    inner = indent + '  '
    lines.append(f'{indent}message {m.name} {{')
    synth = synthetic_oneofs(m)
    for f in m.field:
        i = f.oneof_index if f.HasField('oneof_index') else None
        if i is None or i in synth:
            lines.append(field_line(f, inner, maps))
    for i, o in enumerate(m.oneof_decl):
        if i in synth:
            continue
        lines.append(f'{inner}oneof {o.name} {{')
        for f in m.field:
            if f.HasField('oneof_index') and f.oneof_index == i:
                lines.append(field_line(f, inner + '  ', maps, in_oneof=True))
        lines.append(f'{inner}}}')
    for e in m.enum_type:
        render_enum(e, inner, lines)
    for n in m.nested_type:
        if not is_map_entry(n):
            render_message(n, inner, lines, maps)
    lines.append(f'{indent}}}')


def main() -> int:
    fds = descriptor_pb2.FileDescriptorSet()
    fds.ParseFromString(SRC.read_bytes())
    for fdp in fds.file:
        FILE_PKG[fdp.name] = pkg_of(fdp)
        SHIPPED[fdp.name] = fdp.package
        base = f'.{fdp.package}' if fdp.package else ''
        for m in fdp.message_type:
            OWNER[f'{base}.{m.name}'] = fdp.name
            index_types(f'{base}.{m.name}', m, fdp.name)
        for e in fdp.enum_type:
            OWNER[f'{base}.{e.name}'] = fdp.name

    total = 0
    for fdp in fds.file:
        global CUR
        CUR = fdp.name
        lines = [f'syntax = "{fdp.syntax or "proto2"}";', '', f'package {FILE_PKG[fdp.name]};', '']
        for d in fdp.dependency:
            lines.append(f'import "{d}";')
        if fdp.dependency:
            lines.append('')
        maps: dict = {}
        for m in fdp.message_type:
            collect_maps(m, maps)
        for m in fdp.message_type:
            render_message(m, '', lines, maps)
            lines.append('')
        for e in fdp.enum_type:
            render_enum(e, '', lines)
            lines.append('')
        body = '\n'.join(lines).rstrip() + '\n'
        (OUT / fdp.name).write_text(body, encoding='utf-8')
        total += len(body)
        print(f'{fdp.name:28s} {len(body):7d} chars  {body.count(chr(10)):4d} lines  pkg={FILE_PKG[fdp.name]}')
    print(f'\nwrote {len(fds.file)} files, {total} chars to {OUT}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
