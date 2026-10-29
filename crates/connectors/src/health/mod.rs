//! User-owned, read-only wearable health connections. Only encrypted OAuth
//! credentials and sync metadata are persisted; health records are returned to
//! an explicit foreground sync and never sent to the model or general memory.
mod config;
mod provider;
#[cfg(test)]
mod tests;

use crate::{
    ConnectorError, Result,
    crypto::{digest, random_secret},
};
use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query, State},
    http::{StatusCode, header, request::Parts},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use config::Config;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AnyPool, Row};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tomorrow_domain::{Repository, now};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Provider {
    Huawei,
    Xiaomi,
}
impl Provider {
    fn all() -> [Self; 2] {
        [Self::Huawei, Self::Xiaomi]
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "huawei" => Ok(Self::Huawei),
            "xiaomi" => Ok(Self::Xiaomi),
            _ => Err(ConnectorError::new(
                StatusCode::NOT_FOUND,
                "health_provider_not_found",
                "没有这个健康数据来源",
            )),
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::Huawei => "huawei",
            Self::Xiaomi => "xiaomi",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Huawei => "华为运动健康",
            Self::Xiaomi => "小米运动健康",
        }
    }
    fn metrics(self) -> &'static [&'static str] {
        match self {
            Self::Huawei => &["steps"],
            Self::Xiaomi => &["steps", "heart_rate", "sleep", "weight", "active_energy"],
        }
    }
    fn scope(self, metric: &str) -> Option<&'static str> {
        match (self, metric) {
            (Self::Huawei, "steps") => Some("https://www.huawei.com/healthkit/step.read"),
            (Self::Xiaomi, "steps") => Some("200016"),
            (Self::Xiaomi, "heart_rate") => Some("200007"),
            (Self::Xiaomi, "sleep") => Some("200009"),
            (Self::Xiaomi, "weight") => Some("200010"),
            (Self::Xiaomi, "active_energy") => Some("200001"),
            _ => None,
        }
    }
}

pub(super) fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "health_not_configured",
        "服务端尚未配置此厂商健康服务，请管理员完成应用开通、数据权限审批、回调地址与加密密钥配置",
    )
}
fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_health_request",
        "健康连接请求无效，请重新选择数据项目",
    )
}
fn reconnect() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "health_reconnect_required",
        "健康授权已失效或权限不足，请重新连接",
    )
}
fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "health_provider_error",
        "健康平台读取失败，请检查厂商授权、隐私开关及数据同步后重试",
    )
}
fn invalid_state() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_health_oauth_state",
        "健康授权链接已失效或已使用，请返回妥啦重新连接",
    )
}
fn operation_timeout() -> ConnectorError {
    ConnectorError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "health_operation_timeout",
        "健康服务等待超时，请刷新连接状态；若确认码已使用，请重新发起连接，不要重复提交确认码",
    )
}

#[derive(Clone)]
pub struct HealthState {
    inner: Arc<Inner>,
}
struct Inner {
    repo: Repository,
    pool: AnyPool,
    config: Config,
    client: reqwest::Client,
    refresh: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    scopes: Vec<String>,
    metrics: Vec<String>,
    authorized_at: i64,
    config_fingerprint: String,
}
struct Account {
    generation: i64,
    ciphertext: String,
    last_sync_at: i64,
    sync_started_at: i64,
}
#[derive(Serialize, Deserialize)]
struct Pending {
    session: String,
    metrics: Vec<String>,
    config_fingerprint: String,
}
struct Consumed {
    user: String,
    generation: i64,
    pending: Pending,
}
#[derive(Serialize, Deserialize)]
struct PendingFinalize {
    tokens: Tokens,
    session_hash: String,
    config_fingerprint: String,
    generation: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HealthRecord {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<String>,
    pub metric: String,
    pub start_at: String,
    pub end_at: String,
    pub value: f64,
    pub unit: String,
}

impl HealthState {
    pub async fn new(repo: Repository) -> Result<Self> {
        Self::with_config(repo, Config::from_lookup(|key| std::env::var(key).ok())).await
    }
    async fn with_config(repo: Repository, config: Config) -> Result<Self> {
        let pool = repo.pool();
        sqlx::query("CREATE TABLE IF NOT EXISTS health_connector_accounts(user_id TEXT NOT NULL,provider TEXT NOT NULL,generation BIGINT NOT NULL DEFAULT 0,encrypted_tokens TEXT NOT NULL DEFAULT '',last_sync_at BIGINT NOT NULL DEFAULT 0,sync_started_at BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(user_id,provider))").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS health_oauth_states(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,generation BIGINT NOT NULL,encrypted_pending TEXT NOT NULL,expires_at BIGINT NOT NULL)").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS health_pending_tokens(receipt_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,generation BIGINT NOT NULL,encrypted_pending TEXT NOT NULL,expires_at BIGINT NOT NULL)").execute(&pool).await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS health_oauth_expiry ON health_oauth_states(expires_at)",
        )
        .execute(&pool)
        .await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|_| ConnectorError::internal())?;
        Ok(Self {
            inner: Arc::new(Inner {
                repo,
                pool,
                config,
                client,
                refresh: Arc::new(tokio::sync::Mutex::new(())),
            }),
        })
    }
    pub fn reconfigured(&self, values: &HashMap<String, String>) -> Self {
        Self {
            inner: Arc::new(Inner {
                repo: self.inner.repo.clone(),
                pool: self.inner.pool.clone(),
                config: Config::from_lookup(|key| values.get(key).cloned()),
                client: self.inner.client.clone(),
                refresh: self.inner.refresh.clone(),
            }),
        }
    }
    fn config(&self, provider: Provider) -> Result<&config::ProviderConfig> {
        self.inner.config.provider(provider)
    }
    async fn account(&self, user: &str, provider: Provider) -> Result<Option<Account>> {
        sqlx::query("SELECT generation,encrypted_tokens,last_sync_at,sync_started_at FROM health_connector_accounts WHERE user_id=$1 AND provider=$2").bind(user).bind(provider.id()).fetch_optional(&self.inner.pool).await?.map(|row|Ok(Account {generation:row.try_get("generation")?,ciphertext:row.try_get("encrypted_tokens")?,last_sync_at:row.try_get("last_sync_at")?,sync_started_at:row.try_get("sync_started_at")?})).transpose()
    }
    fn decode(&self, user: &str, provider: Provider, ciphertext: &str) -> Result<Tokens> {
        let value = self
            .inner
            .config
            .crypto()?
            .decrypt(user, provider.id(), "health_tokens", ciphertext)
            .map_err(|_| reconnect())?;
        let tokens: Tokens = serde_json::from_slice(&value).map_err(|_| reconnect())?;
        if tokens.config_fingerprint != self.config(provider)?.fingerprint {
            return Err(reconnect());
        }
        Ok(tokens)
    }
    pub async fn statuses(&self, user: &str) -> Result<Value> {
        let mut items = Vec::new();
        for provider in Provider::all() {
            let account = self.account(user, provider).await?;
            let has_credentials = account.as_ref().is_some_and(|a| !a.ciphertext.is_empty());
            let tokens = account
                .as_ref()
                .and_then(|a| self.decode(user, provider, &a.ciphertext).ok());
            let status = if self.config(provider).is_err() {
                "not_configured"
            } else if has_credentials {
                if tokens
                    .as_ref()
                    .is_some_and(|t| t.expires_at > now() + 10 || t.refresh_token.is_some())
                {
                    "connected"
                } else {
                    "reconnect_required"
                }
            } else {
                "available"
            };
            let detail = match provider {
                Provider::Huawei => {
                    "通过华为官方授权只读步数。需在华为运动健康开启数据共享；首版未申请历史权限，仅读取连接生效后的记录。步数按UTC日汇总，非本地今日总步数。"
                }
                Provider::Xiaomi => {
                    "通过小米官方授权只读所选健康数据。需先将手表或手环同步到小米运动健康；可读取范围以厂商审批和个人授权为准。"
                }
            };
            items.push(json!({"id":provider.id(),"name":provider.name(),"status":status,"detail":detail,"last_sync_at":account.as_ref().filter(|a|a.last_sync_at>0).map(|a|rfc3339(a.last_sync_at*1000)).transpose()?,"metrics":provider.metrics(),"granted_metrics":tokens.map(|t|t.metrics).unwrap_or_default(),"has_credentials":has_credentials,"storage":"local_records_server_oauth_only"}));
        }
        Ok(json!({"items":items}))
    }
    async fn authorize(
        &self,
        user: &str,
        session: &str,
        provider: Provider,
        metrics: Vec<String>,
    ) -> Result<String> {
        let config = self.config(provider)?;
        let metrics = validate_metrics(provider, metrics)?;
        let state = random_secret();
        let hash = digest(&state);
        let pending = Pending {
            session: session.into(),
            metrics: metrics.clone(),
            config_fingerprint: config.fingerprint.clone(),
        };
        let encrypted = self.inner.config.crypto()?.encrypt(
            user,
            provider.id(),
            &format!("health_state:{hash}"),
            &serde_json::to_vec(&pending).map_err(|_| ConnectorError::internal())?,
        )?;
        let mut tx = self.inner.pool.begin().await?;
        sqlx::query(
            "DELETE FROM health_pending_tokens WHERE expires_at<=$1 OR(user_id=$2 AND provider=$3)",
        )
        .bind(now())
        .bind(user)
        .bind(provider.id())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM health_oauth_states WHERE expires_at<=$1 OR(user_id=$2 AND provider=$3)",
        )
        .bind(now())
        .bind(user)
        .bind(provider.id())
        .execute(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO health_connector_accounts(user_id,provider,generation) VALUES($1,$2,0) ON CONFLICT(user_id,provider) DO NOTHING").bind(user).bind(provider.id()).execute(&mut *tx).await?;
        let generation:i64=sqlx::query("UPDATE health_connector_accounts SET generation=generation+1 WHERE user_id=$1 AND provider=$2 RETURNING generation").bind(user).bind(provider.id()).fetch_one(&mut *tx).await?.try_get("generation")?;
        sqlx::query("INSERT INTO health_oauth_states(state_hash,user_id,provider,generation,encrypted_pending,expires_at) VALUES($1,$2,$3,$4,$5,$6)").bind(hash).bind(user).bind(provider.id()).bind(generation).bind(encrypted).bind(now()+600).execute(&mut *tx).await?;
        tx.commit().await?;
        let endpoint = match provider {
            Provider::Huawei => &self.inner.config.endpoints.huawei_authorize,
            Provider::Xiaomi => &self.inner.config.endpoints.xiaomi_authorize,
        };
        let mut url = reqwest::Url::parse(endpoint).map_err(|_| ConnectorError::internal())?;
        let mut scopes: Vec<&str> = metrics.iter().filter_map(|m| provider.scope(m)).collect();
        if provider == Provider::Xiaomi {
            scopes.push("200013")
        }
        url.query_pairs_mut().extend_pairs([
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", config.redirect.as_str()),
            ("response_type", "code"),
            ("scope", scopes.join(" ").as_str()),
            ("state", state.as_str()),
        ]);
        match provider {
            Provider::Xiaomi => {
                url.query_pairs_mut().extend_pairs([
                    ("scope_provider", "healthkit"),
                    ("skip_confirm", "false"),
                    ("pt", "0"),
                ]);
            }
            Provider::Huawei => {
                url.query_pairs_mut().append_pair("access_type", "offline");
            }
        }
        Ok(url.into())
    }
    async fn consume(&self, provider: Provider, state: &str) -> Result<Consumed> {
        if state.len() != 43
            || !state
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(invalid_state());
        }
        let hash = digest(state);
        let row=sqlx::query("DELETE FROM health_oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>$3 RETURNING user_id,generation,encrypted_pending").bind(&hash).bind(provider.id()).bind(now()).fetch_optional(&self.inner.pool).await?.ok_or_else(invalid_state)?;
        let user: String = row.try_get("user_id")?;
        let cipher: String = row.try_get("encrypted_pending")?;
        let plain = self
            .inner
            .config
            .crypto()?
            .decrypt(
                &user,
                provider.id(),
                &format!("health_state:{hash}"),
                &cipher,
            )
            .map_err(|_| invalid_state())?;
        let pending: Pending = serde_json::from_slice(&plain).map_err(|_| invalid_state())?;
        if pending.config_fingerprint != self.config(provider)?.fingerprint {
            return Err(invalid_state());
        }
        let owner = self
            .inner
            .repo
            .authenticate(&pending.session)
            .await
            .map_err(|_| invalid_state())?;
        if owner != user {
            return Err(invalid_state());
        }
        Ok(Consumed {
            user,
            generation: row.try_get("generation")?,
            pending,
        })
    }
    async fn complete(&self, provider: Provider, query: Callback) -> Result<String> {
        let pending = self
            .consume(provider, query.state.as_deref().ok_or_else(invalid_state)?)
            .await?;
        if query.error.is_some() {
            return Err(ConnectorError::new(
                StatusCode::BAD_REQUEST,
                "health_authorization_denied",
                "你已取消健康数据授权，可返回妥啦重新选择",
            ));
        }
        let code = query
            .code
            .filter(|v| !v.is_empty() && v.len() <= 4096)
            .ok_or_else(invalid_state)?;
        let tokens = self.exchange(provider, &pending, &code).await?;
        if self
            .inner
            .repo
            .authenticate(&pending.pending.session)
            .await
            .map_err(|_| invalid_state())?
            != pending.user
        {
            return Err(invalid_state());
        }
        let receipt = random_secret();
        let hash = digest(&receipt);
        let value = PendingFinalize {
            tokens,
            session_hash: digest(&pending.pending.session),
            config_fingerprint: pending.pending.config_fingerprint,
            generation: pending.generation,
        };
        let cipher = self.inner.config.crypto()?.encrypt(
            &pending.user,
            provider.id(),
            &format!("health_receipt:{hash}"),
            &serde_json::to_vec(&value).map_err(|_| ConnectorError::internal())?,
        )?;
        let changed=sqlx::query("INSERT INTO health_pending_tokens(receipt_hash,user_id,provider,generation,encrypted_pending,expires_at) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM health_connector_accounts WHERE user_id=$2 AND provider=$3 AND generation=$4)").bind(&hash).bind(&pending.user).bind(provider.id()).bind(pending.generation).bind(cipher).bind(now()+300).execute(&self.inner.pool).await?.rows_affected();
        if changed != 1 {
            return Err(invalid_state());
        }
        // No health data is read here. Only the originating app session plus
        // the browser-held receipt can finalize this account binding.
        Ok(receipt)
    }
    async fn finalize(
        &self,
        user: &str,
        session: &str,
        provider: Provider,
        receipt: &str,
    ) -> Result<Value> {
        self.config(provider)?;
        if receipt.len() != 43
            || !receipt
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(invalid_state());
        }
        let hash = digest(receipt);
        // A different account cannot even consume the receipt. A different
        // session of the same account burns it but cannot complete the flow.
        let row=sqlx::query("DELETE FROM health_pending_tokens WHERE receipt_hash=$1 AND user_id=$2 AND provider=$3 AND expires_at>$4 RETURNING generation,encrypted_pending").bind(&hash).bind(user).bind(provider.id()).bind(now()).fetch_optional(&self.inner.pool).await?.ok_or_else(invalid_state)?;
        let generation: i64 = row.try_get("generation")?;
        let cipher: String = row.try_get("encrypted_pending")?;
        let plain = self
            .inner
            .config
            .crypto()?
            .decrypt(
                user,
                provider.id(),
                &format!("health_receipt:{hash}"),
                &cipher,
            )
            .map_err(|_| invalid_state())?;
        let pending: PendingFinalize =
            serde_json::from_slice(&plain).map_err(|_| invalid_state())?;
        if pending.session_hash != digest(session)
            || pending.config_fingerprint != self.config(provider)?.fingerprint
            || pending.generation != generation
        {
            return Err(invalid_state());
        }
        if self
            .inner
            .repo
            .authenticate(session)
            .await
            .map_err(|_| invalid_state())?
            != user
        {
            return Err(invalid_state());
        }
        self.account(user, provider)
            .await?
            .filter(|a| a.generation == generation)
            .ok_or_else(invalid_state)?;
        let tokens = pending.tokens;
        // A real, read-only response validates health access. A token alone
        // does not prove Health Kit enrollment or the privacy sharing switch.
        let mut probe = tokens.clone();
        probe.metrics.truncate(1);
        tokio::time::timeout(
            std::time::Duration::from_secs(55),
            self.read_records(provider, &probe, 1),
        )
        .await
        .map_err(|_| upstream())??;
        if self
            .inner
            .repo
            .authenticate(session)
            .await
            .map_err(|_| invalid_state())?
            != user
        {
            return Err(invalid_state());
        }
        let cipher = self.inner.config.crypto()?.encrypt(
            user,
            provider.id(),
            "health_tokens",
            &serde_json::to_vec(&tokens).map_err(|_| ConnectorError::internal())?,
        )?;
        let changed=sqlx::query("UPDATE health_connector_accounts SET encrypted_tokens=$1,last_sync_at=0,sync_started_at=0 WHERE user_id=$2 AND provider=$3 AND generation=$4").bind(cipher).bind(user).bind(provider.id()).bind(generation).execute(&self.inner.pool).await?.rows_affected();
        if changed != 1 {
            return Err(invalid_state());
        }
        Ok(json!({"connected":true,"provider":provider.id(),"granted_metrics":tokens.metrics}))
    }
    async fn sync(
        &self,
        user: &str,
        provider: Provider,
        days: i64,
        metrics: Option<Vec<String>>,
    ) -> Result<Value> {
        if !(1..=30).contains(&days) {
            return Err(invalid());
        }
        let metrics = metrics.map(|m| validate_metrics(provider, m)).transpose()?;
        self.config(provider)?;
        let initial = self
            .account(user, provider)
            .await?
            .filter(|a| !a.ciphertext.is_empty())
            .ok_or_else(reconnect)?;
        if initial.sync_started_at > now() - 30 {
            return Err(ConnectorError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "health_sync_cooldown",
                "刚刚已请求同步，请30秒后再试",
            ));
        }
        let started=sqlx::query("UPDATE health_connector_accounts SET sync_started_at=$1 WHERE user_id=$2 AND provider=$3 AND generation=$4 AND sync_started_at=$5").bind(now()).bind(user).bind(provider.id()).bind(initial.generation).bind(initial.sync_started_at).execute(&self.inner.pool).await?.rows_affected();
        if started != 1 {
            return Err(reconnect());
        }
        let mut tokens = self.access_tokens(user, provider).await?;
        if let Some(metrics) = metrics {
            let requested = metrics;
            if requested.iter().any(|m| !tokens.metrics.contains(m)) {
                return Err(reconnect());
            }
            tokens.metrics = requested;
        }
        let (records, truncated) = tokio::time::timeout(
            std::time::Duration::from_secs(55),
            self.read_records(provider, &tokens, days),
        )
        .await
        .map_err(|_| upstream())??;
        // Disconnect or newer consent wins even when an old network call finishes later.
        let changed=sqlx::query("UPDATE health_connector_accounts SET last_sync_at=$1 WHERE user_id=$2 AND provider=$3 AND generation=$4 AND encrypted_tokens<>''").bind(now()).bind(user).bind(provider.id()).bind(initial.generation).execute(&self.inner.pool).await?.rows_affected();
        if changed != 1 {
            return Err(reconnect());
        }
        Ok(
            json!({"records":records,"synced_at":rfc3339(now()*1000)?,"truncated":truncated,"window_days":days,"storage":"local_records_server_oauth_only"}),
        )
    }
    pub async fn disconnect(&self, user: &str, provider_id: &str) -> Result<Value> {
        let provider = Provider::parse(provider_id)?;
        let mut tx = self.inner.pool.begin().await?;
        sqlx::query("UPDATE health_connector_accounts SET generation=generation+1,encrypted_tokens='',last_sync_at=0,sync_started_at=0 WHERE user_id=$1 AND provider=$2").bind(user).bind(provider.id()).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM health_oauth_states WHERE user_id=$1 AND provider=$2")
            .bind(user)
            .bind(provider.id())
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM health_pending_tokens WHERE user_id=$1 AND provider=$2")
            .bind(user)
            .bind(provider.id())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(
            json!({"local_credentials_removed":true,"remote_revoked":false,"message":"妥啦已移除本服务保存的授权并停止同步；如需撤销厂商侧授权，请在厂商健康App的三方授权管理中操作。"}),
        )
    }
}

fn validate_metrics(provider: Provider, metrics: Vec<String>) -> Result<Vec<String>> {
    if metrics.is_empty()
        || metrics.len() > provider.metrics().len()
        || metrics.iter().any(|m| provider.scope(m).is_none())
    {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    Ok(metrics
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect())
}
pub(super) fn rfc3339(ms: i64) -> Result<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(upstream)
}

struct User {
    id: String,
    session: String,
}
impl FromRequestParts<HealthState> for User {
    type Rejection = ConnectorError;
    async fn from_request_parts(parts: &mut Parts, state: &HealthState) -> Result<Self> {
        let session = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(tomorrow_domain::auth::bearer_token)
            .ok_or_else(ConnectorError::unauthorized)?;
        let id = state
            .inner
            .repo
            .authenticate(session)
            .await
            .map_err(|_| ConnectorError::unauthorized())?;
        Ok(Self {
            id,
            session: session.into(),
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authorize {
    metrics: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FinalizeInput {
    receipt: String,
}
#[derive(Deserialize)]
struct Callback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SyncInput {
    days: Option<i64>,
    metrics: Option<Vec<String>>,
}

pub fn router(state: HealthState) -> Router {
    Router::new()
        .route("/v1/health/connections", get(statuses))
        .route(
            "/v1/health/connections/{provider}/authorize",
            post(authorize),
        )
        .route("/v1/health/connections/{provider}/sync", post(sync))
        .route("/v1/health/connections/{provider}/finalize", post(finalize))
        .route(
            "/v1/health/connections/{provider}",
            axum::routing::delete(disconnect),
        )
        .route("/v1/health/oauth/{provider}/callback", get(callback))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(2048))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                response.headers_mut().insert(
                    "referrer-policy",
                    header::HeaderValue::from_static("no-referrer"),
                );
                response.headers_mut().insert(
                    "x-content-type-options",
                    header::HeaderValue::from_static("nosniff"),
                );
                response.headers_mut().insert(
                    "content-security-policy",
                    header::HeaderValue::from_static(
                        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
                    ),
                );
                response
            },
        ))
}
/// In-process marker for the API error normalizer. This cannot be supplied by
/// an HTTP client; only the sanitized callback renderer attaches it.
#[derive(Clone)]
pub struct OAuthPage;
async fn statuses(State(state): State<HealthState>, User { id, .. }: User) -> Result<Json<Value>> {
    Ok(Json(state.statuses(&id).await?))
}
async fn authorize(
    State(state): State<HealthState>,
    User { id, session }: User,
    Path(provider): Path<String>,
    Json(input): Json<Authorize>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"authorization_url":state.authorize(&id,&session,Provider::parse(&provider)?,input.metrics).await?}),
    ))
}
async fn sync(
    State(state): State<HealthState>,
    User { id, .. }: User,
    Path(provider): Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let input = if body.is_empty() {
        SyncInput::default()
    } else {
        if !headers
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .and_then(|v| v.split(';').next())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        {
            return Err(invalid());
        }
        serde_json::from_slice::<SyncInput>(&body).map_err(|_| invalid())?
    };
    Ok(Json(
        tokio::time::timeout(
            std::time::Duration::from_secs(80),
            state.sync(
                &id,
                Provider::parse(&provider)?,
                input.days.unwrap_or(7),
                input.metrics,
            ),
        )
        .await
        .map_err(|_| operation_timeout())??,
    ))
}
async fn disconnect(
    State(state): State<HealthState>,
    User { id, .. }: User,
    Path(provider): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(state.disconnect(&id, &provider).await?))
}
async fn finalize(
    State(state): State<HealthState>,
    User { id, session }: User,
    Path(provider): Path<String>,
    Json(input): Json<FinalizeInput>,
) -> Result<Json<Value>> {
    let provider = Provider::parse(&provider)?;
    Ok(Json(
        tokio::time::timeout(
            std::time::Duration::from_secs(80),
            state.finalize(&id, &session, provider, &input.receipt),
        )
        .await
        .map_err(|_| operation_timeout())??,
    ))
}
async fn callback(
    State(state): State<HealthState>,
    Path(provider): Path<String>,
    Query(query): Query<Callback>,
) -> Response {
    let mut response=match Provider::parse(&provider) {Ok(provider)=>match tokio::time::timeout(std::time::Duration::from_secs(30),state.complete(provider,query)).await.unwrap_or_else(|_|Err(operation_timeout())) {
        Ok(receipt)=>{
            let origin=state.config(provider).ok().and_then(|c|reqwest::Url::parse(&c.redirect).ok()).map(|u|u.origin().ascii_serialization()).unwrap_or_default();
            let mut link=reqwest::Url::parse("tada://health/complete").expect("static app URL");link.query_pairs_mut().extend_pairs([("provider",provider.id()),("receipt",receipt.as_str()),("server",origin.as_str())]);
            Html(format!("<!doctype html><html lang=\"zh\"><meta charset=\"utf-8\"><title>返回妥啦确认健康连接</title><p>厂商授权已返回，尚未读取健康数据。</p><p>请在发起连接的妥啦账号中完成确认，请勿转发此页面或确认码。</p><p><a href=\"{}\">返回妥啦完成连接</a></p><p>若无法打开，可复制以下确认码，在妥啦“我的健康”粘贴确认。确认码5分钟内有效，仅限发起连接的登录会话使用。</p><code>{}</code></html>",html_escape(link.as_str()),receipt)).into_response()
        },
        Err(error)=>(error.status,Html(format!("<!doctype html><html lang=\"zh\"><meta charset=\"utf-8\"><title>健康连接未完成</title><p>{}</p><p>请返回妥啦检查配置或重新授权。</p></html>",error.message))).into_response()
    },Err(error)=>error.into_response()};
    response.extensions_mut().insert(OAuthPage);
    response
}
fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#39;")
}
