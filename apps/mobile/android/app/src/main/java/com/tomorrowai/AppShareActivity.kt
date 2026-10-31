package com.tomorrowai

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.provider.OpenableColumns
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Semaphore

/** Explicit Android ShareSheet target; copied data remains local until reviewed. */
class AppShareActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (intent?.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE) || !activeShares.tryAcquire()) {
      finish(); return
    }
    val input = intent
    val source = AppInputStore.sourceId(callingPackage ?: referrer?.takeIf { it.scheme == "android-app" }?.host)
    val generation = AppInputStore.generation(this)
    Thread {
      val copiedFiles = mutableListOf<File>()
      try {
        val title = input.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString().orEmpty().take(200)
        val text = input.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty().take(8000)
        @Suppress("DEPRECATION")
        val streams = if (input.action == Intent.ACTION_SEND_MULTIPLE) {
          input.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        } else {
          listOfNotNull(input.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        }
        require(streams.size <= 5) { "一次最多分享 5 个文件" }
        require(text.isNotBlank() || streams.isNotEmpty()) { "未收到可导入的文字或文件" }
        val clipUris = input.clipData?.let { clip ->
          (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri?.toString() }.toSet()
        }.orEmpty()
        val hasReadGrant = input.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0
        val captured = System.currentTimeMillis()
        var totalBytes = 0L
        // Keep captions independent from files: reviewing one must not discard the other.
        val entries = (if (text.isNotBlank()) listOf<Uri?>(null) else emptyList()) + streams
        val items = entries.map { uri ->
          JSONObject().apply {
            put("id", "share-" + UUID.randomUUID()); put("source_app", source); put("kind", "share")
            put("title", title.ifBlank { "分享给妥啦" }); put("text", if (uri == null) text else "")
            put("created_at", Instant.ofEpochMilli(captured).toString()); put("created_ms", captured)
            if (uri == null) firstWebUrl(text)?.let { put("url", it) }
            if (uri != null) {
              // Only temporary, user-granted content URIs are read. No arbitrary file/network paths.
              require(AppInputStore.isGrantedContentShare(uri.toString(), hasReadGrant, clipUris)) { "请通过系统分享文件并允许读取" }
              require(checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED) { "没有分享文件的读取权限" }
              var name = "分享文件"
              var reportedSize = -1L
              contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                  val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                  val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                  if (nameIndex >= 0) name = cursor.getString(nameIndex).orEmpty().takeLast(180).substringAfterLast('/').substringAfterLast('\\').ifBlank { name }
                  if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) reportedSize = cursor.getLong(sizeIndex)
                }
              }
              require(reportedSize <= AppInputStore.MAX_FILE_BYTES) { "分享文件合计不能超过 20 MB" }
              val file = File(AppInputStore.cacheDir(this@AppShareActivity), UUID.randomUUID().toString())
              copiedFiles.add(file)
              val started = System.nanoTime()
              contentResolver.openInputStream(uri)?.use { stream ->
                file.outputStream().use { output ->
                  val buffer = ByteArray(8192)
                  while (true) {
                    require(System.nanoTime() - started < 30_000_000_000L) { "读取文件超时" }
                    val count = stream.read(buffer)
                    if (count < 0) break
                    totalBytes += count
                    require(totalBytes <= AppInputStore.MAX_FILE_BYTES) { "分享文件合计不能超过 20 MB" }
                    output.write(buffer, 0, count)
                  }
                }
              } ?: error("无法读取分享文件")
              if (title.isBlank()) put("title", name)
              put("file", JSONObject().apply {
                put("uri", Uri.fromFile(file).toString()); put("name", name)
                put("mime_type", contentResolver.getType(uri)?.take(120) ?: "application/octet-stream")
                put("size", file.length())
              })
            }
          }
        }
        val accepted = AppInputStore.addShares(this, items, generation)
        if (!accepted) copiedFiles.forEach { it.delete() }
        runOnUiThread {
          if (accepted) {
            Toast.makeText(this, "已加入本机待处理，请在应用连接中确认导入", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
          }
          finish()
        }
      } catch (_: Exception) {
        copiedFiles.forEach { it.delete() }
        runOnUiThread {
          Toast.makeText(this, "无法接收分享：最多 5 个文件，合计 20 MB；可改为复制文字后导入", Toast.LENGTH_LONG).show()
          finish()
        }
      } finally { activeShares.release() }
    }.start()
  }

  companion object {
    private val activeShares = Semaphore(2)
    private fun firstWebUrl(text: String): String? {
      val candidate = Regex("https?://[^\\s<>\\\"]+", RegexOption.IGNORE_CASE).find(text)?.value?.take(2048) ?: return null
      return try { Uri.parse(candidate).takeIf { !it.host.isNullOrBlank() && it.userInfo == null }?.toString() }
      catch (_: Exception) { null }
    }
  }
}
