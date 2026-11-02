# 妥啦桌面客户端

首版面向 Windows x64，采用共享 React Web 界面和 Tauri 2 / Rust 桌面外壳。macOS、Linux 的配置与凭据适配保留在同一个外壳中；这不等于已经完成这两个平台的构建和实机验收。

## 使用

Windows 交付目录是 `artifacts/desktop/`。`tada-desktop-latest.exe` 是可直接运行的程序，安装程序另行标为 `setup`，不要混淆。程序依赖系统的 Microsoft Edge WebView2；安装程序按 Tauri 配置检查该运行环境。

默认服务为 `https://api.example.invalid`。使用已有账号的手机号和密码登录；登录不会发送验证码。首次注册、忘记密码目前在妥啦手机版完成。自建服务通过“连接服务器”选择并检查地址，界面按实例公布的能力提供手机号或邮箱密码登录。切换服务不会把旧服务的账号令牌发给新服务，也不会在连接失败时自动切回官方服务。

首版包含对话历史与分页、真实流式回复、工具状态、停止接收与同请求重连、Markdown 表格和代码卡片、今日简报、事项管理、记忆管理、账号与服务器设置。停止接收只关闭客户端连接，服务端已经开始的执行可能仍继续，重新连接复用同一请求标识。

语音、图片/文件上传、手机数据权限、桌面文件夹持续索引、本地 SQLite 消息缓存、本地离线模型及自动更新不属于这一版已交付能力。界面不提供假开关或模拟成功。正式发布使用的代码签名与更新签名也应单独配置；开发包不声称拥有正式签名。

## 目录和平台边界

| 目录 | 职责 |
| --- | --- |
| `packages/client-core` | HTTP/SSE、DTO、实例身份验证、幂等重连、平台中立的 transport |
| `apps/client` | React/TypeScript/Vite 页面、虚拟化会话列表、Markdown、后台代码高亮 |
| `apps/desktop` | 独立 Cargo workspace、Tauri 窗口、Rust 网络桥接、系统凭据库 |
| `scripts/Build-Desktop.ps1` | Windows 构建、候选产物、发布、存储统计与可选安全清理 |

页面通过 `platform.ts` 访问平台适配。桌面使用 Rust reqwest 和 Tauri Channel；浏览器使用 fetch。浏览器版会话令牌只驻留内存；桌面令牌使用按服务 origin 和实例 ID 隔离的系统凭据库，非秘密的服务器偏好单独保存。模型厂商 API key 仍由所选服务器管理。

Web 产物可独立部署，但推荐和对应 Rust API 同源，例如同一主机 `/` 提供界面、`/v1` 提供 API。当前官方 API 没有开放任意网站跨域读取；把页面放在其他域名或 localhost 并不自动获得访问权限。自建服务请求不经官方代理。若另域部署，应由服务管理员明确配置允许的来源、HTTPS 和会话策略，不能通过关闭 TLS 校验解决。

## 开发和构建

先阅读 `development-storage-policy.md`。使用已经安装的 Rust/MSVC/Windows SDK、Node.js 和 pnpm。依赖版本由各项目 lockfile 固定，根服务端 Cargo workspace 不受桌面编译影响。

```powershell
pnpm --dir apps/client install --frozen-lockfile
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop dev
```

只开发 Web 页面可以执行 `pnpm --dir apps/client dev`。生产 Web 构建执行 `pnpm --dir apps/client build`，产物在 `apps/client/dist`。原生窗口的验证应使用实际 WebView2，不能仅凭 Chromium 页面测试声明桌面运行通过。

```powershell
# 先生成候选程序；不覆盖已验收的 latest。
pwsh -NoProfile -File scripts/Build-Desktop.ps1 -NoBundle
# 同时生成 Windows 安装程序。
pwsh -NoProfile -File scripts/Build-Desktop.ps1
# 完成测试和审核后发布 latest，可保留已验证回退程序。
pwsh -NoProfile -File scripts/Build-Desktop.ps1 -Publish
```

脚本将原生输出统一放在 `apps/desktop/src-tauri/target`，检查真实剩余空间，统计所有登记工作区的保留量。不要多个 agent 同时写同一个 target。临时构建允许超出 10 GB；完成交付与验证后才清理确认无用的输出。`-CleanBuildCache` 是收尾可选项，会保护源码、密钥、数据库、链接、正在使用的程序和未知归属文件。不要在迭代中反复清缓存。

## 验证与已知边界

`pnpm --dir apps/client typecheck` 检查共享界面；`pnpm --dir apps/client test` 执行界面回归；核心测试可通过该已安装的 Vitest 指定 `packages/client-core` 根目录执行。原生单测：

```powershell
cargo test --release --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

验收应明确区分受控合成流式 fixture、真实 Rust 隔离服务与生产健康检查。性能记录包括精确程序哈希、启动时间、长会话挂载行数和交互测量；“使用 Rust”不是流畅度的验收证据。测试进程专用的 WebView2 调试端口不得进入发布配置。
