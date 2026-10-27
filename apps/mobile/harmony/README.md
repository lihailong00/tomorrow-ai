# 原生鸿蒙迁移预留

首版交付 Android，React Native 版本固定为 0.82.1；该版本已进入上游不支持状态，后续必须结合原生依赖与 RNOH 兼容矩阵验证升级。本目录是迁移规划，不是已运行的鸿蒙工程。

共享范围为 `src` 中的业务模型、HTTP 协议、页面状态和绝大部分 UI。所有系统能力通过 `src/platform` 接口访问；不可从业务页面直接依赖 Android 原生模块。

迁移原生鸿蒙时：

1. 确认所选 RNOH 发行版支持的 React Native 版本，单独建立 Harmony host 与 ArkTS 工程并运行真实设备冒烟测试；不能假设 Android 安装包或 npm 原生包直接兼容。
2. 以 HUKS/安全存储实现会话凭据接口，以 AVRecorder、文件选择器、系统分享和通知服务实现平台接口。
3. 替换 AsyncStorage、safe-area-context 等原生依赖，验证渲染、键盘、安全区、权限拒绝、文件 URI 和后台生命周期。视觉层使用的 `react-native-svg` 也需要选择匹配 RNOH 的适配版本；图标、助手球和渐变统一封装在 `src/ui/visuals.tsx`，可集中替换渲染实现而不修改页面业务逻辑。
4. 校验网络安全策略、签名、应用身份和厂商推送，不复用 Android 平台配置。
5. 复用版本化 `/v1` API 与后端；执行与 Android 相同的注册、会话恢复、对话、记忆、任务审批、取消和日程回归。

当前能力状态见 `capabilities.json`，所有鸿蒙系统能力均标记为 `planned`。
