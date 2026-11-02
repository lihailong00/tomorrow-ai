# 场景分组侧边栏

侧栏沿用已确认的浅色 Demo，底部四栏继续承担常用主导航。

| 位置 | 入口 |
| --- | --- |
| 顶部固定 | 品牌、未读通知、新对话、搜索 |
| 日常 | 今日、我的任务、每日成长 |
| 我的内容 | 对话记录、记忆、我的成果、文件与导入 |
| 服务与工具 | 应用连接、健康数据；“更多工具”展开定时安排、AI 执行任务、导入 AI 对话 |
| 底部固定 | 当前服务、账户、设置、帮助 |

顶部与底部位于 `ScrollView` 外，中间入口可独立滚动。选中目的地显示浅蓝底；打开当前低频工具时自动展开对应分组。侧栏使用原生 `Modal` 和 `Animated`，点击遮罩、收起按钮或 Android 返回键关闭，并遵循系统减弱动画设置。

搜索先匹配本机功能名和别名，输入停顿 280ms 后只查询最近 50 条会话标题；同时匹配本账号已有的置顶记录。不会调用模型或拉取聊天正文。关闭、切换用户或服务器会中止请求；不同账号/服务器的搜索状态不复用。

各入口复用现有功能：定时安排直接进入 `TasksScreen` 的计划列表；账户和服务器分别定位到现有设置页的对应部分；服务器切换仍需完成原有身份检查与账号隔离。帮助页提供常见问题、相关页面入口和可复制的反馈模板，不自动发送反馈。

从聊天/编辑页面进入底部主页面时，主页面作为一个带 `tab` 的导航条目加入现有栈；不会重设整个导航栈或改变原条目的账号范围。返回可以继续原来的对话草稿。根页面的底部切换保留既有行为。

验证入口：

```powershell
cd apps/mobile
node node_modules/jest/bin/jest.js --runInBand __tests__/sidebar-navigation.test.tsx __tests__/sidebar-schedules.test.tsx __tests__/app-chat-header.test.tsx __tests__/navigation-races.test.tsx __tests__/instances.test.tsx --silent --testTimeout=15000
node node_modules/typescript/bin/tsc --noEmit
```

本次为客户端源码实现；没有变更服务端接口，也未进行 APK 发包或真机视觉验收。
