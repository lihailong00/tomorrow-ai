package com.tomorrowai

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.ByteArrayOutputStream
import kotlin.math.min
import kotlin.math.sqrt
import kotlin.math.floor

/** Creates memory-only analysis copies; never opens an original for writing. */
internal object PhotoAnalysisImage {
  const val MAX_BYTES=4*1024*1024
  data class Copy(val bytes:ByteArray,val mime:String)

  fun target(width:Int,height:Int):Pair<Int,Int> {
    require(width>0 && height>0)
    val long=maxOf(width,height).toDouble()
    val short=minOf(width,height).toDouble()
    val tall=long/short>2.5
    val pixelCap=if(tall) 6_291_456.0 else 4_194_304.0
    val edgeCap=if(tall) 8192.0 else 3072.0
    val scale=min(1.0,min(edgeCap/long,sqrt(pixelCap/(width.toDouble()*height))))
    return Pair(maxOf(1,floor(width*scale).toInt()),maxOf(1,floor(height*scale).toInt()))
  }

  fun create(context:Context,uri:Uri,sourceMime:String):Copy {
    // ImageDecoder applies EXIF orientation; re-encoding drops GPS and other EXIF.
    val bitmap=ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver,uri)) { decoder,info,_ ->
      val size=target(info.size.width,info.size.height)
      decoder.allocator=ImageDecoder.ALLOCATOR_SOFTWARE
      decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
      decoder.setTargetSize(size.first,size.second)
    }
    try {
      require(bitmap.width>=32 && bitmap.height>=32)
      if(sourceMime=="image/png") {
        val png=encode(bitmap,Bitmap.CompressFormat.PNG,100)
        if(png.size<=MAX_BYTES) return Copy(png,"image/png")
      }
      // Keep text edges readable: never reduce JPEG quality below 92 to meet a cap.
      val rgb=if(bitmap.hasAlpha()) Bitmap.createBitmap(bitmap.width,bitmap.height,Bitmap.Config.ARGB_8888).also {
        val canvas=Canvas(it);canvas.drawColor(Color.WHITE);canvas.drawBitmap(bitmap,0f,0f,null)
      } else bitmap
      try {
        for(quality in intArrayOf(95,92)) {
          val jpeg=encode(rgb,Bitmap.CompressFormat.JPEG,quality)
          if(jpeg.size<=MAX_BYTES) return Copy(jpeg,"image/jpeg")
        }
        error("Analysis copy exceeds quality-preserving size limit")
      } finally { if(rgb!==bitmap) rgb.recycle() }
    } finally { bitmap.recycle() }
  }

  private fun encode(bitmap:Bitmap,format:Bitmap.CompressFormat,quality:Int):ByteArray =
    ByteArrayOutputStream().use { output ->
      check(bitmap.compress(format,quality,output))
      output.toByteArray()
    }
}
