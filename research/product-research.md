# Today.ai 官方公开证据备忘

检索日期：2026-10-26（Asia/Shanghai）。范围：公开官网、官方应用商店详情；未注册、登录、安装、购买或运行任务。因此“有公开入口 / 官方说明”不代表功能已通过端到端验收。

## 1. 证据口径

- **公开可观察**：能看到真实页面、下载链接、登录选项、商店上架信息。
- **官网声明**：官方声称产品支持，但本次没有在账号中执行。
- **指南或示例**：方法论、虚构案例和未来方向，不能转写为已经上线的设置或完整能力。
- **需实测**：读写权限、套餐开关、限额、执行成功率、端侧支持等。

## 2. 产品与核心能力

### S1：官网首页

URL：https://today.ai/ （无可见发布日期）

官网把产品定位为理解用户、主动介入的个人助理，页面演示 Today / Tasks / Memories / Capabilities 四个入口以及每日简报、健康指标、项目、旅行等卡片。它宣称可调用先进模型、执行多步任务、使用常驻云电脑和社区 Skills、跨设备工作。展示中的 Figma、新文件、品牌项目等只是情景示例，不能据此确认某个连接器具备相应写能力。官网没有公开模型版本、云电脑配置、可用性 SLA、Skills 兼容规范或跨设备控制协议。

### S2：能力总览

URL：https://today.ai/articles/capabilities （无可见发布日期）

官网声明支持：跨会话个人记忆；结合时间、记忆和授权数据的简报及建议；任务规划、搜索、文件、代码与连接工具；一次性与重复任务；符合条件的云端后台执行；文字、语音、图片、文件、链接输入；转写、摘要、后续问答和部分结果导出。用户可管理所支持的记忆。任务能呈现草稿、待批准或完成状态。外部操作可能要求确认。站点明确说明：权限、账户、地区、客户端和发布批次影响能力；依赖本地设备的工作仍需要该设备；生成建议与送达通知是两个不同环节。所有项目均为官网说明，未登录验证。

### S3：产品介绍（应警惕过期）

URL：https://today.ai/articles/blog/what-is-today

可见日期：发布 2026-08-03，更新 2026-09-15。

介绍宣称记忆以可读事实条目呈现，可编辑、删除，并能追溯哪些记忆影响建议；每日晨间简报和晚间收尾；日历、邮件、笔记、健康等可选且可撤销连接；确认后进行外部执行；云端续跑与安装社区 Skills。此文仍称“当前免费、以后可能收费”，与现行 Terms 及 App Store 已有付费方案冲突，应将其用于理解定位与交互方向，不用作当前收费依据。文中“家庭共享记忆”是探索方向，不列入已上线功能。

## 3. 集成目录与设备能力

### S4：集成目录

URL：https://today.ai/articles/integrations （无可见发布日期）

目录写明 55 项，逐项计数为 **38 项未标 Soon，17 项标 Soon**。未标 Soon 不等于本次验证可用。

未标 Soon：Gmail、Google Calendar、Google Drive、Google Contacts、Microsoft 365、Excel、Slack、Discord、Notion、X、LinkedIn、Todoist、Trello、Asana、ClickUp、Airtable、Linear、Zoom、Calendly、Cal.com、Dropbox、Miro、Figma、GitHub、GitLab、Sentry、Supabase、HubSpot、Attio、YNAB、QuickBooks、Zoho Invoice、Splitwise、WHOOP、Oura、Garmin、Fitbit、COROS。

Soon：Feishu、Lark、DingTalk、WhatsApp、Reddit、Instagram、Facebook、TickTick、Monday.com、Jira、Tencent Docs、Gong、Salesforce、Dynamics 365、Stripe、Square、Strava。

目录列出设备权限能力：日历、通讯录、提醒事项、健康、照片、媒体、邮件、笔记、消息、本地文件、屏幕、电脑操作、剪贴板、脚本、位置、系统信息、通知、使用情况及短信通话。平台支持不一致；Windows 原生邮件/日历/剪贴板与 Linux 剪贴板/屏幕标 Soon。目录笼统把部分能力标为 iOS/macOS，不能据此保证两端相同。每个连接器的实际读写动作和审批边界需要单独验收。

## 4. 录音与会议记忆

### S5：Recording 产品页

URL：https://today.ai/articles/recording （无可见发布日期）

官网声明会议录音结合已有项目、人物与决策记忆生成摘要，可跨会议关联项目、识别决策变化，并在同一处继续问答和生成下一步。录音前通过日历触发的锁屏 Live Activity 邀请，用户每次点击后才开始。录音入口明确限 Mac 和 iPhone；摘要与后续对话可在 Today 支持的其他平台查看。记忆提供背景，录音是事实来源，不确定关系应保留不确定性。未验证音源类型、后台录制、语言与时长上限。

### S6：Recording 发布文章

URL：https://today.ai/articles/blog/introducing-today-recording

可见发布日期：2026-09-18。

文章称录音包含摘要、原文、分享及围绕会议内容的追问，并声称不额外收费。尤其要区分：**speaker recognition（按声音识别具体人物）仍在内部测试，无发布日期；会议转成自动行动建议尚未提供**（原文第 74–75 行），不可写成已经上线。当前说法是摘要及用户主动追问；自动创建任务或自动产出行动建议不能从通用任务能力推导。页面有自测质量表述，但本次未复核数据与重跑评估，不能给出“已达到某准确率”的验收结论。

## 5. 客户端与账户

### S7：下载页

URL：https://today.ai/downloads （无可见发布日期）

公开可观察到 Mac Apple Silicon / Intel（macOS 14+）、Windows x64 / ARM64（Windows 10+）、Linux x64 / ARM64 下载链接。iOS 为二维码，Android 为归因跳转链接。没有下载或验证安装包运行。浏览器扩展按钮实际指向 https://today.ai/thanks?platform=browserExtension ，本次未找到直接 Chrome 商店地址，不能认定扩展正式可用。Windows 链接示例：https://releases.today.ai/apps/today/desktop/windows/latest/today-windows-x64.exe 。

### S8：登录页

URL：https://today.ai/login （无可见发布日期）

公开页面有 Google、Microsoft 登录与邮箱输入。未执行授权；不推断邮箱验证机制、密码策略或登录后引导步骤。

### S9：支持页（信息落后于下载页）

URL：https://today.ai/support?language=en （无可见发布日期）

称首次登录有简短引导、设置里有 Help & Feedback、通常一个工作日响应。该页仍只写 iOS/macOS 与 web，其他平台开发中；它与当前下载页和 Android 商店上架存在冲突，应以更具体入口为平台证据，同时保留“安装运行未测”。

### S10：Apple App Store 官方详情

URL：https://apps.apple.com/us/app/today-personal-ai-assistant/id6760608312?platform=ipad

公开可观察：发布者 Today AI PTE. LTD.，产品 ID 6760608312；iPhone/iPad 上架，iOS/iPadOS 18+；语言为英语、日语、简中、繁中。页面也列兼容 Apple Silicon Mac（macOS 15+），但标注未验证适用 macOS，不能替代独立 Mac 安装包要求。美区内购列 **Pro Monthly US$20、Ultra Monthly US$200**；Pro 条目重复，不能推断为两个不同权益。页面显示版本 1.21.1，具体相对更新时间可能随抓取缓存变化。评论未用作产品事实证据。

### S11：Google Play 官方详情

URL：https://play.google.com/store/apps/details?id=ai.today.android.app

更新日期存在抓取缓存差异：本子代理读取为 2026-09-17，父代理同日直接打开为 2026-10-15。最终文档建议省略具体 Android 更新时间。

公开可观察 Android 产品上架、开发者 Today AI、应用 ID ai.today.android.app、含内购。商店说明支持文字语音、图像文件、记忆、后台与定时任务、每日简报和支持的消息渠道。说明没有列具体消息渠道，不能因此确认 WhatsApp 等 Soon 入口。未安装，没有验证系统最低版本、权限与国际/国内构建差异。

## 6. 套餐、隐私与控制

### S12：Terms

URL：https://today.ai/terms

可见生效日期：2026-09-07。

现行条款明确 Free / Pro / Ultra，Pro 与 Ultra 为月付；符合资格账户可有 7 天 Pro 试用，Ultra 无试用。权益、限额、模型等可依账户、渠道、地区与版本变化。确切账单价格在购买前显示。因此美区 App Store 价格只是渠道地区样本；尚无公开 token、积分、并发、任务次数、云电脑时长、文件大小或录音时长额度。条款声明通常 18+；商店年龄分级不能替代服务资格。条款也限制未经授权的逆向和大规模抓取；本次仅常规阅读公开页面。

### S13：Privacy

URL：https://today.ai/privacy

可见生效日期：2026-05-13；最后更新：2026-08-31。

隐私文件明确 Android Health Connect 和 iOS/iPadOS HealthKit 为授权后读取，不回写；Apple 数据可后台同步入云，用于健康看板、摘要与问答，撤销权限不等于删除已同步数据。文件列举 AI/cloud 提供商可能含 AWS、Anthropic、OpenAI，但这不能证明具体线上模型或架构。声明用户可查看删除聊天/任务内容，不允许第三方用可识别聊天、附件和健康数据训练公开基础模型。设置有 Delete Account；关联聊天、记忆、任务及同步数据随账户删除。以上是政策承诺，未独立审计或实测删除传播。

## 7. 不能转为已上线功能的指南

### S14：记忆设计指南

URL：https://today.ai/articles/blog/what-should-ai-agent-remember

可见发布：2026-10-11，更新：2026-10-16。

内容提出记忆应该有来源、时间、状态、作用域与过期规则，并讨论隔离上下文、暂停记忆和版本历史。这是通用的设计指南，**并不证明 Today 已有这些字段、开关和完整 UI**。可供复刻产品定义参考，但需标“我们的技术/产品方案”。

### S15：每日简报指南

URL：https://today.ai/articles/blog/ai-daily-briefing

可见发布：2026-10-02，更新：2026-10-22。

文章建议简报显式列日期时区、变更、事实与建议、未检查的数据源，并区分生成、送达、阅读。它明确说案例是虚构示例，设计并非所有客户端均可配置的承诺。适合转为我们的验收标准，不能作为 Today 设置项已实现的依据。

## 8. 下一轮实际体验必须确认

1. Today / Tasks / Memories / Capabilities 登录后真实导航、卡片和信息结构。
2. 新用户能否跳过第三方授权、首次引导、Free 实际能力及付费墙。
3. 单条记忆来源、编辑/删除生效、敏感信息策略、矛盾合并、是否有不记忆模式。
4. 一次性/重复任务创建、修改、暂停、取消、时区、失败重试、结果与通知位置。
5. 每个连接器真实动作与 OAuth scope；撤销、令牌过期、限流与审批提示。
6. 云电脑生命周期、后台最长运行时间、文件导入导出、远程接管与本机离线边界。
7. 各平台端侧权限；尤其目录笼统 iOS/macOS 分组不能据此推断 iOS 允许任意电脑控制。
8. 会议录音的音源、转写时延、说话人分离、中文/混合语言、配额与分享权限。
9. 套餐实时权益与限额，浏览器扩展发行状态，社区 Skills 安装与兼容格式。

上述缺项是“尚未证实”，不等于 Today 不具备。当前足以形成公开证据驱动的功能基线和独立实现路线，不足以宣称逐屏、逐端、逐权限已达到一比一验收。
