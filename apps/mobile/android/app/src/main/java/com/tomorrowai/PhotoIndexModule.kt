package com.tomorrowai

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import androidx.work.*
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import org.json.JSONArray
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

/** Android-only adapter. Photos are decoded locally; only allowlisted JSON leaves the device. */
class PhotoIndexModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var requesting = false
  override fun getName() = "TomorrowPhotoIndex"

  @ReactMethod fun status(server: String, user: String, promise: Promise) = inBackground(promise) {
    val store = PhotoIndexStore(context)
    val config = store.config()
    JSONObject().put("deviceId", store.deviceId()).put("enabled", config.optBoolean("enabled") && config.optString("scope") == store.scope(server, user))
      .put("state", if (config.optString("scope") == store.scope(server,user)) store.prefs.getString("state", "idle") else "idle")
      .put("lastSyncAt", if (config.optString("scope") == store.scope(server,user)) store.prefs.getLong("last_sync",0) else 0)
  }

  // Called only by the explicit settings action; status/boot never requests permissions.
  @ReactMethod fun requestAccess(promise: Promise) = UiThreadUtil.runOnUiThread {
    if (PhotoIndexStore.hasAccess(context)) { promise.resolve(true); return@runOnUiThread }
    val activity = context.currentActivity as? PermissionAwareActivity
    if (activity == null) { promise.reject("E_ACTIVITY", "请在应用前台开启相册索引"); return@runOnUiThread }
    if (requesting) { promise.reject("E_BUSY", "请先完成相册权限选择"); return@runOnUiThread }
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

  @ReactMethod fun enable(server: String, user: String, epoch: Double, promise: Promise) = inBackground(promise) {
    require(URL(server).protocol == "https") { "相册索引需要 HTTPS 服务地址" }
    require(epoch >= 1 && epoch <= 9_007_199_254_740_991.0 && epoch % 1.0 == 0.0)
    require(PhotoIndexStore.hasAccess(context)) { "请先授予相册访问权限" }
    val store = PhotoIndexStore(context)
    val config = JSONObject().put("server", server.trimEnd('/')).put("user",user).put("scope",store.scope(server,user))
      .put("epoch",epoch.toLong()).put("enabled",true).put("device",store.deviceId())
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
    PhotoIndexDb(context).use { it.writableDatabase.delete("assets","scope=?",arrayOf(store.scope(server,user))) }
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
  fun saveConfig(value:JSONObject) { check(prefs.edit().putString("config",value.toString()).commit()) }
  fun stop() { saveConfig(config().put("enabled",false)); prefs.edit().putString("state","paused").commit() }
  fun current(config:JSONObject):Boolean {
    val current=config()
    return current.optBoolean("enabled") && current.optString("scope")==config.optString("scope") && current.optLong("epoch")==config.optLong("epoch")
  }
  fun deviceId():String = synchronized(DEVICE_LOCK) {
    prefs.getString("device_id",null) ?: UUID.randomUUID().toString().also { check(prefs.edit().putString("device_id",it).commit()) }
  }
  fun scope(server:String,user:String):String = MessageDigest.getInstance("SHA-256").digest((server.trimEnd('/')+"\u0000"+user).toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }

  // Reuse the existing Keystore-encrypted session, never copy tokens into WorkManager data/preferences.
  fun session(config:JSONObject):String? = try {
    val encrypted=context.getSharedPreferences("tomorrow_secure",Context.MODE_PRIVATE).getString("tomorrow.session.v1",null)
    if (encrypted==null) null else {
      val parts=encrypted.split(':',limit=2)
      val key=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey("tomorrow.session.v1",null) as SecretKey
      val cipher=Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)))
      val saved=JSONObject(String(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),Charsets.UTF_8))
      if (saved.optString("serverUrl").trimEnd('/')==config.optString("server") && saved.optJSONObject("user")?.optString("id")==config.optString("user")) saved.optString("token").takeIf { it.isNotBlank() } else null
    }
  } catch (_:Exception) { null }

  companion object {
    private val DEVICE_LOCK=Any()
    fun fullAccess(context:Context):Boolean = context.checkSelfPermission(if(Build.VERSION.SDK_INT>=33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED
    fun hasAccess(context:Context):Boolean = fullAccess(context) || (Build.VERSION.SDK_INT>=34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)==PackageManager.PERMISSION_GRANTED)
  }
}

internal class PhotoIndexDb(context:Context):SQLiteOpenHelper(context,"photo_index.db",null,1) {
  override fun onCreate(db:SQLiteDatabase) { db.execSQL("CREATE TABLE assets(scope TEXT NOT NULL,media_id INTEGER NOT NULL,asset_id TEXT NOT NULL,signature TEXT NOT NULL,payload TEXT NOT NULL,epoch INTEGER NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,media_id))") }
  override fun onUpgrade(db:SQLiteDatabase,old:Int,new:Int) = Unit
  data class Asset(val mediaId:Long,val assetId:String,val signature:String,val payload:String,val epoch:Long,val retryAt:Long)
  fun get(scope:String,id:Long):Asset? = readableDatabase.rawQuery("SELECT media_id,asset_id,signature,payload,epoch,retry_at FROM assets WHERE scope=? AND media_id=?",arrayOf(scope,id.toString())).use { if(it.moveToFirst()) Asset(it.getLong(0),it.getString(1),it.getString(2),it.getString(3),it.getLong(4),it.getLong(5)) else null }
  fun all(scope:String):List<Asset> = readableDatabase.rawQuery("SELECT media_id,asset_id,signature,payload,epoch,retry_at FROM assets WHERE scope=?",arrayOf(scope)).use { c->buildList { while(c.moveToNext()) add(Asset(c.getLong(0),c.getString(1),c.getString(2),c.getString(3),c.getLong(4),c.getLong(5))) } }
  fun put(scope:String,asset:Asset) { writableDatabase.execSQL("INSERT OR REPLACE INTO assets(scope,media_id,asset_id,signature,payload,epoch,retry_at)VALUES(?,?,?,?,?,?,?)",arrayOf(scope,asset.mediaId,asset.assetId,asset.signature,asset.payload,asset.epoch,asset.retryAt)) }
  fun remove(scope:String,id:Long) { writableDatabase.delete("assets","scope=? AND media_id=?",arrayOf(scope,id.toString())) }
}

/** Small, resumable jobs; no worker exists until explicit enable(). */
class PhotoIndexWorker(context:Context,params:WorkerParameters):Worker(context,params) {
  override fun doWork():Result {
    val store=PhotoIndexStore(applicationContext)
    val config=store.config()
    if (!config.optBoolean("enabled")) return Result.success()
    if (store.session(config)==null) { store.prefs.edit().putString("state","signed_out").commit(); return Result.success() }
    if (!PhotoIndexStore.hasAccess(applicationContext)) { store.prefs.edit().putString("state","no_permission").commit(); return Result.success() }
    try {
      // Fail closed before reading photos if server consent was revoked/cleared.
      val status=request(store,config,"GET","")
      if (!status.optBoolean("enabled") || status.optLong("epoch")!=config.optLong("epoch")) {
        if(store.current(config)) store.stop()
        return Result.success()
      }
      if (!active(store,config)) return Result.success()
      store.prefs.edit().putString("state","scanning").commit()
      val more=scan(store,config)
      if (active(store,config)) {
        store.prefs.edit().putString("state",if(more) "queued" else "idle").putLong("last_sync",System.currentTimeMillis()).commit()
        if (more) enqueue(applicationContext)
      }
      return Result.success()
    } catch (_:ConsentEnded) {
      if(store.current(config)) store.stop()
      return Result.success()
    } catch (_:Exception) {
      if(store.current(config)) store.prefs.edit().putString("state","retrying").commit()
      return if (runAttemptCount<4) Result.retry() else Result.success()
    }
  }

  private fun active(store:PhotoIndexStore,config:JSONObject):Boolean = !isStopped && store.current(config) && store.session(config)!=null && PhotoIndexStore.hasAccess(applicationContext)
  private class ConsentEnded:Exception()
  private fun request(store:PhotoIndexStore,config:JSONObject,method:String,suffix:String,body:JSONObject?=null):JSONObject {
    if (!active(store,config)) throw ConsentEnded()
    val token=store.session(config) ?: throw ConsentEnded()
    val url=URL(config.getString("server")+"/v1/photo-index/devices/"+config.getString("device")+suffix)
    require(url.protocol=="https")
    val connection=url.openConnection() as HttpURLConnection
    connection.instanceFollowRedirects=false; connection.connectTimeout=15_000; connection.readTimeout=20_000
    connection.requestMethod=method; connection.setRequestProperty("Authorization","Bearer $token"); connection.setRequestProperty("Accept","application/json")
    try {
      if(body!=null) {
        val bytes=body.toString().toByteArray(Charsets.UTF_8)
        require(bytes.size<=96*1024)
        connection.doOutput=true; connection.setRequestProperty("Content-Type","application/json"); connection.setFixedLengthStreamingMode(bytes.size)
        connection.outputStream.use { it.write(bytes) }
      }
      val status=connection.responseCode
      if(status==401 || status==403 || status==409) throw ConsentEnded()
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
    val recognizer=TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    val labeler=ImageLabeling.getClient(ImageLabelerOptions.Builder().setConfidenceThreshold(0.75f).build())
    try {
      PhotoIndexDb(applicationContext).use { db ->
        val cursor=resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,projection.toTypedArray(),null,null,"${MediaStore.Images.Media.DATE_MODIFIED} DESC, ${MediaStore.Images.Media._ID} DESC") ?: return false
        cursor.use { c ->
          while(c.moveToNext()) {
            if(!active(store,config)) throw ConsentEnded()
            val id=c.getLong(0); seen.add(id)
            val signature=(0 until c.columnCount).joinToString(":") { if(c.isNull(it)) "" else c.getString(it) }
            val old=db.get(scope,id)
            if(old!=null && old.signature==signature && (old.epoch==epoch || old.retryAt>System.currentTimeMillis())) continue
            if(processed>=15 || System.currentTimeMillis()-start>75_000) { more=true; continue }
            processed++
            val uri=ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,id)
            val payload:JSONObject
            val assetId=old?.assetId ?: UUID.randomUUID().toString()
            try {
              if(old!=null && old.signature==signature && old.payload.isNotBlank()) payload=JSONObject(old.payload)
              else {
                val bitmap=decode(uri)
                try {
                  val input=InputImage.fromBitmap(bitmap,0)
                  val text=Tasks.await(recognizer.process(input),20,TimeUnit.SECONDS).text.take(12_000)
                  if(!active(store,config)) throw ConsentEnded()
                  val labels=Tasks.await(labeler.process(input),20,TimeUnit.SECONDS).take(12).joinToString(", ") { it.text }
                  val metadata=JSONObject().put("taken_at",if(c.isNull(5) || c.getLong(5)<=0) JSONObject.NULL else c.getLong(5))
                    .put("modified_at",c.getLong(4)).put("width",max(1,c.getInt(2))).put("height",max(1,c.getInt(3))).put("size",max(0,c.getLong(1))).put("mime_type",c.getString(6) ?: "image/jpeg")
                  val description=buildString { if(labels.isNotBlank()) append("画面标签：$labels。"); if(text.isNotBlank()) append("图片含文字：${text.take(200)}"); if(isEmpty()) append("图片未识别出明确标签或文字。") }
                  val results=JSONArray().put(JSONObject().put("kind","ocr").put("processor","mlkit-chinese-16.0.1-local-v1").put("content",text))
                    .put(JSONObject().put("kind","labels").put("processor","mlkit-labels-17.0.9-local-v1").put("content",labels))
                    .put(JSONObject().put("kind","description").put("processor","local-summary-v1").put("content",description))
                  payload=JSONObject().put("revision",UUID.randomUUID().toString()).put("metadata",metadata).put("results",results)
                } finally { bitmap.recycle() }
              }
            } catch(e:ConsentEnded) { throw e }
            catch(_:Exception) {
              db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,"",0,System.currentTimeMillis()+6*60*60*1000))
              continue
            }
            if(!active(store,config)) throw ConsentEnded()
            // Cache before the network request: retries never repeat OCR on unchanged images.
            db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,payload.toString(),0,0))
            request(store,config,"PUT","/assets/$assetId",payload.put("epoch",epoch))
            if(!active(store,config)) throw ConsentEnded()
            db.put(scope,PhotoIndexDb.Asset(id,assetId,signature,payload.toString(),epoch,0))
          }
        }
        // An absent image is deletion evidence only with full access. Partial grants may hide it.
        if(PhotoIndexStore.fullAccess(applicationContext)) {
          for(old in db.all(scope)) {
            if(old.mediaId in seen) continue
            if(processed>=15) {more=true;break}
            if(!active(store,config)) throw ConsentEnded()
            if(old.payload.isNotBlank()) request(store,config,"DELETE","/assets/${old.assetId}",JSONObject().put("epoch",epoch))
            db.remove(scope,old.mediaId);processed++
          }
        }
      }
    } finally { recognizer.close();labeler.close() }
    return more
  }

  private fun decode(uri:android.net.Uri):Bitmap {
    val resolver=applicationContext.contentResolver
    if(Build.VERSION.SDK_INT>=28) return ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver,uri)) { decoder,info,_ ->
      decoder.allocator=ImageDecoder.ALLOCATOR_SOFTWARE
      decoder.setTargetSampleSize(max(1,(max(info.size.width,info.size.height)+1599)/1600))
    }
    val bounds=BitmapFactory.Options().apply {inJustDecodeBounds=true}
    resolver.openInputStream(uri).use {BitmapFactory.decodeStream(it,null,bounds)}
    var sample=1;while(max(bounds.outWidth,bounds.outHeight)/sample>1600) sample*=2
    val bitmap=resolver.openInputStream(uri).use {BitmapFactory.decodeStream(it,null,BitmapFactory.Options().apply {inSampleSize=sample})} ?: error("decode")
    val orientation=resolver.openInputStream(uri).use { if(it==null) 0 else ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION,0) }
    val degrees=when(orientation){ExifInterface.ORIENTATION_ROTATE_90->90f;ExifInterface.ORIENTATION_ROTATE_180->180f;ExifInterface.ORIENTATION_ROTATE_270->270f;else->0f}
    if(degrees==0f) return bitmap
    return Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,Matrix().apply {postRotate(degrees)},true).also {if(it!==bitmap) bitmap.recycle()}
  }

  companion object {
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
