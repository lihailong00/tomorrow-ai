package com.tomorrowai

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.net.URI
import java.util.UUID

/** Private, short-lived review inbox. This class never makes network requests. */
internal object AppInputStore {
  const val MAX_FILE_BYTES = 20L * 1024 * 1024
  private const val MAX_CACHE_BYTES = 40L * 1024 * 1024
  private const val RETENTION_MS = 24L * 60 * 60 * 1000
  private const val MAX_ITEMS = 100
  private const val PREFS = "tada_app_inputs"

  val packages: Map<String, List<String>> = linkedMapOf(
    "wechat" to listOf("com.tencent.mm"),
    "qq" to listOf("com.tencent.mobileqq"),
    "xiaohongshu" to listOf("com.xingin.xhs"),
    "bilibili" to listOf("tv.danmaku.bili"),
    "douyin" to listOf("com.ss.android.ugc.aweme"),
    "zhihu" to listOf("com.zhihu.android"),
    "taobao" to listOf("com.taobao.taobao"),
    "jd" to listOf("com.jingdong.app.mall"),
    "meituan" to listOf("com.sankuai.meituan"),
    "alipay" to listOf("com.eg.android.AlipayGphone"),
    "didi" to listOf("com.sdu.didi.psnger"),
    "feishu" to listOf("com.ss.android.lark"),
    "dingtalk" to listOf("com.alibaba.android.rimet"),
    "wecom" to listOf("com.tencent.wework"),
    "wps" to listOf("cn.wps.moffice_eng"),
    "tencent_docs" to listOf("com.tencent.docs"),
    "amap" to listOf("com.autonavi.minimap"),
  )

  private val sensitive = Regex(
    "验证码|校验码|验证代码|动态口令|动态密码|一次性密码|授权码|支付密码|付款码|安全码|登录保护|异地登录|新设备登录|安全验证|确认付款|确认支付|" +
      "verification\\s*code|security\\s*code|one[ -]?time\\s*(password|code)|" +
      "authentication\\s*code|authorization\\s*code|sign[ -]?in\\s*code|log[ -]?in\\s*code|password\\s*reset|two[ -]?factor|payment\\s*confirmation|approve\\s*(this\\s*)?payment|\\bcode\\s*(is|:)?\\s*\\d{4,8}\\b|\\botp\\b|\\b2fa\\b",
    RegexOption.IGNORE_CASE,
  )

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  fun cacheDir(context: Context) = File(context.cacheDir, "app-inputs").apply { mkdirs() }
  fun sourceId(packageName: String?): String =
    packages.entries.firstOrNull { packageName in it.value }?.key ?: "shared"
  fun isSensitive(text: String) = sensitive.containsMatchIn(text)
  fun notificationSnapshotId(packageName: String, key: String, postedAt: Long, title: String, text: String): String =
    "notification-" + UUID.nameUUIDFromBytes("$packageName:$key:$postedAt:$title\n$text".toByteArray())

  fun isOwnedCacheFile(root: File, uri: String): Boolean = try {
    val parsed = URI(uri)
    parsed.scheme == "file" && parsed.authority.isNullOrBlank() &&
      File(parsed).canonicalFile.parentFile == root.canonicalFile
  } catch (_: Exception) { false }

  @Synchronized fun sharedImageFile(context: Context, uri: String): Pair<File, Long> {
    require(isOwnedCacheFile(cacheDir(context), uri)) { "只能识别待接收中的分享图片" }
    val entry = read(context).firstOrNull { item ->
      item.optString("kind") == "share" && item.optJSONObject("file")?.let { file ->
        file.optString("uri") == uri && file.optString("mime_type").startsWith("image/", ignoreCase = true)
      } == true
    }
    require(entry != null) { "图片已过期或不在待接收中，请重新分享" }
    val file = File(URI(uri)).canonicalFile
    require(file.isFile && file.length() in 1..MAX_FILE_BYTES) { "图片不可读取或超过 20 MB" }
    return file to generation(context)
  }

  /** The stream must be inside the URI set whose read grant Android checked on launch. */
  fun isGrantedContentShare(uri: String, hasReadGrant: Boolean, clipUris: Set<String>): Boolean {
    if (!hasReadGrant || uri !in clipUris) return false
    return try {
      val parsed = URI(uri)
      parsed.scheme == "content" && !parsed.authority.isNullOrBlank() && parsed.userInfo == null
    } catch (_: Exception) { false }
  }

  @Synchronized fun generation(context: Context): Long = prefs(context).getLong("generation", 0)
  @Synchronized fun selected(context: Context): Set<String> =
    prefs(context).getStringSet("selected", emptySet())!!.filter { it in packages }.toSet()

  @Synchronized fun setSelected(context: Context, apps: Set<String>) {
    require(apps.all { it in packages }) { "未知应用" }
    val previous = selected(context)
    val editor = prefs(context).edit().putStringSet("selected", apps.toSet())
    for (id in packages.keys) {
      if (id !in apps) editor.remove("enabled_at_$id")
      else if (id !in previous) editor.putLong("enabled_at_$id", System.currentTimeMillis())
    }
    check(editor.commit()) { "无法保存应用选择" }
    // Removing an app also removes its unimported notification snippets.
    val retained = read(context).filter { it.optString("kind") != "notification" || it.optString("source_app") in apps }
    write(context, retained)
  }

  @Synchronized fun list(context: Context): List<JSONObject> = read(context).map { JSONObject(it.toString()) }

  @Synchronized fun dismiss(context: Context, ids: Set<String>) {
    val all = read(context)
    all.filter { it.optString("id") in ids }.forEach { deleteFile(context, it) }
    write(context, all.filterNot { it.optString("id") in ids })
  }

  @Synchronized fun clear(context: Context) {
    val editor = prefs(context).edit().remove("queue").remove("selected")
      .putLong("generation", generation(context) + 1)
    packages.keys.forEach { editor.remove("enabled_at_$it") }
    check(editor.commit()) { "无法清空待处理资料" }
    cacheDir(context).listFiles()?.forEach { if (it.isFile) it.delete() }
  }

  @Synchronized fun addNotification(context: Context, packageName: String, key: String, postedAt: Long, title: String, text: String) {
    val source = sourceId(packageName)
    if (source !in selected(context) || text.isBlank() || isSensitive("$title\n$text")) return
    if (postedAt < prefs(context).getLong("enabled_at_$source", Long.MAX_VALUE)) return
    val boundedTitle = title.take(200)
    val boundedText = text.take(4000)
    val notificationKey = UUID.nameUUIDFromBytes("$packageName:$key".toByteArray()).toString()
    val id = notificationSnapshotId(packageName, key, postedAt, boundedTitle, boundedText)
    val current = read(context)
    if (current.any { it.optString("id") == id }) return
    append(context, current.filterNot { it.optString("notification_key") == notificationKey }, JSONObject().apply {
      put("id", id); put("kind", "notification"); put("source_app", source)
      put("notification_key", notificationKey)
      put("title", boundedTitle); put("text", boundedText)
      put("created_at", Instant.now().toString()); put("created_ms", System.currentTimeMillis())
    })
  }

  @Synchronized fun addShares(context: Context, items: List<JSONObject>, expectedGeneration: Long): Boolean {
    if (generation(context) != expectedGeneration) { items.forEach { deleteFile(context, it) }; return false }
    append(context, read(context), items)
    return true
  }

  private fun append(context: Context, current: List<JSONObject>, item: JSONObject) {
    append(context, current, listOf(item))
  }

  private fun append(context: Context, current: List<JSONObject>, additions: List<JSONObject>) {
    val items = current + additions
    val removed = items.take((items.size - MAX_ITEMS).coerceAtLeast(0)).toMutableList()
    var retained = items.takeLast(MAX_ITEMS)
    var cacheBytes = retained.sumOf { it.optJSONObject("file")?.optLong("size", 0L) ?: 0L }
    while (cacheBytes > MAX_CACHE_BYTES && retained.isNotEmpty()) {
      val first = retained.first()
      cacheBytes -= first.optJSONObject("file")?.optLong("size", 0L) ?: 0L
      removed.add(first)
      retained = retained.drop(1)
    }
    write(context, retained)
    removed.forEach { deleteFile(context, it) }
  }

  private fun read(context: Context): List<JSONObject> {
    val now = System.currentTimeMillis()
    val queue = try { JSONArray(prefs(context).getString("queue", "[]")) } catch (_: Exception) { JSONArray() }
    val items = (0 until queue.length()).mapNotNull { queue.optJSONObject(it) }
    val valid = items.filter { val age = now - it.optLong("created_ms", 0); age in 0..RETENTION_MS }
    items.filterNot { it in valid }.forEach { deleteFile(context, it) }
    if (valid.size != items.size) write(context, valid)
    // Orphans from interrupted shares expire as well; never traverse outside this cache.
    val referenced = valid.mapNotNull { it.optJSONObject("file")?.optString("uri") }.toSet()
    cacheDir(context).listFiles()?.filter { it.isFile && now - it.lastModified() > RETENTION_MS && Uri.fromFile(it).toString() !in referenced }
      ?.forEach { it.delete() }
    return valid
  }

  private fun write(context: Context, items: List<JSONObject>) {
    check(prefs(context).edit().putString("queue", JSONArray(items).toString()).commit()) { "无法保存待处理资料" }
  }

  private fun deleteFile(context: Context, item: JSONObject) {
    try {
      val uri = Uri.parse(item.optJSONObject("file")?.optString("uri") ?: return)
      if (uri.scheme != "file") return
      val file = File(uri.path ?: return).canonicalFile
      if (file.parentFile == cacheDir(context).canonicalFile && file.isFile) file.delete()
    } catch (_: Exception) { /* Cache cleanup is best effort, bounded again on next read. */ }
  }
}
