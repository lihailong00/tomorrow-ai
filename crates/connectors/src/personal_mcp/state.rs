use super::{
    catalog,
    transport::{self, Credentials},
};
use crate::{
    ConnectorError, Result,
    crypto::{Crypto, digest, random_secret},
};
use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query, State},
    http::{StatusCode, header, request::Parts},
    response::Response,
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{AnyPool, Row};
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::timeout};
use tomorrow_domain::{Repository, now, timestamp};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(40);
const TOOL_BYTES: usize = 256 * 1024;

fn storage_byte_limit(provider: &str, purpose: &str) -> usize {
    if purpose == "personal_mcp_tools" {
        catalog::discovery_limits(provider).1
    } else {
        TOOL_BYTES
    }
}
const RESULT_BYTES: usize = 96 * 1024;
const ARGUMENT_BYTES: usize = 16 * 1024;
const NOTE_ARGUMENT_BYTES: usize = 48 * 1024;
const ACTION_TTL: i64 = 600;

type RequestFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
pub(super) trait McpTransport: Send + Sync {
    fn discover<'a>(
        &'a self,
        provider: &'a str,
        credentials: &'a Credentials,
    ) -> RequestFuture<'a, Vec<Value>>;
    fn call<'a>(
        &'a self,
        provider: &'a str,
        credentials: &'a Credentials,
        tool: &'a str,
        arguments: Value,
    ) -> RequestFuture<'a, Value>;
}
struct OfficialTransport;
impl McpTransport for OfficialTransport {
    fn discover<'a>(
        &'a self,
        provider: &'a str,
        credentials: &'a Credentials,
    ) -> RequestFuture<'a, Vec<Value>> {
        Box::pin(transport::discover(provider, credentials))
    }
    fn call<'a>(
        &'a self,
        provider: &'a str,
        credentials: &'a Credentials,
        tool: &'a str,
        arguments: Value,
    ) -> RequestFuture<'a, Value> {
        Box::pin(transport::call(provider, credentials, tool, arguments))
    }
}

#[derive(Clone)]
pub struct PersonalMcpState(Arc<Inner>, Option<Arc<str>>);
struct Inner {
    repo: Repository,
    pool: AnyPool,
    crypto: Option<Crypto>,
    transport: Arc<dyn McpTransport>,
    requests: Arc<Semaphore>,
    baidu_experience_enabled: bool,
    #[cfg(test)]
    fixture_runtime: bool,
}
struct Account {
    generation: i64,
    encrypted: String,
    tools: String,
    checked: i64,
    failed: bool,
    environment: String,
}

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "连接参数无效，请检查后重试",
    )
}
fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "not_configured",
        "此 MCP 连接尚不可用，请查看连接说明或联系服务器管理员",
    )
}
fn required() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "connection_required",
        "账号连接已变化或授权已失效，请刷新后重新连接",
    )
}
fn busy() -> ConnectorError {
    ConnectorError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "操作过于频繁，请稍后再试",
    )
}
fn missing() -> ConnectorError {
    ConnectorError::new(
        StatusCode::NOT_FOUND,
        "not_found",
        "找不到此连接或待确认操作",
    )
}
fn provider_failed() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "provider_error",
        "账号校验或服务调用未成功，请检查个人授权后重试",
    )
}

impl PersonalMcpState {
    pub async fn new(repo: Repository) -> Result<Self> {
        let crypto = std::env::var("CONNECTOR_ENCRYPTION_KEY")
            .ok()
            .and_then(|v| Crypto::from_hex(&v).ok());
        Self::with_transport(repo, crypto, Arc::new(OfficialTransport)).await
    }
    pub(super) async fn with_transport(
        repo: Repository,
        crypto: Option<Crypto>,
        transport: Arc<dyn McpTransport>,
    ) -> Result<Self> {
        let pool = repo.pool();
        for sql in [
            "CREATE TABLE IF NOT EXISTS personal_mcp_accounts (user_id TEXT NOT NULL,provider TEXT NOT NULL,generation BIGINT NOT NULL DEFAULT 0,encrypted_credentials TEXT NOT NULL DEFAULT '',encrypted_tools TEXT NOT NULL DEFAULT '',checked_at BIGINT NOT NULL DEFAULT 0,last_failed BIGINT NOT NULL DEFAULT 0,environment TEXT NOT NULL DEFAULT 'production',PRIMARY KEY(user_id,provider))",
            "CREATE TABLE IF NOT EXISTS personal_mcp_actions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,generation BIGINT NOT NULL,tool TEXT NOT NULL,encrypted_arguments TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,started_at BIGINT NOT NULL DEFAULT 0,encrypted_result TEXT NOT NULL DEFAULT '')",
            "CREATE INDEX IF NOT EXISTS personal_mcp_actions_owner ON personal_mcp_actions(user_id,created_at)",
            "CREATE TABLE IF NOT EXISTS personal_mcp_requests(request_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,action_id TEXT NOT NULL,argument_hash TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS personal_mcp_rate_limits(user_id TEXT NOT NULL,bucket BIGINT NOT NULL,attempts BIGINT NOT NULL,PRIMARY KEY(user_id,bucket))",
        ] {
            sqlx::query(sql).execute(&pool).await?;
        }
        Ok(Self(Arc::new(Inner {
            repo,
            pool,
            crypto,
            transport,
            requests: Arc::new(Semaphore::new(8)),
            baidu_experience_enabled: std::env::var("BAIDU_NETDISK_EXPERIENCE_ENABLED")
                .ok()
                .is_some_and(|value| matches!(value.as_str(), "true" | "1")),
            #[cfg(test)]
            fixture_runtime: false,
        }), None))
    }
    pub fn with_tencent_docs_fixture(mut self, owner: String) -> Self {
        self.1 = Some(owner.into());
        self
    }
    pub fn uses_tencent_docs_fixture(&self, user: &str) -> bool {
        self.1.as_deref() == Some(user)
    }
    pub fn reconfigured(&self, values: &HashMap<String, String>) -> Self {
        Self(Arc::new(Inner {
            repo: self.0.repo.clone(),
            pool: self.0.pool.clone(),
            crypto: values
                .get("CONNECTOR_ENCRYPTION_KEY")
                .and_then(|v| Crypto::from_hex(v).ok()),
            transport: self.0.transport.clone(),
            requests: self.0.requests.clone(),
            baidu_experience_enabled: values
                .get("BAIDU_NETDISK_EXPERIENCE_ENABLED")
                .is_some_and(|value| matches!(value.as_str(), "true" | "1")),
            #[cfg(test)]
            fixture_runtime: self.0.fixture_runtime,
        }), self.1.clone())
    }
    fn available(&self, id: &str) -> bool {
        if id == "baidu_netdisk" && !self.0.baidu_experience_enabled {
            return false;
        }
        #[cfg(test)]
        if self.0.fixture_runtime {
            return catalog::find(id).is_ok();
        }
        catalog::runtime_available(id)
    }
    fn crypto(&self) -> Result<&Crypto> {
        self.0.crypto.as_ref().ok_or_else(unavailable)
    }
    async fn admit(&self, user: &str) -> Result<()> {
        let bucket = now() / 60;
        let row = sqlx::query("INSERT INTO personal_mcp_rate_limits(user_id,bucket,attempts) VALUES($1,$2,1) ON CONFLICT(user_id,bucket) DO UPDATE SET attempts=personal_mcp_rate_limits.attempts+1 WHERE personal_mcp_rate_limits.attempts<30 RETURNING attempts")
            .bind(user).bind(bucket).fetch_optional(&self.0.pool).await?;
        if row.is_none() {
            return Err(busy());
        }
        sqlx::query("DELETE FROM personal_mcp_rate_limits WHERE bucket<$1")
            .bind(bucket - 2)
            .execute(&self.0.pool)
            .await?;
        Ok(())
    }
    async fn account(&self, user: &str, provider: &str) -> Result<Option<Account>> {
        let row = sqlx::query("SELECT generation,encrypted_credentials,encrypted_tools,checked_at,last_failed,environment FROM personal_mcp_accounts WHERE user_id=$1 AND provider=$2").bind(user).bind(provider).fetch_optional(&self.0.pool).await?;
        row.map(|r| {
            Ok(Account {
                generation: r.try_get("generation")?,
                encrypted: r.try_get("encrypted_credentials")?,
                tools: r.try_get("encrypted_tools")?,
                checked: r.try_get("checked_at")?,
                failed: r.try_get::<i64, _>("last_failed")? != 0,
                environment: r.try_get("environment")?,
            })
        })
        .transpose()
    }
    fn encrypt(
        &self,
        user: &str,
        provider: &str,
        purpose: &str,
        value: &impl serde::Serialize,
    ) -> Result<String> {
        let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
        if bytes.len() > storage_byte_limit(provider, purpose) {
            return Err(invalid());
        }
        // Existing vault envelopes intentionally cap each item at 64KiB. Bind
        // ordered chunks to their total and index rather than relaxing that cap.
        let parts: Vec<_> = bytes.chunks(24 * 1024).collect();
        let mut chunks = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            chunks.push(self.crypto()?.encrypt(
                user,
                provider,
                &format!("{purpose}:{}:{index}", parts.len()),
                part,
            )?);
        }
        Ok(format!(
            "chunks-v1:{}",
            serde_json::to_string(&chunks).map_err(|_| invalid())?
        ))
    }
    fn decode<T: serde::de::DeserializeOwned>(
        &self,
        user: &str,
        provider: &str,
        purpose: &str,
        encrypted: &str,
    ) -> Result<T> {
        let value = if let Some(encoded) = encrypted.strip_prefix("chunks-v1:") {
            let byte_limit = storage_byte_limit(provider, purpose);
            if encoded.len() > byte_limit * 2 {
                return Err(required());
            }
            let chunks: Vec<String> = serde_json::from_str(encoded).map_err(|_| required())?;
            let max_chunks = if provider == "tencent_docs" && purpose == "personal_mcp_tools" {
                byte_limit.div_ceil(24 * 1024)
            } else {
                16
            };
            if chunks.is_empty() || chunks.len() > max_chunks {
                return Err(required());
            }
            let mut bytes = Vec::new();
            for (index, chunk) in chunks.iter().enumerate() {
                bytes.extend(
                    self.crypto()?
                        .decrypt(
                            user,
                            provider,
                            &format!("{purpose}:{}:{index}", chunks.len()),
                            chunk,
                        )
                        .map_err(|_| required())?,
                );
            }
            if bytes.len() > byte_limit {
                return Err(required());
            }
            bytes
        } else {
            self.crypto()?
                .decrypt(user, provider, purpose, encrypted)
                .map_err(|_| required())?
        };
        serde_json::from_slice(&value).map_err(|_| required())
    }
    async fn current(&self, user: &str, provider: &str, generation: i64) -> Result<()> {
        if self
            .account(user, provider)
            .await?
            .is_none_or(|a| a.generation != generation || a.encrypted.is_empty())
        {
            return Err(required());
        }
        Ok(())
    }
    async fn credentials(&self, user: &str, provider: &str) -> Result<(Account, Credentials)> {
        catalog::find(provider)?;
        if !self.available(provider) {
            return Err(unavailable());
        }
        let account = self
            .account(user, provider)
            .await?
            .filter(|a| !a.encrypted.is_empty())
            .ok_or_else(required)?;
        let credentials: Credentials = self.decode(
            user,
            provider,
            "personal_mcp_credentials",
            &account.encrypted,
        )?;
        credentials.validate(provider)?;
        Ok((account, credentials))
    }
    async fn item(&self, user: &str, id: &str) -> Result<Value> {
        let provider = catalog::find(id)?;
        let mut value = serde_json::to_value(provider).map_err(|_| ConnectorError::internal())?;
        if id == "tencent_docs" && self.uses_tencent_docs_fixture(user) {
            value["name"] = json!("腾讯文档 · 模拟连接");
            value["description"] = json!("青禾周会调试剧本，支持搜索同名文档及读取正文");
            value["status"] = json!("connected");
            value["has_credentials"] = json!(false);
            value["tool_count"] = json!(2);
            value["environment"] = json!("sandbox");
            value["simulated"] = json!(true);
            return Ok(value);
        }
        let configured = self.0.crypto.is_some() && self.available(id);
        let account = self.account(user, id).await?;
        let credentials_valid = account.as_ref().is_some_and(|a| {
            !a.encrypted.is_empty()
                && self
                    .decode::<Credentials>(user, id, "personal_mcp_credentials", &a.encrypted)
                    .is_ok_and(|credentials| credentials.validate(id).is_ok())
        });
        let status = if !configured {
            "not_configured"
        } else if account
            .as_ref()
            .is_some_and(|a| !a.encrypted.is_empty() && (!credentials_valid || a.failed))
        {
            "needs_reconnect"
        } else if credentials_valid {
            "connected"
        } else {
            "not_connected"
        };
        let tools = account
            .as_ref()
            .and_then(|account| self.account_tools(user, id, account).ok())
            .unwrap_or_default();
        value["status"] = json!(status);
        value["has_credentials"] = json!(
            account
                .as_ref()
                .is_some_and(|account| !account.encrypted.is_empty())
        );
        value["tool_count"] = json!(if credentials_valid { tools.len() } else { 0 });
        value["checked_at"] = json!(
            account
                .as_ref()
                .filter(|a| a.checked > 0)
                .map(|a| timestamp(a.checked))
        );
        value["environment"] = if id == "baidu_netdisk" {
            json!("experience")
        } else {
            json!(
                account
                    .as_ref()
                    .map(|a| a.environment.as_str())
                    .unwrap_or("production")
            )
        };
        value["experience_only"] = json!(id == "baidu_netdisk");
        value["credential_kind"] = json!("token");
        value["requires_server_url"] = json!(id == "memos");
        value["requires_account"] = json!(id == "jianguoyun");
        value["requires_client_id"] = json!(id == "ima");
        if id == "memos" {
            let address = account
                .as_ref()
                .and_then(|account| {
                    self.decode::<Credentials>(
                        user,
                        id,
                        "personal_mcp_credentials",
                        &account.encrypted,
                    )
                    .ok()
                })
                .and_then(|credentials| credentials.server_url)
                .or_else(super::memos::default_server_url);
            value["server_url"] = json!(address);
        }
        value["supports_sandbox"] = json!(id == "didi");
        value["unavailable_reason"] = if self.0.crypto.is_none() {
            json!("服务器尚未配置账号凭证加密，请管理员在后台完成设置")
        } else if !self.available(id) {
            json!(
                provider
                    .unsupported_reason
                    .unwrap_or("服务器尚未安装此供应商所需的官方连接组件")
            )
        } else {
            Value::Null
        };
        Ok(value)
    }
    pub async fn statuses(&self, user: &str) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        for provider in catalog::providers() {
            items.push(self.item(user, provider.id).await?);
        }
        Ok(items)
    }
    pub async fn connect(
        &self,
        user: &str,
        provider: &str,
        credentials: Credentials,
    ) -> Result<Value> {
        catalog::find(provider)?;
        if self.uses_tencent_docs_fixture(user) {
            return Err(unavailable());
        }
        credentials.validate(provider)?;
        self.crypto()?;
        if !self.available(provider) {
            return Err(unavailable());
        }
        self.admit(user).await?;
        let _permit = self.0.requests.try_acquire().map_err(|_| busy())?;
        // Reserve before I/O. A disconnect or newer connect fences this attempt.
        let row = sqlx::query("INSERT INTO personal_mcp_accounts(user_id,provider,generation) VALUES($1,$2,1) ON CONFLICT(user_id,provider) DO UPDATE SET generation=personal_mcp_accounts.generation+1 RETURNING generation").bind(user).bind(provider).fetch_one(&self.0.pool).await?;
        let generation: i64 = row.try_get("generation")?;
        self.invalidate_actions(user, provider).await?;
        let tools = timeout(
            REQUEST_TIMEOUT,
            self.0.transport.discover(provider, &credentials),
        )
        .await
        .map_err(|_| provider_failed())??;
        let tools = clean_tools(provider, &credentials, tools)?;
        let encrypted = self.encrypt(user, provider, "personal_mcp_credentials", &credentials)?;
        let encrypted_tools = self.encrypt(user, provider, "personal_mcp_tools", &tools)?;
        let changed = sqlx::query("UPDATE personal_mcp_accounts SET encrypted_credentials=$1,encrypted_tools=$2,checked_at=$3,last_failed=0,environment=$4,generation=generation+1 WHERE user_id=$5 AND provider=$6 AND generation=$7")
            .bind(encrypted).bind(encrypted_tools).bind(now()).bind(&credentials.environment).bind(user).bind(provider).bind(generation).execute(&self.0.pool).await?.rows_affected();
        if changed != 1 {
            return Err(required());
        }
        self.invalidate_actions(user, provider).await?;
        self.item(user, provider).await
    }
    pub async fn test(&self, user: &str, provider: &str) -> Result<Value> {
        if provider == "tencent_docs" && self.uses_tencent_docs_fixture(user) {
            return self.item(user, provider).await;
        }
        self.admit(user).await?;
        let _permit = self.0.requests.try_acquire().map_err(|_| busy())?;
        let (account, credentials) = self.credentials(user, provider).await?;
        let discovered = timeout(
            REQUEST_TIMEOUT,
            self.0.transport.discover(provider, &credentials),
        )
        .await;
        self.current(user, provider, account.generation).await?;
        let tools = match discovered {
            Ok(Ok(tools)) => clean_tools(provider, &credentials, tools)?,
            _ => {
                sqlx::query("UPDATE personal_mcp_accounts SET last_failed=1 WHERE user_id=$1 AND provider=$2 AND generation=$3").bind(user).bind(provider).bind(account.generation).execute(&self.0.pool).await?;
                return Err(provider_failed());
            }
        };
        let encrypted = self.encrypt(user, provider, "personal_mcp_tools", &tools)?;
        let changed=sqlx::query("UPDATE personal_mcp_accounts SET encrypted_tools=$1,checked_at=$2,last_failed=0 WHERE user_id=$3 AND provider=$4 AND generation=$5 AND encrypted_credentials<>''").bind(encrypted).bind(now()).bind(user).bind(provider).bind(account.generation).execute(&self.0.pool).await?.rows_affected();
        if changed != 1 {
            return Err(required());
        }
        self.item(user, provider).await
    }
    pub async fn disconnect(&self, user: &str, provider: &str) -> Result<Value> {
        if self.uses_tencent_docs_fixture(user) {
            return Err(unavailable());
        }
        catalog::find(provider)?;
        // Also creates a tombstone while an initial connection is still verifying.
        sqlx::query("INSERT INTO personal_mcp_accounts(user_id,provider,generation) VALUES($1,$2,1) ON CONFLICT(user_id,provider) DO UPDATE SET generation=personal_mcp_accounts.generation+1,encrypted_credentials='',encrypted_tools='',checked_at=0,last_failed=0,environment='production'").bind(user).bind(provider).execute(&self.0.pool).await?;
        self.invalidate_actions(user, provider).await?;
        Ok(json!({"ok":true}))
    }
    async fn invalidate_actions(&self, user: &str, provider: &str) -> Result<()> {
        sqlx::query("UPDATE personal_mcp_actions SET status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='executing' THEN 'unknown_outcome' ELSE status END,encrypted_arguments='',encrypted_result='' WHERE user_id=$1 AND provider=$2 AND generation<>(SELECT generation FROM personal_mcp_accounts WHERE user_id=$1 AND provider=$2)").bind(user).bind(provider).execute(&self.0.pool).await?;
        Ok(())
    }
    fn account_tools(&self, user: &str, provider: &str, account: &Account) -> Result<Vec<Value>> {
        let mut tools: Vec<Value> = self.decode(user, provider, "personal_mcp_tools", &account.tools)?;
        // FlyAI's catalog is defined by this adapter. Keep already verified keys
        // working with newly exposed read commands without a new vendor probe.
        if provider == "fliggy" && super::fliggy::is_legacy_catalog(&tools) {
            return Ok(super::fliggy::tool_catalog());
        }
        if provider == "ima" && tools.iter().any(|tool| tool["name"] == "ima_list_knowledge_bases") {
            return Ok(super::ima::tool_catalog());
        }
        // Apply current permissions to cached schemas after a backend upgrade.
        for tool in &mut tools {
            if let Some(name) = tool["name"].as_str() {
                let requires_confirmation = !catalog::is_read_only(provider, name);
                tool["requires_confirmation"] = json!(requires_confirmation);
            }
        }
        Ok(tools)
    }
    pub async fn tools(&self, user: &str, provider: &str) -> Result<Value> {
        if provider == "tencent_docs" && self.uses_tencent_docs_fixture(user) {
            return Ok(super::tencent_docs_fixture::tools());
        }
        let (account, _) = self.credentials(user, provider).await?;
        let tools = self.account_tools(user, provider, &account)?;
        self.current(user, provider, account.generation).await?;
        Ok(json!({"items":tools}))
    }
    /// A form approval is bound to the exact connected account version.
    pub async fn personal_form_catalog(&self, user: &str, provider: &str) -> Result<(Value, i64)> {
        let (account, _) = self.credentials(user, provider).await?;
        let tools = self.account_tools(user, provider, &account)?;
        self.current(user, provider, account.generation).await?;
        Ok((json!({"items":tools}), account.generation))
    }
    pub async fn invoke_personal_form(&self, user: &str, provider: &str, tool: &str, arguments: Value, operation_key: &str, generation: i64) -> Result<Value> {
        self.invoke_for_generation(user, provider, tool, arguments, operation_key, Some(generation), None).await
    }
    /// The API supplies the destination from the exact quote the user approved.
    pub async fn prepare_didi_order(
        &self, user: &str, arguments: Value, operation_key: &str, generation: i64,
        destination: Option<[f64; 2]>,
    ) -> Result<Value> {
        self.invoke_for_generation(user, "didi", "taxi_create_order", arguments, operation_key,
            Some(generation), destination).await
    }

    pub async fn didi_quote(&self, user: &str, arguments: Value, operation_key: &str) -> Result<(Value, i64, bool)> {
        let (account, credentials) = self.credentials(user, "didi").await?;
        let result = self.invoke_for_generation(user, "didi", "taxi_estimate", arguments, operation_key, Some(account.generation), None).await?;
        Ok((result, account.generation, credentials.environment == "sandbox"))
    }
    pub async fn invoke(
        &self,
        user: &str,
        provider: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value> {
        let argument_key = digest(&json!([tool, arguments]).to_string());
        self.invoke_scoped(
            user,
            provider,
            tool,
            arguments,
            &format!("manual:{}:{argument_key}", now() / 600),
        )
        .await
    }
    pub async fn invoke_scoped(
        &self,
        user: &str,
        provider: &str,
        tool: &str,
        arguments: Value,
        operation_key: &str,
    ) -> Result<Value> {
        self.invoke_for_generation(user, provider, tool, arguments, operation_key, None, None).await
    }

    pub fn requires_confirmation(provider: &str, tool: &str) -> bool {
        !catalog::is_read_only(provider, tool)
    }
    async fn invoke_for_generation(
        &self,
        user: &str,
        provider: &str,
        tool: &str,
        arguments: Value,
        operation_key: &str,
        generation: Option<i64>,
        ride_destination: Option<[f64; 2]>,
    ) -> Result<Value> {
        let arguments = if provider == "memos" {
            super::memos::prepare_arguments(tool, arguments)?
        } else {
            arguments
        };
        let argument_limit = if matches!(provider, "notion" | "memos" | "yuque") {
            NOTE_ARGUMENT_BYTES
        } else {
            ARGUMENT_BYTES
        };
        if !arguments.is_object()
            || arguments.to_string().len() > argument_limit
            || tool.is_empty()
            || tool.len() > 160
            || tool.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        if operation_key.is_empty()
            || operation_key.len() > 256
            || operation_key.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        if self.uses_tencent_docs_fixture(user) {
            if provider != "tencent_docs" || generation.is_some() {
                return Err(unavailable());
            }
            return Ok(super::tencent_docs_fixture::call(tool, &arguments));
        }
        self.admit(user).await?;
        let _permit = self.0.requests.try_acquire().map_err(|_| busy())?;
        let (account, credentials) = self.credentials(user, provider).await?;
        if generation.is_some_and(|generation| generation != account.generation) {
            return Err(missing());
        }
        let tools = self.account_tools(user, provider, &account)?;
        if !tools.iter().any(|t| t["name"].as_str() == Some(tool)) {
            return Err(missing());
        }
        reject_secrets(&arguments, &credentials)?;
        if provider == "notion" {
            super::notion::validate_arguments(tool, &arguments)?;
        }
        if provider == "fliggy" {
            super::fliggy::validate_arguments(tool, &arguments)?;
        }
        if provider == "jianguoyun" {
            super::jianguoyun::validate_arguments(tool, &arguments)?;
        }
        if provider == "ima" {
            super::ima::validate_arguments(tool, &arguments)?;
        }
        if provider == "weread" {
            super::weread::validate_arguments(tool, &arguments)?;
        }
        if provider == "qq_music" {
            super::qq_music::validate_arguments(tool, &arguments)?;
        }
        if Self::requires_confirmation(provider, tool) {
            return self
                .pending_action(
                    user,
                    provider,
                    account.generation,
                    tool,
                    arguments,
                    operation_key,
                    ride_destination,
                )
                .await;
        }
        self.current(user, provider, account.generation).await?;
        let result = timeout(
            REQUEST_TIMEOUT,
            self.0
                .transport
                .call(provider, &credentials, tool, arguments),
        )
        .await
        .map_err(|_| provider_failed())??;
        self.current(user, provider, account.generation).await?;
        if provider == "mcdonalds" && tool == "query-meals" {
            // The agent projects the official menu before exposing it to the model.
            // Keep the complete bounded provider result for that projection.
            if result.to_string().len() > super::transport::MCDONALDS_MENU_BYTES {
                return Err(provider_failed());
            }
            reject_secrets(&result, &credentials)?;
        } else {
            clean_result(&credentials, &result)?;
        }
        Ok(json!({"status":if result["isError"]==true{"failed"}else{"completed"},"result":result}))
    }

    async fn ride_status(&self, user: &str, id: &str, include_vehicle: bool) -> Result<Value> {
        let generation: i64 = sqlx::query_scalar("SELECT generation FROM personal_mcp_actions WHERE id=$1 AND user_id=$2 AND provider='didi' AND tool='taxi_create_order' AND status='completed'")
            .bind(id).bind(user).fetch_optional(&self.0.pool).await?.ok_or_else(missing)?;
        let account = self.account(user, "didi").await?.filter(|account| account.generation == generation)
            .ok_or_else(missing)?;
        let (action, destination) = self.action_with_destination(user, id).await?;
        let order = action["result"]["structuredContent"]["orderId"].as_str()
            .filter(|value| !value.is_empty() && value.len() <= 160 && !value.chars().any(char::is_control))
            .ok_or_else(missing)?;
        let query = self.invoke_for_generation(user, "didi", "taxi_query_order",
            json!({"order_id":order}), "ride-status", Some(generation), None).await?;
        let detail = didi_ride_detail(&query["result"], account.environment == "sandbox");
        let status = detail["statusCode"].as_i64()
            .or_else(|| detail["statusCode"].as_str().and_then(|value| value.parse().ok()));
        let Some(status) = status.filter(|_| query["status"] == "completed") else { return Err(provider_failed()) };
        let mut vehicle = Value::Null;
        if include_vehicle && matches!(status, 1 | 2 | 4) {
            if let Ok(result) = self.invoke_for_generation(user, "didi", "taxi_get_driver_location",
                json!({"order_id":order}), "ride-position", Some(generation), None).await {
                if result["status"] == "completed" {
                    let point = didi_vehicle_point(&result["result"], account.environment == "sandbox");
                    if let (Some(lng), Some(lat)) = (point["longitude"].as_f64(), point["latitude"].as_f64()) {
                        if valid_ride_point(lng, lat) {
                            vehicle = json!({"longitude":lng,"latitude":lat});
                        }
                    }
                }
            }
        }
        self.current(user, "didi", generation).await?;
        let label = |value: &Value| value.as_str().unwrap_or("").chars()
            .filter(|c| !c.is_control()).take(100).collect::<String>();
        Ok(json!({"status":status,"status_text":label(&detail["statusText"]),"environment":account.environment,
            "from":label(&action["result"]["structuredContent"]["from"]["name"]),
            "to":label(&action["result"]["structuredContent"]["to"]["name"]),
            "driver":label(&detail["driver"]["name"]),"car":label(&detail["driver"]["carModel"]),
            "plate":label(&detail["driver"]["carPlate"]),"eta":ride_measure(&detail["map"]["eta"], 600.0),
            "distance_km":ride_measure(&detail["map"]["distanceKm"], 1000.0),
            "destination":if include_vehicle && status == 4 {
                didi_order_destination(&action["result"]["structuredContent"]).or(destination)
            } else { None },
            "vehicle":vehicle}))
    }
    async fn pending_action(
        &self,
        user: &str,
        provider: &str,
        generation: i64,
        tool: &str,
        arguments: Value,
        operation_key: &str,
        ride_destination: Option<[f64; 2]>,
    ) -> Result<Value> {
        let request_key = digest(&json!([user, provider, generation, operation_key]).to_string());
        // Only this internal path can create the encrypted array envelope. Public
        // tool arguments must be objects. The destination never goes to the provider.
        let stored_arguments = match ride_destination.filter(|[lng, lat]| valid_ride_point(*lng, *lat)) {
            Some([lng, lat]) => json!([arguments, {"longitude":lng,"latitude":lat}]),
            None => arguments,
        };
        let argument_hash = digest(&json!([tool, stored_arguments]).to_string());
        if let Some(row)=sqlx::query("SELECT action_id,argument_hash FROM personal_mcp_requests WHERE user_id=$1 AND request_key=$2").bind(user).bind(&request_key).fetch_optional(&self.0.pool).await?{
            if row.try_get::<String,_>("argument_hash")?!=argument_hash{return Err(ConnectorError::new(StatusCode::CONFLICT,"mcp_replay_conflict","本次操作参数与原请求不一致，请重新发起需求"));}
            return Ok(action_response(self.action(user,&row.try_get::<String,_>("action_id")?).await?,true));
        }
        let count=sqlx::query("SELECT COUNT(*) AS n FROM personal_mcp_actions WHERE user_id=$1 AND status='pending' AND expires_at>$2").bind(user).bind(now()).fetch_one(&self.0.pool).await?.try_get::<i64,_>("n")?;
        if count >= 30 {
            return Err(busy());
        }
        let id = random_secret();
        let run_scope = operation_key.split(":mcp:").next().unwrap_or(operation_key);
        let dedupe =
            digest(&json!([user, provider, generation, run_scope, tool, stored_arguments]).to_string());
        let encrypted = self.encrypt(
            user,
            provider,
            &format!("personal_mcp_action_arguments:{id}"),
            &stored_arguments,
        )?;
        let mut transaction = self.0.pool.begin().await?;
        sqlx::query("INSERT INTO personal_mcp_actions(id,user_id,provider,generation,tool,encrypted_arguments,dedupe_key,status,created_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,'pending',$8,$9 WHERE EXISTS(SELECT 1 FROM personal_mcp_accounts WHERE user_id=$2 AND provider=$3 AND generation=$4 AND encrypted_credentials<>'') ON CONFLICT(dedupe_key) DO NOTHING")
            .bind(&id).bind(user).bind(provider).bind(generation).bind(tool).bind(encrypted).bind(&dedupe).bind(now()).bind(now()+ACTION_TTL).execute(&mut *transaction).await?;
        let row =
            sqlx::query("SELECT id FROM personal_mcp_actions WHERE user_id=$1 AND dedupe_key=$2")
                .bind(user)
                .bind(dedupe)
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or_else(required)?;
        let action_id: String = row.try_get("id")?;
        sqlx::query("INSERT INTO personal_mcp_requests(request_key,user_id,action_id,argument_hash)VALUES($1,$2,$3,$4)ON CONFLICT(request_key)DO NOTHING").bind(&request_key).bind(user).bind(&action_id).bind(&argument_hash).execute(&mut *transaction).await?;
        let row=sqlx::query("SELECT action_id,argument_hash FROM personal_mcp_requests WHERE user_id=$1 AND request_key=$2").bind(user).bind(request_key).fetch_one(&mut *transaction).await?;
        if row.try_get::<String, _>("argument_hash")? != argument_hash {
            return Err(ConnectorError::new(
                StatusCode::CONFLICT,
                "mcp_replay_conflict",
                "本次操作参数与原请求不一致，请重新发起需求",
            ));
        }
        let action_id: String = row.try_get("action_id")?;
        transaction.commit().await?;
        self.current(user, provider, generation).await?;
        let action = self.action(user, &action_id).await?;
        Ok(action_response(action, action_id != id))
    }
    pub async fn action(&self, user: &str, id: &str) -> Result<Value> {
        self.action_with_destination(user, id).await.map(|(action, _)| action)
    }

    async fn action_with_destination(&self, user: &str, id: &str) -> Result<(Value, Option<Value>)> {
        // Also reconcile a crash between reserving a new account generation and
        // invalidating its old confirmations. An old button must never stay live.
        sqlx::query("UPDATE personal_mcp_actions SET status=CASE WHEN status='pending' THEN 'cancelled' WHEN status='executing' THEN 'unknown_outcome' ELSE status END,encrypted_arguments='',encrypted_result='' WHERE user_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM personal_mcp_accounts WHERE user_id=$1 AND provider=personal_mcp_actions.provider AND generation=personal_mcp_actions.generation AND encrypted_credentials<>'')")
            .bind(user).bind(id).execute(&self.0.pool).await?;
        // An interrupted request/process never becomes retryable. A stale
        // executing record is conservatively unknown until checked in the app.
        sqlx::query("UPDATE personal_mcp_actions SET status='unknown_outcome' WHERE user_id=$1 AND id=$2 AND status='executing' AND started_at<$3").bind(user).bind(id).bind(now()-90).execute(&self.0.pool).await?;
        let row=sqlx::query("SELECT provider,generation,tool,encrypted_arguments,status,expires_at,encrypted_result FROM personal_mcp_actions WHERE user_id=$1 AND id=$2").bind(user).bind(id).fetch_optional(&self.0.pool).await?.ok_or_else(missing)?;
        let provider: String = row.try_get("provider")?;
        let mut status: String = row.try_get("status")?;
        let expires: i64 = row.try_get("expires_at")?;
        if status == "pending" && expires <= now() {
            status = "expired".into();
        }
        let args: String = row.try_get("encrypted_arguments")?;
        let stored_arguments = if args.is_empty() {
            json!({})
        } else {
            self.decode::<Value>(
                user,
                &provider,
                &format!("personal_mcp_action_arguments:{id}"),
                &args,
            )?
        };
        let tool: String = row.try_get("tool")?;
        let (arguments, destination) = match stored_arguments {
            Value::Array(mut stored) if provider == "didi" && tool == "taxi_create_order" && stored.len() == 2 => {
                let destination = stored.pop();
                (stored.remove(0), destination)
            }
            arguments => (arguments, None),
        };
        let mut result = json!({"id":id,"provider":provider,"provider_name":catalog::find(&provider)?.name,"tool":tool,"arguments":arguments,"status":status,"expires_at":timestamp(expires)});
        let encrypted_result: String = row.try_get("encrypted_result")?;
        if !encrypted_result.is_empty() {
            result["result"] = self.decode(
                user,
                &provider,
                &format!("personal_mcp_action_result:{id}"),
                &encrypted_result,
            )?;
        }
        Ok((result, destination))
    }
    pub async fn actions(&self, user: &str) -> Result<Value> {
        let rows=sqlx::query("SELECT id FROM personal_mcp_actions WHERE user_id=$1 AND created_at>$2 AND status IN ('pending','executing','unknown_outcome','completed','failed') ORDER BY created_at DESC,id DESC LIMIT 30").bind(user).bind(now()-86400).fetch_all(&self.0.pool).await?;
        let mut items = Vec::new();
        for row in rows {
            let item = self.action(user, &row.try_get::<String, _>("id")?).await?;
            if item["status"] != "expired" {
                items.push(item);
            }
        }
        Ok(json!({"items":items}))
    }
    pub async fn cancel(&self, user: &str, id: &str) -> Result<Value> {
        self.action(user, id).await?;
        sqlx::query("UPDATE personal_mcp_actions SET status='cancelled' WHERE user_id=$1 AND id=$2 AND status='pending'").bind(user).bind(id).execute(&self.0.pool).await?;
        self.action(user, id).await
    }
    pub async fn confirm(&self, user: &str, id: &str) -> Result<Value> {
        self.admit(user).await?;
        let _permit = self.0.requests.try_acquire().map_err(|_| busy())?;
        let action = self.action(user, id).await?;
        if action["status"] != "pending" {
            return Ok(action);
        }
        let provider = action["provider"].as_str().ok_or_else(invalid)?;
        let (account, credentials) = self.credentials(user, provider).await?;
        let changed=sqlx::query("UPDATE personal_mcp_actions SET status='executing',started_at=$3 WHERE id=$1 AND user_id=$2 AND status='pending' AND expires_at>$3 AND generation=$4 AND EXISTS(SELECT 1 FROM personal_mcp_accounts WHERE user_id=$2 AND provider=$5 AND generation=$4 AND encrypted_credentials<>'')")
            .bind(id).bind(user).bind(now()).bind(account.generation).bind(provider).execute(&self.0.pool).await?.rows_affected();
        if changed != 1 {
            return self.action(user, id).await;
        }
        // Once claimed, no code path changes this action back to pending. A lost
        // response or restart cannot accidentally place an order a second time.
        let result = timeout(
            REQUEST_TIMEOUT,
            self.0.transport.call(
                provider,
                &credentials,
                action["tool"].as_str().ok_or_else(invalid)?,
                action["arguments"].clone(),
            ),
        )
        .await;
        let (status, result) = match result {
            Ok(Ok(result)) if clean_result(&credentials, &result).is_ok() => (
                if result["isError"] == true {
                    "failed"
                } else {
                    "completed"
                },
                result,
            ),
            _ => (
                "unknown_outcome",
                json!({"message":"无法确认操作结果，系统不会自动重试。请到原应用核对订单或资料状态。"}),
            ),
        };
        let encrypted = self.encrypt(
            user,
            provider,
            &format!("personal_mcp_action_result:{id}"),
            &result,
        )?;
        sqlx::query("UPDATE personal_mcp_actions SET status=$1,encrypted_result=$2 WHERE id=$3 AND user_id=$4 AND status='executing' AND EXISTS(SELECT 1 FROM personal_mcp_accounts WHERE user_id=$4 AND provider=$5 AND generation=$6 AND encrypted_credentials<>'')").bind(status).bind(encrypted).bind(id).bind(user).bind(provider).bind(account.generation).execute(&self.0.pool).await?;
        self.current(user, provider, account.generation).await?;
        self.action(user, id).await
    }
}

#[cfg(test)]
#[path = "baidu_state_tests.rs"]
mod baidu_state_tests;

fn action_response(action: Value, replayed: bool) -> Value {
    let status = action["status"].as_str().unwrap_or("unknown_outcome");
    let message = match status {
        "pending" => "尚未执行，等待用户在发起操作的界面核对并确认。",
        "completed" => "此操作已完成；返回已保存的结果，没有再次执行。",
        "failed" => "官方服务明确返回操作未成功；系统不会自动重试。",
        "unknown_outcome" => "无法确认操作结果，系统不会自动重试。请到原应用核对。",
        "executing" => "用户已确认，操作正在处理中；请勿重复提交。",
        "cancelled" => "此操作已取消，没有重新提交。",
        "expired" => "此待确认操作已过期，没有执行。",
        _ => "请查看操作状态，系统没有重新提交。",
    };
    json!({"id":action["id"],"status":if status=="pending"{"confirmation_required"}else{status},"action":action,"replayed":replayed,"message":message})
}

fn valid_ride_point(lng: f64, lat: f64) -> bool {
    (-180.0..=180.0).contains(&lng) && (-90.0..=90.0).contains(&lat)
        && (lng != 0.0 || lat != 0.0)
}

fn didi_order_destination(order: &Value) -> Option<Value> {
    // Older orders already have the official drop-off coordinates in the
    // encrypted create-order response, even when no quote metadata was saved.
    let point = &order["to"];
    let longitude = point["longitude"].as_f64()?;
    let latitude = point["latitude"].as_f64()?;
    valid_ride_point(longitude, latitude)
        .then(|| json!({"longitude":longitude,"latitude":latitude}))
}

fn ride_measure(value: &Value, max: f64) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
        .filter(|value| (0.0..=max).contains(value))
}

fn didi_ride_detail(result: &Value, sandbox: bool) -> Value {
    let detail = &result["structuredContent"];
    if !sandbox || !detail.is_null() {
        return detail.clone();
    }
    // The sandbox still sends some order states as localized text only.
    let text = result["content"][0]["text"].as_str().unwrap_or("");
    let status = if text.starts_with("系统正在为您匹配最近的司机") {
        0
    } else if text.starts_with("系统已为您匹配到司机") {
        1
    } else if text.starts_with("司机已经到达起点附近") {
        2
    } else {
        return Value::Null;
    };
    let field = |prefix| text.lines().find_map(|line| line.trim().strip_prefix(prefix)).map(str::trim);
    let eta = text.split_once("约需").and_then(|(_, tail)| tail.split_once("分钟"))
        .and_then(|(minutes, _)| minutes.trim().parse::<f64>().ok());
    json!({"statusCode":status,"driver":{"name":field("• 称呼："),"carModel":field("• 车型："),
        "carPlate":field("• 车牌：")},"map":{"eta":eta}})
}

fn didi_vehicle_point(result: &Value, sandbox: bool) -> Value {
    let point = &result["structuredContent"];
    if !sandbox || !point.is_null() {
        return point.clone();
    }
    let text = result["content"][0]["text"].as_str().unwrap_or("");
    if !text.starts_with("【司机位置】") {
        return Value::Null;
    }
    let axis = |prefix| text.lines().find_map(|line| line.trim().strip_prefix(prefix))
        .and_then(|value| value.trim().parse::<f64>().ok()).filter(|value| value.is_finite());
    json!({"longitude":axis("经度："),"latitude":axis("纬度：")})
}

fn reject_secrets(value: &Value, credentials: &Credentials) -> Result<()> {
    fn contains(value: &Value, secret: &str, encoded: &str) -> bool {
        let matches = |text: &str| {
            text.contains(secret)
                || (!encoded.is_empty()
                    && text
                        .to_ascii_lowercase()
                        .contains(&encoded.to_ascii_lowercase()))
        };
        match value {
            Value::String(text) => matches(text),
            Value::Array(items) => items.iter().any(|item| contains(item, secret, encoded)),
            Value::Object(object) => object
                .iter()
                .any(|(key, item)| matches(key) || contains(item, secret, encoded)),
            _ => false,
        }
    }
    // Memos instance URLs cannot contain credentials or query strings. They are
    // public connection metadata and can legitimately occur in note links.
    for secret in std::iter::once(credentials.token.as_str())
        .chain(credentials.client_id.as_deref())
        .filter(|s| !s.is_empty())
    {
        let encoded: String = reqwest::Url::parse("https://example.invalid")
            .expect("static url")
            .query_pairs_mut()
            .append_pair("t", secret)
            .finish()
            .query()
            .unwrap_or("")
            .trim_start_matches("t=")
            .to_owned();
        if contains(value, secret, &encoded) {
            return Err(provider_failed());
        }
    }
    Ok(())
}
fn clean_tools(provider: &str, credentials: &Credentials, tools: Vec<Value>) -> Result<Vec<Value>> {
    let (max_tools, max_bytes) = catalog::discovery_limits(provider);
    if tools.len() > max_tools
        || tools.is_empty()
        || serde_json::to_vec(&tools).map_err(|_| invalid())?.len() > max_bytes
    {
        return Err(provider_failed());
    }
    let mut names = std::collections::HashSet::new();
    let mut clean = Vec::new();
    for tool in tools {
        reject_secrets(&tool, credentials)?;
        let name = tool["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 160 && !s.chars().any(char::is_control))
            .ok_or_else(provider_failed)?;
        if !names.insert(name.to_owned()) || !tool["inputSchema"].is_object() {
            return Err(provider_failed());
        }
        let description = tool["description"].as_str().unwrap_or("");
        if description.len() > 8000 {
            return Err(provider_failed());
        }
        clean.push(json!({"name":name,"description":description,"inputSchema":tool["inputSchema"],"requires_confirmation":!catalog::is_read_only(provider,name)}));
    }
    Ok(clean)
}
fn clean_result(credentials: &Credentials, value: &Value) -> Result<()> {
    if value.to_string().len() > RESULT_BYTES {
        return Err(provider_failed());
    }
    reject_secrets(value, credentials)
}

struct User(String);
impl FromRequestParts<PersonalMcpState> for User {
    type Rejection = ConnectorError;
    async fn from_request_parts(parts: &mut Parts, state: &PersonalMcpState) -> Result<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(tomorrow_domain::auth::bearer_token)
            .ok_or_else(ConnectorError::unauthorized)?;
        Ok(Self(
            state
                .0
                .repo
                .authenticate(token)
                .await
                .map_err(|_| ConnectorError::unauthorized())?,
        ))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CallInput {
    tool: String,
    arguments: Value,
}
pub fn router(state: PersonalMcpState) -> Router {
    Router::new()
        .route("/v1/personal-mcp", get(list))
        .route("/v1/personal-mcp/actions", get(actions))
        .route("/v1/personal-mcp/actions/{id}/confirm", post(confirm))
        .route("/v1/personal-mcp/actions/{id}/cancel", post(cancel))
        .route("/v1/personal-mcp/actions/{id}/ride-status", get(ride_status))
        .route("/v1/personal-mcp/{id}", delete(disconnect))
        .route("/v1/personal-mcp/{id}/connect", post(connect))
        .route("/v1/personal-mcp/{id}/test", post(test))
        .route("/v1/personal-mcp/{id}/tools", get(tools))
        .route("/v1/personal-mcp/{id}/call", post(call))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}
async fn list(State(s): State<PersonalMcpState>, User(u): User) -> Result<Json<Value>> {
    Ok(Json(json!({"items":s.statuses(&u).await?})))
}
async fn actions(State(s): State<PersonalMcpState>, User(u): User) -> Result<Json<Value>> {
    Ok(Json(s.actions(&u).await?))
}
#[derive(Deserialize)]
struct RideStatusQuery {
    #[serde(default)]
    include_vehicle: bool,
}

async fn ride_status(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(id): Path<String>,
    Query(query): Query<RideStatusQuery>,
) -> Result<Json<Value>> {
    Ok(Json(s.ride_status(&u, &id, query.include_vehicle).await?))
}
async fn connect(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(p): Path<String>,
    Json(c): Json<Credentials>,
) -> Result<Json<Value>> {
    Ok(Json(s.connect(&u, &p, c).await?))
}
async fn test(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(p): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(s.test(&u, &p).await?))
}
async fn tools(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(p): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(s.tools(&u, &p).await?))
}
async fn disconnect(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(p): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(s.disconnect(&u, &p).await?))
}
async fn call(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(p): Path<String>,
    Json(c): Json<CallInput>,
) -> Result<Json<Value>> {
    Ok(Json(s.invoke(&u, &p, &c.tool, c.arguments).await?))
}
async fn confirm(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(s.confirm(&u, &id).await?))
}
async fn cancel(
    State(s): State<PersonalMcpState>,
    User(u): User,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(s.cancel(&u, &id).await?))
}

#[cfg(test)]
#[path = "notes_live_tests.rs"]
mod notes_live_tests;

#[cfg(test)]
#[path = "docs_storage_capacity_tests.rs"]
mod docs_capacity_tests;

#[cfg(test)]
#[tokio::test]
async fn fliggy_legacy_connection_exposes_eight_tools_without_reconnecting() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("fliggy-legacy@example.test", "unused", "Legacy", "Asia/Shanghai")
        .await.unwrap();
    let mut state = PersonalMcpState::with_transport(
        repo,
        Some(Crypto::from_hex(&"ab".repeat(32)).unwrap()),
        Arc::new(OfficialTransport),
    )
    .await.unwrap();
    Arc::get_mut(&mut state.0).unwrap().fixture_runtime = true;
    let credentials = Credentials {
        token: "legacy-fixture-key".into(),
        environment: "production".into(),
        server_url: None,
        account: None,
        client_id: None,
    };
    let old_tools = json!([
        {"name":"fliggy_fast_search","inputSchema":{"type":"object"}},
        {"name":"fliggy_ai_search","inputSchema":{"type":"object"}}
    ]);
    let key = state.encrypt(&user.id, "fliggy", "personal_mcp_credentials", &credentials).unwrap();
    let tools = state.encrypt(&user.id, "fliggy", "personal_mcp_tools", &old_tools).unwrap();
    sqlx::query("INSERT INTO personal_mcp_accounts(user_id,provider,generation,encrypted_credentials,encrypted_tools,checked_at) VALUES($1,'fliggy',1,$2,$3,1)")
        .bind(&user.id).bind(key).bind(tools).execute(&state.0.pool).await.unwrap();

    assert_eq!(state.item(&user.id, "fliggy").await.unwrap()["tool_count"], 8);
    let visible = state.tools(&user.id, "fliggy").await.unwrap();
    assert_eq!(visible["items"].as_array().unwrap().len(), 8);
    assert_eq!(state.personal_form_catalog(&user.id, "fliggy").await.unwrap(), (visible, 1));
    let error = state.invoke(&user.id, "fliggy", "fliggy_search_train", json!({})).await.err().unwrap();
    assert_eq!(error.code, "invalid_request");
    state.disconnect(&user.id, "fliggy").await.unwrap();
    assert!(state.tools(&user.id, "fliggy").await.is_err());
}
