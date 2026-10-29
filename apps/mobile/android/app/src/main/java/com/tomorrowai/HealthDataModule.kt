package com.tomorrowai

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.facebook.react.bridge.*
import com.facebook.react.common.LifecycleState
import kotlinx.coroutines.*
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID
import kotlin.reflect.KClass

/** No network, storage, sensor streaming, write permissions or background work. */
class HealthDataModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val readPending = AtomicBoolean(false)
  private val invalidated = AtomicBoolean(false)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val permissionContract = PermissionController.createRequestPermissionResultContract()
  // Accessed only on the UI queue. A no-owner registry registration is allowed
  // after STARTED; the explicit observer below owns cancellation/unregistration.
  private var pendingPermission: PermissionRequest? = null
  private class PermissionRequest(val promise: Promise, val metrics: List<String>, val owner: ComponentActivity) {
    var launcher: ActivityResultLauncher<Set<String>>? = null
    var destroyObserver: LifecycleEventObserver? = null
    var resumeListener: LifecycleEventListener? = null
    var timeout: Runnable? = null
    var granted: Set<String>? = null
  }
  override fun getName() = "TadaHealth"

  @ReactMethod fun availability(promise: Promise) {
    try {
      val status = HealthConnectClient.getSdkStatus(context)
      promise.resolve(Arguments.createMap().apply {
        putString("provider", "health_connect")
        putString("status", when (status) {
          HealthConnectClient.SDK_AVAILABLE -> "available"
          HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "requires_update"
          else -> "unavailable"
        })
        putString("detail", when (status) {
          HealthConnectClient.SDK_AVAILABLE -> "可读取已由其他应用写入Health Connect、且由你授权的健康数据"
          HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "需要安装或更新Health Connect；当前手机可能不支持"
          else -> "当前手机不支持Health Connect，可选择华为或小米官方连接"
        })
      })
    } catch (_: Exception) {
      promise.resolve(Arguments.createMap().apply {
        putString("provider", "health_connect")
        putString("status", "unavailable")
        putString("detail", "当前手机没有可用的Health Connect服务")
      })
    }
  }

  @ReactMethod fun requestReadPermissions(values: ReadableArray, promise: Promise) {
    val metrics = try { parseMetrics(values) } catch (_: Exception) {
      promise.reject("E_HEALTH_INPUT", "请选择有效的健康数据类型"); return
    }
    context.runOnUiQueueThread {
      var request: PermissionRequest? = null
      try {
        if (invalidated.get()) {
          promise.reject("E_HEALTH_CANCELLED", "健康权限请求已取消")
          return@runOnUiQueueThread
        }
        requireAvailable()
        val activity = context.currentActivity
        if (activity !is ComponentActivity || activity.isFinishing || activity.isDestroyed ||
            context.lifecycleState != LifecycleState.RESUMED) {
          promise.reject("E_HEALTH_FOREGROUND", "请在应用前台申请健康权限")
          return@runOnUiQueueThread
        }
        if (pendingPermission != null) {
          promise.reject("E_HEALTH_BUSY", "已有健康权限请求正在进行")
          return@runOnUiQueueThread
        }
        val pending = PermissionRequest(promise, metrics, activity)
        request = pending
        pendingPermission = pending
        pending.destroyObserver = LifecycleEventObserver { _, event ->
          if (event == Lifecycle.Event.ON_DESTROY && pendingPermission === pending) {
            clearPermission(pending)
            pending.promise.reject("E_HEALTH_CANCELLED", "页面已关闭，健康权限请求已取消")
          } else if (event == Lifecycle.Event.ON_RESUME) {
            resolvePermissionWhenResumed(pending)
          }
        }
        activity.lifecycle.addObserver(pending.destroyObserver!!)
        pending.resumeListener = object : LifecycleEventListener {
          override fun onHostResume() { resolvePermissionWhenResumed(pending) }
          override fun onHostPause() = Unit
          override fun onHostDestroy() {
            if (pendingPermission === pending) {
              clearPermission(pending)
              pending.promise.reject("E_HEALTH_CANCELLED", "应用页面已关闭，健康权限请求已取消")
            }
          }
        }
        context.addLifecycleEventListener(pending.resumeListener!!)
        // API 34+ delegates to RequestMultiplePermissions, whose synthetic
        // intent must be consumed by ActivityResultRegistry.onLaunch. Calling
        // startActivityForResult(createIntent(...)) cannot request permissions.
        pending.launcher = activity.activityResultRegistry.register(
          "tada-health-${UUID.randomUUID()}", permissionContract,
        ) { granted ->
          if (pendingPermission === pending) {
            pending.granted = granted.toSet()
            pending.launcher?.unregister()
            pending.launcher = null
            // Result callbacks may arrive before RN's onHostResume, including
            // the already-granted path. Keep the request until BOTH the exact
            // Activity and ReactContext are actually resumed; never sleep/poll.
            resolvePermissionWhenResumed(pending)
          }
        }
        pending.timeout = Runnable {
          if (pendingPermission === pending) {
            clearPermission(pending)
            pending.promise.reject("E_HEALTH_PERMISSION_TIMEOUT", "健康授权等待超时，返回应用后可重新申请")
          }
        }.also { mainHandler.postDelayed(it, 5 * 60_000L) }
        pending.launcher!!.launch(metrics.map(::permission).toSet())
      } catch (error: Exception) {
        request?.let(::clearPermission)
        logPermissionFailure(error)
        promise.reject("E_HEALTH_PERMISSION", "无法打开健康授权，请确认Health Connect可用后重试")
      }
    }
  }

  private fun resolvePermissionWhenResumed(request: PermissionRequest) {
    if (pendingPermission !== request || invalidated.get()) return
    val granted = request.granted ?: return
    if (request.owner.isFinishing || request.owner.isDestroyed) {
      clearPermission(request)
      request.promise.reject("E_HEALTH_CANCELLED", "页面已关闭，健康权限请求已取消")
      return
    }
    if (context.currentActivity !== request.owner ||
        context.lifecycleState != LifecycleState.RESUMED ||
        !request.owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
    clearPermission(request)
    try {
      request.promise.resolve(Arguments.createMap().apply {
        putArray("requested", Arguments.fromList(request.metrics))
        putArray("granted", Arguments.fromList(request.metrics.filter { permission(it) in granted }))
      })
    } catch (error: Exception) {
      logPermissionFailure(error)
      request.promise.reject("E_HEALTH_PERMISSION", "健康权限请求未完成，请返回前台重试")
    }
  }

  private fun clearPermission(request: PermissionRequest) {
    if (pendingPermission === request) pendingPermission = null
    request.timeout?.let(mainHandler::removeCallbacks)
    request.timeout = null
    request.destroyObserver?.let { request.owner.lifecycle.removeObserver(it) }
    request.destroyObserver = null
    request.resumeListener?.let(context::removeLifecycleEventListener)
    request.resumeListener = null
    request.launcher?.unregister()
    request.launcher = null
  }

  private fun logPermissionFailure(error: Exception) {
    // Class name only: never exception messages, URI, permissions, data or stack.
    Log.w("TadaHealth", "Health permission request failed: ${error.javaClass.simpleName}")
  }

  @ReactMethod fun readRecords(options: ReadableMap, promise: Promise) {
    val metrics: List<String>
    val days: Int
    try {
      metrics = parseMetrics(requireNotNull(options.getArray("metrics")))
      days = HealthReadPolicy.validateDays(options.getDouble("days"))
    } catch (_: Exception) {
      promise.reject("E_HEALTH_INPUT", "请选择有效的数据类型和1至30天的范围"); return
    }
    if (context.lifecycleState != LifecycleState.RESUMED) {
      promise.reject("E_HEALTH_FOREGROUND", "请在应用前台读取健康数据"); return
    }
    if (!readPending.compareAndSet(false, true)) {
      promise.reject("E_HEALTH_BUSY", "已有健康数据读取正在进行"); return
    }
    scope.launch {
      try {
        requireAvailable()
        val result = withTimeout(30_000) {
          val client = HealthConnectClient.getOrCreate(context)
          val granted = client.permissionController.getGrantedPermissions()
          val permitted = metrics.filter { permission(it) in granted }
          val end = Instant.now()
          val start = end.minus(Duration.ofDays(days.toLong()))
          val output = Arguments.createArray()
          var truncated = false
          // Divide the hard limit across metrics so frequent HR samples cannot starve sleep.
          val limit = HealthReadPolicy.perMetricLimit(permitted.size)
          for (metric in permitted) {
            val rows = readMetric(client, metric, start, end, limit)
            rows.first.forEach(output::pushMap)
            truncated = truncated || rows.second
          }
          Arguments.createMap().apply {
            putArray("records", output)
            putString("synced_at", end.toString())
            putBoolean("truncated", truncated)
            putArray("granted", Arguments.fromList(permitted))
            putArray("unavailable_metrics", Arguments.fromList(metrics.filterNot { it in permitted }))
          }
        }
        promise.resolve(result)
      } catch (_: SecurityException) {
        promise.reject("E_HEALTH_PERMISSION", "健康读取权限已变更，请检查授权后重试")
      } catch (_: TimeoutCancellationException) {
        promise.reject("E_HEALTH_TIMEOUT", "健康数据读取超时，请缩小日期范围后重试")
      } catch (_: CancellationException) {
        promise.reject("E_HEALTH_CANCELLED", "健康数据读取已取消")
      } catch (_: Exception) {
        promise.reject("E_HEALTH_READ", "无法读取健康数据，请确认服务和权限后重试")
      } finally {
        readPending.set(false)
      }
    }
  }

  @ReactMethod fun openSettings(promise: Promise) {
    try {
      val intent = Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("E_HEALTH_SETTINGS", "无法打开健康权限设置，当前手机可能不支持Health Connect")
    }
  }

  private fun requireAvailable() {
    check(HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE)
  }

  private fun parseMetrics(values: ReadableArray): List<String> =
    HealthReadPolicy.validateMetrics((0 until values.size()).map { requireNotNull(values.getString(it)) })

  private fun recordClass(metric: String): KClass<out Record> = when (metric) {
    "steps" -> StepsRecord::class
    "heart_rate" -> HeartRateRecord::class
    "sleep" -> SleepSessionRecord::class
    "workout" -> ExerciseSessionRecord::class
    "weight" -> WeightRecord::class
    else -> throw IllegalArgumentException("metric")
  }
  private fun permission(metric: String): String = HealthPermission.getReadPermission(recordClass(metric))

  private suspend fun readMetric(client: HealthConnectClient, metric: String, start: Instant, end: Instant, limit: Int): Pair<List<WritableMap>, Boolean> {
    val rows = mutableListOf<WritableMap>()
    var page: String? = null
    val seen = mutableSetOf<String>()
    do {
      val response = client.readRecords(ReadRecordsRequest(
        recordType = recordClass(metric),
        timeRangeFilter = TimeRangeFilter.between(start, end),
        pageSize = minOf(limit + 1, 500),
        pageToken = page,
        ascendingOrder = false,
      ))
      for (record in response.records) {
        val converted = convert(record, metric, start, end, limit + 1 - rows.size)
        rows.addAll(converted)
        if (rows.size > limit) return rows.take(limit) to true
      }
      page = response.pageToken?.takeIf { it.isNotEmpty() }
      // A repeated opaque page token is a provider error, not a reason to loop forever.
      check(page == null || seen.add(page))
    } while (page != null)
    return rows to false
  }

  private fun convert(record: Record, metric: String, queryStart: Instant, queryEnd: Instant, remaining: Int): List<WritableMap> {
    if (remaining <= 0) return emptyList()
    fun row(start: Instant, end: Instant, value: Double, unit: String, suffix: String = ""): WritableMap = Arguments.createMap().apply {
      putString("id", "health_connect:${record.metadata.id}$suffix")
      putString("source", "health_connect")
      putString("source_app", record.metadata.dataOrigin.packageName)
      record.metadata.device?.let { device ->
        putString("source_device", listOfNotNull(device.manufacturer, device.model).joinToString(" ").take(160))
      }
      putString("metric", metric)
      putString("start_at", start.toString())
      putString("end_at", end.toString())
      putDouble("value", value)
      putString("unit", unit)
    }
    return when (record) {
      is StepsRecord -> listOf(row(record.startTime, record.endTime, record.count.toDouble(), "count"))
      is HeartRateRecord -> record.samples.asSequence()
        .filter { !it.time.isBefore(queryStart) && !it.time.isAfter(queryEnd) }
        .take(remaining)
        .map { row(it.time, it.time, it.beatsPerMinute.toDouble(), "bpm", ":${it.time}") }.toList()
      is SleepSessionRecord -> {
        val asleep = record.stages.filter { it.stage in setOf(
          SleepSessionRecord.STAGE_TYPE_SLEEPING, SleepSessionRecord.STAGE_TYPE_LIGHT,
          SleepSessionRecord.STAGE_TYPE_DEEP, SleepSessionRecord.STAGE_TYPE_REM,
        ) }
        val minutes = if (record.stages.isNotEmpty()) asleep.sumOf { Duration.between(it.startTime, it.endTime).toMillis() } / 60_000.0
          else Duration.between(record.startTime, record.endTime).toMillis() / 60_000.0
        listOf(row(record.startTime, record.endTime, minutes, "min").apply {
          putString("sleep_basis", if (record.stages.isNotEmpty()) "asleep_stages" else "session_duration")
        })
      }
      is ExerciseSessionRecord -> listOf(row(record.startTime, record.endTime, Duration.between(record.startTime, record.endTime).toMillis() / 60_000.0, "min").apply {
        putInt("exercise_type", record.exerciseType)
      })
      is WeightRecord -> listOf(row(record.time, record.time, record.weight.inKilograms, "kg"))
      else -> emptyList()
    }
  }

  override fun invalidate() {
    invalidated.set(true)
    context.runOnUiQueueThread {
      pendingPermission?.let { pending ->
        clearPermission(pending)
        pending.promise.reject("E_HEALTH_CANCELLED", "健康权限请求已取消")
      }
    }
    scope.cancel()
    super.invalidate()
  }
}
