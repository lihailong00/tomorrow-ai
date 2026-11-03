package com.tomorrowai

/** Resource and ownership limits are independent of the selected conversation. */
internal class ConversationShareFailure(val kind: String) : Exception(kind)

internal object ConversationSharePolicy {
  const val WIDTH = 900
  const val MAX_HEIGHT = 12000
  const val MAX_PAYLOAD_BYTES = 262144
  const val MAX_PNG_BYTES = 8L * 1024 * 1024
  const val MAX_MESSAGES = 100
  const val MAX_CHARACTERS = 100000
  const val MAX_ACTIVE_FILES = 4
  const val MAX_CACHE_FILES = 8
  const val MAX_CACHE_BYTES = 64L * 1024 * 1024
  const val LEASE_MILLIS = 10L * 60 * 1000
  val artifactPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  fun validArtifact(id: String) = artifactPattern.matches(id)
  fun validRequest(id: String) = id.length <= 80 && Regex("^share-[0-9]+-[0-9]+$").matches(id)
  fun requirePayload(payload: String) {
    if (payload.length > MAX_PAYLOAD_BYTES || payload.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD_BYTES) throw ConversationShareFailure("TOO_LARGE")
  }
  fun requireHeight(height: Int) {
    if (height < 1 || height > MAX_HEIGHT) throw ConversationShareFailure("TOO_LARGE")
  }
  fun leaseActive(dispatchedAt: Long?, now: Long): Boolean = dispatchedAt != null && now >= dispatchedAt && now - dispatchedAt < LEASE_MILLIS
  fun cacheHasCapacity(files: Int, bytes: Long): Boolean = files < MAX_CACHE_FILES && bytes <= MAX_CACHE_BYTES - MAX_PNG_BYTES
}
