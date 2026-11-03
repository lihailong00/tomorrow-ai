package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class PhoneAlarmPolicyTest {
  private val zone = ZoneId.of("Asia/Shanghai")
  private fun at(text: String, z: ZoneId = zone) = LocalDateTime.parse(text).atZone(z).toInstant().toEpochMilli()
  private fun rejects(block: () -> Unit) {
    var rejected = false
    try { block() } catch (_: RuntimeException) { rejected = true }
    assertTrue("Invalid or ambiguous time must not be silently normalized", rejected)
  }
  @Test fun tomorrowNoonIsNotTodayOrWeekly() {
    val now = at("2026-11-03T01:00:00")
    assertEquals(at("2026-11-04T12:00:00"), PhoneAlarmPolicy.target("2026-11-04", "12:00", now, zone))
    assertEquals(35 * 60 * 60 * 1000L, PhoneAlarmPolicy.target("2026-11-04", "12:00", now, zone) - now)
  }
  @Test fun invalidAndPastDatesAreRejected() {
    val now = at("2026-11-03T01:00:00")
    rejects { PhoneAlarmPolicy.target("2026-02-30", "12:00", now, zone) }
    rejects { PhoneAlarmPolicy.target("2026-11-03", "00:30", now, zone) }
    rejects { PhoneAlarmPolicy.target("2026-11-04", "24:00", now, zone) }
    rejects { PhoneAlarmPolicy.target("2026-11-4", "12:00", now, zone) }
    rejects { PhoneAlarmPolicy.target("2028-11-04", "12:00", now, zone) }
  }
  @Test fun tooNearTimesAreRejected() {
    rejects { PhoneAlarmPolicy.target("2026-11-03", "12:00", at("2026-11-03T11:59:57"), zone) }
  }
  @Test fun daylightSavingGapsAndFoldsAreNotGuessed() {
    val ny = ZoneId.of("America/New_York")
    rejects { PhoneAlarmPolicy.target("2027-03-14", "02:30", at("2027-03-13T12:00:00", ny), ny) }
    rejects { PhoneAlarmPolicy.target("2027-11-07", "01:30", at("2027-11-06T12:00:00", ny), ny) }
  }
  @Test fun titlesAreBoundedAndCannotContainControlCharacters() {
    assertEquals("女朋友写简历", PhoneAlarmPolicy.label(" 女朋友写简历 "))
    rejects { PhoneAlarmPolicy.label("") }
    rejects { PhoneAlarmPolicy.label("a".repeat(121)) }
    rejects { PhoneAlarmPolicy.label("a\nb") }
  }
  @Test fun bridgeMethodsReturnVoidForNativeInterop() {
    val methods = PhoneAlarmsModule::class.java.declaredMethods.filter {
      it.getAnnotation(com.facebook.react.bridge.ReactMethod::class.java) != null
    }
    assertEquals(8, methods.size)
    methods.forEach { assertEquals(Void.TYPE, it.returnType) }
  }
}
