# 妥啦健康与穿戴设备连接

更新日期：2026-10-29。本文记录首版产品契约、官方接入依据与验收范围。本文不是厂商开通证明；实现进度、测试结果和安装包以本次冻结清单及独立验收证据为准。

## 首版目标

用户在“我的连接 → 我的健康”中选择数据来源，授权妥啦只读已经由穿戴设备同步到健康平台的记录，并查看来源、时间和同步结果。Android 首发，数据协议和界面为后续 iOS、原生鸿蒙适配保留边界。首版不做通用蓝牙配对，不控制手表，不读取厂商账号密码，不做持续传感器监听或紧急健康监护。

设备品牌、健康平台、手机系统是三个维度。同一品牌不同设备、地区和健康 App 版本可能开放不同数据；不能把“有该品牌入口”表述成“全部型号全部指标可用”。小米运动健康与旧版 Zepp Life 也不能混为一个数据源。

### 本轮实现的边界

下表来自当前开发源码检查，不代替测试报告或 Leader 的最终验收。发布前应与冻结版本核对。

| 通道 | 本轮代码范围 | 尚需满足或单独验证 |
|---|---|---|
| 华为云端 | OAuth、只读步数聚合、手动读取、令牌隔离与本地副本 | 应用与 scope 审批、真实华为健康账号和穿戴设备；本轮不宣称已实现心率／睡眠云读取 |
| 小米云端 | OAuth、步数／心率／睡眠／体重／活动消耗读取适配、手动读取 | 应用与 scope 审批、真实账号和设备；不能把协议 fixture 当作互通证明 |
| Android Health Connect | 服务可用性、只读授权、步数／心率／睡眠／运动／体重读取 | 兼容手机上的库、真实来源记录及用户授权；并非厂商直连蓝牙 |
| iOS HealthKit | Swift 原生模块、只读授权和相同五类记录读取代码 | macOS／Xcode 编译签名与 iPhone／Apple Watch 真机验收；安卓 APK 不含 iOS 可运行包 |
| 小米本地 SDK、原生鸿蒙、手表端 App | 本轮未实现 | 后续独立适配和验证，不展示成可用通道 |

本轮健康数值记录经明确的前台读取返回并存入本机加密副本；服务端只持久保存加密 OAuth 令牌、一次性授权状态及同步元数据，不保存完整健康时间序列，不自动同步或发送给 AI。本轮采用最近短窗口重新读取并替换该来源本机副本，不是无限期健康档案、完整历史回填或上游订阅服务。后台云存储、趋势汇总和 Agent 查询属于后续扩展。

## 用户流程与状态

1. 打开健康页，先看当前手机实际可用的数据来源；不可用来源显示原因，不能直接弹权限或报连接成功。
2. 选择需要的记录类型，阅读数据去向说明，再进入厂商 OAuth 或系统健康授权。首版只申请读权限。
3. 厂商 OAuth 回调只换取令牌并加密暂存，不执行读取、不直接建立账号连接。浏览器显示一个五分钟有效的一次性确认码；用户点击严格匹配原服务器的“返回妥啦”链接，或在原 App 中手工粘贴确认码，确认将该次厂商授权连接到自己的妥啦账号。只有发起授权的原 App 会话显式提交最终确认后，后端才执行小范围真实读取并建立连接。区分“授权流程已返回”“等待 App 确认”“接口读取成功”“读取到记录”，空结果不等于拒绝授权，也不等于健康指标为零。
4. 显示最近成功同步时间、记录覆盖区间、来源和真实记录数。失败时保留已有记录，但显示过期或失败状态。
5. “立即同步”触发受控的增量或短窗口读取，避免高频全量轮询。断网保留本机已有数据，用户重试不得重复累计。
6. 用户可停止导入、清除妥啦副本、断开厂商账号。操作结果必须区分本地清除、服务端清除、厂商远程撤权，不能用一次本地删除宣称厂商授权已撤销。

状态至少区分：不支持当前系统、服务端未配置、未连接、授权待完成、可读取、暂无记录、部分可读取、同步失败、需要重新授权。只有实际完成读取的通道才可以显示对应的成功同步结果。

OAuth 最终确认用于防止授权链接被转发后，另一个人的厂商账号自动绑定到原发起人的妥啦账号。确认码仅在厂商回调后的浏览器结果页公开，连接状态列表不返回该码；App 不从状态查询自动兑换，也不因收到链接就自动确认或自动读取。最终确认请求必须来自原始、仍有效的妥啦 App 会话，同时校验一次性、有效期、厂商与原服务器上下文。页面应明确说明正在连接哪个妥啦账号，收到他人转发的授权链接时不要继续确认。

Apple 不向应用公开某一读取权限是否被拒绝；不能用 `requestAuthorization` 成功返回或 `authorizationStatus` 的写权限结果推断读取授权全部通过。[Apple 授权说明](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)

## 数据与隐私边界

- 原生健康库导入默认保存在本机，明确选择前不上传到妥啦服务端或外部模型。
- 选择华为／小米云端授权时，用户必须先知道当前所选妥啦服务端会接收个人授权令牌并代理读取健康记录；它与“纯本机导入”是不同模式，不能套用“数据不离手机”的文案。
- 健康记录不自动进入通用记忆、知识图谱或模型上下文；首版不因连接成功便允许模型读取。
- 官方服务器和自建服务器使用同一数据契约。自建通道不应静默经过官方服务器；厂商应用凭证和回调地址由该部署管理员配置。
- 云端个人令牌按用户隔离、加密保存，不返回客户端或管理页面，不进入日志。数据库加密不能被称为端到端加密。
- 原始记录包含来源平台、设备／采集器标识（若可得）、原记录 ID、指标、单位、开始与结束时间、时区、修改时间和导入时间。缺失来源信息不要编造。
- 数值与时间序列使用结构化存储，不把每个心率采样点写入向量库。按日摘要需有来源及覆盖率，不能将缺失数据补成零。
- 同一个上游样本重复读取必须幂等。多个渠道的步数不要直接相加；首版宜选择来源分别查看，跨来源合并须另行实现并验收。
- 删除妥啦副本不应删除华为、小米或 Apple 健康里的原始记录。用户在上游更正或删除记录后，需要在后续同步中处理；如首版未实现变更游标，只能明确告知短窗口重读和清除重导的范围。

## 官方通道与配置

### 华为运动健康

推荐官方 Health Service Kit 云端读取。华为的设备侧 SDK、REST 接口与未来原生鸿蒙接口是不同适配器，不因官网列出多平台就假定它们使用相同 SDK。

前提包括：妥啦对应应用注册、账号服务、Health Service Kit 所需数据权限审批、用户同意该数据类型，以及华为运动健康 App 数据开放开关。开发者资格和批准的 scope 与用户授权缺一不可。[华为概览](https://developer.huawei.com/consumer/cn/hms/huaweihealth/)、[云侧类型与开放说明](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/overview-0000001177423513)

华为当前申请说明区分个人开发者基本开放数据和高级开放数据，个人开发者还有应用上架等条件；不能承诺一个普通 App ID 就能读取全部心率与睡眠。具体产品类型应在申请页按 Android／REST 对应条件复核。测试权限与正式商用权限也不能混淆。[官方申请条件](https://developer.huawei.com/consumer/ru/doc/atomic-guides/health-apply-as)、[正式权限申请说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides-V14/health-verification-V14)

已核实的协议：

| 项目 | 官方协议 |
|---|---|
| 授权页 | `https://oauth-login.cloud.huawei.com/oauth2/v3/authorize` |
| 授权码换令牌／刷新 | `POST https://oauth-login.cloud.huawei.com/oauth2/v3/token`，表单编码，应用 secret 只在服务端使用 |
| 步数读权限 | `https://www.huawei.com/healthkit/step.read` |
| 心率读权限 | `https://www.huawei.com/healthkit/heartrate.read` |
| 睡眠读权限 | `https://www.huawei.com/healthkit/sleep.read` |
| 授权前历史数据 | 另有 `historydata.open.week`／`month`／`year` 权限，不能默认拥有 |
| 步数按日聚合 | `POST https://health-api.cloud.huawei.com/healthkit/v2/sampleSet:polymerize` |

请求聚合时的 `startTime`、`endTime` 是毫秒；官方响应内部 `samplePoints` 时间是纳秒，必须转换。请求的原子类型为 `com.huawei.continuous.steps.delta`，返回统计类型为 `com.huawei.continuous.steps.total`，步数字段是 `value` 中的 `fieldName: steps`／`integerValue`。`groupByTime.groupPeriod` 可指定 `unit: day`、`value: 1`、时区。读到别的统计值或时间单位不能强行当作步数。

本轮华为聚合实现采用 UTC 日区间，记录标记 `day_utc` 并保留真实开始／结束时间。界面应展示“UTC 日聚合记录”及对应区间，不称为用户本地“今日总步数”；尤其中国时区跨 UTC 零点的记录不能直接当作当地自然日总量。未来增加本地日汇总时需按所选时区重新定义查询和聚合后验收。

官方聚合示例及区域错误见 [REST FAQ](https://developer.huawei.com/consumer/fr/doc/hmscore-guides/faq-0000001476980529)；权限常量见 [Scopes](https://developer.huawei.com/consumer/jp/doc/HMSCore-References/scopes-0000001050092713)；令牌流程见 [Account Kit Codelab](https://developer.huawei.com/consumer/en/codelab/HMSAccounts/)。地区错误 `121001` 不能作为正常空数据；若实现区域重试，只能使用明确允许的华为区域域名，不能把用户令牌转发到任意 `Location`。

华为健康 App 隐私授权与妥啦 OAuth 是两步。官方自有隐私页示例中的固定 `client_id=106804381` 仅服务于华为自有开关页面，不能拿来充当妥啦的应用 ID。[华为健康 App 开放授权](https://developer.huawei.com/consumer/ru/doc/HMSCore-Guides/server-app-auth-example-0000001071757151)

心率的原子类型是 `com.huawei.instantaneous.heart_rate`，字段 `bpm`；睡眠片段与健康睡眠记录属于不同结构。首版如尚未核实并实现它们的具体读取协议，不应在可用指标中勾选；心率告警记录也不能代替常规连续心率数据。订阅通知需要企业开发者资格，首版可先提供手动同步，不作实时承诺。[心率类型](https://developer.huawei.com/consumer/cn/doc/HMScore-Guides/heart-rate-0000001131417172)、[订阅要求](https://developer.huawei.com/consumer/cn/doc/hmscore-guides/subscription-0000001078496860)

### 小米运动健康

优先采用现行官方云服务：管理员申请账号服务、开通运动健康服务并取得需要的权限；用户通过自己的小米账号逐项授权。不要用旧版平台的合作伙伴限制概括最新接口，也不要用米家 IoT Key 代替运动健康授权。

OAuth 使用 `https://account.xiaomi.com/oauth2/authorize`，`scope_provider=healthkit`，显式列出所需 scope，建议 `skip_confirm=false`。服务端使用 `https://account.xiaomi.com/oauth2/token` 换令牌，使用 `https://account.xiaomi.com/oauth2/refresh/token` 刷新。每次回调必须验证绑定到当前用户的一次性 state。[现行服务端指南](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2333)

小米健康 API 的鉴权须以专用服务端指南“公共参数说明”为准：请求包含 `Authorization: Bearer <access_token>`、`X-Client-ID`、`X-Client-Nonce`，以及 JSON 内容类型。Nonce 为 12 字节，前 8 字节随机，后 4 字节为当前 Unix 分钟数的无符号 32 位大端值，最后作 Base64 URL-safe 编码，不得重用。它不是通用小米账号 API 的 MAC 头格式。

同时，健康指南引用的 [通用 OAuth 授权码文档](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1708) 成功示例包含 `token_type: mac`、`mac_key` 和 `mac_algorithm`，健康指南的令牌表也列出后两项。因此不能因 token 响应带 `mac` 就直接拒绝一个完整的官方 OAuth 响应；小米适配器应区分令牌响应元数据与健康资源接口的专用 Bearer 请求格式，使用实际健康只读调用验证。未知类型、异常字段和上游失败不能伪装成连接成功。此处协议依据不等于已用真实账号完成互通。

首版相关只读 scope：步数 `200016`、卡路里 `200001`、心率 `200007`、睡眠 `200009`、体重 `200010`、设备 `200012`；时间范围 scope 包括一个月 `200013`、三个月 `200014`、一年 `200015`。不为首版一次申请无关范围。云 API 固定使用官方 `https://hlthopen.io.mi.com/`，具体采样、健康记录请求结构按 [云接口文档](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2328) 实现，不允许普通用户提供任意数据服务器地址。

字段映射必须分别核对云端与端侧定义，不能因字段同名就复用单位。当前云端 `healthRecords` 的 `com.xiaomi.sleep.health` 字段 `all_sleep_duration` 在 [云端数据类型](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2329) 中明确为分钟，值 90 表示 90 分钟，无需再除以 60。云端浅睡、深睡、REM 和清醒时长也以分钟表示；入睡／醒来时间为毫秒。相对地，[端侧 SDK 数据定义](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2331) 的同名总睡眠时长为秒，未来若接入端侧 SDK 应单独转换。心率 `com.xiaomi.heart_rate.delta` 的 `bpm` 是次／分钟，体重 `com.xiaomi.weight.instantaneous` 的 `weight` 是 kg，卡路里 `com.xiaomi.calories.delta` 的 `calories` 是千卡。真实账号仍需对照厂商 App 读数验证。

本地 SDK 是另一条通道，当前要求中国大陆、Xiaomi HyperOS 4.0 及之后版本、存在 `com.xiaomi.healthkit` 系统服务，并已注册应用和签名及授权；不能作为所有安卓手机上的通用小米手环读取库。[客户端指南](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2332)

### Apple 健康与 Health Connect

Apple 健康为 iOS 端本机 HealthKit 授权与查询，不需要用户向妥啦输入 Apple ID 密码，也不是安卓端拿 Apple 云 API Key。Apple Watch 的记录要先实际进入 Apple 健康；iOS 实现与编译／真机验收分开记录。[HealthKit](https://developer.apple.com/documentation/healthkit)、[执行样本查询](https://developer.apple.com/documentation/healthkit/executing-sample-queries)

Health Connect 是兼容安卓手机的补充通道，运行时检测服务及功能可用性，按类型申请读权限。没有服务、需要更新、用户拒绝、部分授权分别处理，不自动安装或承诺华为 Mate 60 支持。上游厂商健康 App 必须真的向该库写数据，妥啦才读得到。[可用性](https://developer.android.com/health-and-fitness/health-connect/availability)、[开始集成](https://developer.android.com/health-and-fitness/health-connect/get-started)

## 后台和自建部署

后台以厂商预设展示华为、小米：启用状态、应用 ID、应用 secret、固定回调地址、批准的数据范围及必要地区配置。管理员开启不等于厂家已经审批；客户端实际读取失败须显示可操作原因。未配置时连接按钮不发送外部授权请求。

官方服务配置只在官方部署保存。自建用户使用自己的厂商应用和回调地址；不能默认复用官方 secret，也不能为方便而把个人健康令牌回传官方。切换服务端或账号必须隔离连接状态和本机健康记录，不能让后登录用户看到前一账号数据。

本轮代码约定的部署项为：`HUAWEI_HEALTH_CLIENT_ID`、`HUAWEI_HEALTH_CLIENT_SECRET`、`HUAWEI_HEALTH_REDIRECT_URI`，以及对应的 `XIAOMI_HEALTH_*`；个人令牌使用 `CONNECTOR_ENCRYPTION_KEY` 加密。回调路径固定为 `/v1/health/oauth/huawei/callback` 与 `/v1/health/oauth/xiaomi/callback`，生产回调采用 HTTPS。通过公网 `INSTANCE_PUBLIC_URL` 推导时仍需在厂商平台登记完全匹配的地址。secret 和令牌不应进入 APK。

## 首版验收矩阵

| 场景 | 通过标准 | 证据类别 |
|---|---|---|
| 无任何厂商配置 | 健康页可打开；云来源准确显示未配置；无崩溃、无假数据、无外部授权调用 | 自动化＋APK模拟器 |
| 缺少系统健康库 | 返回明确不可用状态，不强行弹授权、不崩溃 | 原生测试＋相应系统实测 |
| 部分授权／拒绝 | 只读取允许的数据；空结果不误判零或全部拒绝 | mock协议＋真机 |
| OAuth state失效／重放／跨账号 | 拒绝回调，不污染连接，不泄露授权码／令牌 | 服务端真实HTTP测试 |
| 转发OAuth链接／最终确认 | 回调只暂存令牌；无确认时不probe不建立连接；确认码五分钟一次性、只在浏览器结果页显示，原App会话显式确认，其他会话或服务器拒绝；无自动兑换 | 服务端真实HTTP＋客户端链接与确认测试 |
| 上游HTTP错误／业务错误 | 不保存为成功；保留旧记录并展示失败 | 协议fixture＋真实HTTP测试 |
| 上游成功但空数据 | 显示接口已读取及暂无记录；不伪造设备／计量值 | 服务端＋客户端测试 |
| 步数、心率、睡眠样本 | 单位、时区、时间范围和来源正确；华为UTC日聚合有`day_utc`及真实区间且不称本地今日总量；跨日睡眠不简单归零点前日 | fixture＋具体设备对照 |
| 重复同步 | 相同来源记录幂等；多来源不重复累计 | 数据层测试 |
| 断网／离开页面／账号切换 | 无过期响应写入别的账号或覆盖新实例数据 | 客户端测试 |
| 默认本机模式 | 导入不向妥啦服务端或模型上传健康内容 | 请求观察＋客户端测试 |
| 删除／断开 | 停止导入；副本清除结果明确；远端撤权结果如实显示 | 服务端＋客户端测试 |
| 有效华为账号与手表 | 审批完备后，真实同意、读取、对照华为健康记录及撤销复测 | 待提供应用资格与本人设备 |
| 有效小米账号与手环 | 审批完备后，真实同意、读取、对照小米运动健康记录及撤销复测 | 待提供应用资格与本人设备 |
| Apple Watch／iPhone | macOS编译、entitlement正确、真实授权查询、HealthKit权限边界 | 独立iOS构建＋真机，安卓模拟器不能代替 |

协议fixture通过只是代码正确性的证据，不是厂商账号、真实设备或云端部署已打通的证据。本轮未取得这些前提时，应在交付中明确标注待验证项目，而不是把入口可见当作全部设备已接入。
