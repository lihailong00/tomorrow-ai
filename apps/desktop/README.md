# 妥啦桌面客户端

Tauri 2 / Rust 外壳。共享产品界面在 `../client`；可独立构建 Web，浏览器不加载 Tauri 平台实现。桌面默认连接官方服务 `https://api.example.invalid`，不启动本地 Node、Pi 或 API 服务。

## Windows 开发与构建

需要已安装的 Rust MSVC、Visual Studio C++ Build Tools、Node.js 和 Edge WebView2。先阅读根目录的 `docs/development-storage-policy.md`，依赖安装和原生构建由一个指定写入者执行。

```powershell
pnpm --dir apps/client install --frozen-lockfile
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop tauri icon ../mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png --output src-tauri/icons
pnpm --dir apps/desktop dev
```

首次没有 lockfile 时，用 `pnpm install` 生成并保留 lockfile。图标来自本项目 Android 已有品牌资源，生成后保留所有平台所需的图标。

交付构建统一使用：

```powershell
pwsh -NoProfile -File scripts/Build-Desktop.ps1 -NoBundle
# 完整 Windows 安装程序（NSIS；首用工具下载需要网络）
pwsh -NoProfile -File scripts/Build-Desktop.ps1
```

脚本默认产出 `artifacts/desktop/candidates/`，不会自动替换已验收的 latest。通过验收后可传 `-Publish` 发布独立程序并保留原 latest 为 rollback。发布的独立 exe 依赖机器上的 WebView2；安装程序可引导安装 WebView2。当前首版未配置正式 Windows 代码签名证书，不把普通构建声明成签名发行版。

脚本复用仓库打包锁和空间统计，检查真实磁盘剩余空间，允许构建临时超过 10 GB；不为临时超额清理活动缓存。`-CleanBuildCache` 只在成功复制/校验交付物、无活动构建进程且验证本任务 target 归属后清理本应用的可重建输出。保留最新和回退、源码、用户数据及凭据；不会清理其他工作区。收尾记录在 `artifacts/desktop-storage.json`，没有持续测量构建峰值。

## 原生桥接协议

`desktop_request({request, requestId?})` 返回 `{status, headers, body}`。

`request` 为 `{serverUrl, path, method, headers?, body?, allowInsecureLan?}`：

- `serverUrl` 只允许源地址。HTTPS 始终验证证书；HTTP 只允许本机，或显式开启 `allowInsecureLan` 的私有局域网。
- `path` 只允许当前服务器的 `/v1/*` 或 `/health`。禁用 HTTP 重定向；禁止其他 origin、Host/Cookie 等请求头。
- `body` 是可选文本，最大 8 MB。该首版桥接不支持任意文件读取或 multipart 文件上传，不将未移植的系统能力伪装成可用。

`desktop_stream({requestId, request, onEvent})` 通过一个 Tauri Channel 顺序发送：

1. `{type:'headers',status,headers}`
2. 多个 `{type:'chunk',bytes:number[]}`
3. `{type:'end'}`

客户端用同一个增量 `TextDecoder` 解码所有 bytes，避免拆分中文 UTF-8 的乱码。HTTP 非成功响应也先发送 headers，网络错误使 invoke Promise 拒绝。`desktop_cancel({requestId})` 真正取消进行中的 HTTP 任务，并处理停止操作先于注册到达的竞态；不会自动重新执行任务。

`desktop_session_read({serverUrl,instanceId})` 返回 token 或 null。
`desktop_session_write({serverUrl,instanceId,token})` 写 token；token=null 删除。

会话保存在 Windows Credential Manager / macOS Keychain / Linux Secret Service，通过规范化 origin + 服务实例 ID 隔离。UI 必须在不带 token 的情况下读取并验证最新 `/v1/instance`，再按对应 ID 恢复凭据，实例变化时不重用旧账号。系统凭据库不可用时明确失败，禁止退化为文件/localStorage 明文。模型厂商 API Key 仍在用户选择的后端管理。

`desktop_open_url({url})` 只接受不含用户名密码的 HTTP(S) 链接并交给系统浏览器；不提供任意 shell 命令接口。Tauri capability 仅授予本地 main 窗口，CSP 禁止远程脚本、iframe 和自动远程图片加载。

## macOS / Linux 后续发行

同一 Rust 外壳和 React 界面保留跨平台依赖，标准系统标题栏处理窗口控制。macOS 在 Mac 构建并签名、公证；Linux 在 Linux 构建并验证 WebKitGTK、GTK 与 Secret Service/DBus 依赖。平台凭据库通过 Cargo target dependencies 选择，不使用 Windows 专有的 UI 代码。当前未执行 macOS/Linux 运行验证，不能把源代码可构建的设计等同于三端已验收。

原生测试：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc`。
