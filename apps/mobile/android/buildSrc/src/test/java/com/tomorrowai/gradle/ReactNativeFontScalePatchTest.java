package com.tomorrowai.gradle;

import static org.junit.Assert.*;

import java.io.IOException;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.jar.JarInputStream;
import java.util.zip.ZipFile;
import org.junit.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.util.CheckClassAdapter;
import org.objectweb.asm.util.Textifier;
import org.objectweb.asm.util.TraceMethodVisitor;

public class ReactNativeFontScalePatchTest {
  private static byte[] baseline(String variant) throws IOException {
    try (ZipFile aar = new ZipFile(System.getProperty("reactNative" + variant + "Baseline"));
         JarInputStream classes = new JarInputStream(aar.getInputStream(aar.getEntry("classes.jar")))) {
      for (var entry = classes.getNextJarEntry(); entry != null; entry = classes.getNextJarEntry()) {
        if (entry.getName().equals(ReactNativeFontScalePatch.TARGET + ".class")) return classes.readAllBytes();
      }
    }
    throw new AssertionError("DisplayMetricsHolder missing from published " + variant + " AAR");
  }

  private static ClassNode read(byte[] bytes) {
    ClassNode node = new ClassNode();
    new ClassReader(bytes).accept(node, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
    return node;
  }

  private static MethodNode initializer(ClassNode node) {
    return node.methods.stream().filter(method -> method.name.equals(ReactNativeFontScalePatch.METHOD)
        && method.desc.equals(ReactNativeFontScalePatch.DESCRIPTOR)).findFirst().orElseThrow();
  }

  private static byte[] patch(byte[] bytes) {
    ClassWriter output = new ClassWriter(ClassWriter.COMPUTE_MAXS);
    new ClassReader(bytes).accept(new ReactNativeFontScalePatch(output), 0);
    return output.toByteArray();
  }

  private static byte[] write(ClassNode node) {
    ClassWriter writer = new ClassWriter(0);
    node.accept(writer);
    return writer.toByteArray();
  }

  private static String methodText(MethodNode method) {
    Textifier textifier = new Textifier();
    method.accept(new TraceMethodVisitor(textifier));
    StringWriter out = new StringWriter();
    textifier.print(new java.io.PrintWriter(out));
    return out.toString();
  }

  @Test
  public void publishedDebugAndReleaseAarsReceiveOnlyTheUpstreamRestoration() throws Exception {
    for (String variant : List.of("Debug", "Release")) {
      byte[] original = baseline(variant);
      ClassNode before = read(original);
      assertEquals(ReactNativeFontScalePatch.ORIGINAL_FINGERPRINT,
          ReactNativeFontScalePatch.fingerprint(initializer(before)));
      byte[] transformed = patch(original);
      ClassNode after = read(transformed);
      assertEquals(before.methods.size(), after.methods.size());
      assertEquals(before.fields.size(), after.fields.size());
      for (int index = 0; index < before.methods.size(); index++) {
        MethodNode oldMethod = before.methods.get(index);
        MethodNode newMethod = after.methods.get(index);
        if (!oldMethod.name.equals(ReactNativeFontScalePatch.METHOD)) {
          assertEquals("Unrelated method changed: " + oldMethod.name, methodText(oldMethod), methodText(newMethod));
        }
      }
      MethodNode method = initializer(after);
      List<AbstractInsnNode> instructions = new ArrayList<>();
      for (AbstractInsnNode instruction : method.instructions) if (instruction.getOpcode() >= 0) instructions.add(instruction);
      int end = instructions.size();
      assertEquals(Opcodes.RETURN, instructions.get(end - 1).getOpcode());
      FieldInsnNode write = (FieldInsnNode) instructions.get(end - 2);
      assertEquals(Opcodes.PUTFIELD, write.getOpcode());
      assertEquals("android/util/DisplayMetrics", write.owner);
      assertEquals("scaledDensity", write.name);
      FieldInsnNode read = (FieldInsnNode) instructions.get(end - 3);
      assertEquals(Opcodes.GETFIELD, read.getOpcode());
      assertEquals("scaledDensity", read.name);
      assertEquals("getWindowDisplayMetrics", ((MethodInsnNode) instructions.get(end - 4)).name);
      assertEquals("getScreenDisplayMetrics", ((MethodInsnNode) instructions.get(end - 5)).name);
      // Removing the four inserted instructions must recover the entire original method.
      for (int index = end - 5; index <= end - 2; index++) method.instructions.remove(instructions.get(index));
      assertEquals(ReactNativeFontScalePatch.ORIGINAL_FINGERPRINT, ReactNativeFontScalePatch.fingerprint(method));
      // Structural verification catches stack/local/frame problems without Android JVM classes.
      new ClassReader(transformed).accept(new CheckClassAdapter(new ClassWriter(0)), 0);
    }
  }

  @Test
  public void onlyTheExactDependencyClassIsSelected() {
    assertTrue(ReactNativeFontScalePatch.isTargetClass("com.facebook.react.uimanager.DisplayMetricsHolder"));
    assertFalse(ReactNativeFontScalePatch.isTargetClass("com.facebook.react.uimanager.PixelUtil"));
    assertFalse(ReactNativeFontScalePatch.isTargetClass("com.tomorrowai.MainActivity"));
    assertFalse(ReactNativeFontScalePatch.isTargetClass("com.facebook.react.uimanager.DisplayMetricsHolderExtra"));
  }

  @Test
  public void dependencyUpgradeRequiresAnExplicitReview() {
    ReactNativeFontScalePatch.requireSupportedVersion("0.82.1");
    assertThrows(IllegalStateException.class, () -> ReactNativeFontScalePatch.requireSupportedVersion("0.83.0"));
    assertThrows(IllegalStateException.class, () -> ReactNativeFontScalePatch.requireSupportedVersion("0.82.2"));
  }

  @Test
  public void alteredInstructionsAreRejected() throws Exception {
    ClassNode changed = read(baseline("Debug"));
    initializer(changed).instructions.insert(new InsnNode(Opcodes.NOP));
    assertThrows(IllegalStateException.class, () -> patch(write(changed)));
  }

  @Test
  public void missingOrChangedSignatureIsRejected() throws Exception {
    ClassNode changed = read(baseline("Debug"));
    initializer(changed).desc = "(Landroid/content/Context;Z)V";
    assertThrows(IllegalStateException.class, () -> patch(write(changed)));
  }

  @Test
  public void applyingTheBackportTwiceIsRejected() throws Exception {
    byte[] alreadyPatched = patch(baseline("Debug"));
    assertThrows(IllegalStateException.class, () -> patch(alreadyPatched));
  }

  @Test
  public void visitorCannotSilentlyTransformAnotherClass() throws Exception {
    ClassNode changed = read(baseline("Debug"));
    changed.name = "com/tomorrowai/Unrelated";
    assertThrows(IllegalStateException.class, () -> patch(write(changed)));
  }
}
