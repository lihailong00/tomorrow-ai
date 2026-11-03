package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class VaultCryptoTest {
  @Test fun recoveryAndCipherRoundTripWithoutPlaintext() {
    val key = VaultCrypto.newKey()
    val plain = "{\"number\":\"0000000000001234\",\"address\":\"示例地址\"}".toByteArray()
    val first = VaultCrypto.seal(key, plain)
    val second = VaultCrypto.seal(key, plain)
    assertNotEquals(first.iv, second.iv)
    assertNotEquals(first.ciphertext, second.ciphertext)
    assertFalse(first.ciphertext.contains("0000000000001234"))
    assertArrayEquals(key, VaultCrypto.recoveryKey(VaultCrypto.recovery(key)))
    assertArrayEquals(plain, VaultCrypto.open(key, first))
  }
  @Test fun anotherKeyCannotDecrypt() {
    val sealed = VaultCrypto.seal(VaultCrypto.newKey(), "secret".toByteArray())
    assertThrows(IllegalArgumentException::class.java) { VaultCrypto.open(VaultCrypto.newKey(), sealed) }
  }
  @Test fun modifiedCiphertextAndHeaderAreRejected() {
    val key = VaultCrypto.newKey()
    val sealed = VaultCrypto.seal(key, "secret".toByteArray())
    val bytes = java.util.Base64.getDecoder().decode(sealed.ciphertext)
    bytes[0] = (bytes[0].toInt() xor 1).toByte()
    assertThrows(Exception::class.java) { VaultCrypto.open(key, sealed.copy(ciphertext = java.util.Base64.getEncoder().encodeToString(bytes))) }
    assertThrows(Exception::class.java) { VaultCrypto.open(key, sealed.copy(kid = "0".repeat(32))) }
  }
  @Test fun malformedRecoveryAndOversizeInputAreRejected() {
    assertThrows(Exception::class.java) { VaultCrypto.recoveryKey("123456") }
    assertThrows(Exception::class.java) { VaultCrypto.seal(VaultCrypto.newKey(), ByteArray(VaultCrypto.MAX_PLAIN_BYTES + 1)) }
  }
  @Test fun recoveryAcceptsCopiedWhitespaceAndLowercaseWithoutChangingTheKey() {
    val key = VaultCrypto.newKey()
    val copied = " \t" + VaultCrypto.recovery(key).lowercase().replace("-", "-\r\n \t") + "\n"
    assertArrayEquals(key, VaultCrypto.recoveryKey(copied))
  }
}
