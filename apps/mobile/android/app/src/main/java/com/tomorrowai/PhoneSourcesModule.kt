package com.tomorrowai

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException

/** Permission UI and paged access to the complete, encrypted, local system-source cache. */
class PhoneSourcesModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val requested = context.getSharedPreferences("tada_phone_permission_requests", 0)
  private var pending: Promise? = null
  @Volatile private var closed = false
  private val handler = Handler(Looper.getMainLooper())
  private val observers = ConcurrentHashMap<String, Pair<String, ContentObserver>>()
  private val pendingChanges = mutableMapOf<String, Runnable>()
  override fun getName() = "TadaPhoneSources"

  private fun permissions(source: String) = PhoneSourceReader.permissions(source)
  private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  private fun state(source: String): String {
    val list = permissions(source)
    if (granted(list.first())) return "granted"
    if (source == "photos" && Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "limited"
    val activity = context.currentActivity
    return if (requested.getBoolean(source, false) && activity != null && !activity.shouldShowRequestPermissionRationale(list.first())) "blocked" else "requestable"
  }
  @ReactMethod fun status(promise: Promise) {
    try {
      promise.resolve(Arguments.createMap().apply {
        putMap("permissions", Arguments.createMap().apply { listOf("contacts", "calendar", "sms", "photos").forEach { putString(it, state(it)) } })
        putString("timezone", TimeZone.getDefault().id)
        putString("locale", Locale.getDefault().toLanguageTag())
      })
    } catch (_: Exception) { promise.reject("E_PHONE_STATUS", "暂时无法检查手机资料权限") }
  }
  @ReactMethod fun request(source: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
    try {
      val list = permissions(source)
      if (state(source) in listOf("granted", "limited")) { promise.resolve(state(source)); return@runOnUiThread }
      val activity = context.currentActivity as? PermissionAwareActivity
        ?: throw IllegalStateException("请在应用前台授权")
      check(pending == null) { "请先完成当前授权" }
      pending = promise
      requested.edit().putBoolean(source, true).apply()
      activity.requestPermissions(list, 3781, PermissionListener { code, _, _ ->
        if (code != 3781) false else {
          val receiver = pending
          pending = null
          if (!closed) receiver?.resolve(state(source))
          true
        }
      })
    } catch (_: Exception) {
      if (pending === promise) pending = null
      promise.reject("E_PHONE_PERMISSION", "无法打开授权，请完成当前授权或在系统应用权限中检查")
    }
  }
  }
  @ReactMethod fun fingerprint(text: String, promise: Promise) {
    if (text.length > 20000) { promise.reject("E_PHONE_SIZE", "所选资料过长，请减少选择"); return }
    promise.resolve(PhoneSourcePolicy.digest(text))
  }
  @ReactMethod fun read(source: String, withContactNames: Boolean, owner: String, force: Boolean, promise: Promise) {
    background(promise) {
      permissions(source)
      check(state(source) in listOf("granted", "limited")) { "请先授权此来源" }
      val scope = PhoneSourceStore.scope(owner)
      val observationGap = observe(scope, source)
      var enqueue = false
      val result = synchronized(PhoneSourceStore.lock) {
        PhoneSourceStore(context).use { store ->
          // Android's selected-photo set can change without changing the permission name.
          // Reconcile identities, while page() independently rechecks current visibility.
          if (observationGap || (source == "photos" && state(source) == "limited")) store.markDirty(scope, source)
          enqueue = store.start(scope, source, force)
          store.page(scope, source, 0, withContactNames)
        }
      }
      if (enqueue) PhoneSourceStore.enqueue(context, scope, source)
      result.toString()
    }
  }
  @ReactMethod fun page(source: String, owner: String, cursor: String, withContactNames: Boolean, promise: Promise) {
    background(promise) {
      permissions(source)
      val after = cursor.toLongOrNull()?.takeIf { it >= 0 } ?: throw IllegalArgumentException("资料游标无效")
      synchronized(PhoneSourceStore.lock) {
        PhoneSourceStore(context).use { it.page(PhoneSourceStore.scope(owner), source, after, withContactNames).toString() }
      }
    }
  }
  @ReactMethod fun record(source: String, owner: String, id: String, promise: Promise) {
    background(promise) {
      permissions(source)
      check(state(source) in listOf("granted", "limited")) { "权限已收回，请重新授权" }
      val recordId = id.removePrefix("$source-").toLongOrNull() ?: throw IllegalArgumentException("记录标识无效")
      if (source == "photos") {
        context.contentResolver.query(ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, recordId),
          arrayOf("_id"), null, null, null)?.use { check(it.moveToFirst()) { "此照片已不在授权范围内" } }
          ?: throw IllegalStateException("无法读取此照片")
      }
      synchronized(PhoneSourceStore.lock) {
        PhoneSourceStore(context).use { it.record(PhoneSourceStore.scope(owner), source, recordId).toString() }
      }
    }
  }
  @ReactMethod fun stop(source: String, owner: String, promise: Promise) {
    background(promise) {
      permissions(source)
      unobserve(source)
      synchronized(PhoneSourceStore.lock) {
        PhoneSourceStore(context).use { it.stop(PhoneSourceStore.scope(owner), source) }
      }
      true
    }
  }
  @ReactMethod fun suspend(promise: Promise) {
    background(promise) {
      observers.keys.toList().forEach { unobserve(it) }
      synchronized(PhoneSourceStore.lock) { PhoneSourceStore(context).use { it.suspendAll() } }
      true
    }
  }
  /** Notifications are debounced per source, never per screen mount. Persist the
   * dirty receipt before scheduling work so process death cannot lose it. */
  private fun observe(scope: String, source: String): Boolean {
    if (observers[source]?.first == scope) return false
    observers.entries.filter { it.value.first != scope }.forEach { unobserve(it.key) }
    unobserve(source)
    val observer = object : ContentObserver(null) {
      override fun onChange(selfChange: Boolean, uri: Uri?) {
        if (closed) return
        synchronized(pendingChanges) {
          pendingChanges.remove(source)?.let { handler.removeCallbacks(it) }
          val update = Runnable {
            synchronized(pendingChanges) { pendingChanges.remove(source) }
            if (!closed) try { executor.execute {
              try {
                val active = synchronized(PhoneSourceStore.lock) { PhoneSourceStore(context).use { store ->
                  if (!store.active(scope, source)) false else {
                    store.markDirty(scope, source)
                    true
                  }
                } }
                if (active && !closed) {
                  PhoneSourceStore.enqueue(context, scope, source)
                  context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("TadaPhoneSourcesChanged", null)
                }
              } catch (failure: Exception) {
                Log.w("TadaPhoneSources", "change_refresh_failed type=${failure.javaClass.simpleName}")
              }
            } } catch (_: RejectedExecutionException) { /* Bridge is closing. */ }
          }
          pendingChanges[source] = update
          handler.postDelayed(update, 1500)
        }
      }
    }
    context.contentResolver.registerContentObserver(PhoneSourceReader.watchUri(source), true, observer)
    observers[source] = scope to observer
    if (closed) unobserve(source)
    return true
  }
  private fun unobserve(source: String) {
    observers.remove(source)?.let { context.contentResolver.unregisterContentObserver(it.second) }
    synchronized(pendingChanges) { pendingChanges.remove(source)?.let { handler.removeCallbacks(it) } }
  }
  private fun background(promise: Promise, action: () -> Any) {
    if (closed) { promise.reject("E_PHONE_CLOSED", "应用已关闭，请重试"); return }
    executor.execute {
      try {
        val result = action()
        if (!closed) promise.resolve(result)
      } catch (_: SecurityException) {
        if (!closed) promise.reject("E_PHONE_DENIED", "系统权限已收回，请重新授权；已保存读取进度")
      } catch (failure: Exception) {
        Log.w("TadaPhoneSources", "read_failed type=${failure.javaClass.simpleName}")
        if (!closed) promise.reject("E_PHONE_READ", failure.message ?: "未能完成读取，请重试；进度已保存")
      }
    }
  }
  override fun invalidate() {
    closed = true
    pending?.reject("E_PHONE_CLOSED", "应用已关闭，请重试"); pending = null
    executor.shutdownNow()
    // Registration/removal may overlap bridge invalidation.
    observers.values.toList().forEach { context.contentResolver.unregisterContentObserver(it.second) }
    observers.clear()
    synchronized(pendingChanges) { pendingChanges.values.forEach { handler.removeCallbacks(it) }; pendingChanges.clear() }
    super.invalidate()
  }
}
