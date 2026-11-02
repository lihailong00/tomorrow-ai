package com.tomorrowai

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Telephony
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Establishes a baseline once; subsequent scans materialize only changed records. */
internal class PhoneSourceReader(private val context: Context) {
  companion object {
    val sources = listOf("contacts", "calendar", "sms", "photos")
    const val BATCH_SIZE = 250
    const val PAGE_SIZE = 50
    fun watchUri(source: String): Uri = when (source) {
      "contacts" -> ContactsContract.AUTHORITY_URI
      "calendar" -> CalendarContract.CONTENT_URI
      "sms" -> Telephony.Sms.CONTENT_URI
      "photos" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      else -> throw IllegalArgumentException("未知手机资料来源")
    }
    fun normalizeCalendarRecord(value: JSONObject): JSONObject {
      val raw = value.optJSONObject("raw")
      val status = if (raw == null) "unknown" else PhoneSourcePolicy.calendarStatus(
        if (raw.isNull("eventStatus")) null else raw.optString("eventStatus"),
        if (raw.isNull("deleted")) null else raw.optString("deleted"))
      return value.put("calendarStatus", status)
        .put("eligibleForTodo", PhoneSourcePolicy.calendarEligibleForTodo(status))
    }
    fun permissions(source: String): Array<String> = when (source) {
      "contacts" -> arrayOf(Manifest.permission.READ_CONTACTS)
      "calendar" -> arrayOf(Manifest.permission.READ_CALENDAR)
      "sms" -> arrayOf(Manifest.permission.READ_SMS)
      "photos" -> if (Build.VERSION.SDK_INT >= 34)
        arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        else if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
      else -> throw IllegalArgumentException("未知手机资料来源")
    }
    fun access(context: Context, source: String): String {
      if (context.checkSelfPermission(permissions(source).first()) == PackageManager.PERMISSION_GRANTED) return "granted"
      if (source == "photos" && Build.VERSION.SDK_INT >= 34 &&
        context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED) return "limited"
      return "denied"
    }
  }

  private fun uri(source: String): Uri = when (source) {
    "contacts" -> ContactsContract.Contacts.CONTENT_URI
    "calendar" -> CalendarContract.Events.CONTENT_URI
    // Includes inbox, sent, drafts, outbox, failed and queued SMS. No date/content filter.
    "sms" -> Telephony.Sms.CONTENT_URI
    "photos" -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    else -> throw IllegalArgumentException("未知手机资料来源")
  }

  fun bounds(source: String): Pair<Long, Long> {
    var upper = 0L
    context.contentResolver.query(uri(source), arrayOf("_id"), null, null, "_id DESC")?.use {
      if (it.moveToFirst()) upper = it.getLong(0)
    } ?: throw IllegalStateException("资料来源暂时不可用")
    val count = context.contentResolver.query(uri(source), arrayOf("_id"), "_id<=?", arrayOf(upper.toString()), null)?.use {
      it.count.toLong()
    } ?: throw IllegalStateException("无法确认资料总数")
    return upper to count
  }

  data class Record(val id: Long, val value: JSONObject)
  /** Contacts/media expose revisions. SMS/calendar require fingerprint checking,
   * but only after a change notification or the low-frequency reconciliation. */
  fun revisions(source: String, after: Long, upper: Long): Map<Long, String> {
    val projection = when (source) {
      "contacts" -> arrayOf("_id", ContactsContract.Contacts.CONTACT_LAST_UPDATED_TIMESTAMP)
      "photos" -> if (Build.VERSION.SDK_INT >= 30) arrayOf("_id", MediaStore.MediaColumns.GENERATION_MODIFIED)
        else arrayOf("_id", "date_modified", "_size", "_display_name", "width", "height", "datetaken")
      else -> null
    }
    val rawRows = queryRows(source, projection, "_id>? AND _id<=?", arrayOf(after.toString(), upper.toString()))
    check(rawRows.all { it.first > after && it.first <= upper }) { "资料来源未按游标返回，请重试" }
    val relatedRows = if (source == "calendar") calendarDetails(rawRows.map { it.first }) else emptyMap()
    val mediaVersion = if (source == "photos" && Build.VERSION.SDK_INT >= 30)
      MediaStore.getVersion(context) else ""
    return rawRows.associate { (id, raw) ->
      val revision = JSONObject().put("row", raw).put("mediaVersion", mediaVersion)
      relatedRows.forEach { (name, rows) -> revision.put(name, rows[id] ?: JSONArray()) }
      id to PhoneSourcePolicy.digest(revision.toString())
    }
  }

  fun records(source: String, ids: List<Long>): List<Record> {
    if (ids.isEmpty()) return emptyList()
    val rows = queryRows(source, null, "_id IN (${ids.joinToString(",") { "?" }})",
      ids.map { it.toString() }.toTypedArray())
    check(rows.all { it.first in ids }) { "资料来源未按标识返回，请重试" }
    return materialize(source, rows)
  }

  private fun queryRows(source: String, projection: Array<String>?, selection: String, args: Array<String>): List<Pair<Long, JSONObject>> {
    val rows = mutableListOf<Pair<Long, JSONObject>>()
    context.contentResolver.query(uri(source), projection, selection, args, "_id ASC")?.use { cursor ->
      var previous = -1L
      while (rows.size < BATCH_SIZE && cursor.moveToNext()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow("_id"))
        check(id > previous) { "资料来源未按游标返回，请重试" }
        rows.add(id to fields(cursor))
        previous = id
      }
    } ?: throw IllegalStateException("资料来源暂时不可用")
    return rows
  }

  private fun calendarDetails(ids: List<Long>): Map<String, Map<Long, JSONArray>> = mapOf(
    "attendees" to related(CalendarContract.Attendees.CONTENT_URI, ids),
    "reminders" to related(CalendarContract.Reminders.CONTENT_URI, ids),
    "extendedProperties" to related(CalendarContract.ExtendedProperties.CONTENT_URI, ids))

  private fun materialize(source: String, rows: List<Pair<Long, JSONObject>>): List<Record> {
    val details = if (source == "contacts") contactDetails(rows.map { it.first }) else emptyMap()
    val calendarDetails = if (source == "calendar") calendarDetails(rows.map { it.first }) else emptyMap()
    return rows.map { (id, raw) ->
      val value = JSONObject().put("id", "$source-$id").put("raw", raw)
        .put("uri", ContentUris.withAppendedId(uri(source), id).toString())
      when (source) {
        "contacts" -> {
          val data = details[id] ?: JSONArray()
          value.put("title", raw.optString("display_name").ifBlank { "未命名联系人" })
            .put("data", data).put("text", contactText(data))
        }
        "calendar" -> {
          // Store Events, including history and recurrence rules; expanding a recurring
          // event into infinitely many Instances would never finish a full import.
          value.put("title", raw.optString("title").ifBlank { "未命名日程" })
            .put("text", listOf(raw.optString("description"), raw.optString("eventLocation"),
              raw.optString("rrule").takeIf { it.isNotBlank() }?.let { "重复规则：$it" }.orEmpty())
              .filter { it.isNotBlank() }.joinToString("\n"))
            .put("timestamp", raw.optLong("dtstart")).put("allDay", raw.optInt("allDay") != 0)
          if (!raw.isNull("dtend")) value.put("end", raw.optLong("dtend"))
          calendarDetails.forEach { (name, records) -> value.put(name, records[id] ?: JSONArray()) }
        }
        "sms" -> value.put("title", PhoneSourcePolicy.maskNumber(raw.optString("address")).ifBlank { "短信" })
          .put("text", raw.optString("body")).put("timestamp", raw.optLong("date"))
          .put("eligibleForTodo", PhoneSourcePolicy.includeSms(raw.optString("body")))
        "photos" -> value.put("title", raw.optString("_display_name").ifBlank { "照片" })
          .put("text", "${raw.optInt("width")} × ${raw.optInt("height")} · 原图保留在本机，图片理解另行开启")
          .put("timestamp", raw.optLong("datetaken").takeIf { it > 0 }
            ?: raw.optLong("date_added") * 1000)
      }
      Record(id, if (source == "calendar") normalizeCalendarRecord(value) else value)
    }
  }

  private fun fields(cursor: Cursor): JSONObject = JSONObject().apply {
    cursor.columnNames.forEachIndexed { index, name ->
      put(name, when (cursor.getType(index)) {
        Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
        Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(index)
        Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
        Cursor.FIELD_TYPE_BLOB -> JSONObject().put("encoding", "base64")
          .put("value", Base64.encodeToString(cursor.getBlob(index), Base64.NO_WRAP))
        else -> cursor.getString(index)
      })
    }
  }

  private fun contactDetails(ids: List<Long>): Map<Long, JSONArray> {
    if (ids.isEmpty()) return emptyMap()
    val result = mutableMapOf<Long, JSONArray>()
    context.contentResolver.query(ContactsContract.Data.CONTENT_URI, null,
      "contact_id IN (${ids.joinToString(",") { "?" }})", ids.map { it.toString() }.toTypedArray(),
      "contact_id ASC, _id ASC")?.use { cursor ->
      while (cursor.moveToNext()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow("contact_id"))
        result.getOrPut(id) { JSONArray() }.put(fields(cursor))
      }
    } ?: throw IllegalStateException("联系人详情暂时不可用；已保留上次进度")
    return result
  }

  private fun related(uri: Uri, ids: List<Long>): Map<Long, JSONArray> {
    if (ids.isEmpty()) return emptyMap()
    val result = mutableMapOf<Long, JSONArray>()
    context.contentResolver.query(uri, null, "event_id IN (${ids.joinToString(",") { "?" }})",
      ids.map { it.toString() }.toTypedArray(), "event_id ASC, _id ASC")?.use { cursor ->
      while (cursor.moveToNext()) {
        result.getOrPut(cursor.getLong(cursor.getColumnIndexOrThrow("event_id"))) { JSONArray() }.put(fields(cursor))
      }
    } ?: throw IllegalStateException("日历详情暂时不可用；已保留上次进度")
    return result
  }

  private fun contactText(data: JSONArray): String = (0 until data.length()).mapNotNull { index ->
    val item = data.getJSONObject(index)
    val label = when (item.optString("mimetype")) {
      ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> "电话"
      ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE -> "邮箱"
      ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE -> "单位"
      ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE -> "地址"
      ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE -> "备注"
      else -> null
    }
    label?.let { "$it：${item.optString("data1")}" }
  }.joinToString("\n")

  fun contactName(number: String): String? = try {
    context.contentResolver.query(Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
      Uri.encode(number)), arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    }
  } catch (_: Exception) { null } // A missing contacts grant must not block SMS.
}
