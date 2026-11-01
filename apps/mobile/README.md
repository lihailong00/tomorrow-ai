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

开发模式通过 Metro 热更新。新安装默认连接官方 HTTPS 服务。开发时可在“设置 → 服务连接”选择自己的服务器；模拟器连接宿主机可填写 `http://10.0.2.2:8080` 并显式允许局域网 HTTP。

## 官方服务与自建服务

- 官方服务使用手机号和密码登录，短信仅用于注册和重置密码；短信发送与测试模式由后端配置决定，客户端不内置测试验证码登录入口。
- 自建服务按 `/v1/instance` 返回的方式登录，默认邮箱和密码；支持开放、邀请码注册或管理员创建账号，无需配置短信。
- 自建后台提供非敏感连接链接 `tada://connect?url=<编码后的地址>&instance=<实例ID>` 和二维码。使用系统相机扫描，或在 App 服务地址框粘贴链接。链接只打开核对界面；检查服务器身份和处理去向并点击确认后才连接。
- 手机在发送密码、令牌或数据前，匿名验证服务器身份与 API 版本。会话同时绑定服务地址和实例 ID；切换时取消旧请求、停止相册后台工作、清空手机资料接收队列和应用选择，并退出当前账号。旧版本会话缺少实例 ID，需要重新登录一次。
- 自建服务离线、地址损坏或本机配置损坏时，保持断开并提示重新选择，不自动切到官方服务。公网要求 HTTPS；局域网 HTTP 需单独确认，相册后台图片处理仍要求 HTTPS。
- 用户授权与模型供应商配置分开：用户授权归用户自己的服务账号；服务器 API Key 只保存在后端。自建数据不经过官方业务服务器，调用外部模型时仍会发送相关内容至配置的供应商，处理去向在连接确认页展示。

会话通过 Android Keystore 保存，服务端注销会撤销当前登录令牌。Android 网络层禁止接口重定向，以免认证信息跟随跳转。iOS/鸿蒙后续实现相同平台端口时，也必须保持禁止重定向、实例绑定和后台授权隔离的约束。

## 生成可独立启动的测试安装包

在仓库根目录运行 `./scripts/Build-Android.ps1`，会查找 Node、JDK 17/21 与 Android SDK，安装锁定依赖、检查类型并构建 ARM64 手机测试包。手机交付 APK 输出到仓库根目录的 `artifacts/apk/`：每次保留带版本号与北京时间的 `tada-v<版本号>-yyyyMMdd-HHmmss-fff.apk`，同时更新 `tada-latest.apk` 作为手机最新版固定入口。版本号读取本目录 `package.json`。可通过 `-NodePath`、`-JavaHome`、`-AndroidHome` 指定本机工具；网络代理通过环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 或 `-ProxyUrl` 临时传入。

模拟器单独运行 `./scripts/Build-Android.ps1 -Target Emulator`，仅构建 x86_64，输出到 `artifacts/apk/emulator/`，拥有独立的 `latest`、回退包和元数据，不会覆盖手机包。旧参数 `-Architectures` 仍支持单个 `arm64-v8a` 或 `x86_64` 并自动选择对应目录；混合架构会被拒绝。发布前还会检查 APK 的实际架构和 OCR 残留，验证失败时保留已有 `latest`。

客户端已移除内置 ML Kit OCR 库和模型，不再提供本机分享图片识字入口。聊天图片理解继续使用后台配置的云端服务，不会因移除 OCR 自动上传待接收图片。

瘦身验收可先生成独立候选包，不替换现有 `latest`：

```powershell
./scripts/Build-Android.ps1 -BuildType Release -Compact -Candidate -RunNativeTests
```

`Release` 启用 R8 代码与资源裁剪；`-Compact` 将原生库与 DEX 压缩打入 APK，安装时由 Android 解压，因此 APK 大小不等于安装后的占用。候选包位于 `artifacts/apk/candidates/release-compact/`。省略 `-Compact` 可在 `candidates/release/` 生成普通 Release 对照包；省略 `-Candidate` 才会进入原有发布流程。两种 Release 包均保留现有测试签名，以支持覆盖安装。

发布校验会确认 R8 后的 JNI 入口、平台桥接和持久 Worker 类仍在 DEX 中。Release 的混淆映射以同名 `.apk.mapping.txt.gz` 保存，原生测试摘要写入对应的空间报告，均在自动清理编译缓存前保留。Release 继续支持用户明确开启的局域网 HTTP；公网服务仍需通过 HTTPS 与服务器身份校验。

也可直接使用 Gradle：

```powershell
cd android
.\gradlew.bat :app:assembleDebug '-PofflineBundle=true' '-PreactNativeArchitectures=arm64-v8a'
```

直接使用 Gradle 时，内部产物为 `android/app/build/outputs/apk/debug/app-debug.apk`；正式交付时统一使用根目录构建脚本导出到 `artifacts/apk/`。`offlineBundle=true` 将 JavaScript 与资源打入测试包并关闭 Metro 连接，因此安装后无需开发服务器，业务数据仍需连接后端。调试签名仅用于测试；正式上架需独立签名和生产域名。

安装包保留与清理遵守根目录 README 的“APK 存放与清理约定”；保留当前和已验证的回退版本。手机与模拟器目录分别发布，勿相互复制覆盖 `latest`。

## 平台能力

- 相册索引默认关闭，用户在设置中确认云端处理并授予相册权限后，才会在充电、非计费网络下增量处理。旧版本地索引授权不会自动转为图片上传授权。
- 相册原图只读；手机在内存中生成分析副本：普通照片最多约 420 万像素、长边 3072，长截图最多约 630 万像素、长边 8192。PNG 在大小允许时保持无损编码，JPEG 品质 95/92；超过 4 MiB 时跳过，不继续牺牲清晰度。缩放后的副本不能保证逐像素无损。
- 图片副本经 HTTPS 临时交给后端与阿里云百炼视觉模型，提取描述、文字和标签；API 和 Nginx 不落盘保存图片，只持久化必要元信息、分析结果和索引。模型密钥仅在后端。停止、清除、会话失效和撤销权限均会阻止后续上传；清除也会阻止在途结果重新写回。云端设置见根目录 `.env.example` 的 `PHOTO_VISION_*`。
- 图片上传返回 202 后由后端继续分析，手机通过短请求查询状态；掉线后优先查询已有任务，避免重复上传和计费。后端进程重启会丢弃内存图片，任务 150 秒后可重试；模型失败的照片暂缓 6 小时再处理，失败调用仍计入当日额度。

- 会话令牌使用 Android Keystore AES-GCM 加密后保存，禁止 AsyncStorage 凭据回退。
- 录音使用系统麦克风权限与 AAC，最长 120 秒；文件选择使用系统文档选择器，复制到本地缓存，最多 20 MB。
- 分享和本地通知使用系统能力；远程推送尚未配置。文件与录音在未配置上传服务时只保存在设备，不会声称已上传。
- Android 11 及以上由原生宿主根据 IME 区域调整可用高度，兼容全面屏布局；Android 10 保留系统窗口缩放。对话附件预览限高滚动，输入与操作区保持独立。
- 所有原生访问集中在 `src/platform`。iOS 工程为初始化骨架，尚未编译或实现原生平台端口；[鸿蒙迁移说明](harmony/README.md) 记录验证步骤。

Android 可构建及运行结果由根项目交付记录说明；iOS 需 macOS/Xcode，原生鸿蒙需对应 DevEco/RNOH 环境与设备验证。
