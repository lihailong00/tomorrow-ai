use std::{env, time::Duration};

use reqwest::{Client, Url, header, redirect::Policy};
use serde::{Deserialize, Serialize};

use crate::{DomainError, Repository, dto::Message, usage::{UsageDispatch, UsageIdentity, UsageMeasurements, UsageOutcome}};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";
const DEEPSEEK_MODEL: &str = "deepseek-flash";
const RESPONSE_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const SYSTEM_INSTRUCTION: &str = "你是妥啦手机助手。请用清晰、简洁的中文回答。只依据提供的对话和用户记忆作答；没有工具执行结果时，不得声称已经浏览网页、读取邮件、创建日程、发送消息或完成其他外部操作。不要虚构引用、事实、权限或操作结果。";

/// Per-request choice. Keep the wire values identical to the mobile/Pi contract.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    #[default]
    Off,
    Low,
    High,
    Max,
}

impl ReasoningEffort {
    pub fn is_off(&self) -> bool { *self == Self::Off }

    pub fn max_tokens(self) -> u32 {
        match self { Self::Off => 4096, Self::Low => 8192, Self::High => 16384, Self::Max => 32768 }
    }

    fn provider_value(self) -> Option<&'static str> {
        match self { Self::Off => None, Self::Low => Some("low"), Self::High => Some("high"), Self::Max => Some("max") }
    }
}

#[cfg(test)]
mod probe_tests;
#[cfg(test)]
mod stream_tests;
#[cfg(test)]
mod reasoning_tests;
#[cfg(test)]
mod usage_tests;

/// Owner and initiating feature are supplied by the authenticated caller, never the model.
#[derive(Clone)]
pub struct UsageContext {
    pub repository: Repository,
    pub user_id: String,
    pub purpose: String,
    pub request_prefix: String,
}

impl UsageContext {
    pub fn new(repository: Repository, user_id: impl Into<String>, purpose: impl Into<String>, request_prefix: impl Into<String>) -> Self {
        Self { repository, user_id: user_id.into(), purpose: purpose.into(), request_prefix: request_prefix.into() }
    }
}

// Deliberately no Debug implementation: provider credentials must not enter logs.
#[derive(Clone)]
pub struct LlmProvider {
    client: Option<Client>,
    base_url: String,
    api_key: Option<String>,
    model: Option<String>,
    remote_intent: bool,
    kind: ProviderKind,
    usage: Option<UsageContext>,
}

#[derive(Clone, Copy)]
enum ProviderKind {
    Compatible,
    DeepSeek,
}

impl ProviderKind {
    fn name(self) -> &'static str {
        match self {
            Self::Compatible => "openai-compatible",
            Self::DeepSeek => "deepseek",
        }
    }

    fn key_variable(self) -> &'static str {
        match self {
            Self::Compatible => "MODEL_API_KEY",
            Self::DeepSeek => "DEEPSEEK_API_KEY",
        }
    }

    fn model_variable(self) -> &'static str {
        match self {
            Self::Compatible => "MODEL_NAME",
            Self::DeepSeek => "DEEPSEEK_MODEL",
        }
    }
}

// Intentionally no Debug implementation: resolved settings contain a secret.
struct ModelSettings {
    base_url: String,
    api_key: Option<String>,
    model: Option<String>,
    remote_intent: bool,
    kind: ProviderKind,
}

/// Resolve one provider as an indivisible configuration. A partially configured
/// MODEL_* provider must never borrow a DEEPSEEK_API_KEY for its custom endpoint.
/// Injecting the lookup keeps resolution pure and independently testable.
fn settings_from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> ModelSettings {
    let base_url = nonempty(lookup("MODEL_BASE_URL"));
    let mut api_key = nonempty(lookup("MODEL_API_KEY"));
    let model = nonempty(lookup("MODEL_NAME"));
    if base_url.is_some() || api_key.is_some() || model.is_some() {
        // A keyless local model is opt-in through both explicit MODEL_BASE_URL
        // and MODEL_NAME. Never borrow a cloud key for a different endpoint.
        if api_key.is_none()
            && model.is_some()
            && base_url
                .as_ref()
                .is_some_and(|base| private_model_url(base))
        {
            api_key = Some("local-no-auth".into());
        }
        return ModelSettings {
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()),
            api_key,
            model,
            remote_intent: true,
            kind: ProviderKind::Compatible,
        };
    }

    let api_key = nonempty(lookup("DEEPSEEK_API_KEY"));
    let base_url = nonempty(lookup("DEEPSEEK_BASE_URL"));
    let model = nonempty(lookup("DEEPSEEK_MODEL"));
    let remote_intent = api_key.is_some() || base_url.is_some() || model.is_some();
    ModelSettings {
        base_url: base_url.unwrap_or_else(|| DEEPSEEK_BASE_URL.into()),
        api_key,
        model: remote_intent.then(|| model.unwrap_or_else(|| DEEPSEEK_MODEL.into())),
        remote_intent,
        kind: ProviderKind::DeepSeek,
    }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub struct ModelReply {
    pub content: String,
    pub mode: String,
    pub provider: Option<String>,
}

/// Deliberately contains no provider response, endpoint, request, or credential.
#[derive(Serialize)]
pub struct ModelProbe {
    pub ok: bool,
    pub code: &'static str,
    pub message: &'static str,
    pub elapsed_ms: u64,
    pub upstream_status: Option<u16>,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl LlmProvider {
    /// One bounded completion with no tools, user data or retries.
    pub async fn probe_connection(&self) -> ModelProbe {
        let start = std::time::Instant::now();
        let mut result = ModelProbe {
            ok: false, code: "not_configured", message: "请先选择模型并配置对应服务商的 API Key。",
            elapsed_ms: 0, upstream_status: None, model: self.model.clone(), input_tokens: None, output_tokens: None,
        };
        if !self.is_configured() { return result; }
        let Ok(endpoint) = completion_endpoint(&self.base_url) else { return result; };
        let client = Client::builder().connect_timeout(Duration::from_secs(7))
            .timeout(Duration::from_secs(25)).redirect(Policy::none()).build();
        let Ok(client) = client else {
            result.code = "connection_failed"; result.message = "无法初始化安全连接，请稍后重试。"; return result;
        };
        let mut body = serde_json::json!({
            "model": self.model.as_deref().unwrap_or_default(),
            "messages": [{"role":"user","content":"Reply OK."}],
            "max_tokens": 128, "stream": false
        });
        if endpoint.host_str() == Some("api.deepseek.com") && self.model.as_deref() == Some("deepseek-flash") {
            body["thinking"] = serde_json::json!({"type":"disabled"});
        }
        let request_id = match self.dispatch_usage().await {
            Ok(id) => id,
            Err(_) => { result.code = "usage_unavailable"; result.message = "用量记录暂不可用，请稍后重试。"; return result; }
        };
        let mut measurements = UsageMeasurements::default();
        let response = client.post(endpoint).bearer_auth(self.api_key.as_deref().unwrap_or_default())
            .json(&body).send().await;
        match response {
            Err(error) => {
                result.code = if error.is_timeout() { "timeout" } else { "connection_failed" };
                result.message = if error.is_timeout() { "模型服务响应超时，请稍后重试。" } else { "无法连接模型服务，请检查网络、服务地址或证书。" };
            }
            Ok(mut response) => {
                let status = response.status().as_u16();
                result.upstream_status = Some(status);
                if !response.status().is_success() {
                    (result.code, result.message) = match status {
                        300..=399 => ("redirect_blocked", "服务返回了重定向，已停止测试以保护密钥。"),
                        401 | 403 => ("authentication_failed", "密钥无效或权限不足，请确认该账号已开通所选模型。"),
                        402 => ("quota_exhausted", "服务商账户余额或可用额度不足。"),
                        404 => ("model_not_found", "模型或接口不存在，请核对所选服务商和模型。"),
                        429 => ("upstream_rate_limited", "服务商限流或额度不足，请稍后重试。"),
                        400 | 422 => ("request_rejected", "服务商未接受测试请求，请检查模型和接口兼容性。"),
                        _ => ("upstream_error", "模型服务暂时不可用，请稍后重试。"),
                    };
                    let mut bytes = Vec::new();
                    while let Ok(Some(chunk)) = response.chunk().await {
                        if bytes.len().saturating_add(chunk.len()) > 64 * 1024 { break; }
                        bytes.extend_from_slice(&chunk);
                    }
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        measurements = compatible_usage(value.get("usage"));
                    }
                } else {
                    result.code = "invalid_response"; result.message = "接口可访问，但未返回有效的模型响应。";
                    let mut bytes = Vec::new();
                    loop {
                        match response.chunk().await {
                            Ok(Some(chunk)) if bytes.len() + chunk.len() <= 64 * 1024 => bytes.extend_from_slice(&chunk),
                            Ok(None) => {
                                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                    measurements = compatible_usage(value.get("usage"));
                                    let message = value.pointer("/choices/0/message");
                                    let generated = message.is_some_and(|message| {
                                        ["content", "reasoning_content"].iter().any(|key| message.get(key).and_then(|v| v.as_str()).is_some_and(|v| !v.is_empty())) ||
                                        message.get("role").and_then(|v| v.as_str()) == Some("assistant") && value.pointer("/choices/0/finish_reason").and_then(|v| v.as_str()) == Some("length")
                                    });
                                    if generated && value.get("error").is_none() {
                                        result.ok = true; result.code = "connected"; result.message = "连接成功，模型已响应。";
                                        result.input_tokens = value.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64());
                                        result.output_tokens = value.pointer("/usage/completion_tokens").and_then(|v| v.as_u64());
                                    }
                                }
                                break;
                            }
                            Err(error) => {
                                if error.is_timeout() { result.code = "timeout"; result.message = "读取模型响应超时，请稍后重试。"; }
                                break;
                            }
                            _ => break,
                        }
                    }
                }
            }
        }
        if self.finish_usage(&request_id, if result.ok { "succeeded" } else { "failed" }, measurements).await.is_err() {
            result.ok = false; result.code = "usage_unavailable"; result.message = "模型已响应，用量结果暂未完整保存。";
        }
        result.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        result
    }
}

impl LlmProvider {
    /// An explicit offline provider for demos and tests; never reads environment values.
    pub fn local() -> Self {
        Self {
            client: None,
            base_url: DEFAULT_BASE_URL.into(),
            api_key: None,
            model: None,
            remote_intent: false,
            kind: ProviderKind::Compatible,
            usage: None,
        }
    }

    pub fn from_env() -> Self {
        // Pi owns provider credentials and the model loop in the split backend.
        if env::var("AGENT_MODE").as_deref() == Ok("pi") {
            return Self::local();
        }
        Self::from_lookup(|name| env::var(name).ok())
    }

    /// A request pins one validated configuration; never changes process environment.
    pub fn from_lookup(lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let settings = settings_from_lookup(lookup);
        if !settings.remote_intent {
            return Self::local();
        }
        let mut provider = Self::from_settings(settings.base_url, settings.api_key, settings.model);
        provider.kind = settings.kind;
        provider
    }

    pub fn is_configured(&self) -> bool {
        self.api_key.as_ref().is_some_and(|key| {
            !key.is_empty() && header::HeaderValue::from_str(&format!("Bearer {key}")).is_ok()
        }) && self
            .model
            .as_ref()
            .is_some_and(|model| !model.trim().is_empty())
            && completion_endpoint(&self.base_url).is_ok()
            && self.client.is_some()
    }

    /// Distinguishes an intended remote configuration from explicit local mode.
    /// An incomplete remote configuration must fail rather than silently run locally.
    pub fn mode(&self) -> &'static str {
        if self.remote_intent { "llm" } else { "local" }
    }

    pub fn model_name(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn provider_name(&self) -> Option<&str> {
        self.remote_intent.then(|| self.kind.name())
    }

    pub fn with_usage(&self, context: UsageContext) -> Self {
        let mut provider = self.clone();
        provider.usage = Some(context);
        provider
    }

    async fn dispatch_usage(&self) -> Result<Option<String>, DomainError> {
        let Some(context) = &self.usage else { return Ok(None); };
        let request_id = format!("{}:{}", context.request_prefix, crate::new_id());
        let model = self.model.as_deref().unwrap_or("unknown");
        context.repository.usage_dispatch(&context.user_id, UsageDispatch::new(
            &request_id, UsageIdentity::new(&self.base_url, model, model, self.kind.name()), "llm", &context.purpose,
        )).await?;
        Ok(Some(request_id))
    }

    async fn finish_usage(&self, request_id: &Option<String>, status: &str, measurements: UsageMeasurements) -> Result<(), DomainError> {
        if let (Some(context), Some(request_id)) = (&self.usage, request_id) {
            context.repository.usage_finish(&context.user_id, request_id, UsageOutcome::new(status, measurements)).await?;
        }
        Ok(())
    }

    pub async fn complete(&self, messages: &[Message]) -> Result<ModelReply, DomainError> {
        self.complete_inner(messages, None).await
    }

    pub async fn complete_with_reasoning(&self, messages: &[Message], effort: ReasoningEffort) -> Result<ModelReply, DomainError> {
        self.complete_inner(messages, Some(effort)).await
    }

    fn reasoning_fields(&self, effort: Option<ReasoningEffort>) -> Result<(Option<serde_json::Value>, Option<&'static str>, Option<u32>), DomainError> {
        let Some(effort) = effort else { return Ok((None, None, None)); };
        let endpoint = completion_endpoint(&self.base_url)?;
        let supported = endpoint.host_str() == Some("api.deepseek.com") &&
            matches!(endpoint.path(), "/chat/completions" | "/v1/chat/completions") &&
            matches!(self.model.as_deref(), Some("deepseek-flash" | "deepseek-v4-pro"));
        if !supported {
            if !effort.is_off() { return Err(DomainError::Validation("当前模型不支持所选思考档位，请关闭思考或在后台选择 DeepSeek。".into())); }
            return Ok((None, None, None));
        }
        Ok((Some(serde_json::json!({"type": if effort.is_off() { "disabled" } else { "enabled" }})),
            effort.provider_value(), Some(effort.max_tokens())))
    }

    async fn complete_inner(&self, messages: &[Message], effort: Option<ReasoningEffort>) -> Result<ModelReply, DomainError> {
        if messages.is_empty() {
            return Err(DomainError::Validation("消息不能为空".into()));
        }

        if !self.remote_intent {
            if effort.is_some_and(|value| !value.is_off()) {
                return Err(DomainError::Validation("请先在后台配置支持思考的 DeepSeek 模型。".into()));
            }
            return Ok(local_reply(messages));
        }
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            DomainError::External(format!("模型服务缺少 {} 配置", self.kind.key_variable()))
        })?;
        let model = self.model.as_deref().ok_or_else(|| {
            DomainError::External(format!("模型服务缺少 {} 配置", self.kind.model_variable()))
        })?;
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| DomainError::Internal("无法初始化模型服务连接".into()))?;
        let endpoint = completion_endpoint(&self.base_url)?;
        let (thinking, reasoning_effort, max_tokens) = self.reasoning_fields(effort)?;
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| DomainError::External("模型服务凭证配置无效".into()))?;
        authorization.set_sensitive(true);

        let mut provider_messages = Vec::with_capacity(messages.len() + 1);
        provider_messages.push(ProviderMessage {
            role: "system",
            content: SYSTEM_INSTRUCTION,
        });
        for message in messages {
            if !matches!(message.role.as_str(), "user" | "assistant" | "system") {
                return Err(DomainError::Validation("消息角色无效".into()));
            }
            provider_messages.push(ProviderMessage {
                role: &message.role,
                content: &message.content,
            });
        }

        // Do not retry generation here: durable retries belong to the task executor.
        let request_id = self.dispatch_usage().await?;
        let mut measurements = UsageMeasurements::default();
        let result = async {
        let mut response = client
            .post(endpoint)
            .header(header::AUTHORIZATION, authorization)
            .json(&CompletionRequest {
                model,
                messages: provider_messages,
                stream: false,
                stream_options: None,
                thinking, reasoning_effort, max_tokens,
            })
            .timeout(Duration::from_secs(if effort.is_some_and(|value| !value.is_off()) { crate::agent::AGENT_EXECUTION_TIMEOUT_SECONDS } else { 60 }))
            .send()
            .await
            .map_err(model_transport_error)?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT_BYTES as u64)
        {
            return Err(DomainError::External("模型回复超过大小限制".into()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(model_transport_error)? {
            if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT_BYTES {
                return Err(DomainError::External("模型回复超过大小限制".into()));
            }
            body.extend_from_slice(&chunk);
        }
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
            measurements = compatible_usage(value.get("usage"));
        }
        // Preserve consumed usage even if content validation below rejects the response.
        self.finish_usage(&request_id, if status.is_success() { "succeeded" } else { "failed" }, measurements.clone()).await?;
        if !status.is_success() {
            return Err(DomainError::External(format!("模型服务返回错误（HTTP {}）", status.as_u16())));
        }
        let completion: CompletionResponse = serde_json::from_slice(&body)
            .map_err(|_| DomainError::External("模型服务返回了无效的回复格式".into()))?;
        let content = completion
            .choices
            .into_iter()
            .next()
            .and_then(|choice| choice.message.content)
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| DomainError::External("模型服务未返回可显示的文本".into()))?;

        Ok(ModelReply {
            content,
            mode: "llm".into(),
            provider: Some(self.kind.name().into()),
        })
        }.await;
        self.finish_usage(&request_id, if result.is_ok() { "succeeded" } else { "failed" }, measurements).await?;
        result
    }

    /// Forward only visible upstream content as it arrives. Awaiting the callback
    /// lets the caller durably checkpoint each delta before consuming more data.
    /// Local demonstrations have no upstream deltas and return their reply once.
    pub async fn complete_stream<F, Fut>(
        &self,
        messages: &[Message],
        on_delta: F,
    ) -> Result<ModelReply, DomainError>
    where
        F: FnMut(String) -> Fut,
        Fut: std::future::Future<Output = Result<(), DomainError>>,
    {
        self.complete_stream_inner(messages, on_delta, None).await
    }

    pub async fn complete_stream_with_reasoning<F, Fut>(&self, messages: &[Message], effort: ReasoningEffort, on_delta: F) -> Result<ModelReply, DomainError>
    where F: FnMut(String) -> Fut, Fut: std::future::Future<Output = Result<(), DomainError>> {
        self.complete_stream_inner(messages, on_delta, Some(effort)).await
    }

    async fn complete_stream_inner<F, Fut>(&self, messages: &[Message], mut on_delta: F, effort: Option<ReasoningEffort>) -> Result<ModelReply, DomainError>
    where F: FnMut(String) -> Fut, Fut: std::future::Future<Output = Result<(), DomainError>> {
        if messages.is_empty() {
            return Err(DomainError::Validation("消息不能为空".into()));
        }
        if !self.remote_intent {
            if effort.is_some_and(|value| !value.is_off()) {
                return Err(DomainError::Validation("请先在后台配置支持思考的 DeepSeek 模型。".into()));
            }
            return Ok(local_reply(messages));
        }
        let api_key = self.api_key.as_deref().ok_or_else(|| {
            DomainError::External(format!("模型服务缺少 {} 配置", self.kind.key_variable()))
        })?;
        let model = self.model.as_deref().ok_or_else(|| {
            DomainError::External(format!("模型服务缺少 {} 配置", self.kind.model_variable()))
        })?;
        let client = self
            .client
            .as_ref()
            .ok_or_else(|| DomainError::Internal("无法初始化模型服务连接".into()))?;
        let endpoint = completion_endpoint(&self.base_url)?;
        let (thinking, reasoning_effort, max_tokens) = self.reasoning_fields(effort)?;
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|_| DomainError::External("模型服务凭证配置无效".into()))?;
        authorization.set_sensitive(true);
        let mut provider_messages = vec![ProviderMessage {
            role: "system",
            content: SYSTEM_INSTRUCTION,
        }];
        for message in messages {
            if !matches!(message.role.as_str(), "user" | "assistant" | "system") {
                return Err(DomainError::Validation("消息角色无效".into()));
            }
            provider_messages.push(ProviderMessage {
                role: &message.role,
                content: &message.content,
            });
        }
        // No generation retries: a disconnect must not start a second model run.
        let request_id = self.dispatch_usage().await?;
        let mut measurements = UsageMeasurements::default();
        let result = async {
        let mut response = client
            .post(endpoint)
            .header(header::AUTHORIZATION, authorization)
            .json(&CompletionRequest {
                model,
                messages: provider_messages,
                stream: true,
                stream_options: Some(serde_json::json!({"include_usage": true})),
                thinking, reasoning_effort, max_tokens,
            })
            .timeout(Duration::from_secs(if effort.is_some_and(|value| !value.is_off()) { crate::agent::AGENT_EXECUTION_TIMEOUT_SECONDS } else { 60 }))
            .send()
            .await
            .map_err(model_transport_error)?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(model_transport_error)? {
                if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT_BYTES { break; }
                body.extend_from_slice(&chunk);
            }
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
                measurements = compatible_usage(value.get("usage"));
            }
            return Err(DomainError::External(format!(
                "模型服务返回错误（HTTP {}）",
                status
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT_BYTES as u64)
        {
            return Err(DomainError::External("模型回复超过大小限制".into()));
        }
        let mut decoder = CompletionStreamDecoder::default();
        let mut total_bytes = 0usize;
        let mut content = String::new();
        let mut content_chars = 0usize;
        let mut finished = false;
        'response: while let Some(chunk) = response.chunk().await.map_err(model_transport_error)? {
            total_bytes = total_bytes.saturating_add(chunk.len());
            if total_bytes > RESPONSE_LIMIT_BYTES {
                return Err(DomainError::External("模型回复超过大小限制".into()));
            }
            let events = decoder.push(&chunk)?;
            // Capture final usage already received in this network chunk before an
            // application callback can reject a delta and stop content processing.
            for event in &events {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(event) {
                    if value.get("error").is_some() && value.get("usage").is_some() {
                        measurements = compatible_usage(value.get("usage"));
                        self.finish_usage(&request_id, "failed", measurements.clone()).await?;
                    }
                }
                if let Ok(update) = completion_stream_update(event) {
                    if let Some(usage) = update.usage {
                        measurements = usage;
                        self.finish_usage(&request_id, "succeeded", measurements.clone()).await?;
                    }
                }
            }
            for event in events {
                let update = completion_stream_update(&event)?;
                if let Some(delta) = update.delta.filter(|value| !value.is_empty()) {
                    content_chars = content_chars.saturating_add(delta.chars().count());
                    if content_chars > 60000 {
                        return Err(DomainError::External("模型回复超过大小限制".into()));
                    }
                    content.push_str(&delta);
                    on_delta(delta).await?;
                }
                if update.finished {
                    finished = true;
                }
                // finish_reason precedes OpenAI's usage-only chunk. Only DONE ends reading.
                if update.done {
                    break 'response;
                }
            }
        }
        if !finished {
            return Err(DomainError::External(
                "模型回复连接中断；已收到的内容已保留".into(),
            ));
        }
        if content.trim().is_empty() {
            return Err(DomainError::External("模型服务未返回可显示的文本".into()));
        }
        Ok(ModelReply {
            content,
            mode: "llm".into(),
            provider: Some(self.kind.name().into()),
        })
        }.await;
        self.finish_usage(&request_id, if result.is_ok() { "succeeded" } else { "failed" }, measurements).await?;
        result
    }

    pub fn from_settings(base_url: String, api_key: Option<String>, model: Option<String>) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(Policy::none())
            .build()
            .ok();
        Self {
            client,
            base_url: base_url.trim().to_owned(),
            api_key: nonempty(api_key),
            model: nonempty(model),
            remote_intent: true,
            kind: ProviderKind::Compatible,
            usage: None,
        }
    }
}

/// Parse SSE at byte boundaries, never decoding an incomplete UTF-8 chunk.
/// Keeping only one unfinished event also bounds providers that omit newlines.
#[derive(Default)]
struct CompletionStreamDecoder {
    pending: Vec<u8>,
    data: String,
}

impl CompletionStreamDecoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, DomainError> {
        const MAX_EVENT_BYTES: usize = 128 * 1024;
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        let mut consumed = 0;
        while let Some(offset) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + offset;
            let line = self.pending[consumed..end]
                .strip_suffix(b"\r")
                .unwrap_or(&self.pending[consumed..end]);
            let line = std::str::from_utf8(line)
                .map_err(|_| DomainError::External("模型服务返回了无效的回复格式".into()))?;
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(std::mem::take(&mut self.data));
                }
            } else if let Some(data) = line.strip_prefix("data:") {
                let data = data.strip_prefix(' ').unwrap_or(data);
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(data);
                if self.data.len() > MAX_EVENT_BYTES {
                    return Err(DomainError::External("模型流事件超过大小限制".into()));
                }
            }
            consumed = end + 1;
        }
        self.pending.drain(..consumed);
        if self.pending.len().saturating_add(self.data.len()) > MAX_EVENT_BYTES {
            return Err(DomainError::External("模型流事件超过大小限制".into()));
        }
        Ok(events)
    }
}

struct CompletionStreamUpdate {
    delta: Option<String>,
    finished: bool,
    done: bool,
    usage: Option<UsageMeasurements>,
}

fn completion_stream_update(data: &str) -> Result<CompletionStreamUpdate, DomainError> {
    if data.trim() == "[DONE]" {
        return Ok(CompletionStreamUpdate {
            delta: None,
            finished: true,
            done: true,
            usage: None,
        });
    }
    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|_| DomainError::External("模型服务返回了无效的回复格式".into()))?;
    if value.get("error").is_some() || !value.get("choices").is_some_and(|v| v.is_array()) {
        return Err(DomainError::External("模型服务返回了无效的回复格式".into()));
    }
    let choice = value.pointer("/choices/0");
    let delta = choice
        .and_then(|v| v.pointer("/delta/content"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let finished = choice
        .and_then(|v| v.get("finish_reason"))
        .is_some_and(|v| !v.is_null());
    // reasoning_content, tool arguments, and every other field remain private.
    let final_usage = finished || value.get("choices").and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty);
    let usage = value.get("usage").filter(|value| final_usage && value.is_object()).map(|value| compatible_usage(Some(value)));
    Ok(CompletionStreamUpdate { delta, finished, done: false, usage })
}

/// Compatible prompt_tokens already includes cache subsets (unlike Pi Usage.input).
fn compatible_usage(value: Option<&serde_json::Value>) -> UsageMeasurements {
    let count = |value: Option<&serde_json::Value>| value.and_then(serde_json::Value::as_i64).filter(|value| (0..=9_007_199_254_740_991).contains(value));
    let Some(value) = value else { return UsageMeasurements::default(); };
    let input = count(value.get("prompt_tokens"));
    let cache_read = value.pointer("/prompt_tokens_details/cached_tokens").or_else(|| value.get("prompt_cache_hit_tokens")).or_else(|| value.get("cached_tokens"));
    let cache_write = value.pointer("/prompt_tokens_details/cache_write_tokens");
    UsageMeasurements {
        input_tokens: input,
        output_tokens: count(value.get("completion_tokens")),
        // A positive prompt total does not prove either cache subset is zero.
        // Only a measured zero input mathematically forces missing subsets to zero.
        cache_read_tokens: cache_read.map_or_else(|| input.filter(|input| *input == 0), |value| count(Some(value))),
        cache_write_tokens: cache_write.map_or_else(|| input.filter(|input| *input == 0), |value| count(Some(value))),
        ..Default::default()
    }
}

#[derive(Serialize)]
struct CompletionRequest<'a> {
    model: &'a str,
    messages: Vec<ProviderMessage<'a>>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Serialize)]
struct ProviderMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct CompletionResponse {
    choices: Vec<CompletionChoice>,
}

#[derive(Deserialize)]
struct CompletionChoice {
    message: CompletionMessage,
}

#[derive(Deserialize)]
struct CompletionMessage {
    content: Option<String>,
}

fn completion_endpoint(base_url: &str) -> Result<Url, DomainError> {
    let mut url =
        Url::parse(base_url).map_err(|_| DomainError::External("模型服务地址配置无效".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.scheme() == "http" && !url.host_str().is_some_and(private_service_host))
    {
        return Err(DomainError::External(
            "模型服务地址须为不含凭证、查询参数和片段的 HTTPS 或内网 HTTP 地址".into(),
        ));
    }
    let path = format!("{}/chat/completions", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// Private hosts are allowed only for administrator-selected inference services.
/// This is not an allowlist for web fetching, redirects, or model-supplied URLs.
pub fn private_service_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if [
        "localhost",
        "api",
        "backend",
        "tomorrow-api",
        "host.docker.internal",
        "ollama",
        "vllm",
        "lmstudio",
    ]
    .contains(&host.as_str())
    {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => false,
    }
}

fn private_model_url(base: &str) -> bool {
    Url::parse(base).is_ok_and(|url| {
        ["http", "https"].contains(&url.scheme())
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.host_str().is_some_and(private_service_host)
    })
}

fn model_transport_error(error: reqwest::Error) -> DomainError {
    let message = if error.is_timeout() {
        "模型服务响应超时，请稍后重试"
    } else if error.is_connect() {
        "无法连接模型服务，请检查服务配置"
    } else {
        "模型服务请求失败，请稍后重试"
    };
    DomainError::External(message.into())
}

fn local_reply(messages: &[Message]) -> ModelReply {
    let input = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.chars().take(200).collect::<String>())
        .unwrap_or_else(|| "（暂无用户消息）".into());
    ModelReply {
        content: format!(
            "当前为本地演示模式，未调用 AI 模型，也未访问网页、邮件或日历。\n\n你的输入：{input}\n\n本回复仅用于演示对话功能，不表示已经执行任何任务。你可以在应用中手动创建记忆、任务和自动化；启用模型服务后可使用真实 AI 回复。"
        ),
        mode: "local".into(),
        provider: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc::{self, Receiver},
        thread,
    };

    fn message(role: &str, content: &str) -> Message {
        Message {
            id: "message-test".into(),
            conversation_id: "conversation-test".into(),
            role: role.into(),
            content: content.into(),
            created_at: "2026-10-26T00:00:00Z".into(),
            model_mode: None,
            attachments: Vec::new(),
        }
    }

    fn settings(values: &[(&str, &str)]) -> ModelSettings {
        settings_from_lookup(|name| {
            values
                .iter()
                .find_map(|(key, value)| (*key == name).then(|| (*value).to_owned()))
        })
    }

    fn provider_from_values(values: &[(&str, &str)]) -> LlmProvider {
        let settings = settings(values);
        if !settings.remote_intent {
            return LlmProvider::local();
        }
        let mut provider =
            LlmProvider::from_settings(settings.base_url, settings.api_key, settings.model);
        provider.kind = settings.kind;
        provider
    }

    #[test]
    fn explicit_compatible_settings_win_without_even_reading_deepseek_credentials() {
        let settings = settings_from_lookup(|name| match name {
            "MODEL_BASE_URL" => Some(" https://custom.example/v1/ ".into()),
            "MODEL_API_KEY" => Some("generic-test-credential".into()),
            "MODEL_NAME" => Some("custom-model".into()),
            _ => panic!("explicit compatible settings must not inspect another provider"),
        });
        assert!(settings.remote_intent);
        assert_eq!(settings.base_url, "https://custom.example/v1/");
        assert_eq!(settings.api_key.as_deref(), Some("generic-test-credential"));
        assert_eq!(settings.model.as_deref(), Some("custom-model"));
        assert_eq!(settings.kind.name(), "openai-compatible");
    }

    #[test]
    fn deepseek_key_selects_default_flash_endpoint_and_model() {
        let provider = provider_from_values(&[("DEEPSEEK_API_KEY", "deepseek-test-credential")]);
        assert_eq!(provider.mode(), "llm");
        assert!(provider.is_configured());
        assert_eq!(provider.base_url, "https://api.deepseek.com");
        assert_eq!(provider.model_name(), Some("deepseek-flash"));
        assert_eq!(provider.provider_name(), Some("deepseek"));
        assert_eq!(
            completion_endpoint(&provider.base_url).unwrap().as_str(),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn deepseek_specific_overrides_stay_with_the_deepseek_provider() {
        let provider = provider_from_values(&[
            ("DEEPSEEK_API_KEY", "deepseek-test-credential"),
            ("DEEPSEEK_BASE_URL", " https://deepseek-proxy.example/v1/ "),
            ("DEEPSEEK_MODEL", " custom-flash "),
        ]);
        assert_eq!(provider.base_url, "https://deepseek-proxy.example/v1/");
        assert_eq!(provider.model_name(), Some("custom-flash"));
        assert_eq!(provider.provider_name(), Some("deepseek"));
    }

    #[test]
    fn empty_values_do_not_select_an_incomplete_provider() {
        let empty_values = [
            ("MODEL_BASE_URL", " "),
            ("MODEL_API_KEY", "\t"),
            ("MODEL_NAME", ""),
            ("DEEPSEEK_API_KEY", "\n"),
            ("DEEPSEEK_BASE_URL", " "),
            ("DEEPSEEK_MODEL", ""),
        ];
        let provider = provider_from_values(&empty_values);
        assert_eq!(provider.mode(), "local");
        assert!(provider.model_name().is_none());
        assert!(provider.provider_name().is_none());
        let mut with_key = empty_values.to_vec();
        with_key.retain(|(name, _)| *name != "DEEPSEEK_API_KEY");
        with_key.push(("DEEPSEEK_API_KEY", "deepseek-test-credential"));
        let provider = provider_from_values(&with_key);
        assert!(provider.is_configured());
        assert_eq!(provider.provider_name(), Some("deepseek"));
    }

    #[tokio::test]
    async fn partial_compatible_configuration_never_borrows_deepseek_credentials() {
        for values in [
            vec![
                ("MODEL_BASE_URL", "https://other-provider.example/v1"),
                ("DEEPSEEK_API_KEY", "deepseek-test-credential"),
            ],
            vec![
                ("MODEL_NAME", "other-model"),
                ("DEEPSEEK_API_KEY", "deepseek-test-credential"),
            ],
        ] {
            let provider = provider_from_values(&values);
            assert_eq!(provider.mode(), "llm");
            assert_eq!(provider.provider_name(), Some("openai-compatible"));
            assert!(!provider.is_configured());
            assert!(provider.api_key.is_none());
            let error = match provider.complete(&[message("user", "hello")]).await {
                Err(error) => error.to_string(),
                Ok(_) => panic!("missing compatible credentials must not fall back"),
            };
            assert!(error.contains("MODEL_API_KEY"));
            assert!(!error.contains("deepseek-test-credential"));
        }
    }

    #[tokio::test]
    async fn generic_key_without_generic_model_does_not_borrow_deepseek_defaults() {
        let provider = provider_from_values(&[
            ("MODEL_API_KEY", "generic-test-credential"),
            ("DEEPSEEK_API_KEY", "deepseek-test-credential"),
            ("DEEPSEEK_MODEL", "deepseek-flash"),
        ]);
        assert_eq!(provider.base_url, DEFAULT_BASE_URL);
        assert!(provider.model_name().is_none());
        assert_eq!(provider.api_key.as_deref(), Some("generic-test-credential"));
        let error = match provider.complete(&[message("user", "hello")]).await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("missing compatible model must remain an error"),
        };
        assert!(error.contains("MODEL_NAME"));
    }

    #[tokio::test]
    async fn deepseek_override_without_key_is_an_error_and_never_local_demo() {
        let provider = provider_from_values(&[("DEEPSEEK_MODEL", "deepseek-flash")]);
        assert_eq!(provider.mode(), "llm");
        assert!(!provider.is_configured());
        let error = match provider.complete(&[message("user", "hello")]).await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("incomplete DeepSeek settings must remain an error"),
        };
        assert!(error.contains("DEEPSEEK_API_KEY"));
    }

    fn mock_server(status: &str, response_body: &str) -> (String, Receiver<serde_json::Value>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let response_body = response_body.to_owned();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let (header_end, content_length) = loop {
                let length = socket.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                request.extend_from_slice(&buffer[..length]);
                if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    break (header_end + 4, content_length);
                }
            };
            while request.len() < header_end + content_length {
                let length = socket.read(&mut buffer).unwrap();
                assert_ne!(length, 0);
                request.extend_from_slice(&buffer[..length]);
            }
            let payload =
                serde_json::from_slice(&request[header_end..header_end + content_length]).unwrap();
            sender.send(payload).unwrap();
            write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            )
            .unwrap();
        });
        (format!("http://{address}/v1"), receiver)
    }

    #[test]
    fn endpoint_joins_paths_and_rejects_credential_bearing_urls() {
        assert_eq!(
            completion_endpoint("https://example.test/v1/")
                .unwrap()
                .as_str(),
            "https://example.test/v1/chat/completions"
        );
        assert!(completion_endpoint("https://secret@example.test/v1").is_err());
        assert!(completion_endpoint("https://example.test/v1?token=secret").is_err());
        assert!(completion_endpoint("file:///tmp/model").is_err());
    }

    #[test]
    fn administrator_inference_urls_allow_private_http_and_reject_public_http() {
        for base in [
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
            "http://192.168.0.8:8080/v1",
            "http://10.0.0.4:8080/v1",
            "http://host.docker.internal:11434/v1",
            "http://ollama:11434/v1",
            "https://public-model.example.test/v1",
        ] {
            assert!(completion_endpoint(base).is_ok(), "{base}");
        }
        for base in [
            "http://public-model.example.test/v1",
            "http://8.8.8.8/v1",
            "http://169.254.169.254/latest",
            "http://user:secret@ollama:11434/v1",
            "http://ollama:11434/v1?api_key=secret",
        ] {
            assert!(completion_endpoint(base).is_err(), "{base}");
        }
    }

    #[test]
    fn keyless_models_require_an_explicit_private_compatible_base_and_model() {
        let local = settings_from_lookup(|name| match name {
            "MODEL_BASE_URL" => Some("http://host.docker.internal:11434/v1".into()),
            "MODEL_NAME" => Some("local-model".into()),
            "DEEPSEEK_API_KEY" => Some("must-not-borrow-cloud-key".into()),
            _ => None,
        });
        assert_eq!(local.api_key.as_deref(), Some("local-no-auth"));
        assert_eq!(local.kind.name(), "openai-compatible");
        for values in [
            vec![("MODEL_BASE_URL", "http://ollama:11434/v1")],
            vec![("MODEL_NAME", "local-model")],
            vec![
                ("MODEL_BASE_URL", "https://public-model.example.test/v1"),
                ("MODEL_NAME", "model"),
            ],
            vec![
                ("DEEPSEEK_BASE_URL", "http://ollama:11434/v1"),
                ("DEEPSEEK_MODEL", "model"),
            ],
        ] {
            let settings = settings_from_lookup(|key| {
                values
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            });
            assert!(settings.api_key.is_none());
        }
    }

    #[tokio::test]
    async fn missing_key_returns_explicit_local_demo_without_network() {
        let provider = LlmProvider::local();
        assert!(!provider.is_configured());
        let reply = provider
            .complete(&[message("user", "帮我发送邮件")])
            .await
            .unwrap();
        assert_eq!(reply.mode, "local");
        assert!(reply.provider.is_none());
        assert!(reply.content.contains("未调用 AI 模型"));
        assert!(reply.content.contains("不表示已经执行任何任务"));
    }

    #[tokio::test]
    async fn incomplete_remote_configuration_is_unavailable_and_stays_an_error() {
        let provider = LlmProvider::from_settings(
            DEFAULT_BASE_URL.into(),
            Some("test-only-secret".into()),
            None,
        );
        assert!(!provider.is_configured());
        assert_eq!(provider.mode(), "llm");
        assert!(
            provider
                .complete(&[message("user", "hello")])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn configured_provider_sends_context_and_returns_real_response() {
        let (base_url, receiver) = mock_server(
            "200 OK",
            r#"{"choices":[{"message":{"content":"来自测试模型的回复"}}]}"#,
        );
        let provider = LlmProvider::from_settings(
            base_url,
            Some("test-only-secret".into()),
            Some("test-model".into()),
        );
        let reply = provider
            .complete(&[
                message("system", "用户偏好：中文短回复"),
                message("user", "今天该做什么？"),
            ])
            .await
            .unwrap();
        assert_eq!(reply.mode, "llm");
        assert_eq!(reply.content, "来自测试模型的回复");
        let payload = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(payload["model"], "test-model");
        assert_eq!(payload["stream"], false);
        assert_eq!(payload["messages"][1]["content"], "用户偏好：中文短回复");
        assert_eq!(payload["messages"][2]["role"], "user");
    }

    #[tokio::test]
    async fn deepseek_adapter_sends_flash_request_and_reports_its_provider() {
        let (base_url, receiver) = mock_server(
            "200 OK",
            r#"{"choices":[{"message":{"content":"DeepSeek 测试回复"}}]}"#,
        );
        let provider = provider_from_values(&[
            ("DEEPSEEK_BASE_URL", base_url.as_str()),
            ("DEEPSEEK_API_KEY", "deepseek-test-credential"),
        ]);
        let reply = provider
            .complete(&[message("user", "hello")])
            .await
            .unwrap();
        assert_eq!(reply.provider.as_deref(), Some("deepseek"));
        assert_eq!(reply.mode, "llm");
        let payload = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(payload["model"], "deepseek-flash");
    }

    #[tokio::test]
    async fn provider_failures_do_not_leak_body_or_fall_back_to_demo() {
        let (base_url, receiver) = mock_server(
            "401 Unauthorized",
            r#"{"error":{"message":"test-only-secret and private prompt"}}"#,
        );
        let provider = LlmProvider::from_settings(
            base_url,
            Some("test-only-secret".into()),
            Some("test-model".into()),
        );
        let error = match provider.complete(&[message("user", "hello")]).await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("a provider failure must remain an error"),
        };
        receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(error.contains("401"));
        assert!(!error.contains("test-only-secret"));
        assert!(!error.contains("private prompt"));
    }
}
