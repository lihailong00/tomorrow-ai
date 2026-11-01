package com.tomorrowai

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.work.*
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.math.max

/** Android adapter: upload bounded analysis copies only after explicit cloud consent. */
class PhotoIndexModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var requesting = false
  override fun getName() = "TomorrowPhotoIndex"
  // UiThreadUtil returns Boolean; async React methods must expose JVM void.
  private fun onUi(action: () -> Unit) { UiThreadUtil.runOnUiThread { action() } }

  @ReactMethod fun status(server: String, user: String, promise: Promise) = inBackground(promise) {
    val store = PhotoIndexStore(context)
    val config = store.config()
    val belongs=config.optString("scope")==store.scope(server,user)
    val cloud=config.optInt("processing_version")==2
    val state=when {
      !belongs -> "idle"
      config.optBoolean("enabled") && !cloud -> "cloud_consent_required"
      config.optBoolean("enabled") && store.session(config)==null -> "signed_out"
      config.optBoolean("enabled") && !PhotoIndexStore.hasAccess(context) -> "no_permission"
      else -> store.prefs.getString("state","idle")
    }
    JSONObject().put("deviceId", store.deviceId()).put("enabled", cloud && config.optBoolean("enabled") && belongs)
      .put("state", state)
      .put("lastSyncAt", if (config.optString("scope") == store.scope(server,user)) store.prefs.getLong("last_sync",0) else 0)
  }

  // Called only by the explicit settings action; status/boot never requests permissions.
  @ReactMethod fun requestAccess(promise: Promise) = onUi {
    if (PhotoIndexStore.hasAccess(context)) { promise.resolve(true); return@onUi }
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台开启相册索引"); return@onUi }
    if (requesting) { promise.reject("E_BUSY", "请先完成相册权限选择"); return@onUi }
    requesting = true
    val permissions = when {
      Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
      Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
      else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
    activity.requestPermissions(permissions, 1501, PermissionListener { request, _, _ ->
      if (request != 1501) false else {
        requesting = false
        promise.resolve(PhotoIndexStore.hasAccess(context)); true
      }
    })
  }

  @ReactMethod fun manageAccess(promise: Promise) = onUi {
    try {
      context.startActivity(android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        android.net.Uri.parse("package:"+context.packageName)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(null)
    } catch (_:Exception) { promise.reject("E_SETTINGS","无法打开系统权限设置") }
  }

  @ReactMethod fun enable(server: String, user: String, epoch: Double, promise: Promise) = inBackground(promise) {
    require(URL(server).protocol == "https") { "相册索引需要 HTTPS 服务地址" }
    require(epoch >= 1 && epoch <= 9_007_199_254_740_991.0 && epoch % 1.0 == 0.0)
    require(PhotoIndexStore.hasAccess(context)) { "请先授予相册访问权限" }
    val store = PhotoIndexStore(context)
    val config = JSONObject().put("server", server.trimEnd('/')).put("user",user).put("scope",store.scope(server,user))
      .put("epoch",epoch.toLong()).put("processing_version",2).put("enabled",true).put("device",store.deviceId())
    val instance=store.instanceId(config)
    require(!instance.isNullOrBlank()) { "请重新确认服务器并登录后开启相册索引" }
    config.put("instance_id",instance)
    require(store.session(config) != null) { "请重新登录后开启相册索引" }
    store.saveConfig(config)
    store.prefs.edit().putString("state","queued").commit()
    PhotoIndexWorker.schedule(context)
    JSONObject().put("ok",true)
  }

  @ReactMethod fun disable(promise: Promise) = inBackground(promise) {
    PhotoIndexStore(context).stop()
    WorkManager.getInstance(context).cancelAllWorkByTag(PhotoIndexWorker.TAG)
    JSONObject().put("ok",true)
  }

  @ReactMethod fun scanNow(promise: Promise) = inBackground(promise) {
    require(PhotoIndexStore(context).config().optBoolean("enabled")) { "请先开启相册索引" }
    PhotoIndexWorker.enqueue(context)
    JSONObject().put("ok",true)
  }

  @ReactMethod fun clearLocal(server: String, user: String, promise: Promise) = inBackground(promise) {
    val store=PhotoIndexStore(context)
    synchronized(PhotoIndexWorker.RUN_LOCK) {
      PhotoIndexDb(context).use { it.writableDatabase.delete("assets","scope=?",arrayOf(store.scope(server,user))) }
    }
    JSONObject().put("ok",true)
  }

  @ReactMethod fun openAsset(server: String, user: String, asset: String, promise: Promise) = inBackground(promise) {
    val store=PhotoIndexStore(context)
    val mediaId=PhotoIndexDb(context).use { db -> db.readableDatabase.rawQuery("SELECT media_id FROM assets WHERE scope=? AND asset_id=?",arrayOf(store.scope(server,user),asset)).use { c->if(c.moveToFirst()) c.getLong(0) else null } }
      ?: error("missing")
    check(PhotoIndexStore.hasAccess(context))
    val uri=ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,mediaId)
    context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW).setDataAndType(uri,"image/*")
      .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION))
    JSONObject().put("ok",true)
  }

  private fun inBackground(promise: Promise, action: () -> JSONObject) {
    Thread {
      try { promise.resolve(Arguments.makeNativeMap(jsonMap(action()))) }
      catch (_: Exception) { promise.reject("E_PHOTO_INDEX", "相册索引操作未完成，请检查权限与登录状态后重试") }
    }.start()
  }
  private fun jsonMap(json: JSONObject): Map<String,Any?> = json.keys().asSequence().associateWith { key -> json.opt(key).takeUnless { it == JSONObject.NULL } }
}

internal class PhotoIndexStore(private val context: Context) {
  val prefs = context.getSharedPreferences("tomorrow_photo_index", Context.MODE_PRIVATE)
  fun config(): JSONObject = try { JSONObject(prefs.getString("config","{}") ?: "{}") } catch (_:Exception) { JSONObject() }
  fun saveConfig(value:JSONObject) = synchronized(CONFIG_LOCK) { check(prefs.edit().putString("config",value.toString()).commit()) }
  fun stop() = synchronized(CONFIG_LOCK) { saveConfig(config().put("enabled",false)); prefs.edit().putString("state","paused").commit(); Unit }
  fun stopIfCurrent(expected:JSONObject) = synchronized(CONFIG_LOCK) { if(current(expected)) stop() }
  fun current(config:JSONObject):Boolean {
    val current=config()
    return current.optInt("processing_version")==2 && current.optBoolean("enabled") && current.optString("scope")==config.optString("scope") && current.optLong("epoch")==config.optLong("epoch") && current.optString("instance_id")==config.optString("instance_id")
  }
  fun deviceId():String = synchronized(DEVICE_LOCK) {
    prefs.getString("device_id",null) ?: UUID.randomUUID().toString().also { check(prefs.edit().putString("device_id",it).commit()) }
  }
  fun scope(server:String,user:String):String {
    val instance=instanceId(JSONObject().put("server",server.trimEnd('/')).put("user",user)) ?: "unverified"
    return MessageDigest.getInstance("SHA-256").digest((server.trimEnd('/')+"\u0000"+instance+"\u0000"+user).toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
  }

  // Reuse the existing Keystore-encrypted session, never copy tokens into WorkManager data/preferences.
  private fun savedSession(config:JSONObject):JSONObject? = try {
    val encrypted=context.getSharedPreferences("tomorrow_secure",Context.MODE_PRIVATE).getString("tomorrow.session.v1",null)
    if (encrypted==null) null else {
      val parts=encrypted.split(':',limit=2)
      val key=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey("tomorrow.session.v1",null) as SecretKey
      val cipher=Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)))
      val saved=JSONObject(String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),Charsets.UTF_8))
      if (saved.optString("serverUrl").trimEnd('/')==config.optString("server") && saved.optJSONObject("user")?.optString("id")==config.optString("user")) saved else null
    }
  } catch (_:Exception) { null }
  fun instanceId(config:JSONObject):String? = savedSession(config)?.optString("instanceId")?.takeIf { it.isNotBlank() }
  fun session(config:JSONObject):String? {
    val saved=savedSession(config) ?: return null
    if(config.has("instance_id") && saved.optString("instanceId")!=config.optString("instance_id")) return null
    return saved.optString("token").takeIf { it.isNotBlank() }
  }

  companion object {
    private val DEVICE_LOCK=Any()
    private val CONFIG_LOCK=Any()
    fun fullAccess(context:Context):Boolean = context.checkSelfPermission(if(Build.VERSION.SDK_INT>=33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED
    fun hasAccess(context:Context):Boolean = fullAccess(context) || (Build.VERSION.SDK_INT>=34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)==PackageManager.PERMISSION_GRANTED)
  }
}

internal class PhotoIndexDb(context:Context):SQLiteOpenHelper(context,"photo_index.db",null,1) {
  override fun onCreate(db:SQLiteDatabase) { db.execSQL("CREATE TABLE assets(scope TEXT NOT NULL,media_id INTEGER NOT NULL,asset_id TEXT NOT NULL,signature TEXT NOT NULL,payload TEXT NOT NULL,epoch INTEGER NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,media_id))") }
  override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int) = Unit
  data class Asset(val mediaId:Long,val assetId:String,val signature:String,val payload:String,val epoch:Long,val retryAt:Long)
  fun get(scope:String,id:Long):Asset? = readableDatabase.rawQuery("SELECT media_id,asset_id,signature,payload,epoch,retry_at FROM assets WHERE scope=? AND media_id=?",arrayOf(scope,id.toString())).use { if(it.moveToFirst()) Asset(it.getLong(0),it.getString(1),it.getString(2),it.getString(3),it.getLong(4),it.getLong(5)) else null }
  // Deletion reconciliation only needs identities, not every photo's full payload.
  fun identitiesAfter(scope:String,after:Long):List<Pair<Long,String>> = readableDatabase.rawQuery(
    "SELECT media_id,asset_id FROM assets WHERE scope=? AND media_id>? ORDER BY media_id LIMIT 250",
    arrayOf(scope,after.toString())).use { c->buildList { while(c.moveToNext()) add(c.getLong(0) to c.getString(1)) } }
  fun put(scope:String,asset:Asset) { writableDatabase.execSQL("INSERT OR REPLACE INTO assets(scope,media_id,asset_id,signature,payload,epoch,retry_at)VALUES(?,?,?,?,?,?,?)",arrayOf<Any>(scope,asset.mediaId,asset.assetId,asset.signature,asset.payload,asset.epoch,asset.retryAt)) }
  fun remove(scope:String,id:Long) { writableDatabase.delete("assets","scope=? AND media_id=?",arrayOf(scope,id.toString())) }
}

/** Small, resumable jobs; no worker exists until explicit enable(). */
class PhotoIndexWorker(context:Context,params:WorkerParameters):Worker(context,params) {
  override fun doWork():Result = synchronized(RUN_LOCK) { doWorkSerial() }
  private fun doWorkSerial():Result {
    val store=PhotoIndexStore(applicationContext)
    val config=store.config()
    if (!config.optBoolean("enabled") || config.optInt("processing_version")!=2) return Result.success()
    if (store.session(config)==null) { store.prefs.edit().putString("state","signed_out").commit(); return Result.success() }
    if (!PhotoIndexStore.hasAccess(applicationContext)) { store.prefs.edit().putString("state","no_permission").commit(); return Result.success() }
    try {
      verifyServerIdentity(config)
      // Fail closed before reading photos if server consent was revoked/cleared.
      val status=request(store,config,"GET","")
      if (!status.optBoolean("enabled") || !status.optBoolean("cloud_processing") || status.optLong("epoch")!=config.optLong("epoch")) {
        store.stopIfCurrent(config)
        return Result.success()
      }
      if (!active(store,config)) return Result.success()
      store.prefs.edit().putString("state","scanning").commit()
      val more=scan(store,config)
      // Prepare one text embedding after cloud vision; only derived indices persist.
      val prepared=if(active(store,config)) request(store,config,"POST","/prepare") else JSONObject()
      if (active(store,config)) {
        val pending=more || (prepared.optBoolean("processed") && prepared.optBoolean("more"))
        val phase=when {pending -> "queued";prepared.optBoolean("deferred") -> "processing_limited";else -> "idle"}
        store.prefs.edit().putString("state",phase).putLong("last_sync",System.currentTimeMillis()).commit()
        if (pending) enqueue(applicationContext)
      }
      return Result.success()
    } catch (_:ProcessingPending) {
      if(store.current(config)) store.prefs.edit().putString("state","analyzing").commit()
      return if(runAttemptCount<6) Result.retry() else Result.success()
    } catch (_:ProcessingLimited) {
      if(store.current(config)) store.prefs.edit().putString("state","processing_limited").commit()
      return if(runAttemptCount<2) Result.retry() else Result.success()
    } catch (_:ConsentEnded) {
      store.stopIfCurrent(config)
      return Result.success()
    } catch (_:Exception) {
      if(store.current(config)) store.prefs.edit().putString("state","retrying").commit()
      return if (runAttemptCount<4) Result.retry() else Result.success()
    }
  }

  private fun active(store:PhotoIndexStore,config:JSONObject):Boolean = !isStopped && store.current(config) && store.session(config)!=null && PhotoIndexStore.hasAccess(applicationContext)
  private class ConsentEnded:Exception()
  private class ProcessingLimited:Exception()
  private class ProcessingPending:Exception()

  /** Background work must perform the same anonymous identity check as the UI. */
  private fun verifyServerIdentity(config:JSONObject) {
    val expected=config.optString("instance_id")
    if(expected.isBlank()) throw ConsentEnded()
    val url=URL(config.getString("server")+"/v1/instance")
    require(url.protocol=="https")
    val connection=url.openConnection() as HttpURLConnection
    connection.instanceFollowRedirects=false;connection.connectTimeout=15_000;connection.readTimeout=15_000
    connection.setRequestProperty("Accept","application/json")
    try {
      val status=connection.responseCode
      if(status in 300..399 || status==404) throw ConsentEnded()
      check(status==200)
      val identity=JSONObject(String(connection.inputStream.use { it.readBytesLimited(16*1024) },Charsets.UTF_8))
      if(identity.optInt("api_version")!=1 || identity.optString("id")!=expected) throw ConsentEnded()
    } finally { connection.disconnect() }
  }

  private fun analysisStatus(store:PhotoIndexStore,config:JSONObject,asset:String,revision:String):JSONObject =
    request(store,config,"GET","/assets/$asset/analyze?epoch=${config.getLong("epoch")}&revision=$revision")

  private fun awaitAnalysis(store:PhotoIndexStore,config:JSONObject,asset:String,revision:String,initial:JSONObject,deadline:Long):Boolean {
    var current=initial
    while(current.optString("status")=="processing") {
      if(!active(store,config)) throw ConsentEnded()
      if(System.currentTimeMillis()>=deadline) throw ProcessingPending()
      android.os.SystemClock.sleep(2_000)
      current=analysisStatus(store,config,asset,revision)
    }
    return current.optString("status")=="complete"
  }
  private fun request(store:PhotoIndexStore,config:JSONObject,method:String,suffix:String,body:JSONObject?=null,image:PhotoAnalysisImage.Copy?=null):JSONObject {
    if (!active(store,config)) throw ConsentEnded()
    val token=store.session(config) ?: throw ConsentEnded()
    val url=URL(config.getString("server")+"/v1/photo-index/devices/"+config.getString("device")+suffix)
    require(url.protocol=="https")
    val connection=url.openConnection() as HttpURLConnection
    connection.instanceFollowRedirects=false; connection.connectTimeout=15_000; connection.readTimeout=if(image!=null) 120_000 else 20_000
    connection.requestMethod=method; connection.setRequestProperty("Authorization","Bearer $token"); connection.setRequestProperty("Accept","application/json")
    try {
      if(body!=null) {
        val json=body.toString().toByteArray(Charsets.UTF_8)
        require(json.size<=8192)
        val boundary="Photo"+UUID.randomUUID().toString().replace("-","")
        val bytes=if(image==null) json else java.io.ByteArrayOutputStream().use { output ->
          output.write(("--$boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n").toByteArray())
          output.write(json)
          output.write(("\r\n--$boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"analysis\"\r\nContent-Type: "+image.mime+"\r\n\r\n").toByteArray())
          output.write(image.bytes); output.write(("\r\n--$boundary--\r\n").toByteArray()); output.toByteArray()
        }
        connection.doOutput=true
        connection.setRequestProperty("Content-Type",if(image==null) "application/json" else "multipart/form-data; boundary=$boundary")
        connection.setFixedLengthStreamingMode(bytes.size)
        connection.outputStream.use { if(!active(store,config)) throw ConsentEnded();it.write(bytes) }
      }
      val status=connection.responseCode
      if(status==401 || status==403 || status==409) throw ConsentEnded()
      if(status==429) throw ProcessingLimited()
      check(status in 200..299)
      val bytes=connection.inputStream.use { it.readBytesLimited(96*1024) }
      return JSONObject(String(bytes,Charsets.UTF_8))
    } finally { connection.disconnect() }
  }
  private fun java.io.InputStream.readBytesLimited(limit:Int):ByteArray {
    val out=java.io.ByteArrayOutputStream(); val buffer=ByteArray(4096)
    while(true) { val n=read(buffer); if(n<0) break; check(out.size()+n<=limit); out.write(buffer,0,n) }
    return out.toByteArray()
  }

  private fun scan(store:PhotoIndexStore,config:JSONObject):Boolean {
    val scope=config.getString("scope"); val epoch=config.getLong("epoch")
    val resolver=applicationContext.contentResolver
    val projection=mutableListOf(MediaStore.Images.Media._ID,MediaStore.Images.Media.SIZE,MediaStore.Images.Media.WIDTH,MediaStore.Images.Media.HEIGHT,MediaStore.Images.Media.DATE_MODIFIED,MediaStore.Images.Media.DATE_TAKEN,MediaStore.Images.Media.MIME_TYPE)
    if(Build.VERSION.SDK_INT>=30) projection.add(MediaStore.MediaColumns.GENERATION_MODIFIED)
    val seen=HashSet<Long>(); var processed=0; var more=false; val start=System.currentTimeMillis()
    val fullAtStart=PhotoIndexStore.fullAccess(applicationContext)
    PhotoIndexDb(applicationContext).use { db ->
        val cursor=resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,projection.toTypedArray(),null,null,"${MediaStore.Images.Media.DATE_MODIFIED} DESC, ${MediaStore.Images.Media._ID} DESC") ?: return false
        cursor.use { c ->
          while(c.moveToNext()) {
            if(!active(store,config)) throw ConsentEnded()
            val id=c.getLong(0); seen.add(id)
            val mime=c.getString(6) ?: "image/jpeg"
            if(mime !in SUPPORTED_MIMES) continue
            val signature=(0 until c.columnCount).joinToString(":") { if(c.isNull(it)) "" else c.getString(it) }+":cloud-vision-v1"
            val old=db.get(scope,id)
            if(old!=null && old.signature==signature && (old.epoch==epoch || old.retryAt>System.currentTimeMillis())) continue
            if(processed>=15 || System.currentTimeMillis()-start>75_000) { more=true; continue }
            processed++
            val uri=ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,id)
            val assetId=old?.assetId ?: UUID.randomUUID().toString()
            val metadata=JSONObject().put("taken_at",if(c.isNull(5) || c.getLong(5)<=0) JSONObject.NULL else c.getLong(5))
              .put("modified_at",c.getLong(4)*1000)
              .put("width",if(c.isNull(2) || c.getInt(2)<=0) JSONObject.NULL else c.getInt(2))
              .put("height",if(c.isNull(3) || c.getInt(3)<=0) JSONObject.NULL else c.getInt(3))
              .put("size",max(0,c.getLong(1))).put("mime_type",mime)
            val revision=MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
            val payload=JSONObject().put("revision",revision).put("metadata",metadata).put("epoch",epoch)
            // Recover an accepted task with a small status request before decoding
            // or uploading the same image again after a worker/network restart.
            if(old!=null && old.signature==signature && old.payload.isNotEmpty()) {
              val status=analysisStatus(store,config,assetId,revision)
              if(status.optString("status")!="missing") {
                val complete=awaitAnalysis(store,config,assetId,revision,status,start+75_000)
                db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,payload.toString(),if(complete) epoch else 0,if(complete) 0 else System.currentTimeMillis()+6*60*60*1000))
                continue
              }
            }
            val copy=try { PhotoAnalysisImage.create(applicationContext,uri,mime) }
            catch(_:Exception) {
              db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,"",0,System.currentTimeMillis()+6*60*60*1000))
              continue
            }
            if(!active(store,config)) throw ConsentEnded()
            // Store metadata/UUID only. No image copies or credentials are cached on disk.
            db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,payload.toString(),0,0))
            val accepted=request(store,config,"POST","/assets/$assetId/analyze",payload,copy)
            val complete=awaitAnalysis(store,config,assetId,revision,accepted,start+75_000)
            if(!active(store,config)) throw ConsentEnded()
            db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,payload.toString(),if(complete) epoch else 0,if(complete) 0 else System.currentTimeMillis()+6*60*60*1000))
          }
        }
        // An absent image is deletion evidence only with full access. Partial grants may hide it.
        if(fullAtStart && PhotoIndexStore.fullAccess(applicationContext)) {
          var after=-1L
          deletionPages@ while(true) {
            val identities=db.identitiesAfter(scope,after)
            if(identities.isEmpty()) break
            for((mediaId,assetId) in identities) {
              after=mediaId
              if(mediaId in seen) continue
              if(processed>=15) {more=true;break@deletionPages}
              if(!active(store,config)) throw ConsentEnded()
              request(store,config,"DELETE","/assets/$assetId",JSONObject().put("epoch",epoch))
              db.remove(scope,mediaId);processed++
            }
          }
        }
      }
    return more
  }

  companion object {
    internal val RUN_LOCK=Any()
    private val SUPPORTED_MIMES=setOf("image/jpeg","image/png","image/webp","image/heic","image/heif","image/avif","image/gif","image/bmp")
    const val TAG="tomorrow-photo-index"
    private fun constraints()=Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).setRequiresBatteryNotLow(true).setRequiresCharging(true).build()
    fun enqueue(context:Context) {
      WorkManager.getInstance(context).enqueueUniqueWork("$TAG-batches",ExistingWorkPolicy.APPEND_OR_REPLACE,
        OneTimeWorkRequestBuilder<PhotoIndexWorker>().addTag(TAG).setConstraints(constraints()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build())
    }
    fun schedule(context:Context) {
      WorkManager.getInstance(context).enqueueUniquePeriodicWork("$TAG-periodic",ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<PhotoIndexWorker>(6,TimeUnit.HOURS).addTag(TAG).setConstraints(constraints()).build())
      enqueue(context)
    }
  }
}
