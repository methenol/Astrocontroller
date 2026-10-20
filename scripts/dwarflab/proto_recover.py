#!/usr/bin/env python3
# DWARFLAB APK recovery pipeline — step 3 of 6, run in order. Inputs:
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
# Requires the python protobuf runtime (pip install protobuf).
"""Recover the DWARFLAB protobuf schemas from the JADX-decompiled generated classes.

Each protobuf outer class holds its serialized FileDescriptorProto as a Java String[]
(chars are bytes). We decode the escapes, concatenate the chunks in array order, and
parse with google.protobuf -- a clean parse whose name matches the referenced .proto
file is the fidelity proof.
"""
import os
import re, sys, json, pathlib
REA = pathlib.Path(os.environ.get('REA_PROJECTS', '/workspace/rea/projects'))
from google.protobuf import descriptor_pb2

WORK = pathlib.Path(os.environ.get('DWARFLAB_WORK', '/tmp'))
SRC = WORK / 'dwarflab-src' / 'sources'
OUT = REA / 'dwarflab' / 'recovered'
OUT.mkdir(parents=True, exist_ok=True)

ESC = {'n': '\n', 't': '\t', 'r': '\r', 'f': '\f', 'b': '\b', '"': '"', "'": "'", '\\': '\\'}


def java_string(lit: str) -> str:
    """Decode one Java string literal body (no surrounding quotes)."""
    out, i, n = [], 0, len(lit)
    while i < n:
        c = lit[i]
        if c != '\\':
            out.append(c); i += 1; continue
        i += 1
        if i >= n:
            raise ValueError('trailing escape')
        d = lit[i]
        if d == 'u':
            out.append(chr(int(lit[i + 1:i + 5], 16))); i += 5; continue
        if d in '01234567':                      # octal escape, up to 3 digits
            j, val = i, 0
            while j < min(i + 3, n) and '0' <= lit[j] <= '7':
                val = val * 8 + int(lit[j], 8); j += 1
            out.append(chr(val)); i = j; continue
        out.append(ESC.get(d, d)); i += 1
    return ''.join(out)


def string_array(src: str, start: int) -> list[str]:
    """Read the String[]{ ... } literal that begins at or after start."""
    o = src.index('{', start)
    depth, i, n, items = 0, o, len(src), []
    while i < n:
        c = src[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                break
        elif c == '"':
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2; continue
                if src[j] == '"':
                    break
                j += 1
            items.append(java_string(src[i + 1:j]))
            i = j
        i += 1
    return items


def java_bytes(chunks: list[str]) -> bytes:
    out = bytearray()
    for ch in ''.join(chunks):
        o = ord(ch)
        if o > 0xFF:
            raise ValueError(f'non-byte char U+{o:04X} in descriptor')
        out.append(o)
    return bytes(out)


def main() -> int:
    fds = descriptor_pb2.FileDescriptorSet()
    report, failures = [], []
    for f in sorted(SRC.glob('com.convergence.dwarflab.proto.*Proto.java')):
        src = f.read_text(encoding='utf-8')
        m = re.search(r'internalBuildGeneratedFileFrom\(', src)
        if not m:
            continue
        chunks = string_array(src, m.end())
        try:
            raw = java_bytes(chunks)
        except ValueError as e:
            failures.append((f.name, f'decode: {e}')); continue
        fdp = descriptor_pb2.FileDescriptorProto()
        try:
            fdp.ParseFromString(raw)
        except Exception as e:                                    # noqa: BLE001
            failures.append((f.name, f'parse: {e}')); continue
        declared = re.search(r'"([A-Za-z0-9_/]+\.proto)"', src)
        if not fdp.name:
            failures.append((f.name, 'no file name')); continue
        if declared and declared.group(1) != fdp.name:
            failures.append((f.name, f'name mismatch {declared.group(1)} != {fdp.name}')); continue
        msgs = sum(1 for _ in iter_messages(fdp.message_type))
        enums = sum(len(e.value) for e in fdp.enum_type)
        report.append({'file': fdp.name, 'package': fdp.package, 'bytes': len(raw),
                       'messages': msgs, 'top_enums': len(fdp.enum_type), 'enum_values': enums,
                       'deps': list(fdp.dependency)})
        fds.file.append(fdp)
    (OUT / 'dwarflab.proto.bin').write_bytes(fds.SerializeToString())
    (OUT / 'schemas.json').write_text(json.dumps({'files': report, 'failures': failures}, indent=1))
    for r in report:
        print(f"{r['file']:28s} {r['package']:14s} {r['bytes']:7d}B  {r['messages']:4d} msgs  "
              f"{r['top_enums']:2d} enums/{r['enum_values']:4d} vals  deps={','.join(r['deps']) or '-'}")
    print(f"\nfiles={len(report)} failures={len(failures)}")
    for n, why in failures:
        print('FAIL', n, why)
    return 0 if not failures and report else 1


def iter_messages(msgs):
    for m in msgs:
        yield m
        yield from iter_messages(m.nested_type)


if __name__ == '__main__':
    sys.exit(main())
