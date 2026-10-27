# Rust 基础设施选型复核

复核日期：2026-10-26。范围：当前 v0.3 路线的检索、缓存、浏览器执行和对象存储。本稿是选型研究记录，未修改正式方案。以下“建议”是结合 50 人 beta、100～500 人试点和权限/删除需求作出的项目判断，并非通用性能排名。

| 层次 | 当前方案 | 建议 | 理由与触发条件 |
| --- | --- | --- | --- |
| 业务数据库与首版检索 | PostgreSQL + pgvector | 保留 | 业务数据、租户权限、来源版本、删除和检索可保持在同一数据库，减少第二份索引的一致性处理。先建立中文与权限过滤的召回/延迟基线，再决定扩展。 |
| 独立向量检索 | 未引入 | 将 Qdrant 列为首要扩展候选，暂不部署 | Rust 实现、官方 Rust 客户端、过滤/混合检索和独立扩容能力值得评估；仅在 pgvector 经合理索引/查询优化后仍不能满足实测召回、延迟或资源隔离要求时引入。Qdrant 只替代检索职责，业务事务数据库仍保留 PostgreSQL。 |
| 嵌入检索/多模态离线数据 | 未引入 | LanceDB 后置 | 官方定位包括嵌入式检索库，并有 Rust SDK；适合后续离线、批量多模态数据或特定检索进程评估，当前不足以抵消第二套数据生命周期的成本。 |
| 进程内缓存与限流 | Redis 按需 | 补充 Moka / governor 为轻量选项，Redis 保持按需 | Moka 可缓存可重建、允许短暂陈旧的数据；governor 可做进程内软限流。两者不能直接承担多副本全局额度、持久任务、审批或共享会话事实。严格预算仍在 PostgreSQL 中原子预占与结算。 |
| 浏览器执行 | 隔离浏览器服务，可采用 Playwright | 保留 | 浏览器功能可靠性、页面等待、下载和排障比执行器语言更重要。Rust 网关经受控接口调用独立执行器，核心权限和任务仍用 Rust。 |
| Rust 浏览器库 | 未定 | chromiumoxide / fantoccini 作为专项备选 | 前者控制 Chrome/Chromium 的 CDP；后者使用 WebDriver、需相应 driver。两者是客户端库，不提供生产隔离边界，不足以直接替换浏览器服务。 |
| 文件对象存储 | S3 兼容存储 | 保留协议，生产优先托管；补充 aws-sdk-s3 | SDK 用 Rust 即可，不需要为了存储服务的实现语言更换成熟托管服务。开发环境或明确要求自建时评估 RustFS。 |
| 自建 Rust 对象存储 | 未指定 | RustFS 主要候选，Garage 场景化候选 | RustFS 已 GA，仍需目标版本 S3 行为及故障恢复验证；Garage 偏小中规模、自建、多地点复制，API 覆盖与目标需求逐项核对。 |

## 1. 检索的依据与工程边界

pgvector 支持精确和近似检索；其官方文档说明，近似索引扫描之后应用过滤可能使结果数量不足，0.8.0 起的 iterative scan 可继续扫描以改善该情况。因此首版不应只加 HNSW 就宣称完成权限检索，需要覆盖租户、来源 ACL、删除状态、数据分布和中文资料的实测。[pgvector](https://github.com/pgvector/pgvector)、[PostgreSQL 官方发布说明](https://www.postgresql.org/about/news/pgvector-080-released-2952/)

Qdrant 有官方 Rust 客户端、payload 过滤和多租户方案，过滤字段需要规划 payload index。多租户检索仍要求服务端准确设置租户过滤和访问策略；使用 Rust 数据库不会自动解决授权问题。[Qdrant Rust client](https://github.com/qdrant/rust-client)、[过滤](https://qdrant.tech/documentation/search/filtering/)、[多租户](https://qdrant.tech/documentation/production-operations/multitenant-search/)

若未来引入独立检索服务，应继续由 PostgreSQL 保存权威业务记录；通过事务出站事件同步可重建的索引，记录来源版本、租户、删除与禁用标记。返回内容前校验当前授权及版本；删除立即阻止召回，不等待异步清理后才生效。还需设计重建、落后监控和双写故障处理。这是项目设计建议。

LanceDB 官方当前定位为 OSS embedded retrieval library，提供 Rust SDK，不能仅因 Rust 实现就视作 PostgreSQL 业务事务替代品。[LanceDB 项目](https://github.com/lancedb/lancedb)、[Rust API](https://docs.rs/lancedb/latest/lancedb/database/index.html)

## 2. 缓存与限流

Moka 是 Rust 进程内并发缓存，可设置容量和过期策略；governor 默认限流状态保存在进程内。[Moka](https://docs.rs/moka/latest/moka/)、[governor](https://docs.rs/governor/latest/governor/)

建议只缓存模型能力配置、公开元数据等可重建数据；敏感检索结果首版尽量不缓存。若缓存用户内容，键中包含租户/身份/资源版本，权限撤销、删除和记忆修订有明确失效机制。进程内缓存不跨 API 副本同步，进程内限流也不能保证整个集群的严格额度。需要共享限流、跨实例事件分发或共享短期缓存时，再引入 Redis/兼容托管服务，Rust 通过 redis-rs 连接。[Redis Rust client 文档](https://redis.io/docs/latest/develop/clients/rust/)

## 3. 浏览器执行

Playwright 官方语言支持为 JavaScript/TypeScript、Python、Java 和 .NET；Rust 不在官方支持列表。社区 Rust 包不等于官方 Rust SDK。[Playwright 官方支持语言](https://playwright.dev/docs/languages)

chromiumoxide 提供 Chrome/Chromium CDP 的 async Rust API；fantoccini 通过 WebDriver 操作兼容浏览器。若未来限定 Chromium、动作覆盖可控，chromiumoxide 可以做针对性验证；不建议首版为统一语言重做完整执行器。[chromiumoxide](https://github.com/mattsse/chromiumoxide)、[fantoccini](https://github.com/jonhoo/fantoccini)

Playwright 官方 Docker 镜像面向测试与开发，官方不建议直接用于访问不可信网站；默认 root 运行还会禁用 Chromium sandbox。生产不可信网页执行继续使用独立运行时、资源/出口限制、凭据代理和用户隔离；不能将“换成 Rust 浏览器库”视作完成隔离。[Playwright Docker](https://playwright.dev/docs/docker)

## 4. S3 兼容存储

RustFS 于 2026-09-16 发布 1.0.0 GA，2026-10-17 发布 1.0.3，项目和文档声明 Apache-2.0；应纠正历史上的“尚未 GA”判断。官方明确只承诺受支持功能的广泛 S3 兼容，不承诺全部 AWS S3/MinIO 行为。Windows 安装目前仅推荐开发调试，生产建议 Linux。[RustFS releases](https://github.com/RustFS/RustFS/releases)、[兼容矩阵](https://github.com/rustfs/rustfs/blob/main/docs/architecture/s3-compatibility-matrix.md)、[安装说明](https://docs.rustfs.com/en/installation)

建议 RustFS 为自建首要候选，但不能仅凭 GA 标签推断已满足本项目可靠性目标。验证应覆盖目标版本的签名 GET/PUT、分片上传与中断恢复、checksum、Range 下载、条件写入、删除、版本/生命周期、访问控制、备份恢复、磁盘/节点故障与升级回退。RustFS 官方推荐 AWS 官方 S3 SDK，本项目可采用 aws-sdk-s3 并锁定兼容版本。[SDK 建议](https://docs.rustfs.com/en/developer/sdk)

Garage 为 Rust 实现、AGPLv3，官方称从 2020 年首版起用于其自身生产服务，面向小中规模的自建多地点存储。其官方兼容表仍将 bucket versioning 列为缺失，应核对当前目标发行版后才作决定。[Garage 官方镜像](https://github.com/deuxfleurs-org/garage)、[Garage 兼容表](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)

MinIO 社区仓库官方页面显示 2026-04-25 归档、当前只读，并标明 AGPLv3；不建议新项目默认采用这份归档社区服务端。商业产品须独立核验。SeaweedFS 项目声明 Apache-2.0，是非 Rust 的自建备选，但本阶段无须因扩展对象存储选型再增加部署工作。[MinIO 官方仓库](https://github.com/minio/minio)、[SeaweedFS 官方仓库](https://github.com/seaweedfs/seaweedfs)

以上许可证仅记录官方声明，不据此推断商用限制或给出法律判断。
