# Tomorrow 后台执行器

独立于 API 运行，复用 `tomorrow-domain` 的数据库仓库与模型服务。两种执行模式共用任务、审批、租约、重试和成果写入逻辑。

默认本地启动现在使用 `AGENT_MODE=pi`：Worker 把生成工作交给 TypeScript Pi 服务，并通过在线 Rust API 的受认证工具网关读取业务资料。后台 Pi 仅有只读工具，不能递归创建任务、自批或写入记忆。Pi/API 不可用时明确失败，按持久策略重试；此模式不承诺 API 停机时仍能独立完成模型任务。原本直接模型/本地整理可显式使用 `Start-Local.ps1 -AgentMode direct`，后文的直接配置说明适用于该模式。详情见 [Pi 服务](../../services/agent/README.md)。

## 本地开发

```powershell
$env:DATABASE_URL = 'sqlite:data/tomorrow.db'
$env:SCHEDULER_MODE = 'local'
cargo run -p tomorrow-worker
```

`local` 是持久数据库轮询模式，适合无需基础设施的首版体验，不是 Temporal。每 2 秒检查到期计划、领取任务，领取后每 15 秒续订 90 秒租约。进程停止后，另一个 Worker 可在租约到期后恢复任务。最多 3 次尝试，失败采用退避重试。

未配置模型时，真实读取用户当前保存的记忆、任务、例行计划，生成明确标注“本地模式”的资料整理和简报。不会编造网页、邮件、日历数据。配置 `DEEPSEEK_API_KEY` 环境变量后，默认使用 `https://api.deepseek.com` 的 `deepseek-flash`；可选用 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 覆盖。显式非空的 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME` 设置优先且独立，不混用不同供应商的密钥。API 与 Worker 共享相同解析逻辑，密钥只存在服务端；配置不完整会明确失败，不会降级为本地内容。

## Temporal

实现使用官方已发布 `temporalio-sdk` / `temporalio-client` / `temporalio-macros` 1.1.0。需要 Rust 1.92 或更新版本；`vendored-protox` 用于编译 SDK 自带协议，无需全局安装 protoc。

先运行 Temporal 服务（例如开发环境 `temporal server start-dev`），然后：

```powershell
$env:DATABASE_URL = 'sqlite:data/tomorrow.db'
$env:SCHEDULER_MODE = 'temporal'
$env:TEMPORAL_ADDRESS = 'http://127.0.0.1:7233'
$env:TEMPORAL_NAMESPACE = 'default'
$env:TEMPORAL_TASK_QUEUE = 'tomorrow-tasks-v1'
$env:TEMPORAL_DISPATCHER_ID = 'tomorrow-task-dispatcher-v1'
cargo run -p tomorrow-worker --features temporal
```

API 和 Worker 必须使用相同数据库、模型配置与 `SCHEDULER_MODE`，以保证运行状态展示一致。不要同时启动 local 与 Temporal Worker 处理同一数据库。每个独立环境使用单独的 namespace、queue 和 dispatcher ID。

`TaskQueueWorkflow` 是真实、可回放的 Temporal 工作流：执行检查计划 Activity → 领取任务 Activity → 生成和保存 Activity；空闲时使用持久计时器，每 500 次循环 Continue-As-New 控制历史大小。数据库、系统时间、模型网络请求均在 Activities 内。执行 Activity 每 5 秒向 Temporal 心跳，并处理取消；数据库事务仍根据任务状态、attempt 和有效租约决定是否发布成果。旧 attempt 和取消任务均不能写入成果与通知。

首版采用单一调度工作流串行领取和执行任务，面向小规模受邀测试。大规模并发可升级为每任务工作流和独立分发器，不影响 App 的接口协议。Temporal 服务不可用时会明确报错，不会伪装执行或自动切换成本地模式。

## 计划与恢复语义

- 计划按 IANA 时区运行；夏令时春季缺失时刻顺延至第一个有效分钟，秋季重复时刻只执行一次。
- 停机期间错过的多次例行执行合并为一次，避免恢复时大量补发。
- 同一个计划发生时刻有持久唯一键；到期时间推进和任务入队在一个事务内。
- 审批针对不可变任务指令；未批准不领取。取消是持久状态，执行中取消会在续租或完成事务时阻止发布。
- 模型生成可能因超时、进程崩溃或 Activity 重试而重复计费；成果和通知保证仅发布一次。首版不执行邮件发送等外部副作用。

## 验证

```powershell
cargo test -p tomorrow-worker
cargo check -p tomorrow-worker --features temporal
# 需真实 Temporal 服务；包含运行、进程重启回放，以及服务不可用时的行为。
cargo test -p tomorrow-worker --features temporal --test temporal_live -- --include-ignored --nocapture
```

任务测试覆盖审批、取消、两个独立仓库竞争领取、过期租约恢复、旧 Worker 拒绝写入、成果和通知幂等、计划重复检查、执行前读取当前记忆。夏令时与跨时区计算测试位于 `tomorrow-domain`。

2026-10-26 验证：5 项持久执行测试通过；真实 Temporal 服务集成测试 2 项通过（36.68 秒）。集成测试实际启动独立 Worker、保存第一任务成果后终止进程、停机入队第二任务、重启同一个工作流并回放历史、验证恰好 2 份成果与通知；最后取消测试工作流，服务记录状态为 `CANCELED`。服务不可达测试确认进程明确报错退出，任务仍为 `queued`，没有降级执行。

参考：[官方 Rust SDK](https://github.com/temporalio/sdk-rust)、[1.1.0 API 文档](https://docs.rs/temporalio-sdk/1.1.0/temporalio_sdk/)。
