package com.tomorrowai

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import java.util.concurrent.Executor
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

/** Explicit user action: bundled OCR, no upload and no library permission request. */
internal object AppSharedImageText {
  private val work = Semaphore(1)
  private val callbacks = Executor { runnable -> Thread(runnable, "TadaImageTextResult").start() }

  fun sampleSize(width: Int, height: Int): Int {
    require(width > 0 && height > 0 && width.toLong() * height <= 200_000_000L) { "图片尺寸过大或无法读取，请先裁剪再识别" }
    var sample = 1
    while ((max(width, height).toLong() + sample - 1) / sample > 2048) sample *= 2
    return sample
  }

  fun recognize(context: Context, uri: String, promise: Promise) {
    if (!work.tryAcquire()) {
      promise.reject("E_OCR_BUSY", "正在识别另一张图片，请稍后再试")
      return
    }
    Thread({
      var bitmap: Bitmap? = null
      var recognizer: TextRecognizer? = null
      try {
        val (file, generation) = AppInputStore.sharedImageFile(context, uri)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val options = BitmapFactory.Options().apply {
          inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight)
          inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        bitmap = BitmapFactory.decodeFile(file.path, options) ?: throw IllegalArgumentException("无法读取图片，请换一张清晰图片")
        val rotation = try {
          when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 0)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
          }
        } catch (_: Exception) { 0 }
        require(AppInputStore.generation(context) == generation) { "图片已被清理，请重新分享" }
        val capturedBitmap = bitmap
        val client = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        recognizer = client
        val task = client.process(InputImage.fromBitmap(capturedBitmap, rotation))
        val settled = AtomicBoolean(false)
        val handler = Handler(Looper.getMainLooper())
        val timeout = Runnable {
          if (settled.compareAndSet(false, true)) promise.reject("E_OCR_TIMEOUT", "识别暂未完成，请稍后重试或裁剪图片")
        }
        handler.postDelayed(timeout, 30_000)
        // Keep the bitmap alive until ML Kit really finishes, even if the UI timed out.
        task.addOnCompleteListener(callbacks) { result ->
          handler.removeCallbacks(timeout)
          try {
            if (settled.compareAndSet(false, true)) {
              val current = AppInputStore.sharedImageFile(context, uri)
              require(current.second == generation) { "图片已被清理，请重新分享" }
              if (!result.isSuccessful) {
                promise.reject("E_IMAGE_TEXT", "未能识别图片文字，请换一张清晰图片")
              } else {
                val text = result.result.text
                require(text.isNotBlank()) { "图片中没有识别到文字，可换一张清晰图片" }
                require(text.length <= 64_000) { "识别文字超过 64000 字，请裁剪图片后重试" }
                promise.resolve(text)
              }
            }
          } catch (error: IllegalArgumentException) {
            promise.reject("E_IMAGE_TEXT", error.message ?: "图片已不可读取，请重新分享")
          } catch (_: Exception) {
            promise.reject("E_IMAGE_TEXT", "图片已不可读取，请重新分享")
          } finally {
            client.close()
            capturedBitmap.recycle()
            work.release()
          }
        }
        // The completion listener now owns these resources.
        bitmap = null
        recognizer = null
      } catch (error: IllegalArgumentException) {
        bitmap?.recycle(); recognizer?.close(); work.release()
        promise.reject("E_IMAGE_TEXT", error.message ?: "无法读取分享图片")
      } catch (_: Exception) {
        bitmap?.recycle(); recognizer?.close(); work.release()
        promise.reject("E_IMAGE_TEXT", "无法读取分享图片，请重新分享或换一张图片")
      } catch (_: OutOfMemoryError) {
        bitmap?.recycle(); recognizer?.close(); work.release()
        promise.reject("E_IMAGE_TEXT", "图片占用内存过大，请裁剪图片后重试")
      }
    }, "TadaImageText").start()
  }
}
