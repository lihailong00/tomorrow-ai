# 轻量图记忆首版

实现日期：2026-10-27。借鉴 Graphiti 的实体、事实、来源 Episode 与增量维护设计，使用本产品现有 Rust / SQLx / Pi。没有引入 Graphiti Python 包、Neo4j 或额外付费抽取服务，也不是 Graphiti 的完整移植。

## 如何使用

在现有聊天中明确要求，例如：

> 请把“Tomorrow 方案确认”这条已保存记忆整理成实体关系图，保留原文依据。

Pi 读取 `list_memories` 的真实 ID、version 和正文，先查询候选，再调用 `index_memory_graph` 提交实体及关系。普通聊天和导入资料不会自动触发索引。模型密钥仍仅由 Pi 服务管理。无需重新打包 Android；新版后端和 Pi 服务启动后，原有聊天接口获得两个业务工具。

索引后可以询问：

> 王伟确认了哪个方案，谁负责部署？
>
> 9 月初的提议和 9 月下旬的确认有什么不同？
>
> 这个项目使用哪些技术，这些结论出自哪条记忆？

`search_knowledge_graph` 返回直接匹配的事实、一跳相关事实、实体 ID 和原文引用；回答仍由 Pi 完成。没有索引的记录需要继续通过原有记忆工具读取，图中没有找到不能等同于事实不存在。

## 已实现的机制

- 一条记忆一次提取，最多 16 个实体、24 条关系；每个账号最多索引 256 条记忆。原文无需两两比较。
- 实体类型：person、project、plan、task、technology、place、organization、item。
- 关系类型：PROPOSED、CONFIRMED、USES、RESPONSIBLE_FOR、BELONGS_TO、REPLACES、PREFERS、DEPENDS_ON。
- 原文、实体范围及名称、关系证据均由 Rust 验证；关系引用须包含两端实体名称。结构校验并不证明语义判断一定正确。
- 每条关系保存 proposed / confirmed / reported / negated 状态。日期只接受证据中明示的 ISO 日期或中文年月日；未知日期留空，不使用入库时间代替发生时间。
- 人物默认保持来源内身份，不根据同名自动跨记忆合并。Pi 可在上下文足够明确时显式复用查询返回的同范围、同类型、同名实体 ID。不自动解析昵称。
- 非人物在同用户、同范围、同类型、规范化同名下复用。范围应具体，方案名称应能区分版本和事项；这个启发式仍可能误合并。
- 图索引绑定原始记忆的完整序列化快照和版本。任何入口更新记忆后，旧关系立即被查询排除；删除记忆后索引和关系级联删除。重建时替换该来源的派生事实。
- 相同来源版本和相同提取内容重复提交返回缓存。相同版本提交不同提取内容返回冲突，需要显式删除索引后重建。Agent 写入使用已有的事务操作回执，支持重试防重与取消权限检查。
- SQLite 和 PostgreSQL 使用同一张结构，查询均按当前用户限制。索引失败整笔回滚，不留下部分事实。

## API

```text
POST   /v1/knowledge-graph/index
GET    /v1/knowledge-graph/search?query=王伟&scope=Tomorrow
DELETE /v1/knowledge-graph/memories/{memory_id}
```

三个接口都要求用户会话。POST 接收 `GraphIndexInput`，用于提交已抽取的结果；API 自身不调用模型。自动抽取由现有聊天中的 Pi 和工具 schema 驱动。DELETE 只移除派生索引，保留原始记忆。

查询可传 `entity_id`、`from`、`before`、`limit`。日期范围起点含、终点不含；未知日期被日期过滤排除。结果中的 `has_more` 表示直接匹配结果超过上限。一跳扩展同样受用户、范围和日期过滤约束。

## 本版边界

本版只索引用户明确选择的已保存记忆。附件、导入聊天、通知和任务不会自动写入图。中文检索使用字符片段和英文单词匹配，再做一跳扩展；没有 BM25、向量、LLM 重排、社区摘要或全图问答。关系规模受入库上限约束，首版在内存对该用户当前有效关系做有界排序。

提议和确认状态是模型对原文的解释，不是外部事实核验。没有“最新记录一定正确”的规则，也不自动判定旧事实失效或某版本是当前最终方案；REPLACES 仅表示原文明确表达的替代关系，历史事件不会被抹掉。

为让证据可检验，第一版要求引用同时出现两个实体名称，因此“这版我同意”等跨记录隐含指代可能无法抽取。这种情况应读取上下文并说明不足，不能编造引用。完整指代解析、多来源证据和更准确的实体消歧是下一步能力。

## 验证

```powershell
cargo test -p tomorrow-domain -p tomorrow-api --test knowledge --locked
```

测试覆盖持久化、关系扩展、来源更新/删除、证据和日期校验、同名人物保守处理、跨用户拒绝、事务回滚与 Agent 操作防重。

2026-10-27 本轮结果：图模块专项测试 10 项通过；Pi 运行循环、配置与联网模块的 29 项测试通过；API 编译、隔离示例编译和验证脚本语法检查通过。全仓回归在并行开发的 `tomorrow-settings::tests::startup_limits_match_pi_caps_and_are_marked_as_requiring_restart` 处失败，其断言要求配置项标记为重启生效；本次未修改该模块。

真实模型验证尚未完成：两次启动独立本机验证服务的操作均被自动审批拒绝，仅返回 `blocked by policy`。第二次已移除系统级模型凭据读取，仍被拒绝；未进一步尝试绕过。现有 8080/8090 服务未重启、云端未更新，不能宣称已经通过真实 DeepSeek 抽取验收。PostgreSQL 专项测试也因未显式提供隔离验证库而跳过。

PostgreSQL 回归需要显式提供隔离验证库：

```powershell
cargo test -p tomorrow-domain --test knowledge postgres_graph_transactions_and_source_versions -- --ignored
```

`crates/api/examples/knowledge-demo.rs` 可以在 18080 启动同一个业务 API 的隔离实例，配合 18090 的 Pi 和独立数据库，避免重启正在使用的主服务。`scripts/Test-KnowledgeGraph.ps1 -Live` 只接受该本机端口，会通过真实 Pi 抽取和查询虚构记录并产生模型费用；报告只含虚构数据、工具轨迹和 Token 用量，不含密码或会话令牌。测试清理创建的记忆并注销会话，不操作真实账号。运行所需的 `AGENT_SERVICE_TOKEN`、Pi `RUST_API_URL` 与示例的 `AGENT_URL` 须对应。

## 借鉴来源

本次研究 Graphiti 的入库编排、实体/关系抽取提示词、实体候选解析、事实去重/冲突提示词、时间与来源字段，以及检索入口；本模块的提示、数据结构和代码为本项目实现。

- [入库与查询编排](https://github.com/getzep/graphiti/blob/main/graphiti_core/graphiti.py)
- [实体抽取](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_nodes.py)
- [关系抽取](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py)
- [实体消歧](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/node_operations.py)
- [事实去重与冲突](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/dedupe_edges.py)

最适合先验证的产品场景是项目决策脉络、人员分工、方案版本与任务依赖、跨记忆找证据。仅有文本偏好或一次简单问答时，原有记忆查询通常已经足够。
