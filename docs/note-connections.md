# 笔记连接：语雀、Notion、Memos

入口是「能力 → 我的连接」。连接属于当前用户与当前妥啦服务器；个人 Token 在服务器加密保存，不进入模型，不作为所有用户共享的后台 Key。写入先生成待确认操作，由本人确认后执行。

| 服务 | 授权 | 本版能力 |
| --- | --- | --- |
| 语雀 | 超级会员个人 Token | 保留官方 `yuque-mcp@1.0.0` 的实际工具发现与调用；搜索、读取、创建和修改以本人账号返回的工具为准 |
| Notion | 个人访问令牌或内部连接 Token，并授权目标页面和读写权限 | 标题检索、元信息、Markdown 正文、子块分页、新建、替换正文、改标题、回收站及恢复 |
| Memos | 实例地址、本人个人 Token | 通过实例内置 MCP 搜索、读取、新建、修改和删除笔记 |

本版 Notion 使用 Rust 对官方 Public API 的适配，不依赖 Notion AI 订阅，也不将 Token 输入包装成 OAuth 登录。面向用户的一键 OAuth 连接尚未实现。Memos 使用原生 MCP。语雀普通账号无法生成所需个人 Token，界面明确提示超级会员要求。

## Notion

1. 在 Notion 的开发者设置创建本人 Token 或内部连接。授予读取、插入和更新内容的能力。
2. 内部连接需要在目标父页面中添加该连接，并授权需要访问的页面。个人 Token 以本人已有权限为准。
3. 在妥啦选择 Notion，填写 Token 后点击「校验并连接」。服务器会实际调用 `GET /v1/users/me`，不会只检查 Token 格式。
4. 对话中可以要求「在某个父页面下创建文章」。Agent 先检索真实页面，再读取并使用真实 ID；没有明确保存位置时先让用户选择。

接口版本固定为 `2026-03-11`。新建一次提交标题、父页面和完整 Markdown；修改正文使用同步 `replace_content`，不允许顺带删除子页面或数据库。标题修改单独执行，以免多个上游请求出现部分成功。删除仅移入回收站，可恢复，不支持永久删除。

语雀、Notion、Memos 的单次操作参数限制为 48 KiB，支持正常长度的中文文章；其他连接仍保持 16 KiB。Notion 本版单次正文最多 10,000 个字符。超过限制应拆分文章，不能静默截断后保存。

普通 API 的搜索只匹配标题，不能宣称已完成全文或语义检索。正文读取保留 `truncated`、`unknown_block_ids`、`warnings`；长笔记可按子块分页补读。首次连接不自动复制整个账号或建立向量索引。

Notion 的调用复用 HTTP 连接；只读请求遇到连接中断或服务端临时错误时最多重试一次，总请求时间受限。创建、修改和回收站操作不自动重试，避免网络断开后重复执行。

官方资料：[账号连接](https://www.notion.com/help/create-integrations-with-the-notion-api)、[公开 API 定价](https://www.notion.com/pricing)、[Markdown 读取](https://developers.notion.com/reference/retrieve-page-markdown)、[正文修改](https://developers.notion.com/reference/update-page-markdown)、[回收站](https://developers.notion.com/reference/trash-page)。

## Memos

需要支持服务前缀工具名的 Memos 版本（0.30 及以上；真实验收使用 0.31.0）。填写实例的根地址，例如 `https://notes.example.com`，而非 API 或 `/mcp` 路径。服务器使用固定的相对 `/mcp` 端点。

连接时完成 MCP 握手、读取工具目录，并实际执行 `auth_get_current_user` 验证用户。只开放六个经过审核的工具：身份、笔记列表/搜索、读取、新建、修改、删除。实例提供的账号管理、Token 管理等工具不会进入 Agent。

新建笔记未指定可见性时，确认参数和实际请求均明确为 `PRIVATE`。搜索「我的笔记」时从真实身份取得作者，再使用厂商工具支持的作者条件；公共可见笔记不代表本人的笔记。

管理员可预置：

```dotenv
MEMOS_DEFAULT_SERVER_URL=https://notes.example.com
```

用户可更换为自己的实例。普通用户提供的地址必须为 HTTPS，不能含用户名、密码、查询参数或片段。服务器对 DNS 结果检查并固定连接地址，禁止重定向。需要访问自己局域网、容器或本机实例时，由该妥啦服务器的管理员显式设置精确来源：

```dotenv
MEMOS_ALLOWED_PRIVATE_ORIGINS=http://memos:5230,http://127.0.0.1:18511
```

该配置不是通配主机列表，不向普通用户或 Agent 开放。Memos 默认实例地址是公共配置；每个用户仍使用自己的个人 Token，不能共享管理员 Token。

官方资料：[费用](https://usememos.com/pricing)、[个人授权](https://usememos.com/docs/integrations/api-access)、[MCP 工具](https://usememos.com/docs/integrations/mcp)。

## 写入及测试结果

「已连接」表示上次实际身份校验成功，不保证每个目标页面均有写入权限。真实的笔记创建/修改以厂商返回结果为准。相同确认不会执行两次；断开或更换凭证会阻断旧确认。写入遇到网络中断、超时或不确定的服务端错误时标记 `unknown_outcome`，先到笔记软件查询，不自动重复创建。

常规回归：

```powershell
cargo test -p tomorrow-connectors personal_mcp --lib
```

官方语雀运行组件的离线握手与目录检查（不使用真实账号）：

```powershell
$env:PERSONAL_MCP_NODE = (Get-Command node).Source
$env:PERSONAL_MCP_YUQUE_SCRIPT = (Resolve-Path 'services/agent/node_modules/yuque-mcp/dist/cli.js').Path
cargo test -p tomorrow-connectors official_yuque_stdio_catalog_smoke_without_network_or_credentials --lib -- --ignored
```

真实 Memos 验证在**专用测试实例**运行，使用临时测试账号与个人 Token：

```powershell
$env:MEMOS_TEST_SERVER_URL = 'http://127.0.0.1:18511'
$env:MEMOS_ALLOWED_PRIVATE_ORIGINS = 'http://127.0.0.1:18511'
# MEMOS_TEST_TOKEN 通过本机环境变量提供，不写在脚本或报告中。
cargo test -p tomorrow-connectors real_memos_account_crud_through_authenticated_http_and_confirmation --lib -- --ignored --nocapture
```

真实 Notion 验证需要 `NOTION_API_KEY`（或 `NOTION_API_TOKEN`）与已授权的 `NOTION_TEST_PARENT_PAGE_ID`。该测试创建带有 `TADA-connector-test-` 前缀的新页面，验证读取、修改、移入回收站、恢复，再将该测试页留在回收站：

```powershell
cargo test -p tomorrow-connectors real_notion_account_crud_with_a_unique_test_page --lib -- --ignored --nocapture
```

测试环境变量仅用于显式运行的测试，不会成为生产环境所有用户共享的默认授权。没有真实账号凭证时，接口契约或模拟服务测试通过必须与「真实账号已跑通」分开记录。

2026-11-01 已使用用户提供的个人 Token 在本机通过妥啦后端真实验证 Notion：身份、已有页面标题检索、Markdown 新建与读取、子块翻页、改标题、替换正文、回收站及恢复。仅创建并修改独立临时测试页，测试结束后移入回收站。本机网络沿用系统代理；此记录不代表云端部署或 APK 发布已完成。
