# 首次使用：连接手机资料

调研与实现日期：2026-10-31。面向 Android APK，包括 HarmonyOS 4 的 Android 兼容环境；不代表原生鸿蒙或 iOS 已实现相同能力。

## 系统资料调研

| 手机自带功能 | 通用接入方式 | 首次使用策略 / 当前实现 |
| --- | --- | --- |
| 照片、截图 | MediaStore / 用户授权的照片范围 | 新增授权与图片元信息预览；图片 OCR、理解和检索复用已有相册索引，单独说明处理去向并开启 |
| 联系人 | Contacts Provider、READ_CONTACTS | 新增本机姓名预览；只在同时选择短信、联系人时匹配短信发件人，不上传通讯录 |
| 日历 | Calendar Provider、READ_CALENDAR | 新增未来 30 天日程读取，处理重复日程实例及全天日程；只读取已同步到系统的事件 |
| 短信 | Telephony Provider、READ_SMS | 新增最近 30 天收件箱读取；过滤验证码与含退订标记的营销内容。受系统/安装来源限制时显示失败，其他来源继续 |
| 天气 | 按城市查询天气厂商 | 新增常用城市选择，通过当前服务器的高德 Web 服务查询；不索取定位权限，不读取天气 App 私有数据库 |
| 健康、运动 | Health Connect / 厂商个人账号授权 | 复用已有健康连接入口；仅在设备支持且授权后读取，厂商数据未必已进入 Health Connect |
| 系统通知 | NotificationListenerService | 复用已有选择应用、开启通知访问的流程；接收授权后的新通知，不假装能读取历史聊天 |
| 文件管理、下载 | Storage Access Framework | 复用现有系统文件选择器；由用户选定文件，不扫描整个手机 |
| 录音机 | 可见的共享音频 / 文件选择 / 系统分享 | 通过现有附件入口选择录音；厂商录音机私有文件不能保证可见，不在启动时读取所有录音 |
| 备忘录、便签 | 厂商开放接口或用户分享/导出 | 复用分享入口，未声称通用读取各品牌备忘录数据库 |
| 时钟、闹钟 | 常用 Intent 可打开时钟、请求设置闹钟 | 没有通用的既有闹钟完整读取流程，本版不索取相关权限 |
| 电话、通话记录 | CallLog Provider、受限制的 READ_CALL_LOG | 不加入首版默认授权；缺少通话业务价值时不增加另一项受限制权限 |
| 浏览器 | 分享网页、用户选择导出文件 | 不通用读取历史、书签或登录状态 |
| 邮箱 | 邮箱协议或厂商个人账号授权 | 可选后续连接，首轮不要求用户配置邮箱 |
| 时间、语言、时区 | 系统公开配置 | 本机展示时区和语言；不收集 IMEI、MAC、广告标识等标识符 |

依据：

- [Android 联系人接口](https://developer.android.com/identity/providers/contacts-provider)
- [Android 日历接口](https://developer.android.com/identity/providers/calendar-provider)
- [Android 共享媒体](https://developer.android.com/training/data-storage/shared/media)、[部分照片访问](https://developer.android.com/about/versions/14/changes/partial-photo-video-access)
- [Android 短信/通话权限及 hard restricted 说明](https://developer.android.com/reference/android/Manifest.permission#READ_SMS)
- [Android 文件选择器](https://developer.android.com/training/data-storage/shared/documents-files)
- [Android 常用 Intent：闹钟、日历、分享等](https://developer.android.com/guide/components/intents-common)
- [Android 应用沙箱](https://source.android.com/docs/security/app-sandbox)
- [高德天气 API](https://developer.amap.com/api/webservice/guide/api/weatherinfo)

## 已实现的使用流程

1. 登录后首次进入今日页，主动展示可跳过的连接引导；不在打开 App 时直接弹一串系统权限。
2. 选择短信、联系人、日历、照片，点击“授权并在本机整理”，依次申请系统权限及读取。任何单项失败都不会阻断其余来源。
3. 首批只在手机内存中预览：联系人最多 200 位；短信最多 100 条、扫描最多 1000 条；日历最多 100 条、扫描最多 500 个实例；照片最多 100 张元信息。
4. 首页显示本次整理数量和接下来的日程；已选来源在回到前台时刷新，不重复弹权限。取消选择停止刷新，设置页可重新管理。
5. 用户勾选至多 10 条短信/日历原文，看到当前服务器地址后点击 AI 整理，才发送所选文字。通讯录和图片不随此操作上传。
6. 复用导入与 Todo 提取接口，产生需要确认的 suggested 待办。导入 SHA-256 标识与提取请求回执可跨重试复用，避免断网重复导入或重复提取。
7. 照片内容分析沿用现有相册处理去向确认，不把列出文件名宣称为“已理解图片”。

## 数据与兼容性

- 本机连接范围按服务器 URL、实例 ID、用户 ID 隔离。短信、联系人、日程和照片列表不写入 AsyncStorage；仅保存来源选择、引导状态、城市和幂等回执。
- 原生查询在串行工作线程执行，不新增后台监听、不申请写短信/写日历/写联系人权限。
- 切换账号/服务器后卸载旧页面，丢弃迟到的读取结果，阻止下一次旧账号上传；已发起并被服务端接收的操作可能继续完成。
- JS 通过 `platform/phoneSources.ts` 接口访问资料；iOS/原生鸿蒙没有适配器时明确不可用，不冒充读取成功。
- 天气增加 `/integrations/amap/read` 的 `operation=weather`。管理员需配置现有高德 Web 服务 Key；普通用户只选城市。旧版服务器或未配置时显示实际错误，不显示模拟天气。
- 短信权限能否授予仍须在不同安装器/品牌真机验证；本地编译与模拟测试不能替代 Mate 60 真机验收。

## 本次改动的集成边界

新代码集中在 `features/phone-sources/`、`platform/phoneSources.ts`、`PhoneSourcesModule.kt`、`PhoneSourcePolicy.kt`。现有文件仅增加首页/设置入口、三项只读权限、原生模块注册，以及高德天气 operation；不修改聊天样式、聊天流式逻辑或已有照片云端同意流程。

已完成集成与发布：Android 实际版本为 **0.1.27 / versionCode 28**，固定入口为 `D:/project/tomorrow-ai/artifacts/apk/tada-latest.apk`。正式目录的两个 latest 别名与版本文件的 SHA-256 相同。当前发布从主目录完整源码构建，保留该目录既有界面与功能；本次模块通过独立接口接入，保留其他窗口改动。

天气 API 已部署至 `https://api.example.invalid`，实例身份、配置版本和已有账号保持不变；更新前已在服务器本机备份数据库和原 API 二进制。目前没有配置高德 Key，管理员仍需在后台配置现有 `AMAP_WEB_API_KEY` 后才能真实查询天气。

最终 v0.1.27 APK 已在独立 Android 31 模拟器上完成升级和全新安装，实际完成首次登录、四项系统授权、联系人/短信/日历/照片信息读取、验证码过滤与首页展示，最终崩溃日志为空。测试只使用虚拟资料，没有读取用户真机或发送真实短信，没有调用付费模型。照片内容分析仍需单独开启并配置相应服务。Mate 60 的具体权限行为尚待真机确认。

验收证据位于 `artifacts/phone-sources-release-20261031/`。本次未执行 Git 提交或推送。
