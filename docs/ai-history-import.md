# AI 对话导入（首版）

在手机「能力 → 导入 AI 对话」中选择 ChatGPT、Claude 或 DeepSeek，在原平台申请官方导出并下载 ZIP / JSON 后，选择文件、允许云端解析、检查预览，确认全部或选中的对话。也可以用电脑浏览器打开同一后端的 `/ai-import`，使用妥啦手机号和密码登录后上传。导入结果按账号在手机和网页间共享；电脑页的登录令牌只保存在当前页面内存，刷新后需重新登录。

本版以文件导入为入口，不接管其他平台登录，不抓取私有接口。ChatGPT、Claude 的邮件下载链接可能要求登录原账号，不能把链接本身当作匿名可下载文件；不提供未经实测的链接自动导入。

## 支持范围

| 平台 | 读取结构 |
| --- | --- |
| ChatGPT | `mapping` 消息树、`author.role`、`content.parts`；有 `current_node` 时标记当前与其他分支；兼容已线性化的 `messages` |
| Claude | `chat_messages`、`sender=human/assistant`；优先结构化可见文字块，旧版空块回退 `text`；存在当前叶节点时按父节点标记分支 |
| DeepSeek | `mapping` 中的 `message.fragments`，只取 `REQUEST/RESPONSE`；兼容线性 `messages` |

保留来源平台、原对话标识的摘要、标题、可用的时间、发言角色及原始父节点引用。没有当前分支标识时不擅自选择一条；存在已知分支歧义时在预览和详情提示。没有时间戳不填入导入时间伪装成发言时间。

只提取用户与 AI 可见文字。图片、视频、音频、附件二进制、思考过程和工具调用不导入。ZIP 仅读取任意目录下的 `conversations.json`、`conversations-*.json`，及一层 `conversations-*.zip` 分片；不会执行或展示压缩包里的 HTML、脚本，也不读取 `users.json` 等账号文件。

单文件 25 MiB；JSON 解压预算 96 MiB；每批最多 5000 段对话、10 万条文字消息、24 MiB 正文；单消息最多 2 MiB。大导出包需解压后按对话 JSON 分片导入。每账号最多 1 万段、128 MiB 规范化记录、两份待确认预览、每小时 12 次解析尝试；每个 API 进程同时最多两个解析/提交请求。

原 ZIP / JSON 不长期保存为附件。规范化预览仅供本人访问，一小时到期、后台每分钟清理；取消时主动删除。确认后保留规范化对话供检索；同来源同原始对话 ID 重复导入会跳过相同记录、更新发生变化的记录，保留妥啦内的对话 ID。删除导入历史不会删除原平台数据，也不会删除用户另行确认保存的记忆。

## 助手使用

`search_ai_history` 只检索本人已确认记录，排除明确不是当前分支的正文；`read_ai_history` 分页读取并标记来源为不可信资料。工具返回的长正文有截断标志，不能据此宣称阅读全文。导入不发起模型调用，也不自动保存记忆。手机「整理记忆候选」会打开对话，要求先展示带原话、时间和来源的候选，由当前用户明确确认后才保存；假设、代写、角色扮演、引用和 AI 猜测不能作为用户事实。

## 验证与格式变化

使用虚构对话构造的格式测试覆盖三平台、ZIP 分片、分支和消息顺序、非正文过滤、循环/不安全路径/超限拒绝；HTTP 测试覆盖预览确认、账号隔离、更新去重、幂等重试、删除与预览到期。未获取用户的真实导出包，不承诺覆盖平台未来或所有历史版本；不认识的结构明确报错，不能空导入后显示成功。

官方导出入口说明：

- [ChatGPT](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)
- [Claude](https://support.claude.com/en/articles/9450526-export-your-claude-data)
- [DeepSeek](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)

格式核对参考各项目作者对实际导出结构的记录；实现自行编写，没有复制这些项目的解析代码：

- [Claude Chat Viewer 格式说明](https://github.com/osteele/claude-chat-viewer/blob/main/docs/schemas.md)
- [AI Chat Retro 格式观察](https://github.com/systems1/aichatretro/blob/main/PLAN.md)
- [DeepSeek Archive Viewer](https://github.com/ismdevteam/deepseek-arhive-viewer)
