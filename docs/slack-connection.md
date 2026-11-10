# Slack 工作区连接

妥啦支持在「能力 → Slack」按需搜索公开频道消息。聊天里也可以输入
`/slack 发布 in:release` 或「帮我在 Slack 里搜一下发布记录」，会直接打开临时搜索页。
搜索可按 Slack 的关键词和频道语法筛选，支持分页和打开原消息。每个妥啦账号保留一个工作区的连接。

## 配置内部试点

1. 准备一个可安装内部应用的 Slack 测试工作区和一个已运行新妥啦后端的 HTTPS 域名。
2. 打开 [Slack 应用管理](https://api.slack.com/apps)，选择 **Create New App → From a manifest**。
   选择测试工作区，导入 [应用模板](../infra/slack/app-manifest.yaml)；将占位域名替换为
   实际的妥啦 API 域名，保留 `/v1/integrations/slack/callback` 路径。模板只请求用户权限
   `search:read.public`，不配置消息写入、私聊、事件订阅或机器人凭据。
3. 在 Slack 应用的 **Basic Information → App Credentials** 获取 Client ID 和 Client Secret，
   保存到妥啦后台的「连接」配置，或通过后端的受保护环境配置传入
   `SLACK_CLIENT_ID`、`SLACK_CLIENT_SECRET`、`SLACK_REDIRECT_URI`。
   回调必须和 Slack 应用中登记的 HTTPS 地址完全一致。服务器还需有
   `CONNECTOR_ENCRYPTION_KEY`；已有服务应继续使用原来的加密密钥。
4. 使用包含 Slack 入口的手机端打开「能力 → Slack」。在 Slack 授权并返回妥啦后，
   搜索测试工作区公开频道里一条已知消息，点开原消息核对。再检查退出后不会恢复上次结果，
   断开后搜索提示重新连接。若工作区要求管理员审批，请先在 Slack 完成审批。

Slack 必须允许该应用使用[实时搜索 API](https://docs.slack.dev/apis/web-api/real-time-search-api/)；
内部应用可用来做试点，跨组织分发需要 Slack Marketplace 上架。若 Slack 返回
`feature_not_enabled`，在测试工作区核对功能资格和应用配置。

## 数据边界

- 搜索只走用户登录后的 `POST /v1/integrations/slack/search`，使用 Slack 官方
  `assistant.search.context`；仅请求公开频道消息，并过滤为当前授权工作区。
- 只保留加密的授权凭据和工作区绑定。消息预览与分页游标只在当前页面内使用；
  后端响应标记为 `no-store`，不进入普通聊天历史、资料导入、模型或长期记忆。
- 「断开 Slack」删除妥啦保存的凭据。需要撤销 Slack 侧的授权时，在 Slack 应用管理中操作。
