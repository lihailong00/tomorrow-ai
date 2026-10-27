# Rust 客户端方案核查

核查日期：2026-10-26。只核查客户端及共享 Rust 核心，不改动正式技术文档。

## 建议结论

**保留 React Native + TypeScript，Android 系统能力用 Kotlin，未来 iOS 用 Swift、原生鸿蒙通过 RNOH / ArkTS 适配。** Rust 偏好优先落实在云端 API、工作流、连接器和工具服务。当前没有足够证据表明，改成 Rust UI 可以同时降低 Android 首发和未来两端迁移的成本。

这是基于本项目的工程判断，尚未运行三端样例。RNOH 依赖矩阵和真机验证仍是选型退出条件，不能承诺固定代码复用率。

## 方案比较

| 方案 | 已核实的支持与限制 | 本项目选择 |
| --- | --- | --- |
| React Native + TypeScript / RNOH | React Native 官方把 OpenHarmony 列为伙伴维护的平台；RNOH 有独立稳定版本线及第三方库适配清单。Android/iOS 主线与鸿蒙依赖不能随意混用。 | 保留主线；早期验证流式聊天、导航、中文输入、录音、文件、授权回跳、安全存储、推送。 |
| Tauri 2 + Rust | 正式移动插件体系围绕 Android/iOS，UI 使用 WebView，系统插件仍常需 Kotlin/Swift。官方仓库已有 `feat/open-harmony` 分支及 `ohos init/dev/build` 代码，不能说完全没有鸿蒙方案；但不能把探索分支等同正式发行及插件完整支持。 | Rust 方向值得关注；当前不替换 RN。鸿蒙分支、插件、构建和升级维护需要独立承担，尚不能证明更方便迁移。 |
| Dioxus | 官方移动指南覆盖 Android/iOS，以 WebView 为稳定路线，WGPU 渲染仍实验性，尚不提供 Android 原生控件/动画。社区 `arkit` 是 Dioxus 0.7 的 OpenHarmony ArkUI renderer，目前 crate 标记 `0.0.1-beta.0`。 | 可做隔离技术样例；不作为本期产品底座。共享 Dioxus 状态并不自动保证两种 renderer 的 UI 和平台能力兼容。 |
| Slint | 2025-06 已加入初始 iOS 支持，2026-09 仍在改进 Android/iOS 生命周期、键盘、选区和安全区域。旧搜索结果里的“iOS 仅在路线图”已过时。未找到由 Slint 官方支持的原生鸿蒙产品路线。 | 不作为同时满足三平台目标的默认选择；适合另外评估 Rust UI / 嵌入式场景。 |
| egui / eframe | 官方 eframe 平台列表含 Android、Web、桌面，未列原生 iOS、鸿蒙；egui 自述不以原生外观为目标，接口仍可能有破坏变更。移动 Web 输入修复不能当作原生 iOS 产品支持证明。 | 不用作本期消费级助手手机 UI。 |
| Flutter + Rust | Flutter 官方支持 Android/iOS，官方平台表没有原生鸿蒙；鸿蒙依赖 OpenHarmony 适配分支和插件。再加 Rust FFI 会引入 Dart/Rust/平台桥接和三端二进制构建。 | Flutter 可保留备选，但不因为喜欢 Rust 就加 Rust 核心层。 |
| Kotlin/Swift/ArkTS UI + Rust/UniFFI 共享核心 | UniFFI 官方完整支持 Kotlin/Swift/Python，Mozilla 在 Firefox 使用；没有官方 ArkTS binding。Rust 本身已有 OpenHarmony target，但这不等于 UniFFI、UI、系统 SDK 已覆盖。 | 端上出现明确的加密、复杂离线算法、音频处理等共享需要时再提取 Rust 核心；鸿蒙另验 N-API。当前云端为主，不增设这一层。 |

## 对现有文档的建议改动

1. 保留 RN/RNOH 主线，增加 Tauri 2、Dioxus、Slint、Flutter + Rust 的取舍说明。
2. 把“Rust 优先”明确为：业务计算和云端主流程优先 Rust，UI 与系统能力按平台成熟度选工具；不要求所有代码同一种语言。
3. 不把“Rust 能编译到 OpenHarmony”写成“Rust 移动框架能直接三端发布”。后者还涉及 UI renderer、生命周期、键盘/无障碍、权限、文件、回跳、推送、商店与签名。
4. 共享纯数据契约优先采用 OpenAPI / JSON Schema + 生成客户端；不把服务端领域对象通过 FFI 带进 App。
5. 若未来明确要求端上 Rust，先用一个有价值的独立模块验证三端构建、桥接、错误传递和取消，不先引入整套共享核心。

## 一手来源与证据

- [React Native：伙伴及社区平台](https://reactnative.dev/docs/out-of-tree-platforms)：列明 OpenHarmony 为伙伴维护。
- [RNOH 稳定版本线](https://gitcode.com/CPF-RN/ohos_react_native/tree/0.82-stable)：有独立 stable 命名和安装坐标；0.82 为文档示例，不在这里指定精确生产版本。
- [RNOH 第三方库维护者清单](https://github.com/react-native-oh-library/usage-docs/blob/master/en/README_EN.md)：部分库须采用鸿蒙包，部分仍在适配；清单版本不代表本项目已验收。
- [Tauri 移动插件开发](https://v2.tauri.app/develop/plugins/develop-mobile/)：Android Kotlin / iOS Swift 实现机制。
- [Tauri 插件支持表](https://v2.tauri.app/plugin/)：正式平台栏目包括 Android/iOS，未列 HarmonyOS。
- [Tauri 官方 OpenHarmony 分支源代码](https://raw.githubusercontent.com/tauri-apps/tauri/feat/open-harmony/crates/tauri-cli/src/mobile/open_harmony/mod.rs)：存在 init/dev/build 与配置代码；该证据只支持“已有适配工作”。
- [Tauri 官方 issue #15236](https://github.com/tauri-apps/tauri/issues/15236)：2026-04 鸿蒙分支实测及依赖白屏问题；不能仅引用 2024 的无计划回复描述当前现状。
- [Dioxus 0.7 移动指南](https://dioxuslabs.com/learn/0.7/guides/platforms/mobile/)：WebView 路线、WGPU 实验性及原生 widget 限制。
- [arkit 作者仓库](https://github.com/richerfu/arkit)、[crate 说明](https://docs.rs/arkit/latest/arkit/)：社区 ArkUI renderer，目前 0.0.1-beta.0。
- [Slint 官方更新记录](https://github.com/slint-ui/slint/blob/master/CHANGELOG.md)：1.12 初始 iOS；1.18 移动端改进。不要依赖返回 404 的旧移动文档。
- [egui 官方仓库](https://github.com/emilk/egui)：eframe 支持平台与非目标。
- [Flutter 官方支持矩阵](https://docs.flutter.dev/reference/supported-platforms)：Android/iOS，未列原生鸿蒙。
- [UniFFI 官方指南](https://mozilla.github.io/uniffi-rs/latest/)、[作者仓库](https://github.com/mozilla/uniffi-rs)：官方语言边界，React Native/Dart 为第三方绑定。
- [Rust 官方 OpenHarmony target 支持](https://doc.rust-lang.org/rustc/platform-support/openharmony.html)：编译器 target 支持，不等于应用框架、绑定和平台 API 全覆盖。

以上为官方文档和维护者仓库核查结果，未对任何移动框架作真机质量或性能保证。
