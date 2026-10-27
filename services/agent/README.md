# Tomorrow Pi 执行服务

Rust 管业务和持久数据，TypeScript + Pi 管模型与工具循环。仅在服务端运行，不改变 Android 首发、未来 iOS / 原生鸿蒙复用云端协议的路线。

## 已接入

- 精确锁定 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 1.4.0，使用真实 `Agent` 循环及 Pi OpenAI-compatible 流式模型适配。
- 默认 DeepSeek Flash；显式非空 `MODEL_*` 设置整组优先，不混用其他供应商的密钥。
- 官方 `deepseek-flash` 使用已核实的 1M 上下文元数据；Pi 的 `thinkingLevel=off` 会明确发送 `thinking.disabled`。代理、旧模型和自定义 provider 保持保守配置。
- 聊天与后台任务统一调用 Pi；没有自动回退到 Rust 直接调用或假回复。旧模式只能显式选择 `-AgentMode direct`。
- 每轮新建隔离 Agent，从 Rust 提供的会话文本重建上下文。长期记忆经 Rust 工具读取。Pi 不另建业务数据库或会话文件目录。
- 不加载 coding-agent、shell、任意文件系统、第三方扩展或自动发现的本机凭据文件。

## 业务工具

| 工具 | 范围 |
| --- | --- |
| `get_current_time` | 用户的当前时间、星期和 IANA 时区 |
| `list_memories`、`save_memory`、`update_memory`、`delete_memory` | 查询和显式管理自己的记忆；修改/删除要求当前版本 |
| `list_tasks`、`get_task`、`create_task`、`cancel_task` | 创建的任务强制等待用户审批，无自批工具 |
| `list_schedules`、`create_schedule`、`pause_schedule` | 创建未启用草稿；启用须用户在现有计划页面完成 |
| `read_attachment` | 读取自己上传的 UTF-8 文本或已转写音频；PDF/Office/图片仍不解析 |

后台任务只获得上述只读工具，不获得创建任务、修改记忆或计划的权限，避免递归派发与重试中的新写入。`weekly` 仍是下一个指定时刻起每七天，不支持自然语言任意星期和完整日历规则；模型须说明该边界。

## 启动与配置

推荐在项目根目录运行：

```powershell
./scripts/Start-Local.ps1
./scripts/Stop-Local.ps1
./scripts/Start-Local.ps1 -NoBuild
```

需要 Node.js 22.19+、pnpm 10，以及已配置的模型环境变量。启动脚本安装锁定依赖、编译 TypeScript，启动 Pi、API、Worker，检查就绪并保存三个进程的身份。`-NoBuild` 要求已经安装和构建。API 默认 8080，Pi 默认 8090，可用 `-Port` 和 `-AgentPort` 修改。使用旧流程：`-AgentMode direct`。

服务独立部署时配置：

| 变量 | 默认 / 说明 |
| --- | --- |
| `AGENT_MODE` | Rust 设置为 `pi`，旧模式为 `direct` |
| `AGENT_URL` | Rust → Pi，默认 `http://127.0.0.1:8090` |
| `AGENT_PORT` | Pi 监听端口，默认 8090；当前只监听本机 |
| `RUST_API_URL` | Pi → Rust，默认 `http://127.0.0.1:8080`，禁止从模型参数指定回调地址 |
| `AGENT_SERVICE_TOKEN` | 两层共享的内部认证令牌，至少 32 字符；本地脚本每次启动随机生成，仅通过进程环境传递 |
| `DEEPSEEK_API_KEY` | 后端模型密钥；默认地址 `https://api.deepseek.com`，模型 `deepseek-flash` |
| `AGENT_MAX_TURNS` | 默认 10 轮，最多 20 |
| `AGENT_MAX_TOOLS` | 默认 20 次，最多 40 |
| `AGENT_TIMEOUT_MS` | 默认 100000，最多 105000 |
| `AGENT_MAX_CONCURRENT` | 默认 4，最多 32；当前为单进程限制 |

不要把 Pi 端口或 Rust `/internal/agent/*` 直接暴露到公网。跨主机部署需 HTTPS、私有网络和反向代理。这里的限制是步骤、时间、输出长度和单进程并发；尚无跨副本金额预占、全局队列或账单价格计算。

## 权限、持久化与恢复

Rust 根据已认证的用户创建 `agent_runs`，每轮颁发独立、限时的随机能力令牌，数据库只存哈希。Pi 工具回调同时需要服务令牌与执行能力令牌；用户身份从执行记录推导，不接受模型传入的 `user_id`。后台任务还要检查当前 attempt、运行状态和有效租约。

`agent_operations` 将业务写入与操作回执放在同一事务中。内部适配器按工具名称和调用序号编号；同一次逻辑执行的相同步骤、相同参数返回已有结果。重试时已执行步骤的参数发生变化会明确中止，不能用改写标题的方式重复创建。新消息属于新的执行，不自动跨消息去重。已完成写入不会随模型回复失败而撤销。

`agent_events` 记录轮次、工具调用、成功/失败与 Token 用量，不记录模型思维链、服务令牌和模型密钥。原始对话与工具参数可能包含个人数据，执行记录仅账号本人可读。手机聊天返回可选 `agent_run_id`，可查询：

```text
GET  /v1/agent-runs
GET  /v1/agent-runs/{id}
POST /v1/agent-runs/{id}/cancel
```

取消后 Rust 拒绝后续工具操作，Pi 每两秒检查执行权并中断模型调用。进程崩溃后的活动执行会在 150 秒租约过期后显示 interrupted；聊天可用原 client_request_id 重试，后台任务由现有 Worker/Temporal 策略恢复。恢复可能重新调用模型并再次计费；这是有限重跑与持久操作防重，不是 Pi 全部内部状态的无损 checkpoint 回放。Pi 模式需要 Rust API 在线，API 停机时 Worker 无法通过业务工具网关完成执行。

Pi 内部流式接收模型输出；当前移动端保留整轮 JSON 回复，不包含逐字流式展示或执行记录专页。没有加入多 Agent、MCP、自动发信、浏览器、代码执行或任意插件安装。

## 验证

```powershell
cd services/agent
pnpm install --frozen-lockfile
pnpm test
```

Rust 权限、防重、取消、失败恢复与 API 网关测试在 `crates/domain/tests/agent.rs`、`crates/api/tests/agent.rs`。真实 PostgreSQL 并发测试需显式设置 `TEST_DATABASE_URL`：

```powershell
cargo test -p tomorrow-domain --test agent_postgres -- --ignored
./scripts/Test-Pi.ps1
```

`Test-Pi.ps1` 是真实付费模型集成验证；独立账号、虚构数据、校验落库和执行事件，结果保存在 `artifacts/pi-live-verification.json`。单元测试使用真实 Pi 执行循环与可控模型流，便于复现故障，不计作真实供应商调用。

公开题库的 40 题固定抽样入口（会产生真实模型费用）：

```powershell
./scripts/Test-AgentBenchmarks.ps1 -DryRun
./scripts/Test-AgentBenchmarks.ps1 -Concurrency 100
```

题型为 BFCL 16、ToolSandbox 12、LongMemEval-S 8、Mem2ActBench-small 4。各模块固定源版本、题号和文件哈希；每次运行前重新核验数据。全局并发上限 100，真实产品聊天遵循当前服务 4 并发；多轮题内按顺序执行。测试用独立账号，清理计划和记忆并登出，保留执行记录供审核。

BFCL 使用官方 AST 评分函数，测第一轮工具调用；ToolSandbox 为映射到本产品的改编题，经真实 Rust API + Pi 执行；LongMemEval 提供完整 S 历史，是长上下文基线，使用 DeepSeek 替代上游列出的评分模型；Mem2Act 提供完整关联会话和目标工具 schema，以隔离工具记录器核验参数。后两者不代表产品自动长期记忆能力，全部抽样也不构成官方完整榜单成绩。

原始结果、逐题来源及 Token 用量位于 `artifacts/agent-benchmarks/`。重跑自动归档上一轮结果，不覆盖失败证据。人工复核单列任务完成、流程遵循及题目歧义；`benchmarks/report.mjs` 在复核后生成 HTML 报告及包含重跑费用的汇总。

上游：[Pi](https://github.com/earendil-works/pi)、[Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)、[Pi AI](https://github.com/earendil-works/pi/tree/main/packages/ai)，均遵循其 MIT 许可；版本由本目录 `pnpm-lock.yaml` 锁定。
