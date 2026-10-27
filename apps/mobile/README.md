# 妥啦（Tada）— Android 首版

React Native 0.82.1、React 19.1.1、TypeScript；原生 Android 包 `com.tomorrowai`，最低 Android 10（API 29）。[React Native 0.82 已停止上游支持](https://reactnative.dev/releases/)，当前固定版本用于首版构建，后续升级需验证原生依赖和鸿蒙迁移矩阵。

## 本地开发

需要 Node 20.19.4+、pnpm、完整 JDK 17 或 21（包含 `javac`、`jlink`）、Android SDK Platform 36、Build Tools 36.0.0、NDK 27.2.12479018、CMake 3.22.1。设置本地 `JAVA_HOME`、`ANDROID_HOME`，并将 `node` 放入 PATH；可在 `android/local.properties` 设置 `sdk.dir`。不要提交机器路径。部分 IDE 的精简 JBR 不含 `jlink`，不能用于构建；Android Studio 自带完整 JBR 可用。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test --runInBand
pnpm start
pnpm android
```

开发模式通过 Metro 热更新。API 默认连接 `http://10.0.2.2:8080`（Android 模拟器宿主机）；真机需在登录页或设置页填写可达的服务地址。

## 手机号账号测试

登录页支持中国大陆手机号注册和验证码登录。先选择“创建账号”或“登录”，输入手机号，点击“获取验证码”，再填写 `123456`。当前为固定验证码测试模式，不会实际发送短信；验证码挑战五分钟有效，错误五次后失效，同一手机号和用途一分钟内不能重复获取。

每个手机号对应独立账号。退出后用另一个手机号注册即可验证多用户；重新登录原手机号可恢复其会话、记忆、任务和计划。当前会话仍通过 Android Keystore 保存，服务端注销会撤销该次登录令牌。此更改同时要求运行新版 Rust API，旧服务不包含 `/auth/phone/*` 路由。

## 生成可独立启动的测试安装包

在仓库根目录运行 `./scripts/Build-Android.ps1`，会查找 Node、JDK 17/21 与 Android SDK，安装锁定依赖、检查类型并构建双架构测试包。所有交付 APK 统一输出到仓库根目录的 `artifacts/apk/`：每次保留带版本号与北京时间的 `tada-v<版本号>-yyyyMMdd-HHmmss-fff.apk`，同时覆盖 `tada-latest.apk` 作为最新版固定入口。版本号读取本目录 `package.json`。不要再向 `artifacts/` 根目录或其他位置复制交付 APK。可通过 `-NodePath`、`-JavaHome`、`-AndroidHome` 指定本机工具；网络代理通过环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 或 `-ProxyUrl` 临时传入。

也可直接使用 Gradle：

```powershell
cd android
.\gradlew.bat :app:assembleDebug '-PofflineBundle=true' '-PreactNativeArchitectures=arm64-v8a,x86_64'
```

直接使用 Gradle 时，内部产物为 `android/app/build/outputs/apk/debug/app-debug.apk`；正式交付时统一使用根目录构建脚本导出到 `artifacts/apk/`。`offlineBundle=true` 将 JavaScript 与资源打入测试包并关闭 Metro 连接，因此安装后无需开发服务器，业务数据仍需连接后端。调试签名仅用于测试；正式上架需独立签名和生产域名。

`artifacts/apk/` 只存安装包，可按文件名中的构建时间清理历史版本，或删除该目录内所有 APK 后重新构建；不会删除后端账号与业务数据。只保留最新版的命令见根目录 README 的“APK 存放与清理约定”。

## 平台能力

- 会话令牌使用 Android Keystore AES-GCM 加密后保存，禁止 AsyncStorage 凭据回退。
- 录音使用系统麦克风权限与 AAC，最长 120 秒；文件选择使用系统文档选择器，复制到本地缓存，最多 20 MB。
- 分享和本地通知使用系统能力；远程推送尚未配置。文件与录音在未配置上传服务时只保存在设备，不会声称已上传。
- Android 11 及以上由原生宿主根据 IME 区域调整可用高度，兼容全面屏布局；Android 10 保留系统窗口缩放。对话附件预览限高滚动，输入与操作区保持独立。
- 所有原生访问集中在 `src/platform`。iOS 工程为初始化骨架，尚未编译或实现原生平台端口；[鸿蒙迁移说明](harmony/README.md) 记录验证步骤。

Android 可构建及运行结果由根项目交付记录说明；iOS 需 macOS/Xcode，原生鸿蒙需对应 DevEco/RNOH 环境与设备验证。
