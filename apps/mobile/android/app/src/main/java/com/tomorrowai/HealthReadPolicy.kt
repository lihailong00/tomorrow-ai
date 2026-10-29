package com.tomorrowai

import androidx.health.connect.client.records.SleepSessionRecord

/** Shared bounds for the foreground-only, read-only native health bridge. */
internal object HealthReadPolicy {
  const val MAX_DAYS = 30
  const val MAX_RECORDS = 2000
  val metrics = setOf("steps", "heart_rate", "sleep", "workout", "weight")

  fun validateMetrics(values: List<String>): List<String> {
    require(values.isNotEmpty() && values.size <= metrics.size) { "请选择一到五种健康数据" }
    require(values.all { it in metrics } && values.distinct().size == values.size) { "健康数据类型无效" }
    return values
  }

  fun validateDays(days: Double): Int {
    require(days.isFinite() && days >= 1 && days <= MAX_DAYS && days % 1.0 == 0.0) { "仅支持读取最近1至30天" }
    return days.toInt()
  }

  fun perMetricLimit(count: Int): Int = MAX_RECORDS / count.coerceIn(1, metrics.size)

  data class SleepStageDuration(val type: Int, val durationMillis: Long)
  data class SleepSummary(val minutes: Double, val basis: String)

  /** Unknown stages are missing knowledge, never evidence of zero sleep. */
  fun summarizeSleep(sessionDurationMillis: Long, stages: List<SleepStageDuration>): SleepSummary {
    require(sessionDurationMillis > 0 && stages.all { it.durationMillis > 0 }) { "睡眠记录时间区间无效" }
    val asleep = setOf(
      SleepSessionRecord.STAGE_TYPE_SLEEPING, SleepSessionRecord.STAGE_TYPE_LIGHT,
      SleepSessionRecord.STAGE_TYPE_DEEP, SleepSessionRecord.STAGE_TYPE_REM,
    )
    val awake = setOf(
      SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED,
      SleepSessionRecord.STAGE_TYPE_OUT_OF_BED,
    )
    if (stages.isEmpty() || stages.any { it.type !in asleep && it.type !in awake }) {
      return SleepSummary(sessionDurationMillis / 60_000.0, "session_duration")
    }
    return SleepSummary(stages.filter { it.type in asleep }.sumOf { it.durationMillis.toDouble() } / 60_000.0, "asleep_stages")
  }
}
