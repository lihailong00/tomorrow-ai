package com.tomorrowai

import java.security.MessageDigest

internal object PhoneSourcePolicy {
  fun limit(source: String) = if (source == "contacts") 200 else 100
  fun normalizeNumber(value: String): String = value.filter { it.isDigit() }.removePrefix("0086").let { if (it.length == 13 && it.startsWith("86")) it.drop(2) else it }
  fun maskNumber(value: String): String = value.replace(Regex("(?<!\\d)(?:\\+?86[- ]?)?(1[3-9]\\d{9})(?!\\d)")) { it.groupValues[1].take(3) + "****" + it.groupValues[1].takeLast(4) }.take(120)
  fun includeSms(text: String) = text.isNotBlank() && !AppInputStore.isSensitive(text) && !Regex("退订[回回复]*[TtDdNn]|回复[TtDdNn]退订|unsubscribe", RegexOption.IGNORE_CASE).containsMatchIn(text)
  fun digest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
