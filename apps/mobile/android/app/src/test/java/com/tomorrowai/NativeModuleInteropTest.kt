package com.tomorrowai

import com.facebook.react.bridge.ReactMethod
import org.junit.Assert.*
import org.junit.Test

class NativeModuleInteropTest {
  @Test fun asynchronousBridgeMethodsReturnVoidForTurboModuleInterop() {
    val modules = listOf(PhoneAlarmsModule::class.java, PhoneCalendarModule::class.java, PhotoIndexModule::class.java,
      TomorrowPlatformModule::class.java, AppInputsModule::class.java, AppPermissionInspectionModule::class.java)
    for (module in modules) {
      val methods = module.declaredMethods.filter { it.getAnnotation(ReactMethod::class.java) != null }
      assertTrue("${module.simpleName} must expose bridge methods", methods.isNotEmpty())
      for (method in methods) {
        if (!method.getAnnotation(ReactMethod::class.java)!!.isBlockingSynchronousMethod) {
          assertEquals("${module.simpleName}.${method.name} must return void for asynchronous interop", Void.TYPE, method.returnType)
        }
      }
    }
  }
}
