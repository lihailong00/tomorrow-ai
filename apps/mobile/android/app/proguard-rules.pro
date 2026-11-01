# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# WorkManager persists these class names in existing installations and creates
# workers through reflection after restarts or upgrades. Keep that contract.
-keep,allowoptimization class com.tomorrowai.** extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# RN 0.82.1 registers this wrapper and its nested delegates from JNI even with
# dev support disabled. Java reachability alone drops it and crashes on launch.
-keep class com.facebook.react.devsupport.CxxInspectorPackagerConnection* { *; }
