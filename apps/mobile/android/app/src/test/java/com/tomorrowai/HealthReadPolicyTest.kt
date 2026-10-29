package com.tomorrowai

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
}
