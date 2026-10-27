//! Server-side, read-only Google connectors. OAuth tokens never cross the app API.
mod config;
mod crypto;
mod reads;

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{FromRequestParts, Path, Query, State, rejection::QueryRejection},
    http::{StatusCode, header, request::Parts},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
};
use config::{Config, http_client};
use crypto::{digest, random_secret};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AnyPool, Row};
use tokio::sync::Mutex;
use tomorrow_domain::{Capability, Repository, now};

type Result<T> = std::result::Result<T, ConnectorError>;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ConnectorError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ConnectorError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "连接服务暂时不可用",
        )
    }
    fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "Google 连接尚未配置或配置无效，请配置 OAuth 客户端、固定回调地址与 32 字节加密密钥",
        )
    }
    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "请先登录，或重新登录后重试",
        )
    }
    fn reconnect() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "connection_required",
            "Google 授权不可用，请重新连接",
        )
    }
    fn invalid() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", "请求参数无效")
    }
    fn invalid_state() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_oauth_state",
            "授权链接已失效或已使用，请返回应用重新连接",
        )
    }
    fn upstream() -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "provider_error",
            "Google 服务请求失败，请稍后重试；如持续失败，请重新连接",
        )
    }
}

impl From<sqlx::Error> for ConnectorError {
    fn from(_: sqlx::Error) -> Self {
        Self::internal()
    }
}

impl IntoResponse for ConnectorError {
    fn into_response(self) -> Response {
        (
            self.status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Service {
    Calendar,
    Gmail,
    Drive,
}

impl Service {
    fn all() -> [Self; 3] {
        [Self::Calendar, Self::Gmail, Self::Drive]
    }
    pub(crate) fn parse(id: &str) -> Result<Self> {
        match id {
            "google_calendar" => Ok(Self::Calendar),
            "gmail" => Ok(Self::Gmail),
            "google_drive" => Ok(Self::Drive),
            _ => Err(ConnectorError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "找不到这个连接器",
            )),
        }
    }
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Calendar => "google_calendar",
            Self::Gmail => "gmail",
            Self::Drive => "google_drive",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Calendar => "Google 日历",
            Self::Gmail => "Gmail",
            Self::Drive => "Google 云端硬盘",
        }
    }
    fn scope(self) -> &'static str {
        match self {
            Self::Calendar => "https://www.googleapis.com/auth/calendar.events.readonly",
            Self::Gmail => "https://www.googleapis.com/auth/gmail.readonly",
            Self::Drive => "https://www.googleapis.com/auth/drive.metadata.readonly",
        }
    }
    fn detail(self) -> &'static str {
        match self {
            Self::Calendar => "仅只读主日历的日程，不创建或修改日程",
            Self::Gmail => "仅只读邮件列表与摘要，不发送、修改或删除邮件",
            Self::Drive => "仅只读文件名称和元数据，不下载正文或修改文件",
        }
    }
}

#[derive(Serialize)]
pub struct ConnectorInfo {
    pub id: String,
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Clone)]
pub struct ConnectorState {
    inner: Arc<Inner>,
}

struct Inner {
    repo: Repository,
    pool: AnyPool,
    config: Option<Config>,
    client: Client,
    refresh_lock: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    scope: String,
}

struct Account {
    generation: i64,
    ciphertext: String,
}

struct PendingAuthorization {
    user_id: String,
    service: Service,
    verifier: String,
    generation: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    token_type: Option<String>,
    scope: Option<String>,
}

impl ConnectorState {
    pub async fn new(repo: Repository) -> Result<Self> {
        Self::with_config(repo, Config::from_env().ok()).await
    }

    async fn with_config(repo: Repository, config: Option<Config>) -> Result<Self> {
        let pool = repo.pool();
        sqlx::query("CREATE TABLE IF NOT EXISTS google_connector_accounts (user_id TEXT NOT NULL,service TEXT NOT NULL,generation BIGINT NOT NULL DEFAULT 0,encrypted_tokens TEXT NOT NULL DEFAULT '',updated_at BIGINT NOT NULL,PRIMARY KEY(user_id,service))").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS google_oauth_states (state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,service TEXT NOT NULL,generation BIGINT NOT NULL,encrypted_verifier TEXT NOT NULL,expires_at BIGINT NOT NULL)").execute(&pool).await?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS google_oauth_expiry ON google_oauth_states(expires_at)",
        )
        .execute(&pool)
        .await?;
        Ok(Self {
            inner: Arc::new(Inner {
                repo,
                pool,
                config,
                client: http_client()?,
                refresh_lock: Mutex::new(()),
            }),
        })
    }

    pub fn is_configured(&self) -> bool {
        self.inner.config.is_some()
    }

    fn config(&self) -> Result<&Config> {
        self.inner
            .config
            .as_ref()
            .ok_or_else(ConnectorError::unavailable)
    }

    pub async fn statuses(&self, user_id: &str) -> Result<Vec<ConnectorInfo>> {
        let mut result = Vec::new();
        for service in Service::all() {
            let (status, detail) = if let Some(config) = &self.inner.config {
                match self.account(user_id, service).await? {
                    Some(account) if !account.ciphertext.is_empty() => {
                        match self.decode_tokens(config, user_id, service, &account.ciphertext) {
                            Ok(tokens)
                                if tokens.expires_at > now() || tokens.refresh_token.is_some() =>
                            {
                                ("connected", service.detail())
                            }
                            _ => ("not_connected", "授权信息失效，请重新连接"),
                        }
                    }
                    _ => ("not_connected", service.detail()),
                }
            } else {
                (
                    "not_configured",
                    "服务端尚未配置可用的 Google OAuth 客户端与加密密钥",
                )
            };
            result.push(ConnectorInfo {
                id: service.id().into(),
                name: service.name().into(),
                status: status.into(),
                detail: detail.into(),
            });
        }
        Ok(result)
    }

    pub async fn capabilities(&self, user_id: &str) -> Result<Vec<Capability>> {
        Ok(self
            .statuses(user_id)
            .await?
            .into_iter()
            .map(|connector| Capability {
                id: connector.id,
                name: connector.name,
                description: "Google 授权只读连接".into(),
                category: "connector".into(),
                status: if connector.status == "connected" {
                    "available"
                } else {
                    "not_configured"
                }
                .into(),
                detail: connector.detail,
            })
            .collect())
    }

    async fn account(&self, user: &str, service: Service) -> Result<Option<Account>> {
        let row = sqlx::query("SELECT generation,encrypted_tokens FROM google_connector_accounts WHERE user_id=$1 AND service=$2").bind(user).bind(service.id()).fetch_optional(&self.inner.pool).await?;
        row.map(|row| {
            Ok(Account {
                generation: row.try_get("generation")?,
                ciphertext: row.try_get("encrypted_tokens")?,
            })
        })
        .transpose()
    }

    fn decode_tokens(
        &self,
        config: &Config,
        user: &str,
        service: Service,
        ciphertext: &str,
    ) -> Result<Tokens> {
        let plaintext = config
            .crypto
            .decrypt(user, service.id(), "tokens", ciphertext)?;
        serde_json::from_slice(&plaintext).map_err(|_| ConnectorError::reconnect())
    }

    async fn begin_authorization(&self, user: &str, service: Service) -> Result<String> {
        let config = self.config()?;
        let state = random_secret();
        let state_hash = digest(&state);
        let verifier = random_secret();
        let encrypted_verifier = config.crypto.encrypt(
            user,
            service.id(),
            &format!("pkce:{state_hash}"),
            verifier.as_bytes(),
        )?;
        let mut transaction = self.inner.pool.begin().await?;
        sqlx::query(
            "DELETE FROM google_oauth_states WHERE expires_at<=$1 OR (user_id=$2 AND service=$3)",
        )
        .bind(now())
        .bind(user)
        .bind(service.id())
        .execute(&mut *transaction)
        .await?;
        sqlx::query("INSERT INTO google_connector_accounts(user_id,service,generation,encrypted_tokens,updated_at) VALUES($1,$2,0,'',$3) ON CONFLICT(user_id,service) DO NOTHING").bind(user).bind(service.id()).bind(now()).execute(&mut *transaction).await?;
        let row = sqlx::query("UPDATE google_connector_accounts SET generation=generation+1,updated_at=$1 WHERE user_id=$2 AND service=$3 RETURNING generation").bind(now()).bind(user).bind(service.id()).fetch_one(&mut *transaction).await?;
        let generation: i64 = row.try_get("generation")?;
        sqlx::query("INSERT INTO google_oauth_states(state_hash,user_id,service,generation,encrypted_verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&state_hash).bind(user).bind(service.id()).bind(generation).bind(encrypted_verifier).bind(now()+600).execute(&mut *transaction).await?;
        transaction.commit().await?;
        let mut url =
            Url::parse(&config.endpoints.authorize).map_err(|_| ConnectorError::internal())?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", config.redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", service.scope()),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "false"),
            ("code_challenge", digest(&verifier).as_str()),
            ("code_challenge_method", "S256"),
        ]);
        Ok(url.into())
    }

    async fn consume_state(&self, state: &str) -> Result<PendingAuthorization> {
        let config = self.config()?;
        if state.len() != 43
            || !state
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(ConnectorError::invalid_state());
        }
        let state_hash = digest(state);
        // DELETE ... RETURNING is atomic across API replicas, including one-time consumption.
        let row = sqlx::query("DELETE FROM google_oauth_states WHERE state_hash=$1 AND expires_at>$2 RETURNING user_id,service,generation,encrypted_verifier").bind(&state_hash).bind(now()).fetch_optional(&self.inner.pool).await?.ok_or_else(ConnectorError::invalid_state)?;
        let user: String = row.try_get("user_id")?;
        let service = Service::parse(&row.try_get::<String, _>("service")?)?;
        let generation = row.try_get("generation")?;
        let verifier: String = row.try_get("encrypted_verifier")?;
        let verifier = String::from_utf8(config.crypto.decrypt(
            &user,
            service.id(),
            &format!("pkce:{state_hash}"),
            &verifier,
        )?)
        .map_err(|_| ConnectorError::invalid_state())?;
        Ok(PendingAuthorization {
            user_id: user,
            service,
            verifier,
            generation,
        })
    }

    async fn exchange_code(&self, pending: PendingAuthorization, code: &str) -> Result<()> {
        if code.is_empty() || code.len() > 4096 {
            return Err(ConnectorError::invalid());
        }
        let config = self.config()?;
        let response = self
            .inner
            .client
            .post(&config.endpoints.token)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("redirect_uri", config.redirect_uri.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| ConnectorError::upstream())?;
        let value = read_json(response, 65536).await?;
        let response: TokenResponse =
            serde_json::from_value(value).map_err(|_| ConnectorError::upstream())?;
        let tokens = validate_tokens(response, pending.service, None)?;
        let ciphertext = config.crypto.encrypt(
            &pending.user_id,
            pending.service.id(),
            "tokens",
            &serde_json::to_vec(&tokens).map_err(|_| ConnectorError::internal())?,
        )?;
        // A concurrent disconnect or a newer authorization invalidates this callback.
        let changed = sqlx::query("UPDATE google_connector_accounts SET encrypted_tokens=$1,updated_at=$2 WHERE user_id=$3 AND service=$4 AND generation=$5").bind(ciphertext).bind(now()).bind(&pending.user_id).bind(pending.service.id()).bind(pending.generation).execute(&self.inner.pool).await?.rows_affected();
        if changed == 0 {
            return Err(ConnectorError::invalid_state());
        }
        Ok(())
    }

    async fn access_token(
        &self,
        user: &str,
        service: Service,
        force_refresh: bool,
    ) -> Result<String> {
        let config = self.config()?;
        let initial = self
            .account(user, service)
            .await?
            .filter(|account| !account.ciphertext.is_empty())
            .ok_or_else(ConnectorError::reconnect)?;
        let initial_tokens = self.decode_tokens(config, user, service, &initial.ciphertext)?;
        if !force_refresh && initial_tokens.expires_at > now() + 60 {
            return Ok(initial_tokens.access_token);
        }
        let _refresh_guard = self.inner.refresh_lock.lock().await;
        let account = self
            .account(user, service)
            .await?
            .filter(|account| !account.ciphertext.is_empty())
            .ok_or_else(ConnectorError::reconnect)?;
        let tokens = self.decode_tokens(config, user, service, &account.ciphertext)?;
        if tokens.expires_at > now() + 60
            && (!force_refresh || account.ciphertext != initial.ciphertext)
        {
            return Ok(tokens.access_token);
        }
        let Some(refresh_token) = tokens.refresh_token.as_deref() else {
            self.invalidate_account(user, service, &account).await?;
            return Err(ConnectorError::reconnect());
        };
        let response = self
            .inner
            .client
            .post(&config.endpoints.token)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
            ])
            .send()
            .await
            .map_err(|_| ConnectorError::upstream())?;
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
        ) {
            self.invalidate_account(user, service, &account).await?;
            return Err(ConnectorError::reconnect());
        }
        let response: TokenResponse = serde_json::from_value(read_json(response, 65536).await?)
            .map_err(|_| ConnectorError::upstream())?;
        let tokens = validate_tokens(response, service, tokens.refresh_token)?;
        let ciphertext = config.crypto.encrypt(
            user,
            service.id(),
            "tokens",
            &serde_json::to_vec(&tokens).map_err(|_| ConnectorError::internal())?,
        )?;
        let changed = sqlx::query("UPDATE google_connector_accounts SET encrypted_tokens=$1,updated_at=$2 WHERE user_id=$3 AND service=$4 AND generation=$5 AND encrypted_tokens=$6").bind(ciphertext).bind(now()).bind(user).bind(service.id()).bind(account.generation).bind(&account.ciphertext).execute(&self.inner.pool).await?.rows_affected();
        if changed == 0 {
            let current = self
                .account(user, service)
                .await?
                .filter(|account| !account.ciphertext.is_empty())
                .ok_or_else(ConnectorError::reconnect)?;
            let current = self.decode_tokens(config, user, service, &current.ciphertext)?;
            if current.expires_at <= now() + 10 {
                return Err(ConnectorError::reconnect());
            }
            return Ok(current.access_token);
        }
        Ok(tokens.access_token)
    }

    async fn invalidate_account(
        &self,
        user: &str,
        service: Service,
        account: &Account,
    ) -> Result<()> {
        sqlx::query("UPDATE google_connector_accounts SET encrypted_tokens='',generation=generation+1,updated_at=$1 WHERE user_id=$2 AND service=$3 AND generation=$4 AND encrypted_tokens=$5").bind(now()).bind(user).bind(service.id()).bind(account.generation).bind(&account.ciphertext).execute(&self.inner.pool).await?;
        Ok(())
    }

    async fn google_get(
        &self,
        user: &str,
        service: Service,
        url: &str,
        query: &[(String, String)],
    ) -> Result<Value> {
        let token = self.access_token(user, service, false).await?;
        let response = self
            .inner
            .client
            .get(url)
            .bearer_auth(token)
            .query(query)
            .send()
            .await
            .map_err(|_| ConnectorError::upstream())?;
        let response = if response.status() == StatusCode::UNAUTHORIZED {
            let token = self.access_token(user, service, true).await?;
            self.inner
                .client
                .get(url)
                .bearer_auth(token)
                .query(query)
                .send()
                .await
                .map_err(|_| ConnectorError::upstream())?
        } else {
            response
        };
        read_json(response, 2 * 1024 * 1024).await
    }

    async fn clear_local(&self, user: &str, service: Option<Service>) -> Result<()> {
        let mut transaction = self.inner.pool.begin().await?;
        match service {
            Some(service) => {
                sqlx::query("UPDATE google_connector_accounts SET encrypted_tokens='',generation=generation+1,updated_at=$1 WHERE user_id=$2 AND service=$3").bind(now()).bind(user).bind(service.id()).execute(&mut *transaction).await?;
                sqlx::query("DELETE FROM google_oauth_states WHERE user_id=$1 AND service=$2")
                    .bind(user)
                    .bind(service.id())
                    .execute(&mut *transaction)
                    .await?;
            }
            None => {
                sqlx::query("UPDATE google_connector_accounts SET encrypted_tokens='',generation=generation+1,updated_at=$1 WHERE user_id=$2").bind(now()).bind(user).execute(&mut *transaction).await?;
                sqlx::query("DELETE FROM google_oauth_states WHERE user_id=$1")
                    .bind(user)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    async fn disconnect(&self, user: &str, service: Service) -> Result<Value> {
        let account = self.account(user, service).await?;
        // Local disconnect commits before any remote request, including network failure.
        self.clear_local(user, Some(service)).await?;
        let tokens = account.as_ref().and_then(|account| {
            self.inner.config.as_ref().and_then(|config| {
                self.decode_tokens(config, user, service, &account.ciphertext)
                    .ok()
            })
        });
        let mut attempted = false;
        let mut revoked = false;
        if let (Some(config), Some(tokens)) = (&self.inner.config, tokens) {
            attempted = true;
            let token = tokens
                .refresh_token
                .as_deref()
                .unwrap_or(&tokens.access_token);
            revoked = self
                .inner
                .client
                .post(&config.endpoints.revoke)
                .form(&[("token", token)])
                .send()
                .await
                .is_ok_and(|response| response.status() == StatusCode::OK);
        }
        let disconnected_ids = if revoked {
            // Google revocation is project-wide, not restricted to one requested scope.
            self.clear_local(user, None).await?;
            Service::all()
                .into_iter()
                .map(|service| service.id())
                .collect::<Vec<_>>()
        } else {
            vec![service.id()]
        };
        Ok(
            json!({"ok":true,"revocation_attempted":attempted,"revoked":revoked,"disconnected_ids":disconnected_ids,
            "detail":if revoked{"已撤销 Google 授权。Google 撤销可能影响同一项目的其他服务，本应用的 Google 连接已全部清除"}else if attempted{"本地连接已清除；远端撤销未确认，可在 Google 账号权限设置中再次撤销"}else{"本地连接已清除"}}),
        )
    }
}

fn validate_tokens(
    response: TokenResponse,
    service: Service,
    old_refresh: Option<String>,
) -> Result<Tokens> {
    if response.access_token.is_empty()
        || response.access_token.len() > 8192
        || response.expires_in <= 0
        || response.expires_in > 31 * 86400
        || response
            .token_type
            .as_ref()
            .is_some_and(|kind| !kind.eq_ignore_ascii_case("bearer"))
        || response
            .refresh_token
            .as_ref()
            .is_some_and(|token| token.is_empty() || token.len() > 8192)
        || response.scope.as_ref().is_some_and(|scope| {
            !scope
                .split_whitespace()
                .any(|scope| scope == service.scope())
        })
    {
        return Err(ConnectorError::upstream());
    }
    Ok(Tokens {
        access_token: response.access_token,
        refresh_token: response.refresh_token.or(old_refresh),
        expires_at: now() + response.expires_in,
        scope: response.scope.unwrap_or_else(|| service.scope().into()),
    })
}

async fn read_json(mut response: reqwest::Response, limit: usize) -> Result<Value> {
    if !response.status().is_success() {
        return Err(ConnectorError::upstream());
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ConnectorError::upstream());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ConnectorError::upstream())?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ConnectorError::upstream());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ConnectorError::upstream())
}

struct Auth {
    user_id: String,
}

impl FromRequestParts<ConnectorState> for Auth {
    type Rejection = ConnectorError;
    async fn from_request_parts(parts: &mut Parts, state: &ConnectorState) -> Result<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(ConnectorError::unauthorized)?;
        let user_id = state
            .inner
            .repo
            .authenticate(token)
            .await
            .map_err(|_| ConnectorError::unauthorized())?;
        Ok(Self { user_id })
    }
}

pub fn router(state: ConnectorState) -> Router {
    Router::new()
        .route("/v1/connectors", get(list))
        .route("/v1/connectors/{id}/authorize", post(authorize))
        .route("/v1/connectors/{id}", delete(disconnect))
        .route("/v1/connectors/google/callback", get(callback))
        .route(
            "/v1/connectors/google_calendar/events",
            get(reads::calendar_events),
        )
        .route("/v1/connectors/gmail/messages", get(reads::gmail_messages))
        .route("/v1/connectors/google_drive/files", get(reads::drive_files))
        .with_state(state)
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

async fn list(State(state): State<ConnectorState>, auth: Auth) -> Result<Json<Value>> {
    Ok(Json(json!({"items":state.statuses(&auth.user_id).await?})))
}
async fn authorize(
    State(state): State<ConnectorState>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<impl IntoResponse> {
    let url = state
        .begin_authorization(&auth.user_id, Service::parse(&id)?)
        .await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"authorization_url":url})),
    ))
}
async fn disconnect(
    State(state): State<ConnectorState>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(
        state
            .disconnect(&auth.user_id, Service::parse(&id)?)
            .await?,
    ))
}

#[derive(Deserialize)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(state): State<ConnectorState>,
    query: std::result::Result<Query<CallbackQuery>, QueryRejection>,
) -> Response {
    let result = async {
        let Query(query) = query.map_err(|_| ConnectorError::invalid())?;
        let pending = state
            .consume_state(
                query
                    .state
                    .as_deref()
                    .ok_or_else(ConnectorError::invalid_state)?,
            )
            .await?;
        if query.error.is_some() {
            return Ok(false);
        }
        state
            .exchange_code(
                pending,
                query.code.as_deref().ok_or_else(ConnectorError::invalid)?,
            )
            .await?;
        Ok::<bool, ConnectorError>(true)
    }
    .await;
    let (status, message) = match result {
        Ok(true) => (
            StatusCode::OK,
            "授权完成。请返回 Tomorrow AI 并刷新连接列表。",
        ),
        Ok(false) => (StatusCode::OK, "你已取消本次授权。请返回 Tomorrow AI。"),
        Err(error) => (error.status, error.message),
    };
    (status,[(header::CACHE_CONTROL,"no-store"),(header::REFERRER_POLICY,"no-referrer"),(header::CONTENT_SECURITY_POLICY,"default-src 'none'; frame-ancestors 'none'")],Html(format!("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Tomorrow AI</title><body><h1>Tomorrow AI</h1><p>{message}</p></body></html>"))).into_response()
}

#[cfg(test)]
mod tests;
