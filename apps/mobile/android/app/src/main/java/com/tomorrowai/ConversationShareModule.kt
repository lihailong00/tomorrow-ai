package com.tomorrowai

import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.common.LifecycleState
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** User-initiated local PNG export with opaque, short-lived artifact handles. */
class ConversationShareModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(3)) { task ->
    Thread(task, "tada-conversation-share").apply { isDaemon = true }
  }
  private val directory = File(context.cacheDir, "conversation-share")
  private var generation = 0L
  private var closed = false
  private class Request(val id: String, val generation: Long, val promise: Promise) {
    val cancelled = AtomicBoolean(false)
    val settled = AtomicBoolean(false)
  }
  private class Artifact(val id: String, val file: File, val generation: Long, val created: Long) {
    var dispatchedAt: Long? = null
    var released = false
  }
  private val requests = mutableMapOf<String, Request>()
  private val artifacts = mutableMapOf<String, Artifact>()
  private val cleanupTask = Runnable { cleanupExpired() }

  override fun getName() = "TadaConversationShare"
  init {
    // This module exclusively owns UUID-named PNG/tmp files in this directory.
    try { directory.mkdir(); sweepOwnedOrphans() } catch (_: Exception) { /* Export reports an unavailable cache without breaking startup. */ }
    scheduleCleanup()
  }
  private fun foreground() = !closed && context.lifecycleState == LifecycleState.RESUMED && context.currentActivity?.let { !it.isFinishing && !it.isDestroyed } == true
  private fun owned(file: File): Boolean = try { file.canonicalFile.parentFile == directory.canonicalFile && !java.nio.file.Files.isSymbolicLink(file.toPath()) } catch (_: Exception) { false }
  private fun deleteOwned(file: File) { try { if (owned(file)) file.delete() } catch (_: Exception) {} }
  private fun cacheFiles(): List<File> {
    try { return directory.listFiles()?.filter { file ->
      (file.extension == "png" || file.extension == "tmp") && ConversationSharePolicy.validArtifact(file.nameWithoutExtension) && owned(file) && file.isFile
    } ?: emptyList() } catch (_: Exception) { throw ConversationShareFailure("UNAVAILABLE") }
  }
  private fun requireCacheCapacity() {
    val files = cacheFiles()
    if (!ConversationSharePolicy.cacheHasCapacity(files.size, files.sumOf { it.length() })) throw ConversationShareFailure("BUSY")
  }
  private fun sweepOwnedOrphans() {
    val wall = System.currentTimeMillis()
    cacheFiles().forEach { file ->
      if (!artifacts.containsKey(file.nameWithoutExtension) && wall - file.lastModified() >= ConversationSharePolicy.LEASE_MILLIS) deleteOwned(file)
    }
  }
  private fun check(request: Request) {
    synchronized(lock) {
      if (closed || request.cancelled.get() || request.generation != generation || requests[request.id] !== request) throw ConversationShareFailure("CANCELLED")
    }
  }
  private fun fail(request: Request, kind: String) {
    synchronized(lock) { if (requests[request.id] === request) requests.remove(request.id) }
    if (request.settled.compareAndSet(false, true)) request.promise.reject("E_SHARE_$kind", "分享处理未完成")
  }
  private fun reject(promise: Promise, error: Throwable) {
    val kind = (error as? ConversationShareFailure)?.kind ?: if (error is OutOfMemoryError) "TOO_LARGE" else "UNAVAILABLE"
    promise.reject("E_SHARE_$kind", "分享处理未完成")
  }
  private fun execute(promise: Promise, task: () -> Unit) {
    try { executor.execute { try { task() } catch (error: Throwable) { reject(promise, error) } } }
    catch (_: RejectedExecutionException) { promise.reject("E_SHARE_BUSY", "正在处理其他长图") }
  }
  @ReactMethod fun prepare(requestId: String, payload: String, promise: Promise) {
    if (!ConversationSharePolicy.validRequest(requestId)) { promise.reject("E_SHARE_UNAVAILABLE", "无效请求"); return }
    try { ConversationSharePolicy.requirePayload(payload) } catch (error: Throwable) { reject(promise, error); return }
    val request = synchronized(lock) {
      if (closed) { promise.reject("E_SHARE_CANCELLED", "页面已关闭"); return }
      if (requests.containsKey(requestId) || requests.size >= 3 || artifacts.values.count { !it.released } >= ConversationSharePolicy.MAX_ACTIVE_FILES) {
        promise.reject("E_SHARE_BUSY", "正在处理其他长图"); return
      }
      try { requireCacheCapacity() } catch (error: Throwable) { reject(promise, error); return }
      Request(requestId, generation, promise).also { requests[requestId] = it }
    }
    try {
      executor.execute {
        var temp: File? = null
        var output: File? = null
        var bitmap: android.graphics.Bitmap? = null
        try {
          check(request)
          synchronized(lock) { requireCacheCapacity() }
          val plan = ConversationShareRenderer.plan(payload) { check(request) }
          val generated = plan.render { check(request) }; bitmap = generated
          check(request)
          if (!directory.isDirectory && !directory.mkdir()) throw ConversationShareFailure("UNAVAILABLE")
          val id = UUID.randomUUID().toString()
          val temporary = File(directory, "$id.tmp"); val completed = File(directory, "$id.png")
          temp = temporary; output = completed
          if (!owned(temporary) || !owned(completed)) throw ConversationShareFailure("UNAVAILABLE")
          FileOutputStream(temporary).use { stream -> if (!generated.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)) throw ConversationShareFailure("UNAVAILABLE") }
          generated.recycle(); bitmap = null
          check(request)
          if (temporary.length() !in 1..ConversationSharePolicy.MAX_PNG_BYTES) throw ConversationShareFailure("TOO_LARGE")
          if (!temporary.renameTo(completed)) throw ConversationShareFailure("UNAVAILABLE")
          val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", completed)
          synchronized(lock) {
            check(request)
            if (artifacts.values.count { !it.released } >= ConversationSharePolicy.MAX_ACTIVE_FILES) throw ConversationShareFailure("BUSY")
            artifacts[id] = Artifact(id, completed, request.generation, SystemClock.elapsedRealtime())
            requests.remove(requestId)
            if (request.settled.compareAndSet(false, true)) request.promise.resolve(Arguments.createMap().apply {
              putString("id", id); putString("uri", uri.toString()); putInt("width", ConversationSharePolicy.WIDTH)
              putInt("height", plan.height); putDouble("size", completed.length().toDouble())
            })
          }
          output = null // Registry now owns the finished file.
        } catch (error: Throwable) {
          fail(request, (error as? ConversationShareFailure)?.kind ?: if (error is OutOfMemoryError) "TOO_LARGE" else "UNAVAILABLE")
        } finally {
          bitmap?.recycle()
          temp?.let { deleteOwned(it) }; output?.let { deleteOwned(it) }
        }
      }
    } catch (_: RejectedExecutionException) { fail(request, "BUSY") }
  }
  @ReactMethod fun cancel(requestId: String, promise: Promise) {
    val request = synchronized(lock) { requests[requestId]?.also { it.cancelled.set(true) } }
    if (request != null) fail(request, "CANCELLED")
    promise.resolve(null)
  }
  private fun find(id: String, expectedGeneration: Long): Artifact {
    if (!ConversationSharePolicy.validArtifact(id)) throw ConversationShareFailure("EXPIRED")
    val artifact = artifacts[id] ?: throw ConversationShareFailure("EXPIRED")
    if (closed || generation != expectedGeneration || artifact.generation != generation || artifact.released ||
      SystemClock.elapsedRealtime() - artifact.created >= ConversationSharePolicy.LEASE_MILLIS || !owned(artifact.file) || !artifact.file.isFile) throw ConversationShareFailure("EXPIRED")
    return artifact
  }
  @ReactMethod fun share(id: String, promise: Promise) {
    val expectedGeneration = synchronized(lock) { generation }
    main.post {
      try {
        synchronized(lock) {
          val artifact = find(id, expectedGeneration)
          if (!foreground()) throw ConversationShareFailure("FOREGROUND")
          val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", artifact.file)
          val intent = Intent(Intent.ACTION_SEND).apply {
            type = "image/png"; putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri("妥啦对话", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          val chooser = Intent.createChooser(intent, "分享对话").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          // Mark and launch under the epoch lock: cancellation can invalidate
          // pending work, never a chooser the user has already asked to open.
          context.currentActivity!!.startActivity(chooser)
          artifact.dispatchedAt = SystemClock.elapsedRealtime()
          artifact.file.setLastModified(System.currentTimeMillis()) // Preserve the receiver lease across process recreation.
          promise.resolve(null)
        }
      } catch (error: Throwable) { reject(promise, error) }
    }
  }
  @ReactMethod fun save(id: String, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { promise.reject("E_SHARE_UNSUPPORTED", "此系统请通过分享面板保存图片"); return }
    val expectedGeneration = synchronized(lock) { generation }
    if (!foreground()) { promise.reject("E_SHARE_FOREGROUND", "请回到应用前台"); return }
    execute(promise) {
      val file = synchronized(lock) { find(id, expectedGeneration).file }
      var destination: Uri? = null
      var committed = false
      try {
        synchronized(lock) { find(id, expectedGeneration) }
        val values = ContentValues().apply {
          put(MediaStore.Images.Media.DISPLAY_NAME, "Tada-${UUID.randomUUID()}.png")
          put(MediaStore.Images.Media.MIME_TYPE, "image/png")
          put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Tada")
          put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val targetUri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: throw ConversationShareFailure("UNAVAILABLE")
        destination = targetUri
        context.contentResolver.openOutputStream(targetUri)?.use { target -> file.inputStream().use { source -> source.copyTo(target) } } ?: throw ConversationShareFailure("UNAVAILABLE")
        synchronized(lock) {
          find(id, expectedGeneration)
          if (!foreground()) throw ConversationShareFailure("FOREGROUND")
          if (context.contentResolver.update(targetUri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) != 1) throw ConversationShareFailure("UNAVAILABLE")
          committed = true
          promise.resolve(null)
        }
      } finally { if (!committed) destination?.let { try { context.contentResolver.delete(it, null, null) } catch (_: Exception) {} } }
    }
  }
  @ReactMethod fun release(id: String, promise: Promise) {
    synchronized(lock) {
      artifacts[id]?.let { artifact ->
        artifact.released = true
        // Android's chooser may hand the URI to a receiver after the app closes
        // its preview. Keep exactly this user-authorized file for a short lease.
        if (!ConversationSharePolicy.leaseActive(artifact.dispatchedAt, SystemClock.elapsedRealtime())) {
          deleteOwned(artifact.file); artifacts.remove(id)
        }
      }
    }
    promise.resolve(null)
  }
  @ReactMethod fun cancelAll(promise: Promise) { cancelOwned(); promise.resolve(null) }
  private fun cancelOwned() {
    synchronized(lock) {
      generation++
      requests.values.toList().forEach { it.cancelled.set(true); fail(it, "CANCELLED") }
      artifacts.values.toList().forEach { artifact ->
        artifact.released = true
        if (!ConversationSharePolicy.leaseActive(artifact.dispatchedAt, SystemClock.elapsedRealtime())) {
          deleteOwned(artifact.file); artifacts.remove(artifact.id)
        }
      }
      try { sweepOwnedOrphans() } catch (_: Exception) {}
    }
  }
  private fun cleanupExpired() {
    try {
      synchronized(lock) {
        val now = SystemClock.elapsedRealtime()
        artifacts.values.toList().forEach { artifact ->
          if (now - artifact.created >= ConversationSharePolicy.LEASE_MILLIS && !ConversationSharePolicy.leaseActive(artifact.dispatchedAt, now)) {
            deleteOwned(artifact.file); artifacts.remove(artifact.id)
          }
        }
        sweepOwnedOrphans()
      }
    } catch (_: Exception) { /* A later foreground export can report the cache error. */ }
    scheduleCleanup()
  }
  private fun scheduleCleanup() { if (!closed) main.postDelayed(cleanupTask, 60000) }
  override fun invalidate() {
    closed = true; main.removeCallbacks(cleanupTask); cancelOwned(); executor.shutdownNow(); super.invalidate()
  }
}
