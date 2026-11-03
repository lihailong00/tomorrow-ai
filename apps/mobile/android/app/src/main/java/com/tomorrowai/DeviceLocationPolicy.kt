package com.tomorrowai

/** Pure policy; never converts coordinates, accesses hardware or persists fixes. */
object DeviceLocationPolicy {
  const val MAX_AGE_MS = 300000L
  const val FRESH_AGE_MS = 30000L
  const val TIMEOUT_MS = 8000L
  fun ageMillis(fix: Long, now: Long): Long? {
    if (fix <= 0 || now < fix) return null
    return ((now - fix) / 1000000L).takeIf { it <= MAX_AGE_MS }
  }
  fun validCoordinates(lat: Double, lon: Double, accuracy: Double) =
    lat.isFinite() && lon.isFinite() && accuracy.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0 && accuracy >= 0
  fun stale(source: String, age: Long) = source == "last_known" || age > FRESH_AGE_MS
  fun permission(fine: Boolean, coarse: Boolean, requested: Boolean, rationale: Boolean, hasActivity: Boolean): String =
    if (fine || coarse) "granted" else if (requested && hasActivity && !rationale) "blocked" else "denied"
  fun accuracy(fine: Boolean, coarse: Boolean) = if (fine) "precise" else if (coarse) "approximate" else "none"
}
