package com.tomorrowai

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Portable vault format; Android Keystore only wraps the random data key. */
data class SealedVaultData(val kid: String, val iv: String, val ciphertext: String)

object VaultCrypto {
  const val MAX_PLAIN_BYTES = 196608
  private val random = SecureRandom()
  fun newKey(): ByteArray = ByteArray(32).also { random.nextBytes(it) }
  fun fingerprint(key: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(key).take(16).joinToString("") { "%02x".format(it.toInt() and 255) }
  fun recovery(key: ByteArray): String {
    require(key.size == 32)
    return "TV1-" + key.joinToString("") { "%02X".format(it.toInt() and 255) }.chunked(8).joinToString("-")
  }
  fun recoveryKey(value: String): ByteArray {
    val normalized = value.replace(Regex("\\s+"), "").uppercase()
    require(normalized.startsWith("TV1-")) { "恢复密钥格式不正确" }
    val hex = normalized.removePrefix("TV1-").replace("-", "")
    require(hex.matches(Regex("[0-9A-F]{64}"))) { "恢复密钥格式不正确" }
    return ByteArray(32) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
  fun seal(key: ByteArray, plain: ByteArray): SealedVaultData {
    require(key.size == 32 && plain.size <= MAX_PLAIN_BYTES)
    val kid = fingerprint(key)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
    cipher.updateAAD("tada-private-vault:v1:$kid".toByteArray())
    return SealedVaultData(kid, Base64.getEncoder().encodeToString(cipher.iv),
      Base64.getEncoder().encodeToString(cipher.doFinal(plain)))
  }
  fun open(key: ByteArray, data: SealedVaultData): ByteArray {
    require(key.size == 32 && data.kid == fingerprint(key)) { "恢复密钥与这份备份不匹配" }
    require(data.ciphertext.length <= 262168)
    val iv = Base64.getDecoder().decode(data.iv)
    val encrypted = Base64.getDecoder().decode(data.ciphertext)
    require(iv.size == 12 && encrypted.size in 16..(MAX_PLAIN_BYTES + 16))
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    cipher.updateAAD("tada-private-vault:v1:${data.kid}".toByteArray())
    return cipher.doFinal(encrypted)
  }
}
