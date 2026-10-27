# 妥啦首版管理后台与自建部署

同一套客户端和后端支持官方服务与自建服务。客户端默认连接官方服务；自建部署者配置自己的模型等服务，用户在手机的服务连接页输入地址或扫描后台二维码。自建服务故障不会把用户业务数据转发给官方服务器。

## 部署前提

- Linux x86_64 或 ARM64，Docker Engine 与 Docker Compose v2；建议至少 2 核、4 GiB 内存。源码构建建议 4 GiB 以上内存和足够磁盘。
- 首版生产自建使用 PostgreSQL 17、服务器本机附件目录和持久数据库轮询 Worker。数据库、Pi 和 Worker 不开放公网端口。Temporal、对象存储和高可用集群不是这套最小部署的组成部分。
- 可先在本机访问。手机及公网访问需要可达的 HTTPS 地址，反向代理须保留原始 Host、转发协议并支持文件上传。不要直接把明文 HTTP 登录暴露在公网。
- 服务器、模型服务或诊断请求不会默认连接官方控制服务。使用第三方模型、语音或地图服务时，相应内容仍会发送给配置的服务商；后台展示这些处理去向。

## 从源码启动

在仓库根目录运行：

```sh
docker compose -f infra/selfhost/compose.yaml build
docker compose -f infra/selfhost/compose.yaml up -d
docker compose -f infra/selfhost/compose.yaml ps
```

首版仓库提供可构建镜像的 Dockerfile，目前不假定存在已发布的公共镜像地址。构建入口只接受源代码白名单；本机 `.env`、APK、数据、开发产物及密钥不会进入镜像构建上下文。

首次启动的初始化容器为该实例生成数据库密码、内部服务令牌和连接器加密密钥。它们保存在私有 Docker 卷中，重启不会重新生成。API 另行生成配置加密主密钥及一次性安装凭证。

默认地址为 `http://localhost:8080/admin/`，仅绑定服务器回环地址。在部署机器读取一次性安装凭证：

```sh
docker compose -f infra/selfhost/compose.yaml exec server cat /data/config/setup-token
```

在网页输入凭证，创建实例所有者，设置实例名称和公开服务地址，然后配置对话模型。无需模型 Key 也能启动并进入管理页面；未配置时 AI 功能明确提示等待配置。初始化成功后安装入口关闭，安装凭证不再可用。

后台中创建的所有者同时拥有普通用户身份，手机端可按实例支持的账号密码方式登录。自建默认关闭陌生人注册、启用邮箱密码账号；不强制短信。可由所有者在后台选择邀请或开放注册。短信登录等服务只有部署者配置后才可使用。

如需更换监听地址/端口，可复制 `infra/selfhost/deployment.env.example` 到仓库外的私有路径，并显式指定：

```sh
docker compose --env-file /private/tada-deployment.env -f infra/selfhost/compose.yaml up -d
```

默认 `TADA_BIND=127.0.0.1`；推荐在同机使用 HTTPS 反向代理。可信局域网临时调试可设置 `TADA_BIND=0.0.0.0`，手机必须使用服务器局域网地址而非 `localhost`。这不改变公网应使用 HTTPS 的要求。

不要执行 `docker compose down -v`，除非明确打算删除该实例数据库、附件和恢复所需密钥。

## 官方服务与配置优先级

新实例默认 `INSTANCE_MODE=self_hosted`、`REGISTRATION_POLICY=closed`。官方部署可显式设置 `INSTANCE_MODE=official` 并选择手机号密码和注册策略。模式仅描述服务归属，不会赋予自建实例官方账号、Key 或数据访问权限。

网页配置保存在 PostgreSQL，敏感项经过服务器主密钥加密。读取接口只返回是否配置和脱敏提示；不会回传原 Key。主密钥文件默认为 `$TADA_CONFIG_DIR/master.key`，必须和数据库共同保存。

优先级固定为 **非空环境变量覆盖 → 网页已保存配置 → 默认值**。由非空环境变量覆盖的字段在后台显示锁定。Compose 模板为名称、公开地址和注册策略传入空值，使它们可以在网页设置；部署者只有在希望锁定时才填非空值。模型供应商 Key 不写进 Compose 模板，也不分发给客户端。

实例内部令牌、数据库连接和本机加密主密钥属于部署配置，不作为普通网页字段提供。`/data/runtime.env` 仅含该实例内部秘密，权限为 0600。配置加密主密钥缺失时，已有加密配置不会静默失效或被重新生成的密钥覆盖。

## 连接手机

在后台复制公开服务地址或显示连接二维码，在手机“设置 → 服务连接”中连接。二维码只包含服务地址与实例识别信息，不包含管理员会话、密码或服务商 Key。

切换实例后需重新登录；各实例账号、会话和数据独立。通知、相册等自动导入许可按实例隔离，切换后重新确认。导出导入只在用户明确操作时发生，不会自动将官方数据复制到自建服务。

## 加密备份

实例所有者在“数据与维护”设置至少 12 个字符的独立备份口令，创建、查看状态、下载或删除备份。口令不会保存在服务器；遗失口令后无法解密下载的备份。

首版网页备份仅支持 **PostgreSQL＋本机附件存储**，每份最多 256 MiB，最多保留 5 份完成的备份，单个 API 进程同时只能执行 1 个。超过限制需要部署者使用 PostgreSQL 和文件系统的运维备份方案。SQLite 或 S3 实例在页面明确显示不支持，避免导出不完整数据。

备份包含：

- PostgreSQL 一致性快照，其中包含用户数据、网页配置和已加密的凭据。
- 同一数据库快照引用的原始本机附件；附件丢失、修改或超限会使整份备份失败。
- 配置目录中的恢复主密钥，排除安装凭证、日志和临时文件。
- `recovery/effective-settings.json` 保存当时生效的配置白名单（包括仅由环境变量提供的服务商 Key）；`recovery/effective-secrets.env` 保存生效的连接器/配置加密密钥。二者只存在于加密备份内，不会显示在页面或元数据中；备份期间配置版本变化会使该次备份失败，需重试。
- `BACKUP_RECOVERY_FILES` 显式指定的私有运行配置文件。Compose 默认包含 `/data/runtime.env`；systemd 部署者应将实际数据库、运行、模型、短信等环境文件加入此列表，使用操作系统路径分隔符。
- 格式、时间、数据库和文件清单等恢复说明。

文件采用带随机盐、PBKDF2-HMAC-SHA256 600,000 次派生和 AES-256-GCM 分块认证的 `TADABAK2` 格式。每块及最终结束记录均参与认证，错误口令、篡改和截断会拒绝恢复。明文暂存仅位于服务器私有 0700 工作目录，文件 0600，完成或失败后删除；异常停机遗留的工作目录在下次创建备份时清理。下载接口只提供加密文件，并禁止缓存。

数据库密码仅通过 `pg_dump` 子进程环境传入，不出现在命令参数或页面错误中。备份文件本身包含全站隐私和恢复密钥，仍应离线保管。后台不会上传到我们的服务器。

多副本 API 和数据库/文件系统联合快照不属于首版部署；不要让多个 API 进程共享本机备份目录。备份不包含未上传的手机相册原图、外部平台账户中的资料以及 S3 对象。

## 离线恢复

首版不提供网页上传恢复功能。恢复是明确替换实例数据的离线运维操作；请先验证备份，再停止 API、Agent、Worker，保持 PostgreSQL 运行。

在装有 Python 3 和 `cryptography` 的受控机器上，可以先只解密检查到一个**尚不存在**的目录，不修改数据库：

```sh
python3 infra/selfhost/restore.py /private/backup.tadabak --output /private/restore-check
```

口令通过交互读取，不能作为命令参数。不要在共享目录或不可信机器解密。输出含数据库、原始附件和恢复密钥，使用后由部署者妥善清除。

Compose 离线恢复示例：先把加密文件放入私有宿主机目录，停止服务器服务，再使用相同镜像执行恢复工具：

```sh
docker compose -f infra/selfhost/compose.yaml stop server
# 获取数据库连接环境时不要输出到共享终端/日志。
# 该临时容器只运行恢复工具，不启动 API、Agent 或 Worker。
docker compose -f infra/selfhost/compose.yaml run --rm --no-deps \
  --entrypoint python3 -e TADA_OFFLINE_RESTORE=1 \
  -v /private/tada-backups:/restore:ro \
  server /opt/tada/selfhost/restore.py /restore/backup.tadabak \
  --output /data/restore-check --apply --data-dir /data
```

工具交互要求输入备份口令及 `REPLACE INSTANCE`。运行配置从 `/data/runtime.env` 安全读取，不需要手工把数据库密码写进命令。它使用事务恢复 PostgreSQL，再注销所有手机/后台会话、撤销邀请、关闭定时任务并取消待执行任务；用户重新登录后再决定哪些任务需要重新发起。当前实例的旧 `config`、`uploads` 目录保留为 `.pre-restore`，部署者验证恢复后再清理。

解密目录须位于 `/data` 同一文件系统，保证目录替换使用原子重命名。`recovery/*.env` 只导出供部署者审核，不会自动覆盖目标实例的数据库主机和密码。恢复到新实例时应从中恢复旧 `CONNECTOR_ENCRYPTION_KEY`（用于用户连接器凭据），保留目标实例自己的 `DATABASE_URL` 和新的内部服务令牌。旧环境配置中显式提供的模型 Key 等也需要由部署者选择恢复；网页配置的密钥随数据库和 `master.key` 恢复。

检查恢复结果及模型配置后启动 `server`。恢复失败时继续保持服务停止，阅读工具的通用错误和私有部署日志；不要在公开 issue 中粘贴数据库错误、备份内容或密钥。

## 构建与发布多架构镜像

Dockerfile 不固定 CPU 架构；Rust、Node 和 PostgreSQL 的基础镜像选择同一目标架构。部署者或维护者可使用自己的镜像仓库发布：

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f infra/selfhost/Dockerfile -t YOUR_REGISTRY/tada-server:YOUR_VERSION --push .
```

以上为发布示例，仓库未自动向任何镜像仓库推送。维护者应在两个架构完成实际启动和恢复验证后再标记对应发布版本，不因构建成功就宣称所有架构已验证。Compose 中的镜像名应替换为自己验证后的地址。

## 维护与范围

- 管理后台是同源静态页面，由 Rust API 提供；不需要第二个公网管理服务或让网页获得 root 权限。
- 初始化凭证、独立后台会话、角色检查、CSRF 与来源检查保护管理操作；全站备份仅限实例所有者。
- 升级前创建备份并查看迁移说明。首次版本不提供自动升级、远程 shell 或读取任意服务器文件功能。
- 私有数据卷和数据库卷同等重要；丢失解密主密钥可能使已有配置和第三方授权不可恢复。
- 本文件描述代码提供的部署路径；具体发布的验证范围由发布报告说明，不等同于所有平台和真实第三方账号均已联调。

### 管理员恢复与环境配置迁移

已登录的所有者可在后台更换登录密码。忘记管理员密码时不依赖短信：停止 API 和 Worker 后，由拥有服务器访问权的部署者运行 `tada-admin-recover`。它继承实例的 `DATABASE_URL`、`TADA_CONFIG_DIR` 等私有进程环境，从标准输入读取单行 JSON：`{"email":"已有所有者邮箱","new_password":"新的足够长密码","confirm_instance_id":"该实例的 ID"}`。实例 ID 来自公开 `/v1/instance` 响应的 `id` 字段。恢复仅针对已有所有者，会注销旧会话；请勿将密码放入命令参数、脚本仓库或共享日志。

环境 Key 迁移到网页配置可使用同镜像中的 `tada-config --import-environment`。该命令只处理配置白名单，保存时加密，输出为脱敏摘要；迁移后部署者再移除相应环境覆盖并重启进程，网页字段才会解除锁定。`tada-config --status` 仅输出实例识别、版本及数量等公开状态。执行前同样应妥善备份，不能把现有环境文件公开。
