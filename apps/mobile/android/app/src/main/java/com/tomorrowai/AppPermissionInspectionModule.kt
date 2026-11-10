package com.tomorrowai

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.content.ComponentName
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/** Reads package metadata on demand. No application contents or activity logs are read. */
class AppPermissionInspectionModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val executor = Executors.newSingleThreadExecutor()
  override fun getName() = "TadaAppPermissionInspection"

  override fun invalidate() {
    executor.shutdownNow()
    super.invalidate()
  }

  @ReactMethod fun scan(promise: Promise) { scanPermissions(null, null, promise) }

  @ReactMethod fun scanPermissions(permission: String?, packageName: String?, promise: Promise) {
    try {
      executor.execute {
        try {
          require(permission == null || permission in FILTERS)
          require(packageName == null || PACKAGE_NAME.matches(packageName))
          promise.resolve(inspect(permission, packageName))
        } catch (_: Exception) {
          promise.reject("E_APP_PERMISSION_INSPECTION", "暂时无法读取应用权限")
        }
      }
    } catch (_: RejectedExecutionException) {
      promise.reject("E_APP_PERMISSION_INSPECTION", "暂时无法读取应用权限")
    }
  }

  private fun inspect(permission: String?, packageName: String?) = with(context.packageManager) {
    @Suppress("DEPRECATION")
    val apps = if (packageName != null) {
      listOf(if (Build.VERSION.SDK_INT >= 33) getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()))
        else getPackageInfo(packageName, PackageManager.GET_PERMISSIONS))
    } else if (Build.VERSION.SDK_INT >= 33) getInstalledPackages(
        PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
      ) else getInstalledPackages(PackageManager.GET_PERMISSIONS)
    check(packageName != null || apps.any { it.packageName == context.packageName }) { "Package information unavailable" }

    val accessibility = runCatching {
      val manager = checkNotNull(context.getSystemService(AccessibilityManager::class.java))
      manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        .mapNotNull { it.resolveInfo?.serviceInfo?.packageName }.toSet()
    }.getOrNull()
    val notifications = runCatching { NotificationManagerCompat.getEnabledListenerPackages(context) }.getOrNull()
    val invisibleSpecial = packageName == null && ((accessibility.orEmpty() + notifications.orEmpty()) - apps.map { it.packageName }.toSet()).isNotEmpty()
    val eligible = apps.filter { info ->
      info.applicationInfo?.let { it.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0 } == true
    }
    check(packageName == null || eligible.size == 1) { "Selected app unavailable" }

    val findings = eligible.mapNotNull { info ->
      val app = info.applicationInfo ?: return@mapNotNull null
      val grants = grantedSensitivePermissions(info).toMutableList()
      val reasons = mutableListOf<String>()
      var priority = 0
      if (info.packageName in accessibility.orEmpty()) {
        grants.add("无障碍服务")
        reasons.add("已启用无障碍服务")
        priority += 4
      }
      if (info.packageName in notifications.orEmpty()) {
        grants.add("通知使用权")
        reasons.add("已开启通知使用权")
        priority += 3
      }
      val name = runCatching { getApplicationLabel(app).toString() }.getOrDefault(info.packageName)
        .replace(CONTROL_CHARACTERS, " ").trim().take(100).ifEmpty { info.packageName }
      val unrelated = grants.filter { it in UTILITY_SENSITIVE_GRANTS }
      if (SIMPLE_UTILITY.containsMatchIn(name) && unrelated.isNotEmpty()) {
        reasons.add("应用名称像是简单工具，建议核对" + unrelated.joinToString("、") + "权限的用途")
        priority += 3
      }
      if (grants.size >= 2 && installSource(info.packageName) == null) {
        reasons.add("系统未提供安装来源，同时已获准使用多项敏感权限")
        priority += 2
      }
      val include = packageName != null || if (permission == null) reasons.isNotEmpty()
        else grants.any { it in FILTERS.getValue(permission) }
      if (include) Finding(name, info.packageName, grants, reasons, priority) else null
    }.sortedWith(compareByDescending<Finding> { it.priority }.thenBy { it.name }.thenBy { it.packageName })

    Arguments.createMap().apply {
      putInt("scanned", eligible.size)
      putInt("flagged", findings.count { it.reasons.isNotEmpty() })
      putInt("matched", findings.size)
      putArray("unavailable", Arguments.fromList(buildList {
        if (accessibility == null) add("无障碍服务")
        if (notifications == null) add("通知使用权")
        if (invisibleSpecial) add("部分已启用服务对应的应用未出现在可见清单中")
        if (eligible.any { !it.requestedPermissions.isNullOrEmpty() && it.requestedPermissionsFlags == null }) add("部分应用的权限授权状态")
      }))
      putArray("findings", Arguments.createArray().apply {
        findings.take(40).forEach { finding -> pushMap(Arguments.createMap().apply {
          putString("name", finding.name)
          putString("packageName", finding.packageName)
          putArray("grants", Arguments.fromList(finding.grants))
          putArray("reasons", Arguments.fromList(finding.reasons))
        }) }
      })
    }
  }

  private fun grantedSensitivePermissions(info: PackageInfo): List<String> {
    val flags = info.requestedPermissionsFlags ?: return emptyList()
    return info.requestedPermissions.orEmpty().mapIndexedNotNull { index, permission ->
      val granted = ((flags.getOrNull(index) ?: 0) and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
      if (granted) SENSITIVE_PERMISSIONS[permission] else null
    }.distinct()
  }

  private fun PackageManager.installSource(packageName: String): String? = runCatching {
    @Suppress("DEPRECATION")
    if (Build.VERSION.SDK_INT >= 30) getInstallSourceInfo(packageName).installingPackageName
    else getInstallerPackageName(packageName)
  }.getOrNull()

  @ReactMethod fun openApplication(packageName: String, promise: Promise) = openSettings(promise) {
    require(PACKAGE_NAME.matches(packageName))
    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    null
  }

  @ReactMethod fun openPrivacy(promise: Promise) = openSettings(promise) {
    val intent = Intent(Settings.ACTION_PRIVACY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    // OEMs may put the privacy dashboard under a different settings activity.
    if (runCatching { context.startActivity(intent) }.isFailure) {
      context.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    null
  }

  @ReactMethod fun openDeviceSettings(destination: String, packageName: String?, promise: Promise) = openSettings(promise) {
    val intent = when (destination) {
      "selected_app" -> {
        require(packageName != null && PACKAGE_NAME.matches(packageName))
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
      }
      "privacy" -> Intent(Settings.ACTION_PRIVACY_SETTINGS)
      "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
      "notification_access" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      else -> error("Unknown settings destination")
    }
    if (runCatching { startSystemSettings(intent) }.isSuccess) "requested"
    else {
      startSystemSettings(Intent(Settings.ACTION_SETTINGS))
      "system_settings"
    }
  }

  @Suppress("DEPRECATION")
  private fun startSystemSettings(intent: Intent) {
    val system = context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
      .firstOrNull { candidate ->
        candidate.activityInfo.applicationInfo.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
      }?.activityInfo ?: error("System settings activity unavailable")
    context.startActivity(intent.setComponent(ComponentName(system.packageName, system.name)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun openSettings(promise: Promise, action: () -> String?) {
    // The scheduler returns a Boolean, but Promise-based React methods must return JVM void.
    UiThreadUtil.runOnUiThread {
      try {
        promise.resolve(action())
      } catch (_: Exception) {
        promise.reject("E_APP_PERMISSION_SETTINGS", "暂时无法打开系统设置")
      }
    }
  }

  private data class Finding(val name: String, val packageName: String, val grants: List<String>, val reasons: List<String>, val priority: Int)

  companion object {
    private val CONTROL_CHARACTERS = Regex("[\\p{Cc}\\p{Cf}]")
    private val SIMPLE_UTILITY = Regex("手电筒|计算器|flashlight|calculator", RegexOption.IGNORE_CASE)
    private val PACKAGE_NAME = Regex("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")
    private val FILTERS = mapOf(
      "microphone" to setOf("麦克风"), "camera" to setOf("相机"),
      "location" to setOf("定位", "后台定位"), "contacts" to setOf("通讯录"), "sms" to setOf("短信"),
      "accessibility" to setOf("无障碍服务"), "notification_access" to setOf("通知使用权"),
    )
    private val UTILITY_SENSITIVE_GRANTS = setOf("通讯录", "短信", "通话记录", "麦克风", "后台定位")
    private val SENSITIVE_PERMISSIONS = mapOf(
      Manifest.permission.READ_CONTACTS to "通讯录",
      Manifest.permission.READ_SMS to "短信",
      Manifest.permission.READ_CALL_LOG to "通话记录",
      Manifest.permission.RECORD_AUDIO to "麦克风",
      Manifest.permission.CAMERA to "相机",
      Manifest.permission.ACCESS_FINE_LOCATION to "定位",
      Manifest.permission.ACCESS_COARSE_LOCATION to "定位",
      Manifest.permission.ACCESS_BACKGROUND_LOCATION to "后台定位",
    )
  }
}
