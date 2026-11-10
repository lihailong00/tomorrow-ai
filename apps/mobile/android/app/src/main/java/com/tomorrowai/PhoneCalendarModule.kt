package com.tomorrowai

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.ContentProviderOperation
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Reminders
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

class PhoneCalendarModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  private var picker: AlertDialog? = null
  private val resolver get() = context.contentResolver
  override fun getName() = "PhoneCalendar"

  private fun perform(promise: Promise, block: () -> Any?) {
    executor.execute {
      try { block()?.let { promise.resolve(it) } }
      catch (error: IllegalArgumentException) { promise.reject("CALENDAR_INVALID", error.message) }
      catch (error: IllegalStateException) { promise.reject("CALENDAR_UNAVAILABLE", error.message) }
      catch (_: SecurityException) { promise.reject("CALENDAR_PERMISSION", "需要允许妥啦读取和写入日历。") }
      catch (_: Exception) { promise.reject("CALENDAR_WRITE_FAILED", "手机日历未能完成操作，请检查日历权限和账号。") }
    }
  }

  private fun requireAccess() {
    for (permission in listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)) {
      if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) throw SecurityException()
    }
  }

  private fun showPicker(promise: Promise, create: (Activity, (String) -> Unit) -> AlertDialog) {
    UiThreadUtil.runOnUiThread {
      val activity = context.currentActivity
      if (activity == null || activity.isFinishing || activity.isDestroyed || picker != null) {
        promise.resolve(null)
        return@runOnUiThread
      }
      try {
        var result: String? = null
        val dialog = create(activity) { result = it }
        dialog.setOnDismissListener {
          if (picker === dialog) picker = null
          promise.resolve(result)
        }
        dialog.show()
        picker = dialog
      } catch (_: Exception) {
        promise.reject("CALENDAR_PICKER_UNAVAILABLE", "暂时无法打开日期或时间选择器。")
      }
    }
  }

  @ReactMethod fun pickDate(date: String, promise: Promise) {
    showPicker(promise) { activity, selected ->
      val zone = ZoneId.systemDefault()
      val today = LocalDate.now(zone)
      val lastDay = LocalDate.of(2100, 12, 31)
      val parsed = runCatching { LocalDate.parse(date) }.getOrDefault(today)
      val initial = if (parsed.isBefore(today) || parsed.isAfter(lastDay)) today else parsed
      DatePickerDialog(activity, { _, year, month, day ->
        selected(LocalDate.of(year, month + 1, day).toString())
      }, initial.year, initial.monthValue - 1, initial.dayOfMonth).apply {
        datePicker.minDate = today.atStartOfDay(zone).toInstant().toEpochMilli()
        datePicker.maxDate = lastDay.atStartOfDay(zone).toInstant().toEpochMilli()
      }
    }
  }

  @ReactMethod fun pickTime(date: String, time: String, promise: Promise) {
    showPicker(promise) { activity, selected ->
      val now = LocalTime.now()
      val suggested = if (date == LocalDate.now().toString())
        if (now.hour == 23) LocalTime.of(23, 59) else LocalTime.of(now.hour + 1, 0)
      else LocalTime.of(9, 0)
      val initial = runCatching { LocalTime.parse(time) }.getOrDefault(suggested)
      val format = DateTimeFormatter.ofPattern("HH:mm", java.util.Locale.ROOT)
      TimePickerDialog(activity, { _, hour, minute ->
        selected(LocalTime.of(hour, minute).format(format))
      }, initial.hour, initial.minute, true)
    }
  }

  @ReactMethod fun calendars(promise: Promise) = perform(promise) {
    requireAccess()
    val result = Arguments.createArray()
    resolver.query(Calendars.CONTENT_URI, arrayOf(Calendars._ID, Calendars.CALENDAR_DISPLAY_NAME, Calendars.ACCOUNT_NAME),
      "${Calendars.CALENDAR_ACCESS_LEVEL}>=? AND ${Calendars.VISIBLE}=1", arrayOf(Calendars.CAL_ACCESS_CONTRIBUTOR.toString()),
      Calendars.CALENDAR_DISPLAY_NAME)?.use { cursor ->
      while (result.size() < 100 && cursor.moveToNext()) {
        result.pushMap(Arguments.createMap().apply {
          putString("id", cursor.getLong(0).toString())
          putString("name", cursor.getString(1).orEmpty().ifBlank { "日历" })
          putString("account", cursor.getString(2).orEmpty())
        })
      }
    }
    result
  }

  private data class Event(val title: String, val start: Long, val end: Long, val zone: String, val allDay: Boolean)

  private fun event(title: String, date: String, time: String, allDay: Boolean, duration: Int): Event {
    val label = title.trim()
    require(label.isNotEmpty() && label.length <= 120) { "请填写 1 到 120 字的日程名称。" }
    require(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(date)) { "请输入有效的日期（YYYY-MM-DD）。" }
    val day = try { LocalDate.parse(date) } catch (_: Exception) { throw IllegalArgumentException("请输入有效的日历日期。") }
    val local = ZoneId.systemDefault()
    require(!day.isBefore(LocalDate.now(local)) && day.year <= 2100) { "请选择今天或未来的日期。" }
    if (allDay) return Event(label, day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
      day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(), "UTC", true)
    require(Regex("[0-9]{2}:[0-9]{2}").matches(time) && duration in 5..720) { "请输入有效的 24 小时时间和时长。" }
    val clock = try { LocalTime.parse(time) } catch (_: Exception) { throw IllegalArgumentException("请输入有效的 24 小时时间。") }
    val dateTime = LocalDateTime.of(day, clock)
    val offsets = local.rules.getValidOffsets(dateTime)
    require(offsets.size == 1) { "这个时间遇到夏令时切换，请换一个时间。" }
    val start = dateTime.toInstant(offsets.single())
    require(start.isAfter(Instant.now())) { "请选择还没过去的开始时间。" }
    return Event(label, start.toEpochMilli(), start.plusSeconds(duration * 60L).toEpochMilli(), local.id, false)
  }

  @ReactMethod fun add(calendarId: String, title: String, date: String, time: String, allDay: Boolean,
    duration: Int, remindBefore: Int, promise: Promise) = perform(promise) {
    requireAccess()
    val id = calendarId.toLongOrNull()?.takeIf { it > 0 } ?: throw IllegalArgumentException("请选择可写的日历。")
    val event = event(title, date, time, allDay, duration)
    require(remindBefore == -1 || (!allDay && remindBefore in 0..10080)) { "请为定时日程选择有效的提醒时间。" }
    require(remindBefore < 0 || event.start - remindBefore * 60_000L > System.currentTimeMillis()) { "提醒时间已过，请调整提醒设置。" }
    val permission = resolver.query(ContentUris.withAppendedId(Calendars.CONTENT_URI, id),
      arrayOf(Calendars.CALENDAR_ACCESS_LEVEL, Calendars.MAX_REMINDERS, Calendars.ALLOWED_REMINDERS, Calendars.VISIBLE),
      null, null, null)?.use { cursor ->
      check(cursor.moveToFirst() && cursor.getInt(0) >= Calendars.CAL_ACCESS_CONTRIBUTOR && cursor.getInt(3) == 1) { "所选日历已不可写，请重新选择。" }
      val methods = cursor.getString(2).orEmpty().split(',').mapNotNull { it.trim().toIntOrNull() }
      val method = if (Reminders.METHOD_ALERT in methods || methods.isEmpty()) Reminders.METHOD_ALERT
        else if (Reminders.METHOD_DEFAULT in methods) Reminders.METHOD_DEFAULT else null
      if (remindBefore >= 0) check((cursor.isNull(1) || cursor.getInt(1) > 0) && method != null) { "所选日历不支持通知提醒，请换一个日历。" }
      method ?: Reminders.METHOD_ALERT
    } ?: error("所选日历已不可用，请重新选择。")
    val operations = arrayListOf(ContentProviderOperation.newInsert(Events.CONTENT_URI)
      .withValue(Events.CALENDAR_ID, id).withValue(Events.TITLE, event.title)
      .withValue(Events.DTSTART, event.start).withValue(Events.DTEND, event.end)
      .withValue(Events.EVENT_TIMEZONE, event.zone).withValue(Events.ALL_DAY, if (event.allDay) 1 else 0)
      .withValue(Events.HAS_ALARM, if (remindBefore >= 0) 1 else 0).build())
    if (remindBefore >= 0) operations.add(ContentProviderOperation.newInsert(Reminders.CONTENT_URI)
      .withValueBackReference(Reminders.EVENT_ID, 0).withValue(Reminders.MINUTES, remindBefore)
      .withValue(Reminders.METHOD, permission).build())
    val saved = resolver.applyBatch(CalendarContract.AUTHORITY, operations).firstOrNull()?.uri
      ?: error("系统日历没有返回保存结果，请先检查日历中是否已有该日程。")
    Arguments.createMap().apply { putString("id", ContentUris.parseId(saved).toString()) }
  }

  @ReactMethod fun openEditor(title: String, date: String, time: String, allDay: Boolean, duration: Int, promise: Promise) = perform(promise) {
    val event = event(title, date, time, allDay, duration)
    val intent = Intent(Intent.ACTION_INSERT).setData(Events.CONTENT_URI)
      .putExtra(Events.TITLE, event.title).putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, event.start)
      .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, event.end).putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, event.allDay)
    startCalendarEditor(intent, promise)
    // The activity launch completes the promise on the UI thread.
    null
  }

  @ReactMethod fun editSavedEvent(eventId: String, promise: Promise) = perform(promise) {
    val id = eventId.toLongOrNull()?.takeIf { it > 0 } ?: throw IllegalArgumentException("找不到已保存的日程。")
    startCalendarEditor(Intent(Intent.ACTION_EDIT).setData(ContentUris.withAppendedId(Events.CONTENT_URI, id)), promise)
    null
  }

  private fun startCalendarEditor(intent: Intent, promise: Promise) {
    val activity = context.currentActivity ?: error("请打开妥啦后重试。")
    activity.runOnUiThread {
      try { activity.startActivity(intent); promise.resolve("opened") }
      catch (_: Exception) { promise.reject("CALENDAR_NO_EDITOR", "无法打开系统日历编辑页面，请到日历应用中操作。") }
    }
  }

  override fun invalidate() {
    UiThreadUtil.runOnUiThread { picker?.dismiss() }
    executor.shutdown()
    super.invalidate()
  }
}
