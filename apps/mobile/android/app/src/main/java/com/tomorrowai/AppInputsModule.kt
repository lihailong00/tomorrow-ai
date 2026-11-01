package com.tomorrowai

import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.*
import org.json.JSONObject

class AppInputsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "TadaAppInputs"

  @ReactMethod fun getStatus(promise: Promise) = run(promise) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    Arguments.createMap().apply {
      putBoolean("supported", true)
      putBoolean("notification_access", manager.isNotificationListenerAccessGranted(ComponentName(context, AppNotificationListener::class.java)))
      putArray("selected_apps", Arguments.fromList(AppInputStore.selected(context).toList()))
      putArray("installed_apps", Arguments.fromList(AppInputStore.packages.filter { (_, packages) ->
        packages.any { packageName -> context.packageManager.getLaunchIntentForPackage(packageName) != null }
      }.keys.toList()))
      putInt("pending_count", AppInputStore.list(context).size)
    }
  }

  @ReactMethod fun setApps(ids: ReadableArray, promise: Promise) = run(promise) {
    require(ids.size() <= AppInputStore.packages.size) { "应用选择过多" }
    AppInputStore.setSelected(context, (0 until ids.size()).map { requireNotNull(ids.getString(it)) }.toSet())
    null
  }

  @ReactMethod fun openNotificationSettings(promise: Promise) = run(promise) {
    context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    null
  }

  @ReactMethod fun listPending(promise: Promise) = run(promise) {
    Arguments.createArray().apply { AppInputStore.list(context).forEach { pushMap(jsonMap(it)) } }
  }

  @ReactMethod fun dismiss(ids: ReadableArray, promise: Promise) = run(promise) {
    require(ids.size() <= 100) { "资料数量过多" }
    AppInputStore.dismiss(context, (0 until ids.size()).map { requireNotNull(ids.getString(it)) }.toSet())
    null
  }

  @ReactMethod fun clear(promise: Promise) = run(promise) { AppInputStore.clear(context); null }

  @ReactMethod fun openApp(id: String, promise: Promise) = run(promise) {
    val packages = AppInputStore.packages[id] ?: throw IllegalArgumentException("未知应用")
    val intent = packages.firstNotNullOfOrNull { context.packageManager.getLaunchIntentForPackage(it) }
    if (intent == null) false else {
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    }
  }

  private fun run(promise: Promise, operation: () -> Any?) {
    try { promise.resolve(operation()) }
    catch (_: Exception) { promise.reject("E_APP_INPUTS", "无法完成本机应用操作，请在前台重试") }
  }

  private fun jsonMap(value: JSONObject): WritableMap = Arguments.createMap().apply {
    value.keys().forEach { key -> when (val entry = value.get(key)) {
      is JSONObject -> putMap(key, jsonMap(entry))
      is String -> putString(key, entry)
      is Boolean -> putBoolean(key, entry)
      is Number -> putDouble(key, entry.toDouble())
    } }
  }
}
