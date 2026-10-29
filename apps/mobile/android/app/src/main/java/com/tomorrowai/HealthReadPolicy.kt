package com.tomorrowai

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
}
