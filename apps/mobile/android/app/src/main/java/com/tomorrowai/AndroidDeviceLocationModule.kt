package com.tomorrowai

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.*
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executor

/** User-requested foreground one-shot; no GMS, background service or stored coordinates. */
class AndroidDeviceLocationModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
  private val main = Handler(Looper.getMainLooper())
  private val requested = context.getSharedPreferences("tada_location_permission", Context.MODE_PRIVATE)
  private var pending: FixRequest? = null
  private var permissionInFlight = false
  private var permissionOwner: FixRequest? = null
  @Volatile private var closed = false
  private class FixRequest(val id: String, val promise: Promise) {
    var phase = "permission"
    var timeout: Runnable? = null
    var cached: Location? = null
    val signals = mutableListOf<CancellationSignal>()
    val listeners = mutableListOf<LocationListener>()
    val activeProviders = mutableSetOf<String>()
  }
  init { context.addLifecycleEventListener(this) }
  override fun getName() = "TadaDeviceLocation"
  private fun onUi(action: () -> Unit) { UiThreadUtil.runOnUiThread { action() } }
  private fun granted(name: String) = context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED
  private fun foreground() = context.currentActivity?.let { !it.isFinishing && !it.isDestroyed } == true && context.lifecycleState == LifecycleState.RESUMED
  private fun permission(): String {
    val activity = context.currentActivity
    return DeviceLocationPolicy.permission(granted(Manifest.permission.ACCESS_FINE_LOCATION), granted(Manifest.permission.ACCESS_COARSE_LOCATION),
      requested.getBoolean("requested", false), activity?.let { it.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION) || it.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) } ?: false, activity != null)
  }
  private fun services(): Boolean = try {
    if (Build.VERSION.SDK_INT >= 28) manager?.isLocationEnabled == true
    else manager?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true || manager?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true
  } catch (_: Exception) { false }

  @ReactMethod fun status(promise: Promise) { onUi {
    promise.resolve(Arguments.createMap().apply {
      putBoolean("supported", !closed && manager != null)
      putString("permission", permission())
      putString("accuracy", DeviceLocationPolicy.accuracy(granted(Manifest.permission.ACCESS_FINE_LOCATION), granted(Manifest.permission.ACCESS_COARSE_LOCATION)))
      putBoolean("services_enabled", services())
    })
  } }
  @ReactMethod fun requestCurrentLocation(requestId: String, promise: Promise) { onUi {
    if (closed || manager == null) { promise.reject("E_LOCATION_UNSUPPORTED", "此设备暂不支持系统定位，请手动选择地点"); return@onUi }
    if (!foreground()) { promise.reject("E_LOCATION_NO_ACTIVITY", "请在应用前台获取位置"); return@onUi }
    if (requestId.length !in 1..96 || !requestId.all { it.isLetterOrDigit() || it == '-' }) { promise.reject("E_LOCATION_INVALID", "定位请求无效"); return@onUi }
    if (pending != null || permissionInFlight) { promise.reject("E_LOCATION_BUSY", "请先完成当前定位或权限选择"); return@onUi }
    if (!services()) { promise.reject("E_LOCATION_SERVICES_DISABLED", "系统定位服务已关闭，请开启后重试或手动选择地点"); return@onUi }
    val request = FixRequest(requestId, promise); pending = request
    if (permission() == "granted") { sample(request); return@onUi }
    if (permission() == "blocked") { fail(request, "E_LOCATION_PERMISSION_BLOCKED", "定位权限未开放，请在系统设置中允许或手动选择地点"); return@onUi }
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) { fail(request, "E_LOCATION_NO_ACTIVITY", "请在应用前台申请定位权限"); return@onUi }
    try {
      permissionInFlight = true
      permissionOwner = request
      requested.edit().putBoolean("requested", true).apply()
      activity.requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), 4937,
        PermissionListener { code, _, _ ->
          if (code != 4937) false else {
            onUi {
              if (permissionOwner === request) { permissionInFlight = false; permissionOwner = null }
              if (pending === request && !closed) {
                when (permission()) {
                  "granted" -> { request.phase = "resume"; if (foreground()) sample(request) }
                  "blocked" -> fail(request, "E_LOCATION_PERMISSION_BLOCKED", "定位权限未开放，请在系统设置中允许或手动选择地点")
                  else -> fail(request, "E_LOCATION_PERMISSION_DENIED", "未允许定位，可重试或手动选择地点")
                }
              }
            }
            true
          }
        })
    } catch (_: Exception) { permissionInFlight = false; permissionOwner = null; fail(request, "E_LOCATION_UNAVAILABLE", "暂时无法申请定位权限，请手动选择地点或稍后再试") }
  } }
  @Suppress("DEPRECATION", "MissingPermission")
  private fun sample(request: FixRequest) {
    if (pending !== request || closed) return
    if (!foreground()) { fail(request, "E_LOCATION_CANCELLED", "应用已离开前台，定位已取消"); return }
    if (permission() != "granted") { fail(request, "E_LOCATION_PERMISSION_DENIED", "定位权限已收回"); return }
    if (!services()) { fail(request, "E_LOCATION_SERVICES_DISABLED", "系统定位服务已关闭"); return }
    val locationManager = manager ?: return
    request.phase = "sampling"
    val providers = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { provider ->
      try { locationManager.allProviders.contains(provider) && locationManager.isProviderEnabled(provider) } catch (_: Exception) { false }
    }
    if (providers.isEmpty()) { fail(request, "E_LOCATION_UNAVAILABLE", "没有可用的系统定位来源，请手动选择地点"); return }
    request.activeProviders.addAll(providers)
    for (provider in providers) {
      try {
        val cached = locationManager.getLastKnownLocation(provider)
        if (cached != null && valid(cached)) {
          if (request.cached == null || cached.elapsedRealtimeNanos > request.cached!!.elapsedRealtimeNanos) request.cached = Location(cached)
        }
      } catch (_: Exception) { /* A provider failure is not a zero location. */ }
    }
    request.timeout = Runnable { fallback(request) }.also { main.postDelayed(it, DeviceLocationPolicy.TIMEOUT_MS) }
    val executor = Executor { task -> main.post(task) }
    for (provider in providers) {
      try {
        if (Build.VERSION.SDK_INT >= 30) {
          val signal = CancellationSignal(); request.signals.add(signal)
          locationManager.getCurrentLocation(provider, signal, executor) { location -> receive(request, provider, location) }
        } else {
          val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) { receive(request, provider, location) }
            override fun onProviderDisabled(name: String) { receive(request, provider, null) }
            override fun onProviderEnabled(name: String) = Unit
            override fun onStatusChanged(name: String?, status: Int, extras: Bundle?) = Unit
          }
          request.listeners.add(listener)
          locationManager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
        }
      } catch (_: SecurityException) { request.activeProviders.remove(provider) }
      catch (_: Exception) { request.activeProviders.remove(provider) }
    }
    if (request.activeProviders.isEmpty()) fallback(request)
  }
  private fun valid(location: Location) = location.hasAccuracy() && location.time > 0 &&
    DeviceLocationPolicy.validCoordinates(location.latitude, location.longitude, location.accuracy.toDouble()) &&
    DeviceLocationPolicy.ageMillis(location.elapsedRealtimeNanos, SystemClock.elapsedRealtimeNanos()) != null
  private fun receive(request: FixRequest, provider: String, location: Location?) {
    if (pending !== request || closed) return
    if (!foreground()) { fail(request, "E_LOCATION_CANCELLED", "应用已离开前台，定位已取消"); return }
    if (permission() != "granted") { fail(request, "E_LOCATION_PERMISSION_DENIED", "定位权限已收回"); return }
    if (!services()) { fail(request, "E_LOCATION_SERVICES_DISABLED", "系统定位服务已关闭"); return }
    if (location != null && valid(location)) { succeed(request, location, "current"); return }
    request.activeProviders.remove(provider)
    if (request.activeProviders.isEmpty()) fallback(request)
  }
  private fun fallback(request: FixRequest) {
    if (pending !== request) return
    if (!foreground()) { fail(request, "E_LOCATION_CANCELLED", "应用已离开前台，定位已取消"); return }
    if (!services()) { fail(request, "E_LOCATION_SERVICES_DISABLED", "系统定位服务已关闭"); return }
    if (permission() != "granted") { fail(request, "E_LOCATION_PERMISSION_DENIED", "定位权限已收回"); return }
    val cached = request.cached
    if (cached != null && valid(cached)) succeed(request, cached, "last_known")
    else fail(request, "E_LOCATION_TIMEOUT", "8 秒内未取得有效位置，请到开阔处重试或手动选择地点")
  }
  private fun cleanup(request: FixRequest) {
    request.timeout?.let { main.removeCallbacks(it) }; request.timeout = null
    request.signals.forEach { it.cancel() }; request.signals.clear()
    request.listeners.forEach { try { manager?.removeUpdates(it) } catch (_: Exception) {} }; request.listeners.clear()
    request.activeProviders.clear(); request.cached = null
  }
  private fun fail(request: FixRequest, code: String, message: String) {
    if (pending !== request) return
    pending = null; cleanup(request); request.promise.reject(code, message)
  }
  private fun succeed(request: FixRequest, location: Location, source: String) {
    if (pending !== request) return
    val age = DeviceLocationPolicy.ageMillis(location.elapsedRealtimeNanos, SystemClock.elapsedRealtimeNanos()) ?: return fallback(request)
    val observedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(location.time))
    val result = Arguments.createMap().apply {
      putDouble("latitude", location.latitude); putDouble("longitude", location.longitude); putDouble("accuracy_m", location.accuracy.toDouble())
      putString("observed_at", observedAt); putString("coordinate_system", "wgs84"); putString("source", source)
      putDouble("age_ms", age.toDouble()); putBoolean("stale", DeviceLocationPolicy.stale(source, age))
    }
    pending = null; cleanup(request); request.promise.resolve(result)
  }
  @ReactMethod fun cancelCurrentLocation(requestId: String, promise: Promise) { onUi {
    pending?.takeIf { it.id == requestId }?.let { fail(it, "E_LOCATION_CANCELLED", "定位已取消") }; promise.resolve(null)
  } }
  private fun settings(action: String, promise: Promise) { onUi {
    try {
      val intent = if (action == Settings.ACTION_APPLICATION_DETAILS_SETTINGS) Intent(action, Uri.parse("package:${context.packageName}")) else Intent(action)
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); promise.resolve(null)
    } catch (_: Exception) { promise.reject("E_LOCATION_UNAVAILABLE", "无法打开系统定位设置，请手动前往设置") }
  } }
  @ReactMethod fun openAppSettings(promise: Promise) { settings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, promise) }
  @ReactMethod fun openLocationSettings(promise: Promise) { settings(Settings.ACTION_LOCATION_SOURCE_SETTINGS, promise) }
  override fun onHostResume() { onUi { pending?.takeIf { it.phase == "resume" }?.let { sample(it) } } }
  override fun onHostPause() { onUi {
    // Permission sheets can pause Android's host. No listeners/timers exist
    // during that phase, and provider access waits for RESUMED after granting.
    pending?.takeIf { it.phase == "sampling" }?.let { fail(it, "E_LOCATION_CANCELLED", "应用已离开前台，定位已取消") }
  } }
  override fun onHostDestroy() { onUi { permissionInFlight = false; permissionOwner = null; pending?.let { fail(it, "E_LOCATION_CANCELLED", "应用页面已关闭，定位已取消") } } }
  override fun invalidate() {
    closed = true
    onUi { permissionInFlight = false; permissionOwner = null; pending?.let { fail(it, "E_LOCATION_CANCELLED", "定位模块已关闭") }; context.removeLifecycleEventListener(this) }
    super.invalidate()
  }
}
