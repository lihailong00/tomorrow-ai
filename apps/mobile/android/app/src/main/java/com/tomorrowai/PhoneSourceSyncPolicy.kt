package com.tomorrowai

/** Refresh decisions are independent of a screen's lifetime. */
internal object PhoneSourceSyncPolicy {
  const val RECONCILE_INTERVAL_MS = 6 * 60 * 60_000L

  fun needsRefresh(state: String, updated: Long, requested: Long, scanned: Long,
    previousAccess: String, access: String, force: Boolean, now: Long): Boolean =
    state == "complete" && (force || requested > scanned || previousAccess != access ||
      now < updated || now - updated >= RECONCILE_INTERVAL_MS)

  fun changedIds(revisions: Map<Long, String>, cached: Map<Long, String>): List<Long> =
    revisions.filter { (id, revision) -> revision != cached[id] }.keys.toList()
}
