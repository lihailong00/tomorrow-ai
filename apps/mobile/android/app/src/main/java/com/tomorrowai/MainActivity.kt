package com.tomorrowai

import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  private var keyboardHost: View? = null
  private var keyboardLayoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Keep resize enabled: older Android versions need it to report IME changes.
    // Some vendor windows do not resize despite this flag, so also observe their
    // actual visible frame instead of relying on IME insets alone.
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
    val content = findViewById<View>(android.R.id.content)
    val initialBottom = content.paddingBottom
    keyboardHost = content
    ViewCompat.setOnApplyWindowInsetsListener(content) { _, insets ->
      updateKeyboardPadding(content, initialBottom, insets)
      insets
    }
    keyboardLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
      updateKeyboardPadding(content, initialBottom, ViewCompat.getRootWindowInsets(content))
    }.also { content.viewTreeObserver.addOnGlobalLayoutListener(it) }
    ViewCompat.requestApplyInsets(content)
  }

  private fun updateKeyboardPadding(
      content: View,
      initialBottom: Int,
      insets: WindowInsetsCompat?,
  ) {
    if (!content.isLaidOut) return
    val location = IntArray(2)
    content.getLocationOnScreen(location)
    val contentBottom = location[1] + content.height
    val visibleFrame = Rect()
    content.getWindowVisibleDisplayFrame(visibleFrame)
    val visibleOverlap = (contentBottom - visibleFrame.bottom).coerceAtLeast(0)
    // A navigation bar is not a keyboard. A real IME normally obscures much
    // more than 80dp; floating IMEs do not require moving a bottom composer.
    val minimumKeyboardHeight = (80 * resources.displayMetrics.density).toInt()
    var overlap = if (visibleFrame.height() > 0 && visibleOverlap > minimumKeyboardHeight) {
      visibleOverlap
    } else {
      0
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
        insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      if (imeBottom > 0) {
        // Window bounds stay independent of a resized content view. Comparing
        // screen coordinates avoids adding the keyboard height a second time
        // when the system has already resized the window.
        val keyboardTop = windowManager.currentWindowMetrics.bounds.bottom - imeBottom
        overlap = maxOf(overlap, (contentBottom - keyboardTop).coerceAtLeast(0))
      }
    }
    val bottom = initialBottom + overlap
    if (content.paddingBottom != bottom) {
      content.setPadding(content.paddingLeft, content.paddingTop, content.paddingRight, bottom)
    }
  }

  override fun onDestroy() {
    keyboardHost?.let { content ->
      keyboardLayoutListener?.let { listener ->
        if (content.viewTreeObserver.isAlive) {
          content.viewTreeObserver.removeOnGlobalLayoutListener(listener)
        }
      }
      ViewCompat.setOnApplyWindowInsetsListener(content, null)
    }
    keyboardLayoutListener = null
    keyboardHost = null
    super.onDestroy()
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "TomorrowAI"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
