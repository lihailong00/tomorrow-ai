# DSH 接入与事项视图插件（首版）

这版在现有 Rust API 后增加可选的 DeepSeek Harness 引擎，保留 Pi。桌面/Web 客户端增加 `todos.view` 扩展点，以及可替换官方列表的“轻看板”实例。两处插件系统分别属于 Agent 执行和客户端展示，不互相依赖。

## 启动与回退

要求 Node.js 22.19 或以上、pnpm 10.20.0，以及现有 Rust 工具链；不要用不同 pnpm 主版本重建同一份依赖缓存。本机已经安装依赖时，在仓库根目录运行：

```powershell
.\scripts\Start-Local.ps1 -AgentMode dsh
```

部署时，Rust API、worker 和 Node Agent 使用相同的 `AGENT_MODE=dsh`，其余 `AGENT_URL`、服务令牌及模型配置沿用现有部署。后台管理的模型配置仍通过已认证的 `/internal/config/runtime` 获取，并为每轮执行固定配置版本。Node 与 Rust 的内部接口必须保持在可信网络。

切回 Pi：停止当前本机服务，再运行 `Start-Local.ps1 -AgentMode pi`；部署环境将同一组服务的 `AGENT_MODE` 改回 `pi` 并重启。默认示例仍使用 Pi，以便按实例试用 DSH。

**回退是下一次执行的配置选择。失败的 DSH 请求不会自动在 Pi 中重跑。** 已发出的工具可能已经成功，自动换引擎重试会引入重复写入风险。现有 Rust 请求去重、操作序号、写入槽位和显式重试记录继续生效。

## 执行边界

- Rust 继续管理用户、权限、会话、持久执行记录、工具副作用、用量记录与客户端 SSE；不把这些职责交给 Harness。
- Node 的 `harness.ts` 选择引擎；DSH 通过官方 `@deepseek-ai/dsh-sdk-client` 启动真实 Harness 子进程，不是 Pi Agent 的别名。
- 使用 DSH 官方 `dsh-llm-pi-ai` **模型协议适配器**连接现有 OpenAI-compatible 接口；执行循环和 Cordis 插件来自 DSH。DeepSeek 的 system 角色、`max_tokens` 和 thinking 协议显式保留，不能在本机代理后误用 OpenAI 默认值。
- 模型密钥只保存在父后端中。DSH 子进程仅获得本轮随机 loopback capability，通过本机代理访问固定模型端点、已授权工具和事件接口。子进程不继承 API Key、Rust 服务令牌、run token、代理或 `NODE_OPTIONS`。
- 每轮使用独立 home、工作目录和进程；不共享不同用户的 DSH 会话、配置或 AGENTS 文件。结束、超时和取消时先回收子进程，再撤销本轮网关并删除本轮临时目录。
- 内建终端、文件读取和目录切换工具关闭；单调工具 guard 再次限制为 Rust 下发的允许工具及已配置的网页工具。模型不能通过默认 DSH 工具取得服务器终端。
- 实时 `llm/stream` 文本片段经 Cordis bridge 插件送入 Rust 原有 `text_start/text_delta` 日志；不在全文完成后模拟打字。推理内容不进入正文。分段保留 Unicode、限制大小并等待后端确认。
- 工具调用仍经过原 Rust 授权与确认流程；工具日志不写参数正文或密钥。达到轮次/工具限额、丢失运行权限或回放冲突时停止。
- 真实 provider 请求沿用 durable dispatch/finish 用量记录。重复的 finish checkpoint 按 request index 合并，原始未知用量字段保持未知；不根据 SDK 的零价格估算费用。

## 已验证与当前限制

锁定 DSH `0.2.1-rc.5`、Cordis `4.0.5`，避免启动时下载未锁定的 CLI。DSH 仍是预发布版本；升级前需要重跑实际进程测试。

本机验收覆盖 Rust → DSH → 数据库工具 → SSE、重复请求不重复写入、不同账号隔离、取消保留已显示文字、权限冲突停止、工具预算及 Pi 回归。另使用服务器已配置的 `deepseek-flash` 和合成资料完成真实模型查询：一次工具、两次模型请求；最终复测首段约 3.5 秒、总计约 3.7 秒，前一轮约 4.9/5.2 秒。这些数字包含每轮进程启动，不是生产延迟承诺。

当前 SDK 的便捷接口接受单个 prompt；Rust 保存的多轮消息以带 role 的 JSON 历史交给 DSH，Rust 仍是历史来源。没有迁移到 DSH 的持久多轮会话仓库。每轮启动进程增加冷启动开销；后续如做池化，必须保留用户与配置隔离。

本轮接入现有业务工具与网页工具。Pi 中实验性的 ToolSearch 和研究复核循环没有迁移至 DSH，也没有因此打开部署开关。需要这些实验能力的实例可继续选 Pi。当前不是全软件插件市场，也没有向服务器部署本轮代码。

## 事项视图插件

正式入口：桌面/Web 客户端 → 事项 → “官方列表 / 轻看板”。两种视图使用同一份真实事项、相同详情、编辑、完成和分页操作。停用“轻看板”会恢复官方列表，不删除事项。只在设备上保存视图偏好，不缓存事项或凭据。

交互演示：运行 `pnpm --dir apps/client dev`，打开 `http://127.0.0.1:1430/todo-plugin-demo.html`。演示使用合成事项，在内存中切换完成状态；正式事项页仍调用当前实例的真实 API。

扩展代码在 `apps/client/src/plugins/`：

| 文件 | 职责 |
| --- | --- |
| `todo-contract.ts` | API v1、`todos.view` 插槽、注册/停用/回退 |
| `official-todos.tsx` | 官方列表插件 |
| `examples/todo-board.tsx` | 可独立替换官方展示的轻看板插件 |
| `TodoViewHost.tsx` | 选择视图、只读数据投影、窄操作回调、错误边界 |

第三个展示插件只需实现 `TodoViewPlugin` 并在启动时注册：

```tsx
const uninstall = todoViews.register({
  manifest: {
    id: 'my.todos', name: '我的事项视图', version: '1.0.0',
    apiVersion: 1, slot: 'todos.view',
  },
  View: ({ items, onOpen, onToggle, busyId }) => (
    <div>{items.map(item => <button key={item.id}
      disabled={!!busyId} onClick={() => onToggle(item.id)}>
      {item.title}
    </button>)}</div>
  ),
});
// 停用：uninstall(); 当前选择不存在时回退到官方列表。
```

视图只得到冻结的展示字段和 `onOpen(id)` / `onToggle(id)`，不获得 ApiClient、账号令牌、模型 Key、原文或草稿。宿主再次检查 ID 是否属于当前已加载事项，并保留版本校验和并发状态。

**首版只加载随应用构建的可信插件。** React 同进程代码本身没有沙箱；上述窄接口不等于能安全执行陌生人上传的 JS。插件市场需要后续独立实现隔离运行、权限、签名、审核、兼容与回滚策略，不能直接把这个注册器用于不可信网络代码。

## 复测

```powershell
pnpm --dir services/agent test
pnpm --dir apps/client test
pnpm --dir apps/client build
cargo build --locked -p tomorrow-api
# 启用需要真实编译 Rust 可执行文件的本地验收；不调用收费模型。
$env:TADA_DSH_RUST_E2E = '1'
pnpm --dir services/agent test:dsh:e2e
Remove-Item Env:TADA_DSH_RUST_E2E
```

`artifacts/dsh-integration-20261103/` 保存本机验收报告和合成界面截图。真实模型报告只记录合成答复、用量与配置版本，不保存密钥。存储检查遵循现有 20 GB 收尾政策，未中断正在执行的构建，也未清理其他会话的缓存。
