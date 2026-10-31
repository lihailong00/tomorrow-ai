package com.tomorrowai

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/** Fixed, local rationale; never loads a remote page or exposes health records. */
class HealthPermissionsActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    title = "妥啦 · 健康数据说明"
    val padding = (24 * resources.displayMetrics.density).toInt()
    val text = TextView(this).apply {
      textSize = 17f
      setPadding(padding, padding, padding, padding)
      text = "妥啦仅在你操作读取时，读取你授权的步数、心率、睡眠、运动和体重。你可以只选择部分项目。\n\n" +
        "Health Connect中的记录由其他应用提供；没有记录不代表健康指标为零。妥啦不会通过此权限修改或删除原始健康记录。\n\n" +
        "原生读取过程不发送网络请求。你可以在妥啦中清除本机记录，或在Health Connect设置中撤销读取权限。\n\n" +
        "华为、小米官方云端连接需要单独授权，其同步会经过你当前使用的服务器。健康数据不会自动发送给AI模型。\n\n" +
        "此功能用于个人生活记录和趋势查看，不用于诊断、治疗或紧急监护。"
    }
    setContentView(ScrollView(this).apply { addView(text) })
  }
}
