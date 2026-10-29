package com.tomorrowai

import androidx.health.connect.client.records.SleepSessionRecord
import org.junit.Assert.*
import org.junit.Test

class HealthReadPolicyTest {
  @Test fun acceptsOnlyEnumeratedReadTypes() {
    assertEquals(listOf("steps", "sleep"), HealthReadPolicy.validateMetrics(listOf("steps", "sleep")))
    for (invalid in listOf(emptyList(), listOf("steps", "steps"), listOf("write_steps"), listOf("medical_records"))) {
      assertThrows(IllegalArgumentException::class.java) { HealthReadPolicy.validateMetrics(invalid) }
    }
  }
  @Test fun boundsHistoryAndRejectsNonIntegralOrNonFiniteDates() {
    assertEquals(1, HealthReadPolicy.validateDays(1.0))
    assertEquals(30, HealthReadPolicy.validateDays(30.0))
    for (invalid in listOf(0.0, -1.0, 31.0, 1.5, Double.NaN, Double.POSITIVE_INFINITY)) {
      assertThrows(IllegalArgumentException::class.java) { HealthReadPolicy.validateDays(invalid) }
    }
  }
  @Test fun metricBudgetNeverExceedsHardLimit() {
    for (count in 1..5) {
      assertTrue(HealthReadPolicy.perMetricLimit(count) * count <= 2000)
      assertTrue(HealthReadPolicy.perMetricLimit(count) > 0)
    }
  }

  private fun stage(type: Int, minutes: Long) = HealthReadPolicy.SleepStageDuration(type, minutes * 60_000)

  @Test fun unknownSleepStageUsesExplicitSessionSpanInsteadOfZeroSleep() {
    val summary = HealthReadPolicy.summarizeSleep(480 * 60_000L, listOf(stage(SleepSessionRecord.STAGE_TYPE_UNKNOWN, 480)))
    assertEquals("session_duration", summary.basis)
    assertEquals(480.0, summary.minutes, 0.0)
  }

  @Test fun mixedOrFutureUnknownStageDoesNotPresentPartialSleepAsComplete() {
    for (unknown in listOf(SleepSessionRecord.STAGE_TYPE_UNKNOWN, 999)) {
      val summary = HealthReadPolicy.summarizeSleep(480 * 60_000L, listOf(
        stage(SleepSessionRecord.STAGE_TYPE_DEEP, 60), stage(unknown, 420),
      ))
      assertEquals("session_duration", summary.basis)
      assertEquals(480.0, summary.minutes, 0.0)
    }
  }

  @Test fun explicitlyAwakeAndOutOfBedStagesCanRecordZeroAsleepMinutes() {
    val summary = HealthReadPolicy.summarizeSleep(90 * 60_000L, listOf(
      stage(SleepSessionRecord.STAGE_TYPE_AWAKE, 30),
      stage(SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED, 30),
      stage(SleepSessionRecord.STAGE_TYPE_OUT_OF_BED, 30),
    ))
    assertEquals("asleep_stages", summary.basis)
    assertEquals(0.0, summary.minutes, 0.0)
  }

  @Test fun knownSleepStagesSumSleepOnlyAndExcludeAwakeIntervals() {
    val summary = HealthReadPolicy.summarizeSleep(480 * 60_000L, listOf(
      stage(SleepSessionRecord.STAGE_TYPE_SLEEPING, 60), stage(SleepSessionRecord.STAGE_TYPE_LIGHT, 120),
      stage(SleepSessionRecord.STAGE_TYPE_DEEP, 120), stage(SleepSessionRecord.STAGE_TYPE_REM, 60),
      stage(SleepSessionRecord.STAGE_TYPE_AWAKE, 120),
    ))
    assertEquals("asleep_stages", summary.basis)
    assertEquals(360.0, summary.minutes, 0.0)
  }

  @Test fun noStagesRetainsRecordedSessionSpanButInvalidIntervalsAreNotZeroFilled() {
    val summary = HealthReadPolicy.summarizeSleep(480 * 60_000L, emptyList())
    assertEquals("session_duration", summary.basis)
    assertEquals(480.0, summary.minutes, 0.0)
    assertThrows(IllegalArgumentException::class.java) { HealthReadPolicy.summarizeSleep(0, emptyList()) }
    assertThrows(IllegalArgumentException::class.java) {
      HealthReadPolicy.summarizeSleep(480 * 60_000L, listOf(stage(SleepSessionRecord.STAGE_TYPE_UNKNOWN, -1)))
    }
  }
}
