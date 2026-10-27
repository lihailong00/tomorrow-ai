# Rust 后端技术栈复核

复核日期：2026-10-26。范围：现有技术路线中的 Rust 云端；不变更 Android 首发、后续 iOS / 原生鸿蒙迁移要求。以下“建议”是结合本项目功能和现有文档作出的工程判断，未进行本项目性能压测。

## 结论

保留 **Axum + Tokio、SQLx、Temporal Rust SDK、PostgreSQL / pgvector**。优先补齐 **utoipa / utoipa-axum** 接口契约工具，并把原先宽泛的模型适配、S3 客户端明确为可替换的 Rust 模块。没有证据支持为了“更多 Rust”而替换成熟数据库、任务平台或对象存储服务。

| 层 | 建议 | 收益与代价 |
| --- | --- | --- |
| Web API | 保留 Axum + Tokio + Tower | 与现有异步运行和中间件路线一致；没有本项目压测支持换框架获得实际收益 |
| 数据访问 | 保留 SQLx | 方便直接控制租户过滤、pgvector、复杂 SQL 和事务；需要自行维护 SQL |
| ORM 替代 | SeaORM / Diesel 作为有明确团队偏好时的备选 | CRUD、关系与查询 DSL 更方便；需要学习实体/DSL 和维护另一套数据访问约定 |
| 持久任务 | 保留 Temporal Rust SDK | 等待批准、恢复、调度归一个系统；不再并列加入另一套后台任务框架 |
| API 文档与跨端契约 | 补充 utoipa + utoipa-axum | 从 Rust 类型和路由生成 OpenAPI，降低手机端接口漂移；仍须校验真实请求/响应符合契约 |
| 模型适配 | 默认 reqwest + serde + 项目自有 Provider 接口；Rig 做限范围验证 | 默认方案控制协议与供应商差异；Rig 可减少多供应商适配工作，但不可把业务状态和授权交给 Agent 框架 |
| S3 客户端 | 针对移动端分片直传优先 aws-sdk-s3，置于内部 Storage 接口后 | 直接暴露分片生命周期和签名能力；必须对实际 S3 兼容供应商做联调 |
| 对象存储通用抽象 | object_store 作为确有多云/本地统一读写需求时的替代 | 已有本地/内存/S3 及签名抽象；不要与 aws-sdk-s3 同时列为必选 |

## 1. Axum 与 Actix Web / Poem / Salvo

Axum 的明确优势是直接使用 Tower 服务/中间件，并围绕 Tokio、Hyper 构建。超时、追踪、压缩等可沿用同一生态。因此现有文档的 Axum/Tokio/Tower 组合合理。[Axum 官方文档](https://docs.rs/axum/latest/axum/)

Actix Web 同样支持流式、WebSocket、HTTP/2 及完整 Tokio 兼容。它是有力备选，不能以“它不能适配 Tokio”或“必须使用 Actor 模型”排除。对本产品而言，没有工作负载压测证明应从 Axum 改为 Actix Web。[Actix Web 官方仓库](https://github.com/actix/actix-web)

Poem 的 poem-openapi 提供宏驱动的 OpenAPI 接口编写；Salvo 提供内置 OpenAPI、HTTP/3 和 WebTransport 等功能。若团队已有这两者经验，它们都可用；现有功能范围未要求这些特性成为更换 Web 框架的必要条件。[Poem OpenAPI 官方文档](https://docs.rs/poem-openapi/latest/poem_openapi/)、[Salvo 官方仓库](https://github.com/salvo-rs/salvo)

更直接的改善是保留 Axum 并引入 utoipa。utoipa 支持 OpenAPI 3.1；utoipa-axum 可在注册 Axum handler 时同步收集 OpenAPI 定义。随后生成移动端 TypeScript 客户端，保持 Android/iOS/鸿蒙共同协议。[utoipa 官方文档](https://docs.rs/utoipa/latest/utoipa/)、[utoipa-axum 官方文档](https://docs.rs/utoipa-axum/latest/utoipa_axum/)

## 2. SQLx 与 SeaORM / Diesel

SQLx 本身是 Rust 异步数据库工具库，直接执行 SQL，提供可选编译期查询检查、连接池和迁移。它不以 ORM DSL 代替 SQL。这与本项目需要明确事务边界、租户隔离及检索查询的路线匹配。[SQLx 官方仓库](https://github.com/transact-rs/sqlx)

SeaORM 是真正的 Rust ORM，提供 Entity、Model、关系、CRUD、迁移、原生 SQL 及事务等能力。它主要解决实体和常见数据库操作的开发便利性；这不自动意味着更快、更安全或更适合 pgvector。[SeaORM 官方介绍](https://www.sea-ql.org/SeaORM/docs/introduction/sea-orm/)、[SeaORM 功能索引](https://www.sea-ql.org/SeaORM/docs/index/)

Diesel 提供查询 DSL 和类型化数据库访问；不能再以“它没有异步”简单排除，因为 diesel-async 为 PostgreSQL 等提供异步连接和查询 trait。pgvector-rust 官方同时支持 SQLx 和 Diesel，因此向量能力也不是两者之间的排他条件。[Diesel 官方指南](https://diesel.rs/guides/getting-started.html)、[diesel-async 文档](https://docs.rs/diesel-async/latest/diesel_async/)、[pgvector-rust 官方仓库](https://github.com/pgvector/pgvector-rust)

建议继续 SQLx。只有在团队明确更熟悉 ORM、常规实体管理成为主要工作量时，才用代表性的“用户/连接器 CRUD + 带租户过滤的混合检索 + 审批原子写入”样例比较 SeaORM/Diesel。选择一种默认数据库访问方式；共享同一事务和租户上下文的边界必须明确，不能为了 CRUD 同时随意引入多个连接池。

## 3. Temporal 与模型/Agent 框架的责任分配

保留用户已接受的 Temporal。官方确认 Rust SDK 于 2026-09-04 正式发布；开发指南已覆盖 Workflow、Activity、Worker、Client、消息、取消和定时器。平台成熟度与刚正式发布的 Rust SDK 生产验证时间仍应分开看。[GA 公告](https://temporal.io/changelog/rust-sdk-generally-available)、[Rust 开发指南](https://docs.temporal.io/develop/rust)

不建议另加 Apalis、Cron 任务系统等来接管同一类调度和恢复。Temporal 负责任务生命周期、批准等待、恢复和持久重试；PostgreSQL 保存产品需要查询的业务记录、操作账本和授权快照。数据库事务完成与启动 Workflow 的双写问题仍需可靠投递/对账设计，不能因为引入 Temporal 自动视为解决。

Rig 当前官方文档已有多供应商模型接口、嵌入、工具、流式处理和 Agent 状态等能力；新版还提供效果记录/重放与会话持久化，因此不能仅按早期“简单模型 SDK”印象评估。它是可用的 Rust 模型集成候选，但功能与 Temporal/产品自有状态存在交界，需要主动限定范围。[Rig 官方仓库](https://github.com/0xPlaygrounds/rig)、[Rig API 文档](https://docs.rs/rig/latest/rig/)

首版默认采用自有 Provider trait，底层使用 reqwest + serde 或经验证的供应商 SDK；reqwest 已提供 Tokio 异步客户端、JSON、multipart 和连接复用。[reqwest 官方文档](https://docs.rs/reqwest/latest/reqwest/)

Rig 的验证应限定为两个实际模型供应商：结构化输出、工具调用、流式增量、用量统计、供应商错误与超时、取消、模型特有参数是否完整保留。通过后可替代手写的模型传输/归一化代码，并保留 HTTP 逃生口。不要直接启用一个不经产品工具网关的通用自主 Agent 循环；批准、权限、预算、幂等与持久任务仍归产品逻辑和 Temporal。长流程避免叠加无界 SDK 重试、Agent 重试和 Activity 重试。

## 4. S3：aws-sdk-s3 与 object_store

现有文档尚未指定 Rust 文件客户端，属于应补齐的选项，而不是已经存在的框架替换。

对手机录音和大附件，倾向 **aws-sdk-s3 + 自有 Storage 接口**。官方客户端提供创建、逐片上传、列片、完成和中止分片上传；官方签名机制支持让手机持短期签名请求直接上传/下载。这样能明确保存 upload ID、part number、ETag、过期续签与清理流程。[AWS Rust S3 Client API](https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/struct.Client.html)、[AWS Rust 签名请求指南](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/presigned-urls.html)

aws-sdk-s3 可配置自定义 endpoint；但这只能说明地址可配置，不能证明任意 S3 兼容服务的行为均一致。实际供应商要联调签名、路径样式、校验和、分片、条件写入及服务器端加密。[AWS Rust endpoint 配置](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/endpoints.html)

object_store 是成熟的 Rust 对象存储统一客户端，有 S3、Azure、GCS、本地和内存实现，支持 multipart 和签名接口；它不是对象存储服务器。服务端主要做跨云通用读写时，它的抽象价值更明显。移动端逐片签名/恢复需求需针对实际 API 验证，不能只看“支持 multipart”几个字。[object_store 官方文档](https://docs.rs/object_store/latest/object_store/)、[签名模块](https://docs.rs/object_store/latest/object_store/signer/index.html)

现阶段选 aws-sdk-s3，不把 object_store 也列为同时必须采用；如果确定需要 S3 以外多个云存储后端，再通过 Storage 接口替换实现。

## 5. 实施验证顺序

1. Axum + utoipa：生成契约并验证流式任务事件、错误、文件接口和旧客户端兼容。
2. SQLx + pgvector：验证实际兼容版本、迁移、离线查询检查策略、事务级租户上下文及混合检索。
3. Temporal：验证重启恢复、批准后继续、取消、活动重试、流程版本升级和敏感载荷处理；这一项比换 Web 框架更关键。
4. 模型：先用小 Provider 接口接通真实供应商，再在同一用例上比较 Rig 是否减少维护量且不丢失能力。
5. 存储：验证 Android 大文件弱网上传与恢复、签名续期、完成核验和取消清理；iOS/鸿蒙沿用同一 HTTP 上传协议。

精确版本以实现时的兼容性验证和 Cargo.lock 为准。本复核未把网页显示的“latest”自动定为项目生产版本，也未据框架宣传或通用跑分推算实际总成本下降。
