package com.tomorrowai;

import static org.junit.Assert.*;
import org.junit.Test;
import java.util.Collections;
import java.util.Set;
import java.io.File;

/** Exercises the same capture policy used by the Android listener, without a device. */
public class AppInputPolicyTest {
  @Test public void rejectsAuthenticationAndPaymentApprovalSnippets() {
    String[] rejected = {
      "【妥啦】您的验证码为 123456", "动态密码：123456", "请进行安全验证后登录",
      "新设备登录通知", "Verification code: 123456", "Your code is 123456",
      "One-time password 123456", "Two factor authentication", "OTP: 123456", "Authorization code ABCD", "Sign-in code 123456",
      "请确认付款", "Payment confirmation needed", "Approve this payment"
    };
    for (String text : rejected) assertTrue(text, AppInputStore.INSTANCE.isSensitive(text));
  }

  @Test public void preservesOrdinaryChatAndOrderReminders() {
    String[] accepted = {"下午三点开会", "您的外卖已送达", "订单已支付成功，预计明天送达", "请记得明天缴费", "Meeting at 3 pm"};
    for (String text : accepted) assertFalse(text, AppInputStore.INSTANCE.isSensitive(text));
  }

  @Test public void treatsUnknownAndSpoofedPackagePrefixesAsUnidentifiedShares() {
    assertEquals("wechat", AppInputStore.INSTANCE.sourceId("com.tencent.mm"));
    assertEquals("qq", AppInputStore.INSTANCE.sourceId("com.tencent.mobileqq"));
    assertEquals("shared", AppInputStore.INSTANCE.sourceId("com.tencent.mm.evil"));
    assertEquals("shared", AppInputStore.INSTANCE.sourceId("unknown.app"));
    assertEquals("shared", AppInputStore.INSTANCE.sourceId(null));
  }

  @Test public void requiresTheFileToMatchTheAndroidGrantedClipUris() {
    String granted = "content://provider.example/document/one";
    Set<String> clips = Collections.singleton(granted);
    assertTrue(AppInputStore.INSTANCE.isGrantedContentShare(granted, true, clips));
    assertFalse(AppInputStore.INSTANCE.isGrantedContentShare(granted, false, clips));
    assertFalse(AppInputStore.INSTANCE.isGrantedContentShare("content://provider.example/document/private", true, clips));
    for (String rejected : new String[]{"file:///data/private", "https://example.com", "content://", "content://user@provider.example/document"}) {
      assertFalse(rejected, AppInputStore.INSTANCE.isGrantedContentShare(rejected, true, Collections.singleton(rejected)));
    }
  }

  @Test public void reusedAndroidNotificationKeysDoNotDeduplicateDifferentMessages() {
    String original = AppInputStore.INSTANCE.notificationSnapshotId("com.tencent.mm", "chat", 1000L, "项目讨论", "下午三点开会");
    assertEquals(original, AppInputStore.INSTANCE.notificationSnapshotId("com.tencent.mm", "chat", 1000L, "项目讨论", "下午三点开会"));
    assertNotEquals(original, AppInputStore.INSTANCE.notificationSnapshotId("com.tencent.mm", "chat", 2000L, "项目讨论", "下午三点开会"));
    assertNotEquals(original, AppInputStore.INSTANCE.notificationSnapshotId("com.tencent.mm", "chat", 1000L, "项目讨论", "改到下午四点"));
  }

  @Test public void ocrAcceptsOnlyDirectPrivateCacheFiles() {
    File root = new File(System.getProperty("java.io.tmpdir"), "tada-owned-images");
    assertTrue(AppInputStore.INSTANCE.isOwnedCacheFile(root, new File(root, "image-one").toURI().toString()));
    assertFalse(AppInputStore.INSTANCE.isOwnedCacheFile(root, new File(root, "../outside").toURI().toString()));
    assertFalse(AppInputStore.INSTANCE.isOwnedCacheFile(root, new File(root, "nested/image").toURI().toString()));
    assertFalse(AppInputStore.INSTANCE.isOwnedCacheFile(root, new File(root.getParentFile(), "tada-owned-images-other/image").toURI().toString()));
    assertFalse(AppInputStore.INSTANCE.isOwnedCacheFile(root, "content://photos/private-image"));
    assertFalse(AppInputStore.INSTANCE.isOwnedCacheFile(root, "https://example.com/image.jpg"));
  }

  @Test public void ocrBoundsDimensionsBeforeAllocatingAPixelBitmap() {
    assertEquals(1, AppSharedImageText.INSTANCE.sampleSize(1024, 768));
    int sample = AppSharedImageText.INSTANCE.sampleSize(4097, 3000);
    assertTrue((4097L + sample - 1) / sample <= 2048);
    for (int[] invalid : new int[][]{{0, 100}, {100, -1}, {50000, 50000}}) {
      try {
        AppSharedImageText.INSTANCE.sampleSize(invalid[0], invalid[1]);
        fail("Expected dimensions to be rejected before decoding");
      } catch (IllegalArgumentException expected) { }
    }
  }
}
