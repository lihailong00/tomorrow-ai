package com.tomorrowai.gradle;

import com.android.build.api.instrumentation.AsmClassVisitorFactory;
import com.android.build.api.instrumentation.ClassContext;
import com.android.build.api.instrumentation.ClassData;
import com.android.build.api.instrumentation.InstrumentationParameters;
import org.objectweb.asm.ClassVisitor;

public abstract class ReactNativeFontScaleVisitorFactory
    implements AsmClassVisitorFactory<InstrumentationParameters.None> {
  @Override
  public boolean isInstrumentable(ClassData classData) {
    return ReactNativeFontScalePatch.isTargetClass(classData.getClassName());
  }

  @Override
  public ClassVisitor createClassVisitor(ClassContext context, ClassVisitor next) {
    return new ReactNativeFontScalePatch(next);
  }
}
