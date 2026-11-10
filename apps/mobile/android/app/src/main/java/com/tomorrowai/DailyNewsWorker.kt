package com.tomorrowai

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** Best-effort delivery when Android permits background network work. */
class DailyNewsWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val context = applicationContext
    val server = inputData.getString("server") ?: return Result.success()
    val user = inputData.getString("user") ?: return Result.success()
    val instance = inputData.getString("instance") ?: return Result.success()
    val config = sessionConfig(server, user).put("instance_id", instance)
    val store = PhotoIndexStore(context)
    val scope = scope(server, user, instance)
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val token = store.session(config) ?: return Result.success()
    if (prefs.getString("enabled", null) != scope || !NotificationManagerCompat.from(context).areNotificationsEnabled()) return Result.success()
    return try {
      val identity = request(server, "/v1/instance") ?: return Result.success()
      if (identity.optInt("api_version") != 1 || identity.optString("id") != instance || store.session(config) != token) return Result.success()
      val id = request(server, "/v1/daily-news/notification", token)?.optString("id") ?: return Result.success()
      if (!id.matches(Regex("daily-news:[a-f0-9-]{36}"))) return Result.success()
      synchronized(lock) {
        if (!isStopped && prefs.getString("enabled", null) == scope && store.session(config) == token &&
            prefs.getString("last:$scope", null) != id && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
          notify(context, id)
          prefs.edit().putString("last:$scope", id).commit()
        }
      }
      Result.success()
    } catch (_: Exception) {
      if (runAttemptCount >= 2) Result.success() else Result.retry()
    }
  }

  companion object {
    private const val WORK = "tada-daily-news"
    private const val PREFS = "tada_daily_news"
    private val lock = Any()

    fun configure(context: Context, rawServer: String, user: String, enabled: Boolean): Unit = synchronized(lock) {
      val server = rawServer.trimEnd('/')
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val manager = WorkManager.getInstance(context)
      requireHttps(server)
      val config = sessionConfig(server, user)
      val instance = requireNotNull(PhotoIndexStore(context).instanceId(config))
      val scope = scope(server, user, instance)
      if (!enabled) {
        if (prefs.getString("enabled", null) == scope) {
          check(prefs.edit().remove("enabled").commit())
          manager.cancelUniqueWork(WORK)
        }
        return@synchronized
      }
      check(NotificationManagerCompat.from(context).areNotificationsEnabled())
      val work = PeriodicWorkRequestBuilder<DailyNewsWorker>(15, TimeUnit.MINUTES)
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setInputData(workDataOf("server" to server, "user" to user, "instance" to instance)).build()
      check(prefs.edit().putString("enabled", scope).commit())
      manager.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, work)
    }

    private fun sessionConfig(server: String, user: String) = JSONObject().put("server", server).put("user", user)

    private fun scope(server: String, user: String, instance: String): String = MessageDigest.getInstance("SHA-256")
      .digest("$server\u0000$user\u0000$instance".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun requireHttps(value: String): URL = URL(value).also {
      require(it.protocol == "https" && it.userInfo == null && it.query == null && it.ref == null)
    }

    private fun request(server: String, path: String, token: String? = null): JSONObject? {
      val connection = requireHttps(server + path).openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 8000
      connection.readTimeout = 8000
      connection.setRequestProperty("Accept", "application/json")
      if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
      try {
        val status = connection.responseCode
        if (status == 401 || status == 403 || status == 404 || status in 300..399) return null
        check(status == 200)
        return connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
          val body = StringBuilder()
          val buffer = CharArray(1024)
          while (true) {
            val count = reader.read(buffer)
            if (count < 0) break
            check(body.length + count <= 16384)
            body.append(buffer, 0, count)
          }
          JSONObject(body.toString())
        }
      } finally { connection.disconnect() }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun notify(context: Context, id: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.createNotificationChannel(NotificationChannel(WORK, "每日新闻", NotificationManager.IMPORTANCE_DEFAULT))
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
      val target = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notice = NotificationCompat.Builder(context, WORK).setSmallIcon(R.drawable.ic_notification)
        .setContentTitle("每日新闻已就绪").setContentText("打开妥啦，在消息里查看今天的简报")
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setContentIntent(target)
        .setOnlyAlertOnce(true).setAutoCancel(true).build()
      NotificationManagerCompat.from(context).notify(id, 1, notice)
    }
  }
}
