package com.tomorrowai

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Telephony
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/** Foreground, bounded, read-only system sources. No network, background observer or content storage. */
class PhoneSourcesModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private val requested = context.getSharedPreferences("tada_phone_permission_requests", 0)
  private var pending: Promise? = null
  @Volatile private var closed = false
  override fun getName() = "TadaPhoneSources"

  private fun permissions(source: String): Array<String> = when (source) {
    "contacts" -> arrayOf(Manifest.permission.READ_CONTACTS)
    "calendar" -> arrayOf(Manifest.permission.READ_CALENDAR)
    "sms" -> arrayOf(Manifest.permission.READ_SMS)
    "photos" -> if (Build.VERSION.SDK_INT >= 34) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
      else if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
      else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    else -> throw IllegalArgumentException("未知手机资料来源")
  }
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
  @ReactMethod fun read(source: String, withContactNames: Boolean, promise: Promise) {
    try { permissions(source) } catch (_: Exception) { promise.reject("E_PHONE_SOURCE", "未知手机资料来源"); return }
    if (closed) { promise.reject("E_PHONE_CLOSED", "页面已关闭，请重试"); return }
    executor.execute {
      try {
        check(state(source) in listOf("granted", "limited")) { "请先授权此来源" }
        val now = System.currentTimeMillis()
        val items = when (source) {
          "contacts" -> contacts()
          "calendar" -> calendar(now)
          "sms" -> sms(now, withContactNames)
          else -> photos()
        }
        if (!closed) promise.resolve(Arguments.createMap().apply {
          putString("source", source); putDouble("readAt", now.toDouble())
          putString("permission", state(source)); putBoolean("limited", items.size >= PhoneSourcePolicy.limit(source))
          putArray("items", Arguments.makeNativeArray(items))
        })
      } catch (_: SecurityException) {
        if (!closed) promise.reject("E_PHONE_DENIED", "系统未允许读取此资料，可能权限已收回或受系统限制；其他来源仍可使用")
      } catch (failure: Exception) {
        Log.w("TadaPhoneSources", "source=$source read_failed type=${failure.javaClass.simpleName}")
        if (!closed) promise.reject("E_PHONE_READ", "暂时未能完成此来源的读取，请重试；其他来源仍可使用")
      }
    }
  }
  private fun contacts(): List<Map<String, Any>> {
    val items = mutableListOf<Map<String, Any>>()
    context.contentResolver.query(ContactsContract.Contacts.CONTENT_URI,
      arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
      null, null, ContactsContract.Contacts.SORT_KEY_PRIMARY + " ASC")?.use { cursor ->
      while (items.size < PhoneSourcePolicy.limit("contacts") && cursor.moveToNext()) {
        val name = cursor.getString(1).orEmpty().trim().take(120)
        items.add(mapOf("id" to "contact-${cursor.getLong(0)}", "title" to name.ifBlank { "未命名联系人" }, "text" to "仅在本机显示，不上传通讯录"))
      }
    } ?: throw IllegalStateException("联系人数据源不可用")
    return items
  }
  private fun calendar(now: Long): List<Map<String, Any>> {
    val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().apply {
      ContentUris.appendId(this, now); ContentUris.appendId(this, now + 30L * 86400000)
    }.build()
    val items = mutableListOf<Map<String, Any>>()
    context.contentResolver.query(uri, arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.BEGIN,
      CalendarContract.Instances.END, CalendarContract.Instances.TITLE, CalendarContract.Instances.DESCRIPTION,
      CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.ALL_DAY),
      CalendarContract.Instances.VISIBLE + "=1 AND (" + CalendarContract.Instances.STATUS + " IS NULL OR " + CalendarContract.Instances.STATUS + "!=2)", null,
      CalendarContract.Instances.BEGIN + " ASC")?.use { cursor ->
      var scanned = 0
      while (items.size < PhoneSourcePolicy.limit("calendar") && scanned++ < 500 && cursor.moveToNext()) {
        val rawTitle = cursor.getString(3).orEmpty().trim()
        val description = cursor.getString(4).orEmpty()
        val location = cursor.getString(5).orEmpty()
        val title = rawTitle.take(200)
        if (title.isBlank() || cursor.getLong(2) < now) continue
        val body = listOf(description.take(1800), location.take(200)).filter { it.isNotBlank() }.joinToString("\n")
        val begin = cursor.getLong(1)
        items.add(mapOf("id" to "calendar-${cursor.getLong(0)}-$begin-${PhoneSourcePolicy.digest(title + body).take(16)}",
          "title" to title, "text" to body, "timestamp" to begin.toDouble(), "end" to cursor.getLong(2).toDouble(), "allDay" to (cursor.getInt(6) != 0),
          "truncated" to (rawTitle.length > 200 || description.length > 1800 || location.length > 200)))
      }
    } ?: throw IllegalStateException("日历数据源不可用")
    return items
  }
  private fun names(): Map<String, String> {
    val result = mutableMapOf<String, String>()
    if (!granted(Manifest.permission.READ_CONTACTS)) return result
    context.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME), null, null, null)?.use { cursor ->
      var scanned = 0
      while (scanned++ < 2000 && cursor.moveToNext()) {
        result[PhoneSourcePolicy.normalizeNumber(cursor.getString(0).orEmpty())] = cursor.getString(1).orEmpty().take(120)
      }
    }
    return result
  }
  private fun sms(now: Long, withContactNames: Boolean): List<Map<String, Any>> {
    // A revoked/unavailable contacts provider must not block an otherwise readable inbox.
    val names = if (withContactNames) try { names() } catch (_: Exception) { emptyMap() } else emptyMap()
    val items = mutableListOf<Map<String, Any>>()
    context.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI,
      arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
      Telephony.Sms.DATE + ">=? AND " + Telephony.Sms.DATE + "<=?", arrayOf((now - 30L * 86400000).toString(), now.toString()), Telephony.Sms.DATE + " DESC")?.use { cursor ->
      var scanned = 0
      while (items.size < PhoneSourcePolicy.limit("sms") && scanned++ < 1000 && cursor.moveToNext()) {
        val raw = cursor.getString(2).orEmpty()
        if (!PhoneSourcePolicy.includeSms(raw)) continue
        val sender = cursor.getString(1).orEmpty()
        val label = names[PhoneSourcePolicy.normalizeNumber(sender)]?.takeIf { it.isNotBlank() } ?: PhoneSourcePolicy.maskNumber(sender)
        items.add(mapOf("id" to "sms-${cursor.getLong(0)}-${PhoneSourcePolicy.digest(raw).take(16)}", "title" to label.ifBlank { "短信" },
          "text" to raw.take(2000), "timestamp" to cursor.getLong(3).toDouble(), "truncated" to (raw.length > 2000)))
      }
    } ?: throw IllegalStateException("短信数据源不可用")
    return items
  }
  private fun photos(): List<Map<String, Any>> {
    val items = mutableListOf<Map<String, Any>>()
    context.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
      arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.DATE_TAKEN,
        MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT), null, null, MediaStore.Images.Media.DATE_ADDED + " DESC")?.use { cursor ->
      while (items.size < PhoneSourcePolicy.limit("photos") && cursor.moveToNext()) {
        val dimensions = if (cursor.getInt(3) > 0 && cursor.getInt(4) > 0) "${cursor.getInt(3)} × ${cursor.getInt(4)}" else "尺寸未知"
        items.add(mapOf("id" to "photo-${cursor.getLong(0)}", "title" to cursor.getString(1).orEmpty().take(180),
          "text" to "$dimensions · 图片内容尚未分析", "timestamp" to cursor.getLong(2).toDouble()))
      }
    } ?: throw IllegalStateException("相册数据源不可用")
    return items
  }
  override fun invalidate() {
    closed = true
    pending?.reject("E_PHONE_CLOSED", "应用已关闭，请重试"); pending = null
    executor.shutdownNow()
    super.invalidate()
  }
}
