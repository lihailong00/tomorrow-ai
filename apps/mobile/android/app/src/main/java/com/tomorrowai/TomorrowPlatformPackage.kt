package com.tomorrowai

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TomorrowPlatformPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(TomorrowPlatformModule(context), PhotoIndexModule(context), AppInputsModule(context), HealthDataModule(context), PhoneSourcesModule(context), PrivateVaultModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
