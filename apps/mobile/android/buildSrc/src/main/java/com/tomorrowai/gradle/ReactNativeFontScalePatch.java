package com.tomorrowai.gradle;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.tree.AbstractInsnNode;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.FieldInsnNode;
import org.objectweb.asm.tree.InsnList;
import org.objectweb.asm.tree.InsnNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.objectweb.asm.tree.MethodInsnNode;
import org.objectweb.asm.tree.MethodNode;
import org.objectweb.asm.tree.TypeInsnNode;
import org.objectweb.asm.tree.VarInsnNode;

/**
 * Backports RN 642f086 to the prebuilt 0.82.1 AAR. Keeping this in the initializer
 * makes every React root, orientation change and font configuration refresh safe.
 * Remove this backport when upgrading to a release that contains the upstream fix.
 * https://github.com/react/react-native/commit/642f086b8ce4088d7f0b3c6453e2bb8c5f75e41b
 */
public final class ReactNativeFontScalePatch extends ClassNode {
  public static final String VERSION = "0.82.1";
  public static final String TARGET = "com/facebook/react/uimanager/DisplayMetricsHolder";
  public static final String METHOD = "initDisplayMetrics";
  public static final String DESCRIPTOR = "(Landroid/content/Context;)V";
  // Instruction fingerprint excludes line numbers/frames and covers the complete
  // original method, including calls, constants, field accesses and local slots.
  static final String ORIGINAL_FINGERPRINT =
      "b5fdd2ea55382cbcc431775426fbf09505ef8ed705ff56308ff0c203ca20791b";
  private static final String METRICS = "Landroid/util/DisplayMetrics;";
  private final ClassVisitor downstream;

  public ReactNativeFontScalePatch(ClassVisitor downstream) {
    super(Opcodes.ASM9);
    this.downstream = downstream;
  }

  public static boolean isTargetClass(String name) {
    return TARGET.replace('/', '.').equals(name);
  }

  public static void requireSupportedVersion(String version) {
    if (!VERSION.equals(version)) {
      throw new IllegalStateException("Review/remove the RN font scale backport before using RN " + version);
    }
  }

  @Override
  public void visitEnd() {
    super.visitEnd();
    if (!TARGET.equals(name)) {
      throw new IllegalStateException("Font scale backport received an unexpected class: " + name);
    }
    MethodNode initializer = null;
    for (MethodNode method : methods) {
      if (METHOD.equals(method.name) && DESCRIPTOR.equals(method.desc)) {
        if (initializer != null) throw unexpected();
        initializer = method;
      }
    }
    if (initializer == null || initializer.access != (Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC | Opcodes.ACC_FINAL)
        || !initializer.tryCatchBlocks.isEmpty()
        || !ORIGINAL_FINGERPRINT.equals(fingerprint(initializer))) {
      throw unexpected();
    }
    AbstractInsnNode methodReturn = initializer.instructions.getLast();
    while (methodReturn != null && methodReturn.getOpcode() < 0) methodReturn = methodReturn.getPrevious();
    if (methodReturn == null || methodReturn.getOpcode() != Opcodes.RETURN) throw unexpected();

    // Exact upstream operation: screenMetrics.scaledDensity = resourceMetrics.scaledDensity.
    // The getters expose the same objects the initializer just stored. Do not
    // multiply font sizes or replace metrics: API 34+ keeps its nonlinear converter.
    InsnList restoration = new InsnList();
    restoration.add(new MethodInsnNode(Opcodes.INVOKESTATIC, TARGET, "getScreenDisplayMetrics", "()" + METRICS, false));
    restoration.add(new MethodInsnNode(Opcodes.INVOKESTATIC, TARGET, "getWindowDisplayMetrics", "()" + METRICS, false));
    restoration.add(new FieldInsnNode(Opcodes.GETFIELD, "android/util/DisplayMetrics", "scaledDensity", "F"));
    restoration.add(new FieldInsnNode(Opcodes.PUTFIELD, "android/util/DisplayMetrics", "scaledDensity", "F"));
    initializer.instructions.insertBefore(methodReturn, restoration);
    accept(downstream);
  }

  private static IllegalStateException unexpected() {
    return new IllegalStateException("RN 0.82.1 DisplayMetricsHolder initializer changed or is already patched; review the font scale backport");
  }

  static String fingerprint(MethodNode method) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
          .digest(normalizedInstructions(method).getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new AssertionError(impossible);
    }
  }

  static String normalizedInstructions(MethodNode method) {
    StringBuilder result = new StringBuilder();
    for (AbstractInsnNode instruction : method.instructions) {
      int opcode = instruction.getOpcode();
      if (opcode < 0) continue;
      result.append(opcode);
      if (instruction instanceof VarInsnNode variable) {
        result.append(':').append(variable.var);
      } else if (instruction instanceof TypeInsnNode type) {
        result.append(':').append(type.desc);
      } else if (instruction instanceof FieldInsnNode field) {
        result.append(':').append(field.owner).append(':').append(field.name).append(':').append(field.desc);
      } else if (instruction instanceof MethodInsnNode call) {
        result.append(':').append(call.owner).append(':').append(call.name).append(':').append(call.desc).append(':').append(call.itf);
      } else if (instruction instanceof LdcInsnNode constant) {
        result.append(':').append(constant.cst);
      } else if (!(instruction instanceof InsnNode)) {
        throw unexpected();
      }
      result.append('\n');
    }
    return result.toString();
  }
}
