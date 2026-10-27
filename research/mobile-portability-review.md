# Android 首发及 iOS / 鸿蒙迁移技术复核

日期：2026-10-26。用途：给两份正式评审稿提供依据；本文件不是新增实施承诺。

## 推荐结论

本项目尚无客户端实现包袱，服务端已规划 TypeScript。建议默认采用 **React Native + TypeScript、Android 原生壳先交付、iOS 与 React Native OpenHarmony（RNOH）保留独立原生工程**。界面、状态、网络协议、缓存策略和业务规则尽量共享，系统能力按接口分别实现。以上是本项目工程判断，并非任何框架保证全功能三端一致。

RN 的优势来自现有 TS 选型和可验证的鸿蒙适配工程；不是因为使用 TypeScript 就能直接运行 ArkTS。ArkTS 原生模块仍需单独编写。首发不做 Web/PWA、桌面或手机通用自动化。云端 Agent、记忆和计划服务保持平台无关，手机负责交互、授权、采集及展示。

## 三种候选路线

| 路线 | Android / iOS | 鸿蒙原生迁移 | 判断 |
| --- | --- | --- | --- |
| React Native + TS | 官方主目标，支持平台相关实现 | RN 官网把 React Native OpenHarmony 列为 Partners 维护的 out-of-tree 平台；需 RNOH 工程及原生模块、组件与依赖验收 | 适合本项目默认路线；锁定 RN 与 RNOH 可兼容版本，不假定 npm 库全部可用 |
| Flutter + Dart | Flutter 团队官方支持矩阵包含 Android / iOS | OpenHarmony 生态维护 SDK、引擎、插件适配分支；不在 Google Flutter 官方支持矩阵内 | 可作团队 Flutter 更熟练时的备选；不能宣传 Google 官方支持鸿蒙；需独立验证 SDK 分支和插件 |
| Kotlin Multiplatform | 可共享数据/业务；Compose Multiplatform 可选共享支持平台 UI，或保留原生 UI | Kotlin/Native 官方 target 表未列 HarmonyOS；不能把 Linux 或 Android target 当鸿蒙 target；生态移植另行评估 | 如只考虑安卓+iOS很有吸引力；本项目还有明确鸿蒙目标，不作三端默认保证 |

一手来源：[RN out-of-tree 平台](https://reactnative.dev/docs/out-of-tree-platforms)、[Flutter 官方支持矩阵](https://docs.flutter.dev/reference/supported-platforms)、[OpenHarmony Flutter 维护方文档](https://gitcode.com/openharmony_sig/docs)、[KMP 官方说明](https://kotlinlang.org/multiplatform/)、[Kotlin/Native targets](https://kotlinlang.org/docs/native-target-support.html)。KMP 与 Compose 是不同层次的技术，前者共享逻辑不必然共享 UI。

## RN / RNOH 版本与依赖边界

[RNOH 维护方仓库](https://gitcode.com/CPF-RN/ohos_react_native)（RN 官方页面链接的 [AtomGit 地址](https://atomgit.com/CPF-RN/ohos_react_native)）的当前 README 将 `main` 描述为版本演进/探索分支，并给出生产稳定版本线。读取时推荐 `0.82-stable`，此处仅记录查阅结果，**不将其作为项目长期固定版本**。不同抓取页面可能反映演进分支，不能用最新主干或 RC 代表生产成熟度。

初始化时做 1～2 周迁移验证，记录并锁定 React、RN、RNOH、Hermes、Android SDK、HarmonyOS SDK、构建工具与原生库精确版本，保存 lockfile/补丁。即使维护方提供 `*-stable` 浮动标签，生产构建仍应固定验证过的精确包版本和提交；升级要重跑三端冒烟用例。

[RNOH 三方库维护方目录](https://github.com/react-native-oh-library/usage-docs/blob/master/en/README_EN.md) 按上游版本、鸿蒙包和适配状态列库。例如文件、权限、WebView、导航、录音等存在适配包或具体版本限制。这只能证明有移植路径，不证明最新版上游库、所有接口与平台行为已经一致。每次引入原生依赖都登记：三端版本、接口覆盖、许可证、维护状态、已知差异、替代实现、真机验证结果。纯 JS 依赖也需排查 DOM、Node、平台假设和传递原生依赖。

## Expo 的限定

[Expo 官方定位](https://docs.expo.dev/core-concepts/)覆盖 Android、iOS 和 Web；[Expo Modules API 官方页面](https://docs.expo.dev/modules/overview/)额外提及的是实验 macOS/tvOS 支持，未列鸿蒙。故本项目优先可维护的原生工程与 RN/RNOH 构建，不把 Expo Go、EAS Build/Submit、Expo Push 或 Expo Modules API 作为三端必须依赖。单个 Expo 纯 JS 库或有可验证替代的模块可独立评估，不能从某个 `@expo/*` 库可用推导整个 Expo SDK 鸿蒙可用。

## 必须隔离的平台接口（设计建议）

| 接口 | 共享产品语义 | 逐平台实现及边界 |
| --- | --- | --- |
| AudioCapture | 录音状态、分片、暂停/恢复、中断、上传 | Android Kotlin；iOS Swift；鸿蒙 ArkTS；用户主动开始录音；处理麦克风权限、锁屏、来电、蓝牙与进程回收；不承诺录系统或其他 App 音频 |
| BackgroundTransfer / Lifecycle | 附件上传队列、重试、断点、状态恢复 | 用各系统允许的任务机制；长 Agent 任务及精确计划在服务端，不能依赖手机常驻或跨端一致后台定时 |
| Notifications | 通知ID、路由、静默设置、已读 | Android 按渠道与地区选推送供应商；iOS APNs；鸿蒙 Push Kit；统一服务端发送接口，分别处理设备 token 变化；推送只是提醒，恢复 App 后查询任务真相 |
| HealthSource | 标准化健康记录、类型、单位、来源、同意与删除 | 后续按 Android Health Connect / Apple HealthKit / 鸿蒙可用健康服务分别评估，权限、审批和字段映射独立；首发不做 |
| Files / Sharing | 文件元信息、导入、导出、分享 | 原生文件选择器、内容 URI/临时访问范围、沙箱路径各异；禁止共享层拼接 Android 路径或遍历任意手机目录 |
| Auth / SecureStorage | 产品账号、连接器授权状态、会话刷新 | 系统浏览器授权及回跳、平台账号入口、安全存储分别实现；云端连接器长期令牌留后端；共享层不嵌入供应商密钥 |
| Billing | 服务端权益、订单、校验和恢复语义 | 各商店/渠道 SDK、商品、收据、回调和恢复购买单独接入；首发可受邀免费测试；不可假设同一支付SDK跨端可用 |
| DeviceActions | 可用能力探测、范围、批准及结果 | 支持分享/打开链接/选择文件等明确动作；Android Intent、iOS App Intents/快捷指令、鸿蒙 Want 等分别评估；缺失时隐藏或降级，不用默认全局无障碍权限替代 |

接口返回至少区分 unsupported、permissionDenied、temporarilyUnavailable 和 success。产品先探测能力再渲染入口。授权、后台限制、原生服务和商店审核各自验收。

Android 前台服务及麦克风受启动时机和使用中权限约束，见 [Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)。鸿蒙官方录音指导要求从前台开始录音；需要持续/后台录音时申请连续任务，见 [AVRecorder 指导](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/using-avrecorder-for-recording)。iOS 后台刷新/处理是系统管理的能力，见 [Apple Background Tasks](https://developer.apple.com/documentation/backgroundtasks)。这些限制共同支持“持久计划和 Agent 执行放服务端”的架构选择。

## 鸿蒙定义与验证门槛

正式文档中的“鸿蒙版”应指 **HarmonyOS NEXT 原生应用路线（HAP/APP 构建、签名、真机和应用市场验收）**。历史上能够运行 Android APK 的华为设备只算 Android 兼容测试，不等于已完成鸿蒙原生移植；OpenHarmony 是开源底座及生态适配入口，不等于自动获得所有华为商业服务 SDK 和上架资格。手机型号、目标 SDK 与系统版本在立项时固定。

第 1～2 周至少验证：同一业务模块的登录回跳、列表与输入法、消息流/断线恢复、本地持久化、文件选择上传、用户主动录音、通知点击恢复任务。Android 主线做到完整；iOS 和鸿蒙跑最小样例，并记录缺失能力。两者是可移植性技术验证，不属于首发产品交付或三端同时上线。付费/健康等后置能力至少验证供应商接入可行性，不提前承诺时间。

## 对正式技术稿的必要改动

1. 所有“Web 首发 / Web MVP / PWA 后续移动 / 桌面优先”替换为 Android 手机首发；保留服务端接口，不做用户 Web 客户端；管理后台如必要只限运维。
2. 客户端默认 RN + TS，Android Kotlin；未来 iOS Swift、鸿蒙 ArkTS/RNOH；删除默认 Next.js 用户前端和 Electron 里程碑。
3. 架构明确 App 退出后云任务仍继续；事件序号恢复、离线缓存、上传队列、通知与任务真相分离。
4. 首发补上移动权限、分享/文件导入、前后台切换、录音策略、弱网和崩溃恢复；第一期不做手机全局控制、系统音频采集、健康和支付。
5. 里程碑含 Android 签名测试包、真机矩阵、内测/商店分发；iOS 与鸿蒙正式迁移另行估时，前期只做样例验证。
6. 验收覆盖锁屏/进程回收、网络切换、权限拒绝/撤销、推送延迟、登录回跳、原生依赖升级和本地缓存删除；不再用响应式布局代表移动验收。

