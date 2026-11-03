package com.tomorrowai

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle

/** Wall time is resolved once, on this phone; never guess a date or repeat day. */
internal object PhoneAlarmPolicy {
  fun target(date: String, time: String, now: Long, zone: ZoneId = ZoneId.systemDefault()): Long {
    require(Regex("\\d{4}-\\d{2}-\\d{2}").matches(date)) { "请填写 YYYY-MM-DD 日期" }
    require(Regex("([01]\\d|2[0-3]):[0-5]\\d").matches(time)) { "请填写 HH:mm 时间" }
    val day = LocalDate.parse(date, DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT))
    val local = LocalDateTime.of(day, LocalTime.parse(time))
    val offsets = zone.rules.getValidOffsets(local)
    require(offsets.size == 1) { "这个时刻因夏令时不存在或有歧义，请另选时间" }
    val at = local.toInstant(offsets[0]).toEpochMilli()
    require(at - now >= 5000) { "时间已过或太接近，请重新选择未来时间" }
    require(at - now <= 366L * 24 * 60 * 60 * 1000) { "请选择一年以内的时间" }
    return at
  }

  fun label(value: String): String {
    val result = value.trim()
    require(result.isNotEmpty() && result.length <= 120 && result.none { it.isISOControl() }) { "提醒内容须为 1–120 个字符" }
    return result
  }
}
