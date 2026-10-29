# 我的连接：个人账号 MCP

客户端“能力 → 我的连接”管理每个用户自己的账号。通知、分享与资料导入仍保留，和云端账号连接分开展示。

首版支持麦当劳、滴滴出行、腾讯文档、腾讯会议、语雀。用户在厂商官方页面取得自己的个人凭证后，点击“校验并连接”。当前这些预设使用个人 Token/Key；不会把手动凭证输入包装成 OAuth 登录。连接前实际调用官方 MCP：HTTP 服务完成协议握手和工具发现；腾讯会议遵循官方独立 JSON-RPC 协议；语雀使用官方 stdio 服务，并调用 `yuque_get_user` 验证账号，不能仅凭离线工具列表判定授权有效。

飞书旧个人托管 MCP 处于调整阶段，新增链接有七天有效期和内测限制，因此首版不接受任意授权 URL；现有飞书应用 OAuth 连接保留。钉钉、WPS365 等企业应用授权不冒充个人 MCP。

## 凭证和公共配置

- 个人凭证在客户端短暂输入，不写入客户端持久存储，不返回给模型，不写日志。服务器使用 `CONNECTOR_ENCRYPTION_KEY` 加密，密文绑定用户、供应商和用途。官方服务和自建服务各自保存自己的授权，不自动迁移。
- 高德等公共服务 Key、模型 Key 和企业应用配置仍在 `/admin/`；无需为个人 MCP 在后台填入某个运营者的个人账号凭证。
- 连接/测试会真实访问厂商，并可能受厂商访问限制或额度规则约束；“已连接”表示上次校验通过，不承诺账号开放了整个 App 的所有功能。
- 断开会删除本服务保存的凭证、工具缓存及操作中的私密参数/结果，阻止旧请求恢复连接。若要让 Token 在其他客户端也失效，需要在厂商侧撤销。

## 使用和操作确认

在对话中提出需求，Agent 先查询个人连接，再动态获取工具定义。工具列表分页进入模型上下文，避免一次塞入所有供应商工具。

经过核实的只读工具可直接调用。写入、点餐、叫车、兑换、取消订单，以及未能确认只读性质的工具，先生成待确认操作。用户在“我的连接”核对供应商、环境和完整参数后确认，模型没有确认接口。

确认请求采用不可变参数和一次性状态转换。同一 Agent 执行中的重复意图合并；重复确认返回已有结果，不再次调用厂商。网络中断、进程退出或上游结果不明时标为 `unknown_outcome`，要求到原应用核实，不自动重试。断开连接不会把已经完成的真实订单误标成“已取消”。MCP `isError: true` 显示失败。滴滴提供明确的正式/模拟环境选择；正式环境可能产生真实订单费用。

## 服务器运行依赖

HTTP 服务无需用户安装 App，也无需新增开发者 Key。语雀固定使用 `services/agent/package.json` 中预装的 `yuque-mcp@1.0.0`，不在用户请求期间联网安装 npm 包。子进程只获得必要系统变量和当前用户的语雀 Token，不继承后端的其他密钥。

开发环境从仓库的 `services/agent/node_modules/yuque-mcp/dist/cli.js` 发现服务。自建容器已设置：

```text
PERSONAL_MCP_NODE=/usr/local/bin/node
PERSONAL_MCP_YUQUE_SCRIPT=/opt/tada/agent/node_modules/yuque-mcp/dist/cli.js
```

systemd 部署模板使用 `/opt/tomorrow/bin/node` 和 `/opt/tomorrow/services/agent/node_modules/yuque-mcp/dist/cli.js`。这些是服务器管理员控制的运行文件路径，用户不能通过 API 指定命令、脚本或远程端点。组件未安装时明确显示不可用，不假报连接成功。

## 接口与 Agent 工具

用户接口在 `/v1/personal-mcp`：列表、连接、测试、工具目录、断开、调用，以及操作列表/确认/取消。所有接口要求用户会话；Agent run Token 不能用于用户确认接口。

Agent 仅有四个桥接工具：`list_mcp_connections`、`list_mcp_tools`、`call_mcp_tool`、`get_mcp_action`。后端从认证的 run 确定用户，拒绝额外用户 ID、令牌或确认字段。长工具目录有 `next_offset`，长操作结果有 `result_next_offset`，偏移按 Unicode 字符计算。

单次只读工具结果仍受后端和模型上下文预算限制。超大正文会明确返回 `tool_result_too_large`，Agent 需要使用厂商工具提供的分页或缩小范围；首版没有任意只读结果的通用全文缓存，不能把未完整提供的内容称为已读全文。

腾讯会议使用官方包提供的固定地址和 `X-Tencent-Meeting-Token`，包版本 1.0.16 内配置的协议头是 `X-Skill-Version: v1.0.15`。调用元数据中的模型来自 Pi 此次执行的固定配置；手动调用无法确定模型时明确填 `not_provided`。

## 验证范围

本机测试覆盖协议 JSON/SSE、会话、分页、凭证加密、跨账号隔离、断开竞态、写入确认、防重放、业务错误、超时、模型工具桥接及客户端切换账号等流程。另启动官方语雀包验证 stdio 工具目录，并以无效凭证核实部分官方远程服务会拒绝未授权请求。

没有使用真实个人账号完成厂商侧点餐、叫车或修改资料；不能将本机测试通过等同于所有厂商真实账号已完成端到端验收。

官方资料：

- 麦当劳：https://open.mcd.cn/mcp/doc
- 滴滴：https://mcp.didichuxing.com/api
- 腾讯文档：https://docs.qq.com/open/auth/mcp.html
- 腾讯会议：https://meeting.tencent.com/support/topic/2233/index.html
- 语雀：https://github.com/yuque/yuque-mcp-server
- 飞书：https://open.feishu.cn/document/mcp_open_tools/end-user-call-remote-mcp-server
