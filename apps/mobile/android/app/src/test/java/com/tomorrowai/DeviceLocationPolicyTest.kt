package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class DeviceLocationPolicyTest {
  @Test fun monotonicAgeRejectsOldFutureAndMissingSamples() {
    val now = 500000000000L
    assertEquals(0L, DeviceLocationPolicy.ageMillis(now, now))
    assertEquals(300000L, DeviceLocationPolicy.ageMillis(now - 300000000000L, now))
    assertNull(DeviceLocationPolicy.ageMillis(now - 300001000000L, now))
    assertNull(DeviceLocationPolicy.ageMillis(now + 1, now))
    assertNull(DeviceLocationPolicy.ageMillis(0, now))
  }
  @Test fun finiteWgs84BoundsAndActualAccuracyAreRequired() {
    assertTrue(DeviceLocationPolicy.validCoordinates(31.2304, 121.4737, 35.0))
    assertTrue(DeviceLocationPolicy.validCoordinates(0.0, 0.0, 0.0))
    assertFalse(DeviceLocationPolicy.validCoordinates(Double.NaN, 121.4, 5.0))
    assertFalse(DeviceLocationPolicy.validCoordinates(91.0, 121.4, 5.0))
    assertFalse(DeviceLocationPolicy.validCoordinates(31.2, 181.0, 5.0))
    assertFalse(DeviceLocationPolicy.validCoordinates(31.2, 121.4, -1.0))
  }
  @Test fun cachedAndOlderCurrentFixesAreExplicitlyStale() {
    assertTrue(DeviceLocationPolicy.stale("last_known", 0))
    assertFalse(DeviceLocationPolicy.stale("current", 30000))
    assertTrue(DeviceLocationPolicy.stale("current", 30001))
  }
  @Test fun approximateGrantDoesNotRequireFinePermission() {
    assertEquals("granted", DeviceLocationPolicy.permission(false, true, true, false, true))
    assertEquals("approximate", DeviceLocationPolicy.accuracy(false, true))
    assertEquals("precise", DeviceLocationPolicy.accuracy(true, true))
    assertEquals("none", DeviceLocationPolicy.accuracy(false, false))
    assertEquals("denied", DeviceLocationPolicy.permission(false, false, false, false, true))
    assertEquals("denied", DeviceLocationPolicy.permission(false, false, true, true, true))
    assertEquals("blocked", DeviceLocationPolicy.permission(false, false, true, false, true))
    assertEquals("denied", DeviceLocationPolicy.permission(false, false, true, false, false))
  }
}
