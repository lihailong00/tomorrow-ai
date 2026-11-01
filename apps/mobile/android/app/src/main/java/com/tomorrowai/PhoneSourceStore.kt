package com.tomorrowai

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** App-private, excluded from backup. Checkpoints and complete records commit together. */
internal class PhoneSourceStore(private val context: Context) : SQLiteOpenHelper(
  context, File(context.noBackupFilesDir, "phone-sources.db").absolutePath, null, 1
) {
  companion object {
    val lock = Any()
    private const val KEY = "tada.phone.sources.v1"
    private const val CHUNK = 48 * 1024
    fun scope(value: String): String {
      require(value.isNotBlank() && value.length <= 4096) { "本机资料缺少账号范围" }
      return PhoneSourcePolicy.digest(value)
    }
    private fun name(scope: String, source: String) = "phone-source-$scope-$source"
    fun enqueue(context: Context, scope: String, source: String) {
      val input = Data.Builder().putString("scope", scope).putString("source", source).build()
      val manager = WorkManager.getInstance(context)
      manager.enqueueUniqueWork(name(scope, source), ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequest.Builder(PhoneSourceSyncWorker::class.java).setInputData(input)
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build())
      manager.enqueueUniquePeriodicWork(name(scope, source) + "-refresh", ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequest.Builder(PhoneSourceSyncWorker::class.java, 6, TimeUnit.HOURS)
          .setInputData(Data.Builder().putAll(input).putBoolean("refresh", true).build())
          .setInitialDelay(6, TimeUnit.HOURS).build())
    }
    fun cancel(context: Context, scope: String, source: String) {
      WorkManager.getInstance(context).cancelUniqueWork(name(scope, source))
      WorkManager.getInstance(context).cancelUniqueWork(name(scope, source) + "-refresh")
    }
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE jobs(scope TEXT, source TEXT, epoch TEXT NOT NULL, after_id INTEGER NOT NULL DEFAULT 0, upper_id INTEGER NOT NULL DEFAULT -1, total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, updated INTEGER NOT NULL, PRIMARY KEY(scope,source))")
    db.execSQL("CREATE TABLE records(scope TEXT, source TEXT, id INTEGER, epoch TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(scope,source,id))")
    // Small encrypted pieces avoid CursorWindow's per-row size limit for long notes/SMS.
    db.execSQL("CREATE TABLE parts(scope TEXT, source TEXT, id INTEGER, part INTEGER, payload BLOB NOT NULL, PRIMARY KEY(scope,source,id,part))")
  }
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
  private val prefs get() = context.getSharedPreferences("tada_phone_sources_sync", 0)
  data class Job(val epoch: String, val after: Long, val upper: Long, val total: Long,
    val processed: Long, val state: String, val error: String, val updated: Long)

  fun job(scope: String, source: String): Job? = readableDatabase.rawQuery(
    "SELECT epoch,after_id,upper_id,total,processed,state,error,updated FROM jobs WHERE scope=? AND source=? AND enabled=1",
    arrayOf(scope, source)).use { if (!it.moveToFirst()) null else Job(it.getString(0), it.getLong(1),
      it.getLong(2), it.getLong(3), it.getLong(4), it.getString(5), it.getString(6), it.getLong(7)) }

  fun active(scope: String, source: String) = prefs.getString("active", "") == scope && job(scope, source) != null
  fun start(scope: String, source: String, force: Boolean = true) {
    require(source in PhoneSourceReader.sources)
    // A different account/server never inherits an old account's background read grant.
    if (prefs.getString("active", "") != scope) {
      writableDatabase.execSQL("UPDATE jobs SET enabled=0")
      check(prefs.edit().putString("active", scope).commit()) { "无法保存本机资料授权" }
    }
    val previous = job(scope, source)
    if (previous?.state == "complete" && source != "photos" && !force && System.currentTimeMillis() - previous.updated < 5 * 60_000L) return
    if (previous == null || previous.state == "complete") {
      writableDatabase.insertWithOnConflict("jobs", null, ContentValues().apply {
        put("scope", scope); put("source", source); put("epoch", UUID.randomUUID().toString())
        put("after_id", 0); put("upper_id", -1); put("total", 0); put("processed", 0)
        put("state", "queued"); put("error", ""); put("enabled", 1); put("updated", System.currentTimeMillis())
      }, SQLiteDatabase.CONFLICT_REPLACE)
    } else {
      writableDatabase.execSQL("UPDATE jobs SET state='queued',error='' WHERE scope=? AND source=?", arrayOf(scope, source))
    }
  }

  fun stop(scope: String, source: String) {
    transaction {
      listOf("jobs", "records", "parts").forEach { delete(it, "scope=? AND source=?", arrayOf(scope, source)) }
    }
    cancel(context, scope, source)
  }
  fun suspendAll() {
    check(prefs.edit().remove("active").commit()) { "无法停止本机资料读取" }
    readableDatabase.rawQuery("SELECT scope,source FROM jobs", null).use { cursor ->
      while (cursor.moveToNext()) cancel(context, cursor.getString(0), cursor.getString(1))
    }
    transaction { listOf("parts", "records", "jobs").forEach { delete(it, null, null) } }
  }
  fun initialize(scope: String, source: String, epoch: String, upper: Long, total: Long) {
    writableDatabase.execSQL("UPDATE jobs SET upper_id=?,total=?,state='running',error='' WHERE scope=? AND source=? AND epoch=? AND enabled=1 AND upper_id=-1",
      arrayOf(upper, total, scope, source, epoch))
  }
  fun error(scope: String, source: String, message: String) {
    writableDatabase.execSQL("UPDATE jobs SET state='error',error=? WHERE scope=? AND source=? AND enabled=1", arrayOf(message, scope, source))
  }

  private val encryptionKey: SecretKey by lazy { loadKey() }
  private fun loadKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  private fun aad(scope: String, source: String, id: Long, part: Int) = "$scope:$source:$id:$part".toByteArray(Charsets.UTF_8)
  private fun encrypt(bytes: ByteArray, aad: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
    init(Cipher.ENCRYPT_MODE, encryptionKey); updateAAD(aad); iv + doFinal(bytes)
  }
  private fun decrypt(bytes: ByteArray, aad: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
    init(Cipher.DECRYPT_MODE, encryptionKey, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    updateAAD(aad); doFinal(bytes.copyOfRange(12, bytes.size))
  }
  private fun transaction(block: SQLiteDatabase.() -> Unit) {
    writableDatabase.beginTransaction()
    try { writableDatabase.block(); writableDatabase.setTransactionSuccessful() }
    finally { writableDatabase.endTransaction() }
  }

  fun commit(scope: String, source: String, checkpoint: Job, rows: List<PhoneSourceReader.Record>, complete: Boolean) {
    val current = job(scope, source)
    // A periodic refresh and an explicit resume may overlap. A stale batch must
    // never move the durable cursor backwards or increment progress twice.
    if (current == null || !active(scope, source) || current.epoch != checkpoint.epoch || current.after != checkpoint.after) return
    transaction {
      for (row in rows) {
        val selection = arrayOf(scope, source, row.id.toString())
        val serialized = row.value.toString()
        val signature = PhoneSourcePolicy.digest(serialized)
        val unchanged = rawQuery("SELECT signature FROM records WHERE scope=? AND source=? AND id=?", selection)
          .use { it.moveToFirst() && it.getString(0) == signature }
        if (unchanged) {
          execSQL("UPDATE records SET epoch=? WHERE scope=? AND source=? AND id=?", arrayOf(checkpoint.epoch, scope, source, row.id))
          continue
        }
        delete("parts", "scope=? AND source=? AND id=?", selection)
        insertWithOnConflict("records", null, ContentValues().apply {
          put("scope", scope); put("source", source); put("id", row.id); put("epoch", checkpoint.epoch); put("signature", signature)
        }, SQLiteDatabase.CONFLICT_REPLACE)
        val bytes = serialized.toByteArray(Charsets.UTF_8)
        var offset = 0; var part = 0
        while (offset < bytes.size) {
          val end = minOf(offset + CHUNK, bytes.size)
          insertOrThrow("parts", null, ContentValues().apply {
            put("scope", scope); put("source", source); put("id", row.id); put("part", part)
            put("payload", encrypt(bytes.copyOfRange(offset, end), aad(scope, source, row.id, part)))
          })
          offset = end; part++
        }
      }
      if (complete) {
        // Clean up disappeared records only once a complete generation succeeded.
        execSQL("DELETE FROM parts WHERE scope=? AND source=? AND id IN (SELECT id FROM records WHERE scope=? AND source=? AND epoch!=?)",
          arrayOf(scope, source, scope, source, checkpoint.epoch))
        delete("records", "scope=? AND source=? AND epoch!=?", arrayOf(scope, source, checkpoint.epoch))
      }
      val processed = checkpoint.processed + rows.size
      execSQL("UPDATE jobs SET after_id=?,processed=?,total=?,state=?,error='',updated=? WHERE scope=? AND source=? AND epoch=?",
        arrayOf(rows.lastOrNull()?.id ?: checkpoint.after, processed, if (complete) processed else maxOf(checkpoint.total, processed),
          if (complete) "complete" else "running", System.currentTimeMillis(), scope, source, checkpoint.epoch))
    }
  }

  fun record(scope: String, source: String, id: Long): JSONObject {
    check(active(scope, source)) { "本机资料读取已停止" }
    check(PhoneSourceReader.access(context, source) != "denied") { "权限已收回，请重新授权" }
    val out = java.io.ByteArrayOutputStream()
    readableDatabase.rawQuery("SELECT part,payload FROM parts WHERE scope=? AND source=? AND id=? ORDER BY part",
      arrayOf(scope, source, id.toString())).use { cursor ->
      var expected = 0
      while (cursor.moveToNext()) {
        check(cursor.getInt(0) == expected) { "资料缓存不完整，请重新整理" }
        out.write(decrypt(cursor.getBlob(1), aad(scope, source, id, expected++)))
      }
      check(expected > 0) { "记录已变化，请刷新" }
    }
    val value = JSONObject(out.toString("UTF-8"))
    // Old encrypted records predate these preview fields. Derive them from the
    // retained provider row before page() removes raw, without losing history.
    return if (source == "calendar") PhoneSourceReader.normalizeCalendarRecord(value) else value
  }

  fun page(scope: String, source: String, after: Long, withContactNames: Boolean): JSONObject {
    check(active(scope, source)) { "本机资料读取已停止" }
    val access = PhoneSourceReader.access(context, source)
    check(access != "denied") { "权限已收回，请重新授权" }
    val job = job(scope, source) ?: throw IllegalStateException("请先开始整理")
    // Under selected-photo access, never expose cached photos from an older grant.
    val epochClause = if (source == "photos" && access == "limited") " AND epoch=?" else ""
    val args = mutableListOf(scope, source, after.toString()).apply { if (epochClause.isNotEmpty()) add(job.epoch) }
    val ids = readableDatabase.rawQuery("SELECT id FROM records WHERE scope=? AND source=? AND id>?$epochClause ORDER BY id LIMIT ${PhoneSourceReader.PAGE_SIZE + 1}",
      args.toTypedArray()).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getLong(0)) } }
    val pageIds = ids.take(PhoneSourceReader.PAGE_SIZE)
    val allowed = if (source == "photos" && access == "limited" && pageIds.isNotEmpty()) {
      context.contentResolver.query(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, arrayOf("_id"),
        "_id IN (${pageIds.joinToString(",") { "?" }})", pageIds.map { it.toString() }.toTypedArray(), null)?.use { cursor ->
        buildSet<Long> { while (cursor.moveToNext()) add(cursor.getLong(0)) }
      } ?: throw SecurityException("无法确认照片授权范围")
    } else pageIds.toSet()
    val values = JSONArray()
    pageIds.filter { it in allowed }.forEach { id ->
      val full = record(scope, source, id)
      val body = full.optString("text")
      if (source == "sms" && withContactNames) PhoneSourceReader(context).contactName(full.getJSONObject("raw").optString("address"))
        ?.takeIf { it.isNotBlank() }?.let { full.put("title", it) }
      full.remove("raw"); full.remove("data")
      full.remove("attendees"); full.remove("reminders"); full.remove("extendedProperties")
      val title = full.optString("title")
      full.put("title", title.take(200)).put("text", body.take(2000))
        .put("truncated", body.length > 2000 || title.length > 200)
      values.put(full)
    }
    val countArgs = mutableListOf(scope, source).apply { if (epochClause.isNotEmpty()) add(job.epoch) }
    val cached = readableDatabase.rawQuery("SELECT COUNT(*) FROM records WHERE scope=? AND source=?$epochClause", countArgs.toTypedArray())
      .use { it.moveToFirst(); it.getLong(0) }
    return JSONObject().put("source", source).put("readAt", job.updated).put("permission", access)
      .put("limited", access == "limited").put("items", values).put("total", job.total)
      .put("processed", job.processed).put("cached", cached).put("syncState", job.state)
      .put("syncError", job.error).put("generation", job.epoch).put("cursor", after.toString())
      .put("nextCursor", if (ids.size > PhoneSourceReader.PAGE_SIZE) ids[PhoneSourceReader.PAGE_SIZE - 1].toString() else JSONObject.NULL)
  }
}

/** No network or AI calls. WorkManager resumes the durable cursor after process death. */
class PhoneSourceSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val scope = inputData.getString("scope") ?: return Result.failure()
    val source = inputData.getString("source") ?: return Result.failure()
    if (source !in PhoneSourceReader.sources) return Result.failure()
    val started = android.os.SystemClock.elapsedRealtime()
    val reader = PhoneSourceReader(applicationContext)
    try {
      synchronized(PhoneSourceStore.lock) {
        PhoneSourceStore(applicationContext).use { store ->
          if (!store.active(scope, source)) return Result.success()
          if (inputData.getBoolean("refresh", false) && store.job(scope, source)?.state == "complete") store.start(scope, source)
        }
      }
      while (!isStopped && android.os.SystemClock.elapsedRealtime() - started < 7 * 60_000L) {
        val job = synchronized(PhoneSourceStore.lock) {
          PhoneSourceStore(applicationContext).use { store ->
            if (!store.active(scope, source)) return Result.success()
            store.job(scope, source) ?: return Result.success()
          }
        }
        if (job.state == "complete") return Result.success()
        check(PhoneSourceReader.access(applicationContext, source) != "denied") { "权限已收回，请重新授权" }
        if (job.upper < 0) {
          val (upper, total) = reader.bounds(source)
          synchronized(PhoneSourceStore.lock) { PhoneSourceStore(applicationContext).use { store ->
            if (!store.active(scope, source)) return Result.success()
            store.initialize(scope, source, job.epoch, upper, total)
          } }
          continue
        }
        val rows = reader.batch(source, job.after, job.upper)
        synchronized(PhoneSourceStore.lock) { PhoneSourceStore(applicationContext).use { store ->
          if (isStopped || !store.active(scope, source)) return Result.success()
          store.commit(scope, source, job, rows, rows.isEmpty())
        } }
        if (rows.isEmpty()) return Result.success()
      }
      if (isStopped) return Result.retry()
      // A successful time slice must not accumulate exponential retry delays.
      // Continue immediately with the durable cursor in a fresh work request.
      synchronized(PhoneSourceStore.lock) { PhoneSourceStore(applicationContext).use { store ->
        if (store.active(scope, source)) PhoneSourceStore.enqueue(applicationContext, scope, source)
      } }
      return Result.success()
    } catch (failure: Exception) {
      try { synchronized(PhoneSourceStore.lock) { PhoneSourceStore(applicationContext).use { store ->
        if (store.active(scope, source)) store.error(scope, source,
          if (PhoneSourceReader.access(applicationContext, source) == "denied") "系统权限已收回，请重新授权；进度已保存。"
          else if (failure is android.database.sqlite.SQLiteFullException) "手机存储空间不足，请释放空间后继续整理；不会截断资料。"
          else "读取暂时中断，进度已保存；将自动重试，也可点击继续整理。")
      } } } catch (_: Exception) { /* A full disk may also prevent saving the error. Retry the same checkpoint. */ }
      return if (PhoneSourceReader.access(applicationContext, source) == "denied") Result.failure() else Result.retry()
    }
  }
}
