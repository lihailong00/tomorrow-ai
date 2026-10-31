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
    extract::{FromRequestParts, Path, State},
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
const RESULT_BYTES: usize = 96 * 1024;
const ARGUMENT_BYTES: usize = 16 * 1024;
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
pub struct PersonalMcpState(Arc<Inner>);
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
            baidu_experience_enabled: std::env::var("BAIDU_NETDISK_EXPERIENCE_ENABLED").ok().is_some_and(|value| matches!(value.as_str(), "true" | "1")),
            #[cfg(test)]
            fixture_runtime: false,
        })))
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
            baidu_experience_enabled: values.get("BAIDU_NETDISK_EXPERIENCE_ENABLED").is_some_and(|value| matches!(value.as_str(), "true" | "1")),
            #[cfg(test)]
            fixture_runtime: self.0.fixture_runtime,
        }))
    }
    fn available(&self, id: &str) -> bool {
        if id == "baidu_netdisk" && !self.0.baidu_experience_enabled { return false; }
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
        if bytes.len() > TOOL_BYTES {
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
            if encoded.len() > TOOL_BYTES * 2 {
                return Err(required());
            }
            let chunks: Vec<String> = serde_json::from_str(encoded).map_err(|_| required())?;
            if chunks.is_empty() || chunks.len() > 16 {
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
            if bytes.len() > TOOL_BYTES {
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
        let configured = self.0.crypto.is_some() && self.available(id);
        let account = self.account(user, id).await?;
        let credentials_valid = account.as_ref().is_some_and(|a| {
            !a.encrypted.is_empty()
                && self
                    .decode::<Credentials>(user, id, "personal_mcp_credentials", &a.encrypted)
                    .is_ok()
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
            .and_then(|a| {
                self.decode::<Vec<Value>>(user, id, "personal_mcp_tools", &a.tools)
                    .ok()
            })
            .unwrap_or_default();
        value["status"] = json!(status);
        value["has_credentials"] = json!(account.as_ref().is_some_and(|account| !account.encrypted.is_empty()));
        value["tool_count"] = json!(if credentials_valid { tools.len() } else { 0 });
        value["checked_at"] = json!(
            account
                .as_ref()
                .filter(|a| a.checked > 0)
                .map(|a| timestamp(a.checked))
        );
        value["environment"] = if id == "baidu_netdisk" { json!("experience") } else { json!(
            account
                .as_ref()
                .map(|a| a.environment.as_str())
                .unwrap_or("production")
        ) };
        value["experience_only"] = json!(id == "baidu_netdisk");
        value["credential_kind"] = json!("token");
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
    pub async fn tools(&self, user: &str, provider: &str) -> Result<Value> {
        let (account, _) = self.credentials(user, provider).await?;
        let tools: Vec<Value> =
            self.decode(user, provider, "personal_mcp_tools", &account.tools)?;
        self.current(user, provider, account.generation).await?;
        Ok(json!({"items":tools}))
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
        if !arguments.is_object()
            || arguments.to_string().len() > ARGUMENT_BYTES
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
        self.admit(user).await?;
        let _permit = self.0.requests.try_acquire().map_err(|_| busy())?;
        let (account, credentials) = self.credentials(user, provider).await?;
        let tools: Vec<Value> =
            self.decode(user, provider, "personal_mcp_tools", &account.tools)?;
        if !tools.iter().any(|t| t["name"].as_str() == Some(tool)) {
            return Err(missing());
        }
        reject_secrets(&arguments, &credentials)?;
        if !catalog::is_read_only(provider, tool) {
            return self
                .pending_action(
                    user,
                    provider,
                    account.generation,
                    tool,
                    arguments,
                    operation_key,
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
        clean_result(&credentials, &result)?;
        Ok(json!({"status":if result["isError"]==true{"failed"}else{"completed"},"result":result}))
    }
    async fn pending_action(
        &self,
        user: &str,
        provider: &str,
        generation: i64,
        tool: &str,
        arguments: Value,
        operation_key: &str,
    ) -> Result<Value> {
        let request_key = digest(&json!([user, provider, generation, operation_key]).to_string());
        let argument_hash = digest(&json!([tool, arguments]).to_string());
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
            digest(&json!([user, provider, generation, run_scope, tool, arguments]).to_string());
        let encrypted = self.encrypt(
            user,
            provider,
            &format!("personal_mcp_action_arguments:{id}"),
            &arguments,
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
        let arguments = if args.is_empty() {
            json!({})
        } else {
            self.decode::<Value>(
                user,
                &provider,
                &format!("personal_mcp_action_arguments:{id}"),
                &args,
            )?
        };
        let mut result = json!({"id":id,"provider":provider,"provider_name":catalog::find(&provider)?.name,"tool":row.try_get::<String,_>("tool")?,"arguments":arguments,"status":status,"expires_at":timestamp(expires)});
        let encrypted_result: String = row.try_get("encrypted_result")?;
        if !encrypted_result.is_empty() {
            result["result"] = self.decode(
                user,
                &provider,
                &format!("personal_mcp_action_result:{id}"),
                &encrypted_result,
            )?;
        }
        Ok(result)
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
        "pending" => "尚未执行。请在我的连接中核对参数并确认；模型无法代替你确认。",
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
    for secret in [
        Some(credentials.token.as_str()),
        credentials.server_url.as_deref(),
    ]
    .into_iter()
    .flatten()
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
    if tools.len() > 128
        || tools.is_empty()
        || serde_json::to_vec(&tools).map_err(|_| invalid())?.len() > TOOL_BYTES
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
        .route("/v1/personal-mcp/{id}", delete(disconnect))
        .route("/v1/personal-mcp/{id}/connect", post(connect))
        .route("/v1/personal-mcp/{id}/test", post(test))
        .route("/v1/personal-mcp/{id}/tools", get(tools))
        .route("/v1/personal-mcp/{id}/call", post(call))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024))
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
