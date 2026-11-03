# 私密资料首版

入口位于「记忆 → 私密资料」，与普通记忆、资料索引、照片和模型上下文分开。

## 实际使用

- 支持家庭／公司地址、银行卡和身份证。可以添加、编辑、删除，为每份资料起名。
- 打开列表、显示完整内容、保存、复制、分享、查看恢复密钥和恢复操作均使用 Android 系统身份验证。
- 设备未设置安全锁屏，或原生安全模块不可用时，功能停止；不使用 AsyncStorage 或明文文件代替。
- 完整内容显示 30 秒后隐藏，切后台、退出或切换账号后隐藏。资料页面开启 Android `FLAG_SECURE`，限制截图和近期任务预览。
- 复制内容标记为敏感，并在约 30 秒后尝试清空仍属于本次复制的剪贴板；系统和其他应用对剪贴板的处理不由本应用控制。
- 「对话取用」是本机的资料名称／类别查找，多个结果交给用户选择。该页不调用云端模型。分享需要用户确认字段，再验证身份并从系统分享面板选择接收人；不会模拟已经向某位联系人发送成功。
- 当前首版使用记录仅在该页面会话内保留，包含动作、资料名称与时间，不持久化完整字段。

## 存储与备份

默认只保存在本机。文件位于 Android `noBackupFilesDir/private-vault`，使用随机 256 位数据密钥与 AES-GCM 加密；数据密钥由要求系统身份验证的 Android Keystore 密钥包装。使用 `AtomicFile` 提交，不通过普通缓存清理删除。

资料作用域由当前服务 URL、已验证实例 ID 和用户 ID 共同确定。切换账号／后端不会自动读取原作用域的资料，也不会把旧资料自动上传到新服务。

「云端加密备份」默认关闭。备份只复用应用当前已登录的 `ApiClient`，展示当前后端的只读信息，没有独立服务器选择、独立地址、独立 token 或备用目的地。

首次开启需要生成并确认保存恢复密钥，再经系统身份验证。恢复密钥为随机数据密钥的编码，具有 256 位随机性；它不是由手机号、登录密码或验证码生成。服务器不会收到恢复密钥、解密密钥或原始资料字段。

关闭时可选择：

1. 停止备份，保留已有云端密文。
2. 验证身份后停止备份并删除当前后端的云端副本。本机资料保留。

恢复只对空的本机资料库执行，避免覆盖已有资料。恢复后备份保持关闭，由用户重新决定。仅保存恢复密钥不能代替保存加密副本；未开启云端备份时，本版本没有自动的异机恢复来源。

云端提供 `GET /v1/private-vault/backup`、`PUT` 和 `DELETE`。接口校验登录用户，使用独立表 `private_vault_backups`；不进入 `resources`、向量检索或 Agent 工具。写操作使用 `expected_version` 作原子比较，阻止覆盖其他设备的新副本。删除清空密文并保留版本墓碑，阻止旧的在途上传复活已删除副本；删除从未上传过的副本也会留下墓碑。成功、未登录、版本冲突和格式／大小拒绝响应均带 `Cache-Control: no-store, private`。

外层密文格式固定为 `schema:1`、`algorithm:A256GCM`、`kid`、`iv`、`ciphertext`，拒绝额外的明文字段。IV 必须为 12 字节、密文必须为 16 至 196,624 字节，均采用规范 Base64 编码；单次 JSON 请求限制为 270 KiB。服务器只校验格式与大小，无法证明任意上传字节确由某个密钥加密；实际密钥匹配和 AEAD 完整性校验发生在手机。传输仍使用当前服务的连接验证和传输策略。

## 平台边界

React Native 页面通过 `src/platform/privateVault.ts` 调用能力。Android 的认证、Keystore、文件、剪贴板和系统分享均位于独立原生模块；通用密文与恢复密钥格式位于 `VaultCrypto.kt`。后续 iOS／原生鸿蒙需要实现相同接口，采用各自的密钥管理与系统认证能力。本次没有将 Android 适配宣称为已经支持其他系统。

## 验证

客户端检查：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/jest/bin/jest.js --runInBand --cache=false --runTestsByPath __tests__/private-vault.test.ts __tests__/private-vault-screen.test.tsx __tests__/memory-understand-you.test.tsx
```

原生模块独立编译及密码学单元测试（复用现有共享依赖，不下载、不启动 Gradle、不生成 APK）：

```powershell
pwsh -NoProfile -File scripts/Test-PrivateVaultNative.ps1
```

完整 Rust 集成验证由指定构建写入者执行 `cargo test -p tomorrow-api --test private_vault`。按照项目存储规范，优先使用本地快速构建和已有兼容缓存，允许临时用量超过 20 GB，构建后统一清理；不在生产服务器编译。Android 系统验证、真机恢复、安装包与服务器发布需要单独验收；JVM 测试不能代替 Android Keystore／指纹的真机验证。

源工作区快照 `80597bb` 留有 26 项客户端／页面／原有记忆回归、TypeScript、ESLint、Android 模块独立编译和 4 项 JVM 加密测试通过的记录；它们不代替本次集成后的完整 Rust、设备和发布验收。本次发布的独立检查与产物记录位于 `artifacts/release42-20261102/`，以实际验收回执为准。
