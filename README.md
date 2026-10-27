# 妥啦（Tada）

GitHub 仓库：[lihailong00/Tada](https://github.com/lihailong00/Tada)。App 显示名称为“妥啦”，现有安装可覆盖升级。

### 管理后台与自建服务

后台入口为 `/admin/`，提供一次性初始化、独立管理员登录、模型/语音/应用配置、用户与邀请管理、加密备份和连接手机二维码。客户端默认使用官方服务，也可连接独立自建实例；自建账号、凭据、数据及敏感导入授权按实例隔离，故障时不会回退官方。部署和恢复步骤见 [自建说明](docs/selfhost.md)。首次启动无需模型 Key；自建默认关闭公开注册并支持邮箱密码账号。供应商密钥只保存在所选服务器，使用第三方模型时相应内容仍会发给该供应商。

### 手机应用接入

在「能力 → 连接手机应用」选择手机上已安装的应用。支持微信、QQ、小红书、哔哩哔哩、抖音、知乎、淘宝、京东、美团、支付宝、滴滴、飞书、钉钉、企业微信、WPS、腾讯文档、高德地图的本机入口。通知读取默认关闭，由用户逐个选择，并在系统设置授予通知访问权限；只接收之后的新通知摘要，不读取其他应用的历史数据库。验证码、登录安全和付款确认类消息采用保守过滤，无法保证识别全部敏感内容，导入前仍应检查。

系统分享目标「妥啦」接收文字、链接和文件，内容先进入本机待接收列表；只有用户确认才上传。通知与分享不要求读取短信、通讯录或全部应用列表。可查看、删除导入资料，并让助手按资料 ID 检索整理；资料中的文字不会提升为新的用户指令。选定资料最多保存 500 条，凭用户操作删除；本机队列最多 100 条，超过 24 小时在下次访问时清理，退出或切换账号时清空。相册索引有独立的选择加入开关，与通知/分享分开授权。

文件支持 UTF-8 文本、DOCX 正文/表格、XLSX 单元格文字与公式缓存值，不执行公式。分享来的图片可点击「识别图片文字」，在手机本机识别、预览和编辑，再确认导入；图片不会因识别而自动上传。PDF、PPT、旧版 Office、扫描件不由云端文档解析器读取；仅保存链接也不代表已读取链接正文。

「更多连接方式」提供可选的云端只读适配器，普通用户无需申请开发者 Key 才能使用手机入口：

| 连接 | 首版可读取的范围 | 连接条件 |
| --- | --- | --- |
| QQ / 163 / 126 邮箱 | 最近 20 封有限摘要、该窗口内关键词匹配 | 用户开启 IMAP 并提供邮箱客户端授权码 |
| 腾讯文档 | 已授权目录与文件元数据 | 运营方配置应用，用户 OAuth 授权 |
| WPS / 金山文档 | 指定文件信息、目录和支持的正文 | 应用权限与用户授权，部分读取需要盘/文件 ID |
| 飞书 | 云盘目录，额外权限允许的 DOCX 正文 | 应用审批、用户和组织可见范围 |
| 钉钉 | 本人日历本与日程 | 应用批准的日历查询权限及用户授权 |
| 语雀 | 本人可访问知识库、文档列表和正文 | 个人访问令牌及平台 API 资格 |
| 企业微信 | 企业应用授权的部门 ID | 企业应用配置；不包含个人微信聊天 |
| 知乎 | 官方检索及本人的公开收藏夹 | 平台个人 Access Secret 与可用额度；不包含私密收藏 |
| 高德 | 地点检索、驾车/步行路线 | 运营方配置 Web 服务 Key |

云端适配器有模拟协议测试，缺少真实平台授权时显示未配置或未连接，不能据此宣称已经同步账号。连接凭据只在后端按用户和平台加密保存，断开连接会清除本地凭据；用户可同时去原平台撤销授权。短信、支付、下单、对外发送消息均不由这些读取接口执行。iOS / 鸿蒙可复用资料、账号和 API 层；通知和系统分享需各自实现系统适配器，目前不宣称与 Android 具有相同权限。

Android 首发的个人 AI 助手首版。客户端使用 React Native / TypeScript，Android 系统能力使用 Kotlin；业务 API、持久任务执行器、文件服务和 Google 连接器使用 Rust，Agent 执行循环使用独立的 TypeScript + Pi 服务。此版本提供可安装、可连接后端的实际工作流程，功能范围与后续产品规划分别记录。

## 开始体验

在 Android 10 或更新手机安装 `artifacts/apk/tada-latest.apk`。安装包已包含界面资源，无需 Metro，默认连接已部署的云端 HTTPS 服务：

`https://api.example.invalid`

首次使用手机号和短信验证码注册，并设置登录密码。之后使用手机号和密码登录，不发送短信。密码为 8–128 个字符，首尾空格会保留，不会自动去除。忘记密码时可通过短信验证码重置；重置成功会使该账号的全部旧会话失效，需要用新密码重新登录。旧版没有设置密码的手机号账号，也通过“忘记密码”设置首个密码。

服务端开放手机号注册，设有按手机号、可信来源 IP 和全站滚动额度的短信防刷限制；云端全站最多 20 次发送尝试 / 24 小时。短信验证码仅用于注册和重置密码。密钥只保留在后端。旧安装若仍使用未自定义的模拟器默认地址，会清除旧会话后迁移到云端；用户自己设置的地址保留。

本地开发时先启动后端：

```powershell
./scripts/Start-Local.ps1
```

在 App 设置中将服务地址改为 `http://10.0.2.2:8080` 可连接本机模拟器后端。USB 真机可运行 `adb reverse tcp:8080 tcp:8080`，再填入 `http://127.0.0.1:8080`，保持 USB 连接和本机服务运行。本地与云端的账号、数据分别保存，安装包不内置账号。

首次进入后自行注册账号。默认不会导入样例邮件、日程或个人资料。启动脚本默认启动 Rust API、Worker 与 Pi 三个进程，需要 Node.js 22.19+、pnpm 10 和后端模型环境变量。没有模型配置时 Pi 明确启动失败；如需体验原先的本地资料整理，可显式运行 `./scripts/Start-Local.ps1 -AgentMode direct`，未配置模型时显示本地模式。

关闭与再次启动：

```powershell
./scripts/Stop-Local.ps1
./scripts/Start-Local.ps1 -NoBuild
```

账号、记忆、对话、计划、任务和上传文件保存在 `data/`，停止服务不会清除。日志位于 `artifacts/logs/`。启动脚本在后台运行 API 与 Worker，核查两者就绪后才报告成功。

本地开发进程没有系统服务守护；运行中退出后需重新启动。云端三个服务由 systemd 守护。Pi 模式的 Worker 需要 API 工具网关与 Pi 服务在线，服务故障会进入持久重试，不能在 API 停机时独立完成模型任务。请一起备份数据库、上传文件和私有 `.env`。模型或转写在超时、崩溃后重试可能再次计费，事务防重保护业务操作与成果，不能保证供应商只扣费一次。当前 APK 使用测试签名，正式发布仍需独立签名；云端已启用 HTTPS。云端配置和防刷边界见 [部署说明](infra/deploy/README.md)。

## 本版可用范围

| 功能 | 当前行为 |
| --- | --- |
| 登录与账号 | 注册、登录、编辑名称/时区、注销会话；手机令牌通过 Android Keystore 加密存储 |
| 今日 | 根据当前账号的真实任务、计划、记忆与结果展示信息；可主动生成简报 |
| 对话 | Pi 多轮工具执行、真实模型、持久对话；可查询/保存/更新/删除记忆、创建待审批任务、创建计划草稿、暂停计划、读取文本附件；请求编号防重 |
| 任务 | 新建、进度、审批、取消、重试与恢复；生成独立成果和通知 |
| 自动计划 | 每天、工作日、每周或一次；按 IANA 时区调度，可暂停、恢复、编辑和删除 |
| 记忆 | 偏好、人物、项目、目标、事实的增删改查；版本冲突提示，删除后不再用于新任务 |
| 文件与语音 | 系统文件选择、短录音、真实上传、资料列表与删除；配置 ASR 后真实转写 |
| 文件上下文 | 文本、DOCX、XLSX 及已转写音频可用于对话；分享图片可本机识字后确认导入。PDF、PPT 暂仅保存 |
| Google 连接 | Calendar、Gmail、Drive 三个只读连接器，需服务端 OAuth 配置与用户本人授权 |
| 成果与通知 | 成果正文、系统分享、站内通知已读；App 在前台可提示新完成任务 |

本版没有自动发送邮件、修改日历、购买或操作网站。任务审批是执行已展示指令的确认流程，不代表已经实现这些外部写入能力。Google 只读资料可在能力页查看，尚未进入自动工具调用和跨服务推理。手机后台/被杀时尚无远程推送；服务端任务仍继续执行，重新打开后回查结果。

## 接入真实模型与语音

默认 `AGENT_MODE=pi`：手机 → Rust API → TypeScript Pi 服务 → Rust 工具网关。Pi 锁定 `@earendil-works/pi-agent-core` / `pi-ai` 1.4.0，只加载本产品声明的业务工具，不加载终端、文件系统或完整 coding-agent。详情和已实现边界见 [Pi 服务说明](services/agent/README.md)。Agent 创建的任务必须在任务详情批准，计划草稿必须由用户启用；模型不能自批。已有 APK 可直接连接新版后端。

执行记录接口为 `GET /v1/agent-runs`、`GET /v1/agent-runs/{id}` 和 `POST /v1/agent-runs/{id}/cancel`，仅当前用户可访问；聊天响应增加可选 `agent_run_id`。Pi 内部使用流式模型接口，当前手机仍按整轮回复展示，尚无逐字输出或执行记录专页。

DeepSeek 读取后端进程的 `DEEPSEEK_API_KEY` 环境变量，默认地址为 `https://api.deepseek.com`、模型为 `deepseek-flash`。可选使用 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 覆盖。Windows 启动脚本按当前进程、用户级、系统级的顺序读取模型环境变量；Pi 模式仅由服务端 Pi 使用模型密钥，Rust 不再执行模型循环。脚本不会把密钥复制到 `.env`、启动参数、运行记录或 Android 安装包。修改环境变量后停止并重新启动后端服务。

首次启动会从 `.env.example` 创建私有 `.env` 并生成本地凭据，后续启动不会覆盖已有配置。若需要显式指定其他兼容服务，可在后端环境变量或私有 `.env` 填入：

```dotenv
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_API_KEY=your-server-side-key
MODEL_NAME=your-provider-model-name
```

显式非空的 `MODEL_*` 设置优先于 `DEEPSEEK_*`，避免混用不同供应商的地址与密钥。接口采用兼容的 `chat/completions` 协议，供应商必须支持对应模型和请求格式。停止再启动服务以载入配置。配置不完整或供应商请求失败会明确报错，不会偷偷返回本地内容。模型密钥不会写入 APK。

当前本机已从系统级 `DEEPSEEK_API_KEY` 接入 `deepseek-flash`，聊天、后台任务生成与成果落库均通过真实调用验证。默认 Pi 模式的十项真实场景报告为 `artifacts/pi-live-verification.json`；原直接模型验证保留在 `artifacts/deepseek-verification.json`。本轮更新并重启 Rust API、Worker 与 TypeScript Pi 服务，已有安卓安装包可直接使用。

语音使用后端 ASR：阿里云百炼配置 `ASR_PROTOCOL=qwen_asr`、`ASR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`ASR_MODEL=qwen3-asr-flash`，`ASR_API_KEY` 只放后端私有环境。也保留 `openai_transcriptions` multipart 协议。手机录音结束后自动转为可编辑文字，用户确认后发送；失败可重试或取消。未配置时明确提示不可转写。文件大小、配额与转写边界见 [文件服务说明](crates/attachments/README.md)。

2026-10-27 语音更新：云端已接入 Qwen3-ASR-Flash，用合成中文 M4A/AAC 录音完成真实转写、缓存复用、跨用户拒绝和临时音频删除验证；只发起一次识别请求，没有发送短信或调用聊天模型。手机端 45 项测试（含 5 项录音转文字流程）通过，APK 0.1.2 / versionCode 3 已同步到 `artifacts/apk/tada-latest.apk`。本次未做真机麦克风到云端的整链路验收。

Google OAuth 的回调、只读权限、加密密钥及断开连接语义见 [连接器说明](crates/connectors/README.md)。本机代码测试不能代替 Google 项目审核或真实账号授权验证。

## Rust 后端与基础设施

需要 Rust 1.92+；仓库锁定依赖版本，包含可选 AWS SDK 的兼容版本。API 与 Worker 是独立进程，通过同一持久数据库协作。

默认使用 SQLite 与持久轮询队列，适合快速体验。完整开发基础设施使用 Docker Compose 启动 PostgreSQL / pgvector 和 Temporal：

```powershell
./scripts/Start-Local.ps1 -Mode temporal -Postgres
```

Temporal 模式使用官方 Rust SDK 1.1.0，执行真实 Workflow / Activity、持久计时器和恢复回放。开发 UI 为 `http://127.0.0.1:8233`。Compose 中的 Temporal 是开发服务，不能直接作为公网生产部署。当前调度工作流串行执行，适合小规模测试；未来可拆为每任务工作流。

PostgreSQL 使用 SQLx、参数化查询和用户作用域；pgvector 扩展已初始化，本版尚未生成向量或提供语义检索。SQLite 和 PostgreSQL 自动应用通用业务结构；`migrations/postgres/` 的增强策略仅作为后续生产模板，当前不宣称已启用数据库级 RLS。文件默认实际保存在私有本地目录，S3 是可选构建能力，配置见文件服务说明。

需要 S3 时在 `.env` 设置 `UPLOAD_STORAGE=s3` 和对应 `S3_*` 配置，再以 `Start-Local.ps1 -S3` 构建启动。可选本机对象存储命令为 `docker compose --profile s3 up -d rustfs`，端口为 19000 / 19001，凭据在私有 `.env` 的 `RUSTFS_*` 字段；使用前建立私有 bucket 并把凭据填入 `S3_*`。本轮已针对 RustFS 1.0.1 实测上传、下载、权限隔离和删除，不据此承诺所有 S3 供应商已验收。

```powershell
./scripts/Stop-Local.ps1 -Infrastructure
```

此命令停止本项目进程和开发容器，保留数据卷。更换 `.env` 中的数据库密码不会自动重设已经初始化的数据卷密码。

## 构建与验证

```powershell
cargo test --workspace --locked
cargo check -p tomorrow-worker --features temporal --locked
./scripts/Test-Smoke.ps1
./scripts/Test-Pi.ps1
./scripts/Build-Android.ps1
```

`Test-Smoke.ps1` 需要本地 API 和 Worker 已启动，创建隔离验证账号，检查实际 HTTP 流程；不会打印密码或令牌。报告为 `artifacts/smoke-results.json`。Android 构建需要 Node、完整 JDK、Android SDK / NDK，脚本支持指定工具路径，详情见 [客户端说明](apps/mobile/README.md)。

### APK 存放与清理约定

所有交付 APK 统一保存在 `artifacts/apk/`，不再放在 `artifacts/` 根目录或散落到其他项目目录。每次使用 `./scripts/Build-Android.ps1` 构建时，保留 `tada-v<版本号>-<北京时间 yyyyMMdd-HHmmss-fff>.apk`，同时更新固定入口 `tada-latest.apk`。旧入口 `tomorrow-ai-latest.apk` 同步指向同一最新版，兼容已有下载路径。版本号读取 `apps/mobile/package.json`。

清理历史安装包、仅保留最新版时，在项目根目录执行：

```powershell
Get-ChildItem -LiteralPath ./artifacts/apk -File -Filter '*.apk' |
  Where-Object Name -ne 'tada-latest.apk' |
  Remove-Item -Force
```

该目录只存安装包，可以整体清理；下次构建会重新创建，不影响 `data/` 中的账号和业务资料。Gradle 自己的 `apps/mobile/android/app/build/outputs/apk/` 是构建内部输出，交付与查找安装包以 `artifacts/apk/` 为准。

`Test-Pi.ps1` 需要默认 Pi 模式服务在线，会进行真实付费模型调用，使用独立账号，逐项核验工具事件与实际资源。报告为 `artifacts/pi-live-verification.json`，包含虚构测试题、真实回答、Token 用量和脱敏执行记录，不包含会话令牌或模型密钥。测试结束删除测试计划和附件并注销测试会话。

冒烟脚本的聊天等待窗口为 120 秒，后台任务默认等待至多 360 秒，覆盖 Pi 多轮调用和 Worker 最多三次持久重试；可用 `-TaskTimeoutSeconds` 显式缩短。等待上限不是耗时承诺，上游失败可能导致重试和更长延迟。

2026-10-26 验收：Rust workspace 检查、真实 PostgreSQL 回归、14 项客户端测试、32 项 HTTP 流程检查通过；另对真实 Temporal 进行进程终止/重启回放，对 RustFS 1.0.1 进行 S3 上传/下载/删除及用户隔离验证。已在 Android 15 / x86_64 模拟器安装最终双架构 APK，完成注册、保存记忆、任务审批与成果、文本附件上传/对话、录音上传/未配置转写提示、文件删除、计划暂停/恢复、覆盖安装与安全会话恢复。随后接入 DeepSeek Flash，49 项 Rust workspace 测试通过，并验证真实聊天与后台任务生成。arm64 真机、Google 实号授权与真实 ASR 尚未验收。

界面已按 Today 的轻盈淡彩与小艺的移动交互方向更新：底部固定导航、导航上方的对话入口、分层简报与任务结果、统一矢量图标与助手球。实际安卓截图：[首页](artifacts/android-redesign-home.png)、[对话](artifacts/android-redesign-chat.png)、[任务结果](artifacts/android-redesign-task-result.png)、[记忆](artifacts/android-redesign-memories.png)、[能力](artifacts/android-redesign-capabilities.png)。

本轮 UI 更新通过类型检查、ESLint（无错误）和 14 项客户端测试，并在 Android 15 模拟器检查覆盖安装与会话恢复、四个主页面、成果查看、对话发送、录音开始/结束，以及 360×740 dp 短屏下带附件的键盘避让和滚动操作。Android 10、arm64 真机、iOS 与鸿蒙仍需独立验证。当前 APK 校验值与本轮验证记录见 `artifacts/verification.json`；首次完整流程记录保存在 `artifacts/verification-alpha-baseline.json`。

OpenAPI：运行中的 `GET /v1/openapi.json`；也可用 `cargo run -p tomorrow-api -- --export-openapi` 导出。主业务类型位于 `crates/domain`，移动端协议适配位于 `apps/mobile/src/api`。

## iOS 与原生鸿蒙迁移

界面、业务状态和协议类型放在共享 TypeScript 层，系统能力统一经 `src/platform/ports.ts` 注入。Android 已实现安全存储、文件、录音、权限、通知和分享。iOS 工程目前为骨架，仍需 Swift 平台适配与 macOS / Xcode 实测；鸿蒙保留 RNOH / ArkTS 接口和迁移清单，见 [鸿蒙说明](apps/mobile/harmony/README.md)。若 RNOH 不满足要求，可使用 ArkUI 宿主复用云端协议和业务设计。

当前 RN 0.82.1 是锁定的首版构建基线，已停止上游支持，正式发布前需要升级并验证 RN / RNOH 与原生依赖组合。本轮不宣称 iOS 或原生鸿蒙已可打包、通知已跨平台可用或达到固定代码复用比例。

## 产品与路线文档

- [Today.ai 功能梳理与对标范围](docs/01-today-ai-功能梳理与对标范围.md)
- [妥啦（Tada）技术路线与实施计划](docs/02-tomorrow-ai-技术路线与实施计划.md)
- [首版接口协作契约](docs/implementation-contract.md)

路线文档中的浏览器执行、跨外部服务的多步工具调用、语义检索、完整离线队列、远程推送、正式渠道发布与三端验证仍需后续实现和验收；当前 Pi 工具限于本产品的记忆、任务、计划和文本附件。
