package com.tomorrowai

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.OkHttpClientFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      useDevSupport = BuildConfig.DEBUG && !BuildConfig.OFFLINE_BUNDLE,
      packageList =
        PackageList(this).packages.apply {
          add(TomorrowPlatformPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // React Native's Android fetch ignores RequestInit.redirect. Disable native
    // redirects as well, so credentials cannot follow a moved server endpoint.
    OkHttpClientProvider.setOkHttpClientFactory(OkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    })
    loadReactNative(this)
  }
}
