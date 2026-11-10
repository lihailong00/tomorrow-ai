# 办事资料自动补全

## 用户流程

当平台工具需要联系人、电话、邮箱、地址、城市、门牌、公司或发票抬头时，Agent 使用 `prepare_personal_tool`。工具会读取当前用户的具名记忆和账号候选资料，直接生成已填写的对话卡片。当前请求明确指定的值优先。多个不同值不擅自选择，其他人的业务使用 `subject=other`，不套用本人资料。

用户只需核对或补充缺失项。卡片显示目标平台、实际工具和其他业务参数。提交卡片是对本次具体参数的确认，服务端通过已有 MCP 操作日志执行，并把回执交还原 Agent 循环。创建地址成功后，Agent 应继续用真实地址编号查询门店、报价等原任务，不能停在“资料已准备”。已有的平台地址先查询复用，不能为了补全而重复创建。

资料库入口通过 Android 系统验证读取本机地址记录，只把本次需要的字段填入表单。选择记录会成组替换联系人、电话和地址，避免混用不同收件人。打开时保护截图，切后台或显示 30 秒后清空表单。不解锁银行卡或身份证，也不上传整个资料库。用户在表单中修改内容不会自动覆盖长期记忆或本机资料。

## 架构

- `crates/api/src/personal_autofill.rs` 是共享业务实现，按语义字段解析资料，校验提交，绑定目标账号版本，再执行工具。
- `crates/api/src/chat_interaction.rs` 使用现有经过身份验证的对话卡片通道。只有卡片本人的有效回答才能执行；模型不能传 `confirmed` 绕过。
- `crates/connectors/src/personal_mcp/state.rs` 复用加密操作记录、账号版本检查和一次执行声明。同一操作重复提交不会重复写入，未知结果不自动重试。
- DSH 复用 `tada-run-bridge` Cordis 插件注册 Rust 下发的工具定义，不修改 Harness 核心，也不在 `tools/pre-execute` 改写已经记录的参数。Pi 使用同一接口。延迟工具加载也始终保留资料补全工具。
- 具名资料查询有独立分页，不依赖聊天的八条相关记忆排名。忽略过期或待确认的记忆。账号姓名、电话、邮箱标记为候选，必须在本次卡片核对。
- 模型调用只需要用途、资料归属、字段映射和业务参数，不需要拿到由后端或设备补全的完整个人资料。返回回执去掉操作参数，并替换本次填入的个人字段值；真实平台编号保留以供下一步使用。

## 平台适配

麦当劳 `delivery-create-address` 内置语义映射，包括联系人、手机号、城市、地址和门牌。仍以当前账号发现的 schema 为准，不凭空开放工具。

其他已接入平台复用同一流程，通过 `bindings` 显式声明实际 schema 的字符串字段用途。例如寄件工具的 `mobile → phone`、`recipient → name`、`street → address`。禁止将字段名相似直接当作语义相同；不支持任意嵌套结构、证件、支付凭证或登录秘密的自动填写。新平台复杂结构需要增加适配，不能宣称任意软件零配置可用。

非个人资料的必填参数缺失时返回 `needs_prerequisites`，让 Agent 先查平台数据，不能让用户手填内部编号。个人字段支持必填、长度、枚举和基本电话/邮箱校验；麦当劳手机号校验为 11 位数字。覆盖范围、地址可达性和其他平台业务规则仍由平台最终校验，错误如实返回。

## 恢复和授权边界

卡片提交只授权该平台、该账号版本、该工具和当前表单参数，不是对后续下单或付款的长期授权。原有下单/付款确认规则继续适用。

卡片等待目前复用 90 秒的在线交互机制，手机断线可在有效期内重连。进程退出或超时不会伪造完成，未提交的表单需要重新发起。已产生的 MCP 操作记录持久化，结果未知时先核对，不自动重放。跨新会话的语义去重仍依赖平台查询和 Agent 使用返回编号，不能承诺任意平台跨会话 exactly-once。

## 验证

- Rust 单元测试覆盖多字段预填、明确覆盖、冲突、他人资料隔离、具名查询、字段校验及回执脱敏。
- 对话交互测试覆盖所有者校验、无效字段不关闭卡片和重复回答。
- MCP 传输夹具验证实际收到已填写参数、账号版本变化拒绝执行和同一操作不重复写入。
- React Native 测试验证预填无需重新输入、仅缺失字段阻止提交、资料成组替换和协议解析。
- Pi / 真实 DSH 执行循环搭配本地模拟模型，验证补全回执返回后继续使用地址编号查询门店。

以上不等于真实商家账号验证。开发验证没有向真实平台创建地址、寄件、下单或付款。

2026-11-04 本次验证结果：7 项 API 单元测试、1 项连接器执行测试、3 项既有 MCP 接口测试、4 项手机卡片测试、2 项 Pi/DSH 执行循环测试通过。手机端及 Agent TypeScript 检查、新文件 ESLint、`git diff --check` 通过。既有定位套件初次 55 项通过、1 项触发 5 秒超时；该项在 20 秒测试等待限制下复测通过，实际约 6.5 秒，没有修改定位实现或原测试。

收尾路径统计为 19,720,917,413 字节，未清理可复用缓存。计量不完整，不能据此确认全项目满足 20 GB 上限。四处未展开的链接位于以下目录，另有共享 SDK/全局缓存及 Docker 的归属统计未覆盖。构建峰值未连续测量。

- `artifacts/overnight-qa-20261028-0145/acceptance/combined-round5/agent/node_modules`
- `artifacts/deploy/ai-history-20261027/release-source/apps/admin/node_modules`
- `artifacts/chat-performance-20261028/native/final-streaming/private/pi/node_modules`
- `artifacts/chat-performance-20261028/android12/plans/prototype1004/pi-stage-platform-v3/synthetic-probe/artifact space & unicode-测试/segment-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/segment-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/alias`
