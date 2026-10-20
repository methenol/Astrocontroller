# DWARFLAB APK recovery pipeline — step 2 of 6, run in order. Inputs:
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
# Needs jadx-headless-mcp 0.7.1 (see REA_JADX_MCP_JAR) and Java 17+.
import jadx.api.JadxDecompiler;
import jadx.api.JadxArgs;
import jadx.api.JavaClass;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Bulk decompile of selected package prefixes using the REA-pinned jadx-headless-mcp engine. */
public class JdxBulk {
  public static void main(String[] argv) throws Exception {
    String apk = argv[0];
    String out = argv[1];
    List<String> prefixes = new ArrayList<>();
    for (int i = 2; i < argv.length; i++) prefixes.add(argv[i]);

    JadxArgs args = new JadxArgs();
    args.setInputFile(new File(apk));
    args.setOutDir(new File(out));
    args.setThreadsCount(8);
    args.setSkipResources(true);

    JadxDecompiler d = new JadxDecompiler(args);
    d.load();
    int ok = 0, fail = 0, skip = 0;
    Path root = new File(out).toPath();
    for (JavaClass c : d.getClasses()) {
      String pkg = c.getPackage() == null ? "" : c.getPackage();
      String cls = c.getRawName();
      boolean match = prefixes.isEmpty();
      for (String p : prefixes) { if (p.equals("<default>") || p.equals("<nopkg>")) { if (!cls.contains(".")) { match = true; break; } } else if (pkg.startsWith(p)) { match = true; break; } }
      if (!match) { skip++; continue; }
      try {
        String code = c.getCode();
        Path f = root.resolve("sources").resolve(cls + ".java");
        Files.createDirectories(f.getParent());
        Files.writeString(f, code, StandardCharsets.UTF_8);
        ok++;
      } catch (Throwable t) {
        Path f = root.resolve("errors").resolve(cls + ".txt");
        Files.createDirectories(f.getParent());
        Files.writeString(f, String.valueOf(t), StandardCharsets.UTF_8);
        fail++;
      }
    }
    System.out.println("decompiled=" + ok + " failed=" + fail + " skipped=" + skip);
  }
}
