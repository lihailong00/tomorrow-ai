package com.tomorrowai

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import org.json.JSONObject
import java.time.ZoneId
import java.util.UUID

/** Alarm operations originate from explicit foreground user actions. */
class PhoneAlarmsModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "PhoneAlarms"
  private fun foreground() {
    check(context.lifecycleState == LifecycleState.RESUMED && context.currentActivity != null) { "请回到妥啦后再操作闹铃" }
  }
  private fun perform(promise: Promise, block: () -> Any?) {
    try { foreground(); promise.resolve(block()) }
    catch (e: Exception) { promise.reject("phone_alarm", e.message ?: "闹铃操作未完成，请重试") }
  }
  private fun openUi(promise: Promise, block: () -> Any?) {
    try { context.runOnUiQueueThread { perform(promise, block) } }
    catch (_: Exception) { promise.reject("phone_alarm", "请回到妥啦后再操作闹铃") }
  }

  @ReactMethod fun availability(promise: Promise) = perform(promise) {
    Arguments.createMap().apply {
      putBoolean("exact", PhoneAlarmStore.exact(context))
      putBoolean("notifications", PhoneAlarmStore.audible(context))
      putBoolean("system_clock", Intent(AlarmClock.ACTION_SHOW_ALARMS).resolveActivity(context.packageManager) != null)
    }
  }
  @ReactMethod fun list(promise: Promise) = perform(promise) {
    Arguments.createArray().apply {
      synchronized(PhoneAlarmStore) {
        PhoneAlarmStore.all(context).sortedBy { it.optLong("at") }.forEach { row -> pushMap(PhoneAlarmStore.view(row)) }
      }
    }
  }
  @ReactMethod fun schedule(id: String, date: String, time: String, title: String, promise: Promise) = perform(promise) {
    require(Regex("[a-zA-Z0-9-]{8,80}").matches(id)) { "闹铃编号无效" }
    val text = PhoneAlarmPolicy.label(title)
    val at = PhoneAlarmPolicy.target(date, time, System.currentTimeMillis())
    check(PhoneAlarmStore.exact(context)) { "请先允许妥啦设置闹钟和提醒，再重试" }
    PhoneAlarmStore.channel(context)
    check(PhoneAlarmStore.audible(context)) { "请先开启妥啦的通知与闹铃声音，再重试" }
    synchronized(PhoneAlarmStore) {
      val prior = PhoneAlarmStore.get(context, id)
      if (prior?.optString("state") == "scheduled" && prior.optLong("at") == at && prior.optString("title") == text) {
        PhoneAlarmStore.install(context, prior)
        return@synchronized PhoneAlarmStore.view(prior)
      }
      check(prior != null || PhoneAlarmStore.all(context).size < 64) { "本机闹铃已达 64 条，请先删除不需要的记录" }
      val row = JSONObject().put("id", id).put("date", date).put("time", time).put("title", text)
        .put("at", at).put("zone", ZoneId.systemDefault().id).put("revision", UUID.randomUUID().toString()).put("state", "pending")
      PhoneAlarmStore.save(context, row)
      try {
        PhoneAlarmStore.install(context, row)
        row.put("state", "scheduled")
        PhoneAlarmStore.save(context, row)
        PhoneAlarmStore.notifications(context).cancel(id, PhoneAlarmStore.NOTIFICATION_ID)
      } catch (failure: Exception) {
        PhoneAlarmStore.manager(context).cancel(PhoneAlarmStore.fire(context, row))
        if (prior == null) PhoneAlarmStore.remove(context, id)
        else {
          PhoneAlarmStore.save(context, prior)
          if (prior.optString("state") == "scheduled" && prior.optLong("at") > System.currentTimeMillis()) {
            try { PhoneAlarmStore.install(context, prior) } catch (_: Exception) {
              PhoneAlarmStore.save(context, prior.put("state", "needs_retry"))
            }
          }
        }
        throw failure
      }
      PhoneAlarmStore.view(row)
    }
  }
  @ReactMethod fun cancel(id: String, promise: Promise) = perform(promise) {
    synchronized(PhoneAlarmStore) {
      PhoneAlarmStore.get(context, id)?.let { row ->
        // Remove first so an already queued broadcast cannot start ringing.
        PhoneAlarmStore.remove(context, id)
        PhoneAlarmStore.manager(context).cancel(PhoneAlarmStore.fire(context, row))
        PhoneAlarmStore.notifications(context).cancel(id, PhoneAlarmStore.NOTIFICATION_ID)
      }
    }
    true
  }
  @ReactMethod fun openExactAlarmSettings(promise: Promise) = openUi(promise) {
    if (Build.VERSION.SDK_INT >= 31) context.currentActivity!!.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")))
    true
  }
  @ReactMethod fun openNotificationSettings(promise: Promise) = openUi(promise) {
    PhoneAlarmStore.channel(context)
    context.currentActivity!!.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, PhoneAlarmStore.CHANNEL))
    true
  }
  @ReactMethod fun openSystemClock(promise: Promise) = openUi(promise) {
    val intent = Intent(AlarmClock.ACTION_SHOW_ALARMS)
    check(intent.resolveActivity(context.packageManager) != null) { "手机没有提供可打开的系统闹钟入口" }
    context.currentActivity!!.startActivity(intent)
    "opened" // Opening a clock is NOT evidence that an alarm was changed.
  }
  @ReactMethod fun createSystemAlarm(hour: Int, minute: Int, title: String, promise: Promise) = openUi(promise) {
    require(hour in 0..23 && minute in 0..59) { "闹钟时间无效" }
    val intent = Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, hour)
      .putExtra(AlarmClock.EXTRA_MINUTES, minute).putExtra(AlarmClock.EXTRA_MESSAGE, PhoneAlarmPolicy.label(title))
      .putExtra(AlarmClock.EXTRA_SKIP_UI, false)
    check(intent.resolveActivity(context.packageManager) != null) { "手机没有提供系统闹钟创建入口" }
    context.currentActivity!!.startActivity(intent)
    "opened" // Never set EXTRA_DAYS: that would turn tomorrow into a weekly alarm.
  }
  @ReactMethod fun setNextSystemAlarm(date: String, time: String, title: String, promise: Promise) = openUi(promise) {
    val next = PhoneAlarmPolicy.nextSystemTarget(date, time, System.currentTimeMillis())
    val intent = Intent(AlarmClock.ACTION_SET_ALARM)
      .putExtra(AlarmClock.EXTRA_HOUR, next.hour)
      .putExtra(AlarmClock.EXTRA_MINUTES, next.minute)
      .putExtra(AlarmClock.EXTRA_MESSAGE, PhoneAlarmPolicy.label(title))
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    check(intent.resolveActivity(context.packageManager) != null) { "手机没有提供系统闹钟创建入口" }
    context.currentActivity!!.startActivity(intent)
    "requested"
  }
}

internal object PhoneAlarmStore {
  const val CHANNEL = "tada_phone_alarms_v1"
  const val NOTIFICATION_ID = 9102
  const val FIRE = "com.tomorrowai.PHONE_ALARM_FIRE"
  const val STOP = "com.tomorrowai.PHONE_ALARM_STOP"
  private fun prefs(c: Context) = c.getSharedPreferences("phone_alarms_v1", Context.MODE_PRIVATE)
  fun manager(c: Context) = c.getSystemService(AlarmManager::class.java)
  fun notifications(c: Context) = c.getSystemService(NotificationManager::class.java)
  fun exact(c: Context) = Build.VERSION.SDK_INT < 31 || manager(c).canScheduleExactAlarms()
  fun channel(c: Context) {
    notifications(c).createNotificationChannel(NotificationChannel(CHANNEL, "妥啦本机闹铃", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "你主动设置的本机闹铃，按设置时的手机时区响铃"
      setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
      enableVibration(true)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    })
  }
  fun audible(c: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
    if (!notifications(c).areNotificationsEnabled()) return false
    val channel = notifications(c).getNotificationChannel(CHANNEL)
    return channel == null || (channel.importance >= NotificationManager.IMPORTANCE_DEFAULT && channel.sound != null)
  }
  fun all(c: Context): List<JSONObject> = prefs(c).all.values.mapNotNull { value ->
    try { JSONObject(value as String) } catch (_: Exception) { null }
  }
  fun get(c: Context, id: String) = prefs(c).getString(id, null)?.let { JSONObject(it) }
  fun save(c: Context, row: JSONObject) { check(prefs(c).edit().putString(row.getString("id"), row.toString()).commit()) { "本机闹铃保存失败" } }
  fun remove(c: Context, id: String) { check(prefs(c).edit().remove(id).commit()) { "本机闹铃删除失败" } }
  private fun broadcastIntent(c: Context, row: JSONObject, action: String) = Intent(c, PhoneAlarmReceiver::class.java)
    .setAction(action).setData(Uri.parse("tada-alarm://local/${row.getString("id")}"))
    .putExtra("id", row.getString("id")).putExtra("revision", row.getString("revision"))
  fun fire(c: Context, row: JSONObject): PendingIntent = PendingIntent.getBroadcast(c, 0, broadcastIntent(c, row, FIRE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  fun install(c: Context, row: JSONObject) {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: error("无法打开妥啦，请重新安装应用")
    val show = PendingIntent.getActivity(c, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    manager(c).setAlarmClock(AlarmManager.AlarmClockInfo(row.getLong("at"), show), fire(c, row))
  }
  fun view(row: JSONObject) = Arguments.createMap().apply {
    for (key in listOf("id", "date", "time", "title", "zone", "state")) putString(key, row.getString(key))
    putDouble("at", row.getLong("at").toDouble())
  }
  fun receive(c: Context, intent: Intent) = synchronized(this) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      all(c).filter { it.optString("state") == "scheduled" }.forEach { row ->
        try {
          if (row.getLong("at") <= System.currentTimeMillis()) save(c, row.put("state", "missed"))
          else if (exact(c)) install(c, row) else save(c, row.put("state", "needs_retry"))
        } catch (_: Exception) { try { save(c, row.put("state", "needs_retry")) } catch (_: Exception) {} }
      }
      return@synchronized
    }
    val id = intent.getStringExtra("id") ?: return@synchronized
    val row = get(c, id) ?: return@synchronized
    if (row.optString("revision") != intent.getStringExtra("revision")) return@synchronized
    if (intent.action == STOP) {
      notifications(c).cancel(id, NOTIFICATION_ID); save(c, row.put("state", "stopped"))
    } else if (intent.action == FIRE && row.optString("state") == "scheduled" && row.getLong("at") <= System.currentTimeMillis() + 1000) {
      channel(c)
      if (!audible(c)) { save(c, row.put("state", "missed")); return@synchronized }
      val stop = PendingIntent.getBroadcast(c, 0, broadcastIntent(c, row, STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: return@synchronized
      val show = PendingIntent.getActivity(c, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notification = Notification.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("妥啦闹铃").setContentText(row.getString("title")).setCategory(Notification.CATEGORY_ALARM)
        .setVisibility(Notification.VISIBILITY_PRIVATE).setOngoing(true).setContentIntent(show)
        .addAction(Notification.Action.Builder(null, "停止铃声", stop).build()).build()
      notification.flags = notification.flags or Notification.FLAG_INSISTENT
      save(c, row.put("state", "fired"))
      try { notifications(c).notify(id, NOTIFICATION_ID, notification) }
      catch (failure: Exception) { save(c, row.put("state", "missed")); throw failure }
    }
  }
}

class PhoneAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try { PhoneAlarmStore.receive(context, intent) } catch (_: Exception) { /* No private reminder text in system logs. */ }
  }
}
