# Toolathlon 真实环境集成与报告

使用固定版本官方任务、Docker MCP 环境、官方 artifact guard 和原始评分器，宿主由 Pi Agent Core 执行。模型密钥从后端环境变量读取，容器仅得到测试文件；此适配不将通用文件/终端工具开放给手机产品。

```powershell
./scripts/Test-Toolathlon.ps1 -DryRun -Concurrency 50 -BudgetCny 10
./scripts/Test-Toolathlon.ps1 -Concurrency 50 -BudgetCny 10 -MaxOutputTokens 8192
./scripts/Test-Toolathlon.ps1 -Concurrency 50 -BudgetCny 10 -Resume artifacts/toolathlon/runs/<run>/results.json
node --test services/agent/toolathlon/*.test.mjs
```

上限为 50 个任务并发，实际并发受待运行题数、环境准备和费用预占约束；题内模型/工具依赖仍按顺序执行。恢复运行保留已获得官方 true/false 的结果，仅续跑未完成项。源码版本和八题名单位于 `research/toolathlon-integration.json`；环境脚本位于 `scripts/toolathlon-infra.ps1`、`scripts/toolathlon-task.ps1`。

本次实验所有模型请求共用 `artifacts/toolathlon/budget-ledger.json`，新输出目录或重跑不会获得新额度。每次先持久化保守费用预占，未知请求继续保留预占；预算网关单实例锁阻止多开额度。不要删除或重置账本来继续本次实验。官方选定评分器不调用模型 API。

## 离线报告

生成或刷新中文 HTML 报告，不调用模型 API：

```powershell
node services/agent/toolathlon/report.mjs
```

默认输出 `artifacts/toolathlon/report.html`。默认读取 `latest.json`，或更新的 `runs/*/results.json`；运行未结束时也可生成当前快照。生成后直接用浏览器打开，刷新即可看到新快照，不需要启动服务。

指定输入与输出：

```powershell
node services/agent/toolathlon/report.mjs artifacts/toolathlon/runs/<run>/results.json
node services/agent/toolathlon/report.mjs --input=artifacts/toolathlon/latest.json --output=artifacts/toolathlon/report.html
```

报告单独统计官方 `true`、`false`、`null` 和环境/接入错误，展示原题、实际工具规模、请求与工具次数、耗时、官方评分依据及原始文件链接。支持恢复运行时的 `task.output_dir` / `artifact_dir`，将 `previous_attempts` / `resume_history` 单列为以前尝试，不混入本轮结果。

本次口径为“集成试跑 · 历史尝试保留”，不标每题尝试 1 次或固定配置的首次通过率。已正式评分 `true` / `false` 的任务不为提高分数重跑；只恢复因预算代理、输出截断或字节防护而未完成的任务。每题优先读取 `agent_limits.max_output_tokens`，缺失时读取该任务自己账本请求中的实际上限，保留旧 4,096 与新 8,192 的混合配置。没有记录时显示未知。

并发上限读取 `user_concurrency_limit` / `concurrency`；跨续跑的实际峰值优先读取 `experiment_peak_concurrency` / `actual_peak_concurrency`，否则使用结果或账本中的 `peak_concurrency`，不从任务数量推测并发。

可用 `task.review.finding_zh` 补充中文“运行后复核”，与官方原始评分依据分开展示；不会改动官方判定。

费用优先读取共享 `budget-ledger.json`，包括所有试跑、失败和重跑；同时展示已确认用量估算与保守占用上界，并非账户扣款账单。报告不读取私有任务 bundle、凭证、答案或评分器源码。

这组任务是 8 道本地文件可行性子集，Pi 替换官方默认 Agent loop。结果不能当作 108 道完整榜单成绩，也不代表验证了多轮用户对话或动态工具发现。
