package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class ConversationSharePolicyTest {
  @Test fun opaqueIdentifiersCannotAddressOtherFiles() {
    assertTrue(ConversationSharePolicy.validArtifact("4d8c3b7a-1c9e-4e31-97a8-c361c6dfdf98"))
    listOf("../private.png", "file:///data/private", "4d8c3b7a-1c9e-4e31-97a8-c361c6dfdf98.png", "", "0000").forEach {
      assertFalse(ConversationSharePolicy.validArtifact(it))
    }
    assertTrue(ConversationSharePolicy.validRequest("share-1793680000000-12"))
    assertFalse(ConversationSharePolicy.validRequest("../../file"))
  }
  @Test fun utf8PayloadAndBitmapLimitsFailBeforeAllocation() {
    ConversationSharePolicy.requirePayload("a".repeat(262144))
    assertThrows(ConversationShareFailure::class.java) { ConversationSharePolicy.requirePayload("a".repeat(262145)) }
    // Chinese text consumes UTF-8 bytes even when JS UTF-16 length looks small.
    assertThrows(ConversationShareFailure::class.java) { ConversationSharePolicy.requirePayload("中".repeat(90000)) }
    ConversationSharePolicy.requireHeight(12000)
    assertThrows(ConversationShareFailure::class.java) { ConversationSharePolicy.requireHeight(12001) }
    assertEquals(43200000, ConversationSharePolicy.WIDTH * ConversationSharePolicy.MAX_HEIGHT * 4)
  }
  @Test fun dispatchedFileLeaseCannotBeReleasedBeforeReceiverReads() {
    assertTrue(ConversationSharePolicy.leaseActive(1000, 1000))
    assertTrue(ConversationSharePolicy.leaseActive(1000, 600999))
    assertFalse(ConversationSharePolicy.leaseActive(1000, 601000))
    assertFalse(ConversationSharePolicy.leaseActive(null, 1500))
    assertFalse(ConversationSharePolicy.leaseActive(2000, 1000))
  }
  @Test fun retainedFilesAndBytesIncludeDispatchedAndOrphanBackpressure() {
    assertTrue(ConversationSharePolicy.cacheHasCapacity(7, 56L * 1024 * 1024))
    assertFalse(ConversationSharePolicy.cacheHasCapacity(8, 1024))
    assertFalse(ConversationSharePolicy.cacheHasCapacity(1, 56L * 1024 * 1024 + 1))
    assertFalse(ConversationSharePolicy.cacheHasCapacity(9, 65L * 1024 * 1024))
  }
}
