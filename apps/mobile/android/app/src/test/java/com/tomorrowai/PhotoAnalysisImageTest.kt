package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class PhotoAnalysisImageTest {
  @Test fun ordinaryPhotoKeepsAspectAndPixelBudget() {
    val (w,h)=PhotoAnalysisImage.target(4000,3000)
    assertTrue(w<=3072 && h<=3072)
    assertTrue(w.toLong()*h<=4_194_304)
    assertEquals(4.0/3.0,w.toDouble()/h,0.002)
  }
  @Test fun longScreenshotGetsHigherResolutionWithoutCropping() {
    val (w,h)=PhotoAnalysisImage.target(1200,12000)
    assertTrue(h<=8192 && h>7000)
    assertTrue(w.toLong()*h<=6_291_456)
    assertEquals(10.0,h.toDouble()/w,0.02)
  }
  @Test fun smallPhotosAreNotUpscaled() {
    assertEquals(Pair(640,480),PhotoAnalysisImage.target(640,480))
  }
  @Test fun extremeDimensionsStayWithinMemoryBudget() {
    val (w,h)=PhotoAnalysisImage.target(100000,100000)
    assertTrue(w.toLong()*h<=4_194_304)
  }
}
