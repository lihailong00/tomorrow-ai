package com.tomorrowai

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.facebook.react.bridge.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** No plaintext SharedPreferences, AsyncStorage, logs, provider calls or fallback. */
class PrivateVaultModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val worker = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private var prompt: CancellationSignal? = null
  private var pendingCredential: (() -> Unit)? = null
  @Volatile private var pendingPromise: Promise? = null
  private var credentialRequestCode = -1
  private var nextCredentialRequest = 7319
  @Volatile private var generation = 0L
  @Volatile private var protectedScope: String? = null
  private val documentNumberTypes = setOf("social_security", "medical_insurance", "passport", "driver_license", "travel_permit", "residence_permit")
  private val fields = mapOf(
    "address" to listOf("owner", "phone", "address"),
    "bank" to listOf("bank", "owner", "number", "branch"),
    "identity" to listOf("owner", "number", "validUntil")
  ) + (documentNumberTypes + setOf("phone", "email")).associateWith { listOf("owner", "number") }

  init {
    context.addLifecycleEventListener(object : LifecycleEventListener {
      override fun onHostResume() {}
      override fun onHostPause() {}
      override fun onHostDestroy() {
        generation++; prompt?.cancel(); pendingCredential = null; credentialRequestCode = -1
        finishError("系统验证已中断，请回到资料页面重试")
      }
    })
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != credentialRequestCode) return
        credentialRequestCode = -1
        val resume = pendingCredential ?: return
        pendingCredential = null
        if (resultCode == Activity.RESULT_OK) resume()
        else finishError("已取消身份验证")
      }
    })
  }

  override fun getName() = "PrivateVault"
  private fun identifier(scope: String): String {
    require(scope.length in 3..2048) { "资料所属账号无效" }
    return MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
  }
  private fun file(scope: String) = AtomicFile(File(File(context.noBackupFilesDir, "private-vault").apply { mkdirs() }, identifier(scope) + ".json"))
  private fun read(scope: String): JSONObject? {
    val storage = file(scope)
    val backup = File(storage.baseFile.path + ".bak")
    if (!storage.baseFile.exists() && !backup.exists()) return null
    require((if (backup.exists()) backup else storage.baseFile).length() <= 400000) { "资料库文件过大" }
    return JSONObject(storage.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
  }
  private fun write(scope: String, value: JSONObject) {
    val bytes = value.toString().toByteArray()
    require(bytes.size <= 400000) { "资料库容量已达上限" }
    val storage = file(scope)
    val output = storage.startWrite()
    try { output.write(bytes); storage.finishWrite(output) }
    catch (failure: Exception) { storage.failWrite(output); throw failure }
  }
  private fun deviceKey(scope: String, create: Boolean): SecretKey {
    val alias = "tada.private-vault.v1." + identifier(scope)
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    check(create) { "本机密钥不可用，请使用恢复密钥恢复云端备份" }
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256).setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(true)
    if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(60, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
    else { @Suppress("DEPRECATION") spec.setUserAuthenticationValidityDurationSeconds(60) }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec.build()) }.generateKey()
  }
  private fun wrap(scope: String, key: ByteArray): JSONObject {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, deviceKey(scope, true))
    cipher.updateAAD(scope.toByteArray())
    return JSONObject().put("iv", Base64.getEncoder().encodeToString(cipher.iv)).put("ciphertext", Base64.getEncoder().encodeToString(cipher.doFinal(key)))
  }
  private fun unwrap(scope: String, value: JSONObject): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    val wrapped = value.getJSONObject("wrapped_key")
    cipher.init(Cipher.DECRYPT_MODE, deviceKey(scope, false), GCMParameterSpec(128, Base64.getDecoder().decode(wrapped.getString("iv"))))
    cipher.updateAAD(scope.toByteArray())
    return cipher.doFinal(Base64.getDecoder().decode(wrapped.getString("ciphertext")))
  }
  private fun envelope(data: SealedVaultData) = JSONObject().put("schema", 1).put("algorithm", "A256GCM")
    .put("kid", data.kid).put("iv", data.iv).put("ciphertext", data.ciphertext)
  private fun sealed(value: JSONObject): SealedVaultData {
    require(value.getInt("schema") == 1 && value.getString("algorithm") == "A256GCM") { "不支持这份备份的加密格式" }
    return SealedVaultData(value.getString("kid"), value.getString("iv"), value.getString("ciphertext"))
  }
  private fun load(scope: String): Pair<JSONObject, ByteArray> {
    read(scope)?.let { return it to unwrap(scope, it) }
    val key = VaultCrypto.newKey()
    try {
      val outer = JSONObject().put("format", 1).put("wrapped_key", wrap(scope, key)).put("revision", UUID.randomUUID().toString())
        .put("backup_enabled", false).put("recovery_ready", false).put("consent_epoch", 0).put("remote_version", 0)
        .put("data", envelope(VaultCrypto.seal(key, JSONObject().put("schema", 1).put("items", JSONArray()).toString().toByteArray())))
      write(scope, outer)
      return outer to key
    } catch (failure: Exception) { key.fill(0); throw failure }
  }
  private fun document(outer: JSONObject, key: ByteArray): JSONObject {
    val plain = VaultCrypto.open(key, sealed(outer.getJSONObject("data")))
    try {
      val doc = JSONObject(plain.toString(Charsets.UTF_8))
      require(doc.getInt("schema") == 1 && doc.getJSONArray("items").length() <= 100) { "资料格式无效" }
      return doc
    } finally { plain.fill(0) }
  }
  private fun saveDocument(scope: String, outer: JSONObject, key: ByteArray, doc: JSONObject) {
    outer.put("data", envelope(VaultCrypto.seal(key, doc.toString().toByteArray())))
      .put("revision", UUID.randomUUID().toString())
    write(scope, outer)
  }
  /** Validate and decrypt first. A bad key must not initialize a blank vault. */
  private fun restoreDocument(scope: String, input: JSONObject): String {
    val recoveryKey = VaultCrypto.recoveryKey(input.getString("recovery_key"))
    try {
      val remoteVersion = input.getLong("remote_version")
      require(remoteVersion in 1..9007199254740991L) { "备份版本无效" }
      val restored = document(JSONObject().put("data", input.getJSONObject("envelope")), recoveryKey)
      val validated = JSONArray()
      val restoredItems = restored.getJSONArray("items")
      val seen = mutableSetOf<String>()
      for (index in 0 until restoredItems.length()) {
        val item = restoredItems.getJSONObject(index); val id = item.getString("id")
        require(id.length in 1..80 && seen.add(id)) { "备份中的资料编号无效" }
        validated.put(validateItem(item, id))
      }
      restored.put("items", validated)
      val existing = read(scope)
      if (existing != null) {
        val oldKey = unwrap(scope, existing)
        try { require(document(existing, oldKey).getJSONArray("items").length() == 0) { "恢复不会覆盖已有本机资料" } }
        finally { oldKey.fill(0) }
      }
      val outer = existing ?: JSONObject().put("format", 1)
      outer.put("wrapped_key", wrap(scope, recoveryKey)).put("backup_enabled", false)
        .put("recovery_ready", true).put("recovery_shown", true).put("remote_version", remoteVersion)
        .put("synced_revision", "").put("consent_epoch", outer.optLong("consent_epoch") + 1)
      saveDocument(scope, outer, recoveryKey, restored)
      return summaries(restored)
    } finally { recoveryKey.fill(0) }
  }
  private fun summaries(doc: JSONObject): String {
    val result = JSONArray()
    val records = doc.getJSONArray("items")
    for (index in 0 until records.length()) {
      val item = records.getJSONObject(index)
      val type = item.getString("type")
      val values = item.getJSONObject("fields")
      val summary = when (type) {
        "address" -> "完整收件地址已隐藏"
        "email" -> "邮箱地址已隐藏"
        else -> "尾号 " + values.optString("number").replace(" ", "").takeLast(4)
      }
      val entry = JSONObject().put("id", item.getString("id")).put("type", type).put("alias", item.getString("alias"))
        .put("summary", if (type == "bank") values.optString("bank") + " · " + summary else summary)
      if (type == "address") entry.put("has_contact_phone", values.optString("phone").isNotBlank())
      result.put(entry)
    }
    return result.toString()
  }
  private fun validateItem(input: JSONObject, id: String): JSONObject {
    val type = input.getString("type")
    val allowed = fields[type] ?: error("不支持的资料类型")
    val alias = input.getString("alias").trim()
    require(alias.length in 1..36) { "资料名称需要 1 至 36 个字" }
    val source = input.getJSONObject("fields")
    require(source.keys().asSequence().all { it in allowed }) { "资料包含不支持的字段" }
    val result = JSONObject()
    for (name in allowed) {
      val value = source.optString(name).trim()
      require(value.length <= if (name == "address") 500 else 120) { "资料字段过长" }
      result.put(name, value)
    }
    require(result.getString("owner").isNotBlank()) { "请填写姓名" }
    if (type == "bank") {
      require(result.getString("bank").isNotBlank()) { "请填写银行名称" }
      require(result.getString("number").replace(" ", "").matches(Regex("[0-9]{12,25}"))) { "请核对银行卡号格式" }
    }
    if (type == "identity") require(result.getString("number").uppercase().matches(Regex("[0-9]{17}[0-9X]"))) { "请填写 18 位身份证号码" }
    if (type == "address") require(result.getString("address").isNotBlank()) { "请填写完整地址" }
    if (type == "phone") require(result.getString("number").matches(Regex("(?:1[3-9][0-9]{9}|\\+[1-9][0-9]{7,14})"))) { "请核对手机号码格式" }
    if (type == "email") require(result.getString("number").matches(Regex("[a-zA-Z0-9.!#\$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)+"))) { "请核对邮箱地址格式" }
    if (type in documentNumberTypes) {
      val number = result.getString("number")
      require(number.matches(Regex("[a-zA-Z0-9-]{5,32}")) && number.any { it in '0'..'9' }) { "请核对证件或卡号格式" }
    }
    return JSONObject().put("id", id).put("type", type).put("alias", alias).put("fields", result)
  }
  private fun find(doc: JSONObject, id: String): JSONObject {
    val items = doc.getJSONArray("items")
    for (index in 0 until items.length()) if (items.getJSONObject(index).getString("id") == id) return items.getJSONObject(index)
    error("资料已不存在，请重新打开列表")
  }
  private fun secretText(item: JSONObject, share: Boolean, includeAddressContact: Boolean): String {
    val value = item.getJSONObject("fields")
    val type = item.getString("type")
    val selectedFields = when {
      type == "address" && (!share || !includeAddressContact) -> listOf("address")
      !share -> listOf("number")
      else -> fields.getValue(type)
    }
    return selectedFields.mapNotNull { value.optString(it).takeIf(String::isNotBlank) }.joinToString("\n")
  }
  private fun copySensitive(text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("私密资料", text)
    clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
    clipboard.setPrimaryClip(clip)
    main.postDelayed({ try { if (clipboard.primaryClip?.getItemAt(0)?.text?.toString() == text) clipboard.clearPrimaryClip() } catch (_: Exception) {} }, 30000)
  }
  private fun statusValue(outer: JSONObject?, available: Boolean): WritableMap = Arguments.createMap().apply {
    putBoolean("available", available); putBoolean("exists", outer != null)
    putBoolean("backup_enabled", outer?.optBoolean("backup_enabled") ?: false)
    putBoolean("recovery_ready", outer?.optBoolean("recovery_ready") ?: false)
    putDouble("remote_version", (outer?.optLong("remote_version") ?: 0).toDouble())
    putDouble("consent_epoch", (outer?.optLong("consent_epoch") ?: 0).toDouble())
    putString("revision", outer?.optString("revision") ?: "")
    putString("synced_revision", outer?.optString("synced_revision") ?: "")
  }

  @ReactMethod fun status(scope: String, promise: Promise) {
    worker.execute { try {
      val secure = (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceSecure
      promise.resolve(statusValue(read(scope), secure))
    } catch (_: Exception) { promise.reject("E_VAULT", "本机资料库暂时不可读取；不会覆盖已有资料") } }
  }
  /** Bind authenticated vault actions to the visible page and cancel them when it closes. */
  @ReactMethod fun setProtected(scope: String, enabled: Boolean, promise: Promise) = main.post {
    try {
      if (enabled) {
        checkNotNull(context.currentActivity) { "请在应用前台打开私密资料" }
        protectedScope = scope
      } else if (protectedScope == scope) {
        protectedScope = null; generation++; prompt?.cancel(); pendingCredential = null; credentialRequestCode = -1
        finishError("资料页面已关闭")
      }
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("E_VAULT_SCREEN", "无法打开资料页面，请在应用前台重试")
    }
  }.let { Unit }

  @ReactMethod fun snapshot(scope: String, promise: Promise) {
    worker.execute { try {
      val value = read(scope) ?: error("请先添加资料")
      check(value.optBoolean("backup_enabled")) { "云端备份已关闭" }
      promise.resolve(JSONObject().put("envelope", value.getJSONObject("data")).put("revision", value.getString("revision"))
        .put("consent_epoch", value.getLong("consent_epoch")).put("remote_version", value.optLong("remote_version")).toString())
    } catch (_: Exception) { promise.reject("E_VAULT_BACKUP", "没有可备份的资料，或云端备份已关闭") } }
  }
  @ReactMethod fun stopBackup(scope: String, promise: Promise) {
    worker.execute { try {
      read(scope)?.let { it.put("backup_enabled", false).put("consent_epoch", it.optLong("consent_epoch") + 1); write(scope, it) }
      promise.resolve(null)
    } catch (_: Exception) { promise.reject("E_VAULT_BACKUP", "停止备份失败，请重试") } }
  }
  @ReactMethod fun acknowledge(scope: String, version: Double, revision: String, epoch: Double, promise: Promise) {
    worker.execute { try {
      require(version >= 0 && version <= 9007199254740991.0 && version % 1 == 0.0)
      val value = read(scope) ?: error("资料库不存在")
      if (value.optLong("consent_epoch") == epoch.toLong()) {
        value.put("remote_version", version.toLong()).put("synced_revision", revision); write(scope, value)
      }
      promise.resolve(null)
    } catch (_: Exception) { promise.reject("E_VAULT_BACKUP", "备份状态保存失败，请重新检查云端副本") } }
  }

  @ReactMethod fun operate(scope: String, operation: String, payload: String, promise: Promise) = main.post {
    try {
      require(operation in listOf("list", "save", "linkPhone", "delete", "reveal", "copy", "share", "recovery", "copyRecovery", "configure", "restore", "authorizeDelete"))
      require(payload.length <= 400000)
      identifier(scope)
      check(protectedScope == scope) { "请在私密资料页面操作" }
      check(pendingPromise == null) { "请先完成当前身份验证" }
      val activity = context.currentActivity ?: error("请在应用前台重试")
      val manager = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      check(manager.isDeviceSecure) { "请先在系统设置中启用锁屏密码或指纹" }
      val epoch = generation
      pendingPromise = promise
      val success = {
        if (protectedScope != scope || generation != epoch) finishError("操作已取消", promise)
        else worker.execute {
          try {
            check(generation == epoch && protectedScope == scope && pendingPromise === promise)
            if (operation == "authorizeDelete") {
              main.post { if (generation == epoch && protectedScope == scope) finishSuccess(null, promise) else finishError("操作已取消", promise) }
              return@execute
            }
            val input = JSONObject(payload)
            if (operation == "restore") {
              val restored = restoreDocument(scope, input)
              main.post { if (generation == epoch && protectedScope == scope) finishSuccess(restored, promise) else finishError("操作已取消", promise) }
              return@execute
            }
            val (outer, key) = load(scope)
            try {
              val doc = document(outer, key)
              val items = doc.getJSONArray("items")
              var result: Any? = null
              when (operation) {
                "list" -> result = summaries(doc)
                "reveal" -> result = find(doc, input.getString("id")).toString()
                "save" -> {
                  val requestedId = input.optString("id")
                  val id = requestedId.ifBlank { UUID.randomUUID().toString() }
                  if (requestedId.isNotBlank()) find(doc, id)
                  val item = validateItem(input, id)
                  val next = JSONArray()
                  for (index in 0 until items.length()) if (items.getJSONObject(index).getString("id") != id) next.put(items.get(index))
                  require(next.length() < 100) { "最多保存 100 份资料" }; next.put(item); doc.put("items", next)
                  saveDocument(scope, outer, key, doc); result = summaries(doc)
                }
                "linkPhone" -> {
                  val phone = find(doc, input.getString("phone_id"))
                  val address = find(doc, input.getString("address_id"))
                  require(phone.getString("type") == "phone" && address.getString("type") == "address") { "请选择手机号和地址资料" }
                  val number = phone.getJSONObject("fields").getString("number")
                  val values = address.getJSONObject("fields")
                  val previous = values.optString("phone")
                  require(previous.isBlank() || previous == number) { "该地址已填写联系电话，请到私密资料中编辑" }
                  if (previous.isBlank()) {
                    values.put("phone", number)
                    saveDocument(scope, outer, key, doc)
                  }
                }
                "delete" -> {
                  val id = input.getString("id"); find(doc, id)
                  val next = JSONArray()
                  for (index in 0 until items.length()) if (items.getJSONObject(index).getString("id") != id) next.put(items.get(index))
                  doc.put("items", next); saveDocument(scope, outer, key, doc); result = summaries(doc)
                }
                "copy", "share" -> {
                  val text = secretText(find(doc, input.getString("id")), operation == "share", input.opt("include_address_contact") == true)
                  main.post {
                    if (protectedScope == scope && generation == epoch) {
                      try {
                        if (operation == "copy") copySensitive(text)
                        else activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "选择资料接收人"))
                        finishSuccess(null, promise)
                      } catch (_: Exception) { finishError("暂时无法复制或分享资料", promise) }
                    } else finishError("操作已取消", promise)
                  }
                  return@execute
                }
                "recovery", "copyRecovery" -> {
                  outer.put("recovery_shown", true); write(scope, outer)
                  val recovery = VaultCrypto.recovery(key)
                  if (operation == "copyRecovery") { main.post { try { check(generation == epoch && protectedScope == scope); copySensitive(recovery); finishSuccess(null, promise) } catch (_: Exception) { finishError("复制失败", promise) } }; return@execute }
                  result = recovery
                }
                "configure" -> {
                  require(input.optBoolean("acknowledged") && outer.optBoolean("recovery_shown")) { "请先保存恢复密钥" }
                  val remoteVersion = input.getLong("remote_version")
                  require(remoteVersion in 0..9007199254740991L)
                  outer.put("remote_version", remoteVersion).put("recovery_ready", true)
                  outer.put("backup_enabled", true).put("consent_epoch", outer.optLong("consent_epoch") + 1); write(scope, outer)
                }
              }
              main.post { if (generation == epoch && protectedScope == scope) finishSuccess(result, promise) else finishError("操作已取消", promise) }
            } finally { key.fill(0) }
          } catch (_: Exception) { main.post { finishError("资料操作失败，请核对输入、身份验证或恢复密钥；已有资料不会被覆盖", promise) } }
        }
      }
      if (Build.VERSION.SDK_INT >= 30) {
        prompt = CancellationSignal()
        BiometricPrompt.Builder(activity).setTitle("解锁妥啦私密资料").setSubtitle("验证身份后，仅执行本次资料操作")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
          .build().authenticate(prompt!!, context.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { success() }
            override fun onAuthenticationError(code: Int, message: CharSequence) { finishError("身份验证未完成，请重试或使用系统锁屏密码", promise) }
          })
      } else {
        @Suppress("DEPRECATION") val intent = manager.createConfirmDeviceCredentialIntent("解锁妥啦私密资料", "请输入系统锁屏密码") ?: error("系统身份验证暂时不可用")
        pendingCredential = success
        credentialRequestCode = nextCredentialRequest++
        @Suppress("DEPRECATION") activity.startActivityForResult(intent, credentialRequestCode)
      }
    } catch (_: Exception) { if (pendingPromise === promise) finishError("请先启用系统锁屏密码，并在资料页面完成身份验证") else promise.reject("E_VAULT_AUTH", "请先完成当前验证，或启用系统锁屏密码后重试") }
  }.let { Unit }
  private fun finishSuccess(value: Any?, expected: Promise? = pendingPromise) { if (pendingPromise !== expected) return; val promise = pendingPromise; pendingPromise = null; prompt = null; pendingCredential = null; promise?.resolve(value) }
  private fun finishError(message: String, expected: Promise? = pendingPromise) { if (pendingPromise !== expected) return; val promise = pendingPromise; pendingPromise = null; prompt = null; pendingCredential = null; promise?.reject("E_VAULT_AUTH", message) }
}
