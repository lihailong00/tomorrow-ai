package com.tomorrowai

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.os.SystemClock
import android.provider.OpenableColumns
import android.provider.Settings
import android.provider.MediaStore
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Android capabilities behind the shared platform port. */
class TomorrowPlatformModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val securePrefs = context.getSharedPreferences("tomorrow_secure", Context.MODE_PRIVATE)
  private val permissionPrefs = context.getSharedPreferences("tomorrow_permissions", Context.MODE_PRIVATE)
  private val attachmentDir get() = File(context.cacheDir, "attachments").apply { mkdirs() }
  private var pickerPromise: Promise? = null
  private var cameraPromise: Promise? = null
  private var cameraFile: File? = null
  private var recorder: MediaRecorder? = null
  private var recordingFile: File? = null
  private var recordingStartedAt = 0L
  private var recordingAutoStopped = false
  private var permissionBusy = false

  init {
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == CAPTURE_PHOTO) {
          val promise = cameraPromise ?: return
          val file = cameraFile
          cameraPromise = null; cameraFile = null
          if (file != null) try {
            context.revokeUriPermission(FileProvider.getUriForFile(context, context.packageName + ".attachments", file),
              Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
          } catch (_: Exception) { }
          if (resultCode != Activity.RESULT_OK || file == null || !file.isFile || file.length() == 0L) {
            file?.delete(); promise.resolve(null); return
          }
          if (file.length() > MAX_FILE_BYTES) {
            file.delete(); promise.reject("E_CAMERA", "照片过大，请降低拍照分辨率后重试"); return
          }
          promise.resolve(Arguments.createMap().apply {
            putString("uri", Uri.fromFile(file).toString()); putString("name", file.name)
            putString("mime_type", "image/jpeg"); putDouble("size", file.length().toDouble())
          })
          return
        }
        if (requestCode != PICK_DOCUMENT) return
        val promise = pickerPromise ?: return
        pickerPromise = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) { promise.resolve(null); return }
        Thread {
          try {
            var name = "document"
            var size = -1L
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
              if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
              }
            }
            require(size <= MAX_FILE_BYTES) { "所选文件最大 25 MB" }
            val file = File(attachmentDir, UUID.randomUUID().toString())
            try {
              context.contentResolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output ->
                  val buffer = ByteArray(8192)
                  var total = 0L
                  while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= MAX_FILE_BYTES) { "所选文件最大 25 MB" }
                    output.write(buffer, 0, count)
                  }
                }
              } ?: error("无法读取所选文件")
            } catch (error: Exception) { file.delete(); throw error }
            promise.resolve(Arguments.createMap().apply {
              putString("uri", android.net.Uri.fromFile(file).toString()); putString("name", name)
              putString("mime_type", context.contentResolver.getType(uri) ?: "application/octet-stream")
              putDouble("size", file.length().toDouble())
            })
          } catch (error: Exception) { promise.reject("E_DOCUMENT", error.message, error) }
        }.start()
      }
    })
  }

  override fun getName() = "TomorrowPlatform"
  private fun onUi(action: () -> Unit) { UiThreadUtil.runOnUiThread { action() } }

  @ReactMethod fun getSystemFontScale(promise: Promise) = onUi {
    // DeviceInfo caches its fontScale until host resume. A live configuration
    // change can already have resized EditText without refreshing JS Dimensions.
    val scale = (context.currentActivity?.resources ?: context.resources).configuration.fontScale
    promise.resolve(if (scale.isFinite() && scale > 0) scale.toDouble() else null)
  }

  private fun encryptionKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).build())
    }.generateKey()
  }

  @ReactMethod fun getSecureItem(key: String, promise: Promise) {
    try {
      val stored = securePrefs.getString(key, null) ?: run { promise.resolve(null); return }
      val parts = stored.split(':', limit = 2)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
      promise.resolve(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
    } catch (error: Exception) { promise.reject("E_SECURE_STORAGE", "安全凭据不可读取，请重新登录", error) }
  }

  @ReactMethod fun setSecureItem(key: String, value: String, promise: Promise) {
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, encryptionKey())
      val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
      val stored = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
      check(securePrefs.edit().putString(key, stored).commit()) { "安全凭据保存失败" }
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("E_SECURE_STORAGE", error.message, error) }
  }

  @ReactMethod fun removeSecureItem(key: String, promise: Promise) {
    if (securePrefs.edit().remove(key).commit()) promise.resolve(null)
    else promise.reject("E_SECURE_STORAGE", "安全凭据删除失败")
  }

  private fun withPermission(permission: String, promise: Promise, action: () -> Unit) {
    if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) { action(); return }
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台重试"); return }
    if (permissionBusy) { promise.reject("E_BUSY", "请先完成当前权限请求"); return }
    permissionBusy = true
    activity.requestPermissions(arrayOf(permission), PERMISSION_REQUEST, PermissionListener { _, _, results ->
      permissionBusy = false
      if (results.firstOrNull() == PackageManager.PERMISSION_GRANTED) action()
      else promise.reject("E_PERMISSION", "权限未授予，可在系统设置中开启")
      true
    })
  }

  @ReactMethod fun pickDocument(promise: Promise) = onUi { openDocument("*/*", promise) }
  @ReactMethod fun pickImage(promise: Promise) = onUi { openDocument("image/*", promise) }
  private fun openDocument(mimeType: String, promise: Promise) {
    val activity = context.currentActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台重试"); return }
    if (pickerPromise != null || cameraPromise != null) { promise.reject("E_BUSY", "请先完成当前图片或文件选择"); return }
    pickerPromise = promise
    try {
      activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = mimeType
      }, PICK_DOCUMENT)
    } catch (error: Exception) { pickerPromise = null; promise.reject("E_DOCUMENT", error.message, error) }
  }

  @ReactMethod fun capturePhoto(promise: Promise) = onUi {
    val activity = context.currentActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台重试"); return@onUi }
    if (cameraPromise != null || pickerPromise != null) { promise.reject("E_BUSY", "请先完成当前图片或文件选择"); return@onUi }
    val file = File(attachmentDir, "photo-${UUID.randomUUID()}.jpg")
    try {
      check(file.createNewFile()) { "无法创建照片" }
      val uri = FileProvider.getUriForFile(context, context.packageName + ".attachments", file)
      cameraPromise = promise; cameraFile = file
      activity.startActivityForResult(Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, uri)
        clipData = ClipData.newUri(context.contentResolver, "photo", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      }, CAPTURE_PHOTO)
    } catch (error: Exception) {
      cameraPromise = null; cameraFile = null; file.delete()
      promise.reject("E_CAMERA", "无法打开相机，可从“＋”选择图片", error)
    }
  }

  @ReactMethod fun readTextFile(uri: String, promise: Promise) {
    Thread {
      try {
        val parsed = Uri.parse(uri)
        require(parsed.scheme == "file") { "仅可读取刚选择的本机文件" }
        val file = File(parsed.path ?: "").canonicalFile
        require(file.parentFile == attachmentDir.canonicalFile) { "仅可读取刚选择的本机文件" }
        require(file.length() <= 120000) { "文字过长，请先选取需要记住的部分" }
        val decoder = Charsets.UTF_8.newDecoder()
          .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
          .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        val text = decoder.decode(java.nio.ByteBuffer.wrap(file.readBytes())).toString().removePrefix("\uFEFF")
        require(text.codePointCount(0, text.length) <= 10000) { "记忆最多 10,000 字，请先选取需要记住的部分" }
        promise.resolve(text)
      } catch (error: Exception) { promise.reject("E_TEXT", error.message ?: "请使用 UTF-8 文字文件", error) }
    }.start()
  }

  @Suppress("DEPRECATION")
  @ReactMethod fun startRecording(promise: Promise) = onUi {
    withPermission(Manifest.permission.RECORD_AUDIO, promise) {
      if (recorder != null) { promise.reject("E_RECORDING", "录音已开始"); return@withPermission }
      try {
        val file = File(attachmentDir, "voice-${System.currentTimeMillis()}.m4a")
        val nextRecorder = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        recorder = nextRecorder; recordingFile = file
        recordingAutoStopped = false
        nextRecorder.apply {
          setAudioSource(MediaRecorder.AudioSource.MIC); setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
          setAudioEncoder(MediaRecorder.AudioEncoder.AAC); setAudioEncodingBitRate(64000); setAudioSamplingRate(22050)
          setMaxDuration(120000)
          setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) recordingAutoStopped = true }
          setOutputFile(file.absolutePath); prepare(); start()
        }
        recordingStartedAt = SystemClock.elapsedRealtime(); promise.resolve(null)
      } catch (error: Exception) {
        recorder?.release(); recorder = null; recordingFile?.delete(); recordingFile = null
        promise.reject("E_RECORDING", error.message, error)
      }
    }
  }

  @ReactMethod fun stopRecording(promise: Promise) = onUi {
    val activeRecorder = recorder; val file = recordingFile
    if (activeRecorder == null || file == null) { promise.reject("E_RECORDING", "当前没有录音"); return@onUi }
    recorder = null; recordingFile = null
    try {
      if (!recordingAutoStopped) activeRecorder.stop()
      promise.resolve(Arguments.createMap().apply {
        putString("uri", android.net.Uri.fromFile(file).toString()); putString("name", file.name); putString("mime_type", "audio/mp4")
        putDouble("duration_ms", (SystemClock.elapsedRealtime() - recordingStartedAt).coerceAtMost(120000).toDouble())
        putDouble("size", file.length().toDouble())
      })
    } catch (error: Exception) { file.delete(); promise.reject("E_RECORDING", "录音过短或已中断，请重试", error) }
    finally { activeRecorder.release() }
  }

  @ReactMethod fun shareText(text: String, promise: Promise) = onUi {
    try {
      val activity = context.currentActivity ?: error("请在应用前台重试")
      activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
      }, "分享自 妥啦")); promise.resolve(null)
    } catch (error: Exception) { promise.reject("E_SHARE", error.message, error) }
  }

  @ReactMethod fun copyText(text: String, promise: Promise) = onUi {
    try {
      val activity = context.currentActivity ?: error("请在应用前台重试")
      val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
      clipboard.setPrimaryClip(ClipData.newPlainText("妥啦消息", text))
      promise.resolve(null)
    } catch (error: Exception) { promise.reject("E_CLIPBOARD", "复制失败，请使用选取文字重试", error) }
  }

  @ReactMethod fun prepareChatImage(uri: String, mimeType: String, name: String, promise: Promise) {
    Thread {
      var preparedFile: File? = null
      try {
        val sourceUri = Uri.parse(uri)
        require(sourceUri.scheme == "file") { "请重新选择图片" }
        val sourceFile = File(sourceUri.path ?: error("图片无法读取")).canonicalFile
        require(sourceFile.parentFile == attachmentDir.canonicalFile && sourceFile.isFile) { "请重新选择图片" }
        require(mimeType.equals("image/jpeg", true) || mimeType.equals("image/png", true)) { "请选择 JPEG 或 PNG 图片" }
        // Older Android builds keep the bounded original. The server still
        // validates the image before inference; current Android uses a copy.
        if (Build.VERSION.SDK_INT < 28) {
          require(sourceFile.length() <= 4L * 1024L * 1024L) { "请选择 4 MB 以内的图片" }
          promise.resolve(Arguments.createMap().apply {
            putString("uri", sourceUri.toString()); putString("name", name)
            putString("mime_type", mimeType.lowercase()); putDouble("size", sourceFile.length().toDouble())
          })
          return@Thread
        }
        val copy = PhotoAnalysisImage.create(context, sourceUri, mimeType.lowercase())
        val suffix = if (copy.mime == "image/png") ".png" else ".jpg"
        val output = File(attachmentDir, "chat-image-${UUID.randomUUID()}$suffix")
        preparedFile = output
        output.writeBytes(copy.bytes)
        val safeName = File(name).name.substringBeforeLast('.', "image").take(100).ifBlank { "image" } + suffix
        promise.resolve(Arguments.createMap().apply {
          putString("uri", Uri.fromFile(output).toString()); putString("name", safeName)
          putString("mime_type", copy.mime); putDouble("size", output.length().toDouble())
        })
      } catch (error: Exception) {
        preparedFile?.delete()
        promise.reject("E_IMAGE_PREPARE", "图片准备失败，请选择清晰的 JPEG 或 PNG 图片后重试。原图片未修改。", error)
      }
    }.start()
  }

  private fun notificationPermissionState(): String {
    if (NotificationManagerCompat.from(context).areNotificationsEnabled()) return "granted"
    // Before Android 13 notification access can only be changed in system settings.
    if (Build.VERSION.SDK_INT < 33) return "blocked"
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return "blocked"
    val activity = context.currentActivity ?: return "requestable"
    return if (permissionPrefs.getBoolean("notifications_requested", false) &&
      !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) "blocked" else "requestable"
  }

  @ReactMethod fun notificationPermissionStatus(promise: Promise) = onUi {
    promise.resolve(notificationPermissionState())
  }

  @ReactMethod fun requestNotifications(promise: Promise) = onUi {
    if (Build.VERSION.SDK_INT < 33 || notificationPermissionState() != "requestable") {
      promise.resolve(NotificationManagerCompat.from(context).areNotificationsEnabled()); return@onUi
    }
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台重试"); return@onUi }
    if (permissionBusy) { promise.reject("E_BUSY", "请先完成当前权限请求"); return@onUi }
    permissionBusy = true
    try {
      activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST, PermissionListener { _, _, results ->
        permissionBusy = false
        // An empty result can mean the dialog was dismissed; it is still requestable.
        if (results.isNotEmpty()) permissionPrefs.edit().putBoolean("notifications_requested", true).apply()
        promise.resolve(NotificationManagerCompat.from(context).areNotificationsEnabled())
        true
      })
    } catch (error: Exception) {
      permissionBusy = false
      promise.reject("E_PERMISSION", "无法打开通知授权，请重试或使用系统通知设置", error)
    }
  }

  @ReactMethod fun openNotificationSettings(promise: Promise) = onUi {
    val activity = context.currentActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台重试"); return@onUi }
    val intents = listOf(
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
    )
    for (intent in intents) {
      try { activity.startActivity(intent); promise.resolve(null); return@onUi }
      catch (_: Exception) { /* Some Android variants only expose app details. */ }
    }
    promise.reject("E_SETTINGS", "无法打开系统设置，请在系统设置中找到妥啦并开启通知")
  }

  @ReactMethod fun showNotification(title: String, body: String, promise: Promise) {
    try {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) { promise.reject("E_PERMISSION", "通知权限未开启"); return }
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "任务与简报", NotificationManager.IMPORTANCE_DEFAULT))
      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val pending = PendingIntent.getActivity(context, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notification = NotificationCompat.Builder(context, CHANNEL_ID).setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(pending).setAutoCancel(true).build()
      NotificationManagerCompat.from(context).notify(SystemClock.uptimeMillis().toInt(), notification); promise.resolve(null)
    } catch (error: Exception) { promise.reject("E_NOTIFICATION", error.message, error) }
  }

  @ReactMethod fun clearCache(promise: Promise) {
    if (recorder != null) { promise.reject("E_BUSY", "请先结束录音"); return }
    attachmentDir.listFiles()?.forEach { it.delete() }; promise.resolve(null)
  }

  override fun invalidate() {
    recorder?.release(); recorder = null; recordingFile?.delete(); recordingFile = null
    pickerPromise?.reject("E_CANCELLED", "应用已关闭文件选择"); pickerPromise = null
    super.invalidate()
  }

  companion object {
    private const val KEY_ALIAS = "tomorrow.session.v1"
    private const val PICK_DOCUMENT = 1401
    private const val PERMISSION_REQUEST = 1402
    private const val CAPTURE_PHOTO = 1403
    private const val CHANNEL_ID = "tomorrow_tasks"
    private const val MAX_FILE_BYTES = 25L * 1024L * 1024L
  }
}
