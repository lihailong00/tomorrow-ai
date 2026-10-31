package com.tomorrowai

import com.facebook.react.bridge.ReactMethod
import org.junit.Assert.*
import org.junit.Test

class PhoneSourcesBridgeTest {
  @Test fun asyncBridgeMethodsHaveJvmVoidReturnType() {
    val methods = PhoneSourcesModule::class.java.declaredMethods.filter { it.getAnnotation(ReactMethod::class.java) != null }
    assertEquals(setOf("status", "request", "read", "fingerprint"), methods.map { it.name }.toSet())
    for (method in methods) {
      assertEquals("${method.name} must return JVM void for TurboModule interop", Void.TYPE, method.returnType)
    }
  }
}
