# DWARFLAB APK recovery pipeline — step 1 of 6, run in order. Inputs:
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
# Run the REA-bundled baksmali, or: java -cp baksmali.jar org.jf.dexlib2.dexdump
import jadx.api.JadxArgs;
import jadx.api.JadxDecompiler;
import jadx.api.JavaClass;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** Dump raw smali for exact constant values that the Java renderer replaces with inlined constants. */
public class SmaliDump {
  public static void main(String[] argv) throws Exception {
    String apk = argv[0];
    String outDir = argv[1];
    List<String> want = new ArrayList<>();
    for (int i = 2; i < argv.length; i++) want.add(argv[i]);

    JadxArgs args = new JadxArgs();
    args.setInputFile(new File(apk));
    args.setOutDir(new File(outDir + "/out"));
    args.setSkipResources(true);
    JadxDecompiler d = new JadxDecompiler(args);
    d.load();
    for (JavaClass c : d.getClasses()) {
      String raw = c.getRawName();
      if (!want.contains(raw)) continue;
      String smali = c.getSmali();
      File f = new File(outDir + "/smali/" + raw + ".smali");
      f.getParentFile().mkdirs();
      Files.writeString(f.toPath(), smali, StandardCharsets.UTF_8);
      System.out.println("wrote " + f + " " + smali.length() + " chars");
    }
  }
}
