# 管理后台与 Pi 运行配置

官方服务和自建服务使用同一套 Pi 服务。全新安装无需模型 Key 也能启动，后台配置完成前，`GET /health` 返回 `ok: true, configured: false`，执行接口返回 HTTP 503 和 `model_not_configured`，不会改用官方服务器或其他供应商。

## 启用后台配置

部署 Pi 时设置：

```dotenv
TADA_RUNTIME_CONFIG=enabled
RUST_API_URL=http://127.0.0.1:8080
# 与 Rust API 使用相同的随机内部服务凭据，至少 32 字符。
AGENT_SERVICE_TOKEN=
```

每次执行开始时，Pi 向固定的 `GET /internal/config/runtime` 读取一次配置，使用 `X-Agent-Service` 内部认证，不携带用户或模型凭据。Rust 返回原子快照 `{ revision, values }`，其中已经完成后台设置和环境变量覆盖规则的合并。Pi 不再叠加自己的模型环境变量，避免后台删除 Key 后旧环境密钥重新生效。

配置接口只允许通过 `RUST_API_URL` 指定的私有服务根地址访问：本机、RFC1918/ULA 私网地址，以及约定的内部容器服务名。拒绝公网地址、用户信息、查询参数、片段、额外路径和 HTTP 重定向。响应最多 64 KiB，读取超时 3 秒；失败返回 `runtime_config_unavailable`，不沿用之前的凭据。Rust 尚未启动时，Pi 仍可启动并报告配置未就绪。

每次执行固定模型、模型地址、模型 Key、搜索设置和运行限制到同一版本。后台保存影响下一次执行，不改变已经开始的模型请求或工具循环。支持的动态运行限制为 `AGENT_MAX_TURNS`、`AGENT_MAX_TOOLS`、`AGENT_TIMEOUT_MS`、`AGENT_MAX_CONCURRENT`，上限分别为 20、40、105000 毫秒、32。搜索和网页读取上限仍各为 8。配置读取和待接纳请求也有总数 32 的保护上限。

`GET /health` 提供 `configured`、`config_source`、`config_revision`、`config_status`、模型名称和搜索是否可用，均不返回密钥或地址。配置无效、缺失或暂时不可读会阻止新执行；日志只记录安全错误码。

## 兼容旧部署

`TADA_RUNTIME_CONFIG` 未设置或为 `disabled` 时，仍在启动时读取 Pi 自身环境变量，不访问后台配置接口。修改此模式的环境配置需要重启 Pi。其他取值会拒绝启动，避免配置拼写错误导致选错来源。

`MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY` 作为一组解析；部分配置不借用 `DEEPSEEK_API_KEY`。显式指定私网模型地址和模型名称时，可不填 Key；Pi 为 SDK 使用固定的非秘密占位值 `local-no-auth`，只会将它发送到经过验证的私有模型地址。支持本机、RFC1918/ULA 私网及 `ollama`、`vllm`、`lmstudio` 等内部服务名。公网模型仍必须有自己的 Key。

搜索仍只访问 DeepSeek 官方 Search/Fetch 地址。自建本地模型不会自动获得官方部署的搜索 Key；若另行启用外部搜索，搜索词会发送给该外部供应商。模型和搜索 Key 不进入模型提示词、业务工具参数、执行结果或健康检查。

## 本地验证

`pnpm test` 覆盖无 Key 启动、真实本机 HTTP 服务、配置版本切换、删除凭据、读取失败、响应与地址边界、局部模型配置隔离、运行限制和日志脱敏。测试只使用本机服务与模拟响应，不访问真实模型或产生 API 费用。
