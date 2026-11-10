# 开发指南

`tomorrow-ai` 是项目与仓库名，App 名称为「妥啦」。产品介绍与使用入口见 [README](../README.md)。各模块的完整说明由对应文档维护。

## 开始前

- 阅读 [开发存储约定](development-storage-policy.md)，构建与安装前后计量，使用仓库脚本打包。
- Rust 后端基线为 Rust 1.92+；Agent 服务需要 Node.js 22.19+、pnpm 10。其他依赖以各项目的 lockfile 为准。
- Android 需要完整 JDK 和 Android SDK / NDK；Windows 桌面需要 Rust / MSVC / Windows SDK 与 WebView2。平台要求见对应客户端文档。
- `.env`、数据库、上传内容、平台凭据、签名材料与本机存储清单不提交到 Git。模型 API Key 只配置在服务端。

## 本地服务

Windows PowerShell 中，在仓库根目录运行：

```powershell
./scripts/Start-Local.ps1
```

默认启动 Rust API、Worker 和 Pi。Pi 模式需要有效的模型配置；[Agent 服务说明](../services/agent/README.md) 包含模型与运行模式的配置方式。初始化脚本首次生成本机私有配置，后续不覆盖已有配置。

明确需要不通过 Agent 服务的本地资料体验时，可选择：

```powershell
./scripts/Start-Local.ps1 -AgentMode direct
```

完整的本地 PostgreSQL / Temporal 开发环境是可选项：

```powershell
./scripts/Start-Local.ps1 -Mode temporal -Postgres
```

停止或复用已构建程序：

```powershell
./scripts/Stop-Local.ps1
./scripts/Start-Local.ps1 -NoBuild
```

开发进程停止后，`data/` 内的数据保留。生产自建请使用 [Docker 部署](selfhost.md)，不要把本地开发环境直接当作公网部署。

### 可选的 AKShare 财经数据

在后端所在机器上运行官方 [AKTools](https://github.com/akfamily/aktools)：

```powershell
uvx aktools@0.1.4 --host 127.0.0.1 --port 8081
```

在妥啦后端的运行环境中设置 `AKSHARE_MCP_URL=http://127.0.0.1:8081/mcp`，
启用 Pi 或 DSH 并重启 API。Docker 部署使用容器可达的服务地址。
如 AKTools 开启了令牌校验，在私有运行环境中另设 `AKSHARE_MCP_TOKEN`。
用户可直接在聊天里查交易日历和 A 股历史日线，不用连接个人账户。
每次最多查 366 个自然日。交易日历使用上游最近 1,000 条记录，超出数据覆盖时会明确标记。

## 连接 Android

Android 模拟器连接本机 API 时，将 App 服务地址设置为 `http://10.0.2.2:8080`。

USB 真机调试可使用：

```sh
adb reverse tcp:8080 tcp:8080
```

随后连接 `http://127.0.0.1:8080`，保持 USB 与本机后端运行。公网实例使用 HTTPS；本机与云端的账号、数据相互独立。

## 构建与验证

选择与变更相关的检查，下面是常用入口，不表示每次修改都需要全量执行：

```powershell
cargo test --workspace --locked
pnpm --dir apps/mobile exec tsc --noEmit
pnpm --dir apps/mobile test --runInBand
pnpm --dir services/agent test
./scripts/Test-Smoke.ps1
```

`Test-Smoke.ps1` 需要本地服务就绪，并创建隔离测试账号。真实模型验证使用 `Test-Pi.ps1`，会调用已配置的供应商并可能计费；模拟协议测试不能代替真实账号、设备和网络验收。

```powershell
./scripts/Build-Android.ps1 -BuildType Release -Compact -RunNativeTests
./scripts/Build-Android.ps1 -BuildType Release -Compact -Target Emulator
```

手机与模拟器的 APK、latest、回退包和元数据分别维护。完整发布、签名和构建产物约定见 [移动端说明](../apps/mobile/README.md)。

## 继续深入

| 主题 | 入口 |
| --- | --- |
| Android 与迁移边界 | [移动端](../apps/mobile/README.md)、[原生鸿蒙](../apps/mobile/harmony/README.md) |
| Windows 与共享客户端 | [桌面说明](windows-client.md)、[客户端协议层](../packages/client-core/README.md) |
| Agent 与持久执行 | [Pi 服务](../services/agent/README.md)、[Worker](../crates/worker/README.md) |
| 模型、语音与文件 | [文件服务](../crates/attachments/README.md)、[实例配置](../crates/settings/README.md) |
| 应用连接 | [个人 MCP](personal-mcp.md)、[笔记连接](note-connections.md)、[连接器](../crates/connectors/README.md) |
| 对话与记忆 | [流式协议](chat-streaming.md)、[图记忆](knowledge-graph.md)、[对话导入](ai-history-import.md) |
| 个人事项与成长 | [事项](personal-todos.md)、[每日成长](daily-growth.md) |
| 部署与运维 | [自建部署](selfhost.md)、[云端部署说明](../infra/deploy/README.md) |

OpenAPI 可通过运行中的 `GET /v1/openapi.json` 获取，也可运行 `cargo run -p tomorrow-api -- --export-openapi` 导出。主业务类型位于 `crates/domain`。
