package com.tomorrowai

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Receives new notifications only, after both system consent and per-app opt-in. */
class AppNotificationListener : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    try {
      if (AppInputStore.sourceId(sbn.packageName) !in AppInputStore.selected(this)) return
      val notification = sbn.notification ?: return
      if (notification.visibility == Notification.VISIBILITY_SECRET ||
          notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 ||
          notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return
      val extras = notification.extras ?: return
      val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
      // Do not read MessagingStyle history, conversation archives or active notifications.
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
        ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString().orEmpty()
      AppInputStore.addNotification(this, sbn.packageName, sbn.key, sbn.postTime, title, text)
    } catch (_: Exception) { /* A malformed third-party notification must not crash the listener. */ }
  }
}
