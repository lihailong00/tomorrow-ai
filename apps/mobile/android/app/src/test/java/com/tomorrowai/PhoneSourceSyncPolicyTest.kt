package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class PhoneSourceSyncPolicyTest {
  private fun refresh(age: Long = 0, requested: Long = 4, scanned: Long = 4,
    previousAccess: String = "granted", access: String = "granted", force: Boolean = false,
    state: String = "complete") = PhoneSourceSyncPolicy.needsRefresh(state, 10_000_000,
      requested, scanned, previousAccess, access, force, 10_000_000 + age)

  @Test fun repeatedVisitsBeyondTheOldFiveMinuteWindowReuseTheCompletedCache() {
    for (age in listOf(0L, 5 * 60_000L, 60 * 60_000L, PhoneSourceSyncPolicy.RECONCILE_INTERVAL_MS - 1))
      assertFalse("age=$age", refresh(age))
  }

  @Test fun changesManualRefreshPermissionChangesAndReconciliationTriggerUpdates() {
    assertTrue(refresh(requested = 5))
    assertTrue(refresh(force = true))
    assertTrue(refresh(previousAccess = "granted", access = "limited"))
    assertTrue(refresh(previousAccess = "limited", access = "granted"))
    assertTrue(refresh(age = PhoneSourceSyncPolicy.RECONCILE_INTERVAL_MS))
    assertTrue(refresh(age = -1))
  }

  @Test fun activeScansAreResumedRatherThanRestartedEvenWhenMoreChangesArrive() {
    for (state in listOf("queued", "running", "error"))
      assertFalse(refresh(state = state, force = true, requested = 5))
  }

  @Test fun onlyNewAndModifiedBodiesAreReadIncludingLargeProviderIds() {
    val largeId = 9_007_199_254_740_993L
    val incoming = linkedMapOf(1L to "same", 2L to "modified", largeId to "new")
    assertEquals(listOf(2L, largeId), PhoneSourceSyncPolicy.changedIds(incoming,
      mapOf(1L to "same", 2L to "old", 3L to "deleted")))
    assertEquals(emptyList<Long>(), PhoneSourceSyncPolicy.changedIds(incoming, incoming))
    assertEquals(incoming.keys.toList(), PhoneSourceSyncPolicy.changedIds(incoming, emptyMap()))
  }
}
