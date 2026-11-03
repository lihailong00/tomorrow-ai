package com.tomorrowai

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.max

/** A local data-only canvas renderer. No HTML, WebView, URI reads or network. */
internal object ConversationShareRenderer {
  private const val PAD = 56f
  private const val INNER = 788
  private val ink = Color.rgb(48, 54, 70)
  private val secondary = Color.rgb(119, 126, 145)
  private val accent = Color.rgb(89, 103, 188)
  private val divider = Color.rgb(233, 235, 243)
  private val soft = Color.rgb(245, 246, 251)
  internal sealed class Draw {
    class Text(val layout: StaticLayout, val x: Float, val y: Float) : Draw()
    class Rect(val left: Float, val top: Float, val right: Float, val bottom: Float, val color: Int) : Draw()
  }
  internal class Plan internal constructor(private val items: List<Draw>, val height: Int) {
    fun render(check: () -> Unit): Bitmap {
      check(); ConversationSharePolicy.requireHeight(height)
      val bitmap = Bitmap.createBitmap(ConversationSharePolicy.WIDTH, height, Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(bitmap); canvas.drawColor(Color.WHITE)
        val orb = Paint(Paint.ANTI_ALIAS_FLAG).apply {
          shader = LinearGradient(58f, 55f, 104f, 101f, intArrayOf(Color.rgb(225, 240, 255), Color.rgb(169, 171, 231), Color.rgb(240, 206, 232)), null, Shader.TileMode.CLAMP)
        }
        canvas.drawCircle(80f, 79f, 23f, orb)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        for (item in items) {
          check()
          when (item) {
            is Draw.Text -> { canvas.save(); canvas.translate(item.x, item.y); item.layout.draw(canvas); canvas.restore() }
            is Draw.Rect -> { paint.color = item.color; canvas.drawRect(item.left, item.top, item.right, item.bottom, paint) }
          }
        }
        check(); return bitmap
      } catch (error: Throwable) { bitmap.recycle(); throw error }
    }
  }
  fun plan(payload: String, check: () -> Unit): Plan {
    ConversationSharePolicy.requirePayload(payload)
    val doc = try { JSONObject(payload) } catch (_: Exception) { throw ConversationShareFailure("UNAVAILABLE") }
    val messages = doc.opt("messages") as? JSONArray ?: throw ConversationShareFailure("UNAVAILABLE")
    if (messages.length() !in 1..ConversationSharePolicy.MAX_MESSAGES) throw ConversationShareFailure("TOO_LARGE")
    var characters = 0
    fun string(value: Any?, maximum: Int = 40000): String {
      if (value !is String) throw ConversationShareFailure("UNAVAILABLE")
      characters += value.length
      if (value.length > maximum || characters > ConversationSharePolicy.MAX_CHARACTERS) throw ConversationShareFailure("TOO_LARGE")
      return value.replace("\r\n", "\n").replace('\r', '\n')
    }
    val title = string(doc.opt("title"), 80).trim().ifEmpty { "与妥啦的一段对话" }
    val draws = mutableListOf<Draw>()
    var y = 0f
    fun ensure(bottom: Float) { ConversationSharePolicy.requireHeight(ceil(bottom + 110).toInt()); check() }
    fun layout(text: String, width: Int, size: Float, color: Int = ink, bold: Boolean = false, mono: Boolean = false): StaticLayout {
      if (width < 1) throw ConversationShareFailure("TOO_LARGE")
      val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = size; this.color = color
        typeface = if (mono) Typeface.MONOSPACE else if (bold) Typeface.create("sans-serif", Typeface.BOLD) else Typeface.create("sans-serif", Typeface.NORMAL)
      }
      val result = StaticLayout.Builder.obtain(text, 0, text.length, paint, width).setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false).setLineSpacing(9f, 1f).setBreakStrategy(Layout.BREAK_STRATEGY_SIMPLE).setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE).build()
      return result
    }
    fun text(value: String, size: Float = 31f, color: Int = ink, bold: Boolean = false, mono: Boolean = false, x: Float = PAD, width: Int = INNER) {
      val lines = layout(value, width, size, color, bold, mono)
      ensure(y + lines.height); draws += Draw.Text(lines, x, y); y += lines.height + 14f
    }
    fun rule() { ensure(y + 30f); draws += Draw.Rect(PAD, y, PAD + INNER, y + 1f, divider); y += 30f }
    y = 58f; text("妥啦", 32f, bold = true, x = 120f, width = INNER - 64)
    y = max(y, 134f); text(title, 44f, bold = true); y += 15f; rule()
    var blocksTotal = 0
    for (index in 0 until messages.length()) {
      check()
      val message = messages.opt(index) as? JSONObject ?: throw ConversationShareFailure("UNAVAILABLE")
      val role = message.opt("role")
      if (role != "user" && role != "assistant") throw ConversationShareFailure("UNAVAILABLE")
      if (index > 0) { y += 16f; rule() }
      text(if (role == "user") "我的提问" else "妥啦的回答", 25f, if (role == "user") accent else secondary)
      val time = message.opt("timeLabel")
      if (time != null && time != JSONObject.NULL) text(string(time, 100), 22f, secondary)
      val blocks = message.opt("blocks") as? JSONArray ?: throw ConversationShareFailure("UNAVAILABLE")
      blocksTotal += blocks.length()
      if (blocks.length() !in 1..128 || blocksTotal > 1024) throw ConversationShareFailure("TOO_LARGE")
      for (blockIndex in 0 until blocks.length()) {
        check()
        val block = blocks.opt(blockIndex) as? JSONObject ?: throw ConversationShareFailure("UNAVAILABLE")
        when (block.opt("type")) {
          "text" -> {
            val heading = block.opt("heading")
            if (heading != null && heading != JSONObject.NULL && (heading !is Number || heading.toDouble() !in 1.0..6.0 || heading.toDouble() % 1 != 0.0)) throw ConversationShareFailure("UNAVAILABLE")
            val h = (heading as? Number)?.toInt() ?: 0
            if (h > 0) y += 10f
            text(string(block.opt("text")), if (h in 1..2) 37f else if (h > 0) 33f else 31f, bold = h > 0 || role == "user")
          }
          "code" -> {
            val value = string(block.opt("text"))
            val language = block.opt("language")
            val lang = if (language == null || language == JSONObject.NULL) "代码" else string(language, 40).ifBlank { "代码" }
            val label = layout(lang, INNER - 36, 23f, secondary)
            val content = layout(value, INNER - 36, 27f, mono = true)
            val height = label.height + content.height + 48f
            ensure(y + height); draws += Draw.Rect(PAD, y, PAD + INNER, y + height, soft)
            draws += Draw.Text(label, PAD + 18f, y + 14f)
            draws += Draw.Text(content, PAD + 18f, y + label.height + 27f)
            y += height + 18f
          }
          "table" -> {
            val headers = block.opt("headers") as? JSONArray ?: throw ConversationShareFailure("UNAVAILABLE")
            val rows = block.opt("rows") as? JSONArray ?: throw ConversationShareFailure("UNAVAILABLE")
            if (headers.length() !in 1..8 || rows.length() > 500) throw ConversationShareFailure("TOO_LARGE")
            val columns = headers.length(); val cellWidth = INNER / columns
            fun row(cells: JSONArray, header: Boolean) {
              if (cells.length() != columns) throw ConversationShareFailure("UNAVAILABLE")
              val layouts = (0 until columns).map { col -> layout(string(cells.opt(col)), cellWidth - 24, 27f, if (header) secondary else ink, bold = header) }
              val height = layouts.maxOf { it.height } + 28f
              ensure(y + height)
              if (header) draws += Draw.Rect(PAD, y, PAD + INNER, y + height, soft)
              layouts.forEachIndexed { col, lines -> draws += Draw.Text(lines, PAD + col * cellWidth + 12f, y + 14f) }
              draws += Draw.Rect(PAD, y + height, PAD + INNER, y + height + 1, divider)
              y += height + 1
            }
            row(headers, true)
            for (rowIndex in 0 until rows.length()) { check(); row(rows.opt(rowIndex) as? JSONArray ?: throw ConversationShareFailure("UNAVAILABLE"), false) }
            y += 18f
          }
          else -> throw ConversationShareFailure("UNAVAILABLE")
        }
      }
    }
    y += 14f; rule(); text("与妥啦的一段对话 · AI 生成", 22f, secondary)
    val height = ceil(y + 30).toInt(); ConversationSharePolicy.requireHeight(height)
    return Plan(draws, height)
  }
}
