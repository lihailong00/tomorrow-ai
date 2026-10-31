package com.tomorrowai

import org.junit.Assert.*
import org.junit.Test

class PhoneSourcePolicyTest {
  @Test fun filtersSecretsAndOptOutMarketingBeforeAnyTruncation() {
    for (value in listOf("您的验证码为 123456", "Your verification code is 123456", "限时优惠，回复T退订", "促销 unsubScribe")) assertFalse(value, PhoneSourcePolicy.includeSms(value))
    for (value in listOf("明天下午三点到院复诊，请提前十分钟到达", "快递已到菜鸟驿站，请凭姓名领取", "航班计划明天上午十点起飞")) assertTrue(value, PhoneSourcePolicy.includeSms(value))
  }
  @Test fun unknownMobileNumbersAreMaskedButServiceSendersRemainUseful() {
    assertEquals("138****1234", PhoneSourcePolicy.maskNumber("13812341234"))
    assertEquals("138****1234", PhoneSourcePolicy.maskNumber("+8613812341234"))
    assertEquals("10690000", PhoneSourcePolicy.maskNumber("10690000"))
    assertEquals("13812341234", PhoneSourcePolicy.normalizeNumber("+86 138-1234-1234"))
  }
  @Test fun identitiesAreStableAndContentSensitive() {
    assertEquals(64, PhoneSourcePolicy.digest("资料").length)
    assertEquals(PhoneSourcePolicy.digest("资料"), PhoneSourcePolicy.digest("资料"))
    assertNotEquals(PhoneSourcePolicy.digest("资料"), PhoneSourcePolicy.digest("资料已更新"))
  }
}
