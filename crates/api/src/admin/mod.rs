//! Instance administration lives on an independent router and never uses mobile bearer tokens.
use axum::{
    extract::{DefaultBodyLimit, FromRequestParts, Path, Query, Request, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{AnyPool, Row};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;
use tomorrow_domain::{auth, now, timestamp, DomainError, Repository};
use tomorrow_settings::{ConfigError, ConfigStore};

pub mod backup;
mod model_probe;
mod usage_pricing;
const COOKIE: &str = "tada_admin_session";
const SESSION_SECONDS: i64 = 12 * 60 * 60;
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXktc2FsdC0xMjM0NQ$2Fk2PbqQ1mQj5F0R2jXYSzOaC84n1sKUXvB+ukpQkqg";

#[derive(Clone)]
pub struct AdminState {
    pub repository: Repository,
    pub settings: ConfigStore,
    pub config_dir: PathBuf,
    password_jobs: Arc<Semaphore>,
    model_probe_jobs: Arc<Semaphore>,
}

#[derive(Debug)]
pub struct AdminError(pub StatusCode, pub &'static str, pub &'static str);
type Result<T> = std::result::Result<T, AdminError>;
impl IntoResponse for AdminError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"error":{"code":self.1,"message":self.2}})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for AdminError {
    fn from(_: sqlx::Error) -> Self {
        internal()
    }
}
impl From<ConfigError> for AdminError {
    fn from(error: ConfigError) -> Self {
        match error {
            ConfigError::Conflict => Self(
                StatusCode::CONFLICT,
                "revision_conflict",
                "配置已被更新，请刷新后重试",
            ),
            ConfigError::Locked => Self(
                StatusCode::CONFLICT,
                "environment_locked",
                "该配置由部署环境管理",
            ),
            ConfigError::Validation => invalid(),
            _ => internal(),
        }
    }
}
fn invalid() -> AdminError {
    AdminError(
        StatusCode::BAD_REQUEST,
        "invalid_input",
        "请检查输入内容和配置格式",
    )
}
fn internal() -> AdminError {
    AdminError(
        StatusCode::SERVICE_UNAVAILABLE,
        "temporarily_unavailable",
        "服务暂时不可用，请稍后重试",
    )
}
fn denied() -> AdminError {
    AdminError(
        StatusCode::UNAUTHORIZED,
        "admin_login_required",
        "请登录管理后台",
    )
}
fn forbidden() -> AdminError {
    AdminError(StatusCode::FORBIDDEN, "forbidden", "无权执行该操作")
}

impl AdminState {
    pub async fn new(repository: Repository, settings: ConfigStore) -> anyhow::Result<Self> {
        let config_dir = settings.config_dir().to_path_buf();
        Self::with_directory(repository, settings, config_dir).await
    }
    pub async fn with_directory(
        repository: Repository,
        settings: ConfigStore,
        config_dir: PathBuf,
    ) -> anyhow::Result<Self> {
        let state = Self {
            repository,
            settings,
            config_dir,
            password_jobs: Arc::new(Semaphore::new(2)),
            model_probe_jobs: Arc::new(Semaphore::new(1)),
        };
        state.initialize().await?;
        Ok(state)
    }
    async fn initialize(&self) -> anyhow::Result<()> {
        for statement in [
            "CREATE TABLE IF NOT EXISTS admin_guard(id BIGINT PRIMARY KEY, revision BIGINT NOT NULL)",
            "INSERT INTO admin_guard(id,revision) VALUES(1,0) ON CONFLICT(id) DO NOTHING",
            "CREATE TABLE IF NOT EXISTS admin_bootstrap(id BIGINT PRIMARY KEY,token_hash TEXT NOT NULL,consumed_at BIGINT NOT NULL DEFAULT 0,created_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS admin_roles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL,created_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS admin_user_controls(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,disabled BIGINT NOT NULL DEFAULT 0,updated_at BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at BIGINT NOT NULL,created_at BIGINT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS admin_session_owner ON admin_sessions(user_id,expires_at)",
            "CREATE TABLE IF NOT EXISTS admin_rate_windows(bucket TEXT PRIMARY KEY,started_at BIGINT NOT NULL,attempts BIGINT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS admin_invites(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,uses_remaining BIGINT NOT NULL)",
        ] { sqlx::query(statement).execute(&self.repository.pool()).await?; }
        let pool = self.repository.pool();
        let initialized: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM admin_roles WHERE role='owner'")
                .fetch_one(&pool)
                .await?;
        if initialized > 0 {
            return Ok(());
        }
        tokio::fs::create_dir_all(&self.config_dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&self.config_dir, std::fs::Permissions::from_mode(0o700))
                .await?;
        }
        let path = self.config_dir.join("setup-token");
        let token = match tokio::fs::read_to_string(&path).await {
            Ok(value) if valid_token(value.trim()) => value.trim().to_owned(),
            Ok(_) => anyhow::bail!("Invalid administrator setup token file"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                use tokio::io::AsyncWriteExt;
                let token = auth::generate_token();
                let mut options = tokio::fs::OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                options.mode(0o600);
                match options.open(&path).await {
                    Ok(mut file) => {
                        file.write_all(token.as_bytes()).await?;
                        file.sync_all().await?;
                        token
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        tokio::fs::read_to_string(&path).await?.trim().to_owned()
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        };
        if !valid_token(&token) {
            anyhow::bail!("Invalid administrator setup token file");
        }
        sqlx::query("INSERT INTO admin_bootstrap(id,token_hash,consumed_at,created_at) VALUES(1,$1,0,$2) ON CONFLICT(id) DO NOTHING")
            .bind(auth::hash_token(&token)).bind(now()).execute(&pool).await?;
        // Refuse an inconsistent token rather than silently replacing the installation credential.
        let stored: String =
            sqlx::query_scalar("SELECT token_hash FROM admin_bootstrap WHERE id=1")
                .fetch_one(&pool)
                .await?;
        if !constant_eq(&stored, &auth::hash_token(&token)) {
            anyhow::bail!("Administrator setup token file does not match database");
        }
        Ok(())
    }
    async fn password_hash(&self, password: String) -> Result<String> {
        auth::validate_password(&password).map_err(|_| invalid())?;
        let permit = self
            .password_jobs
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            auth::hash_password(&password)
        })
        .await
        .map_err(|_| internal())?
        .map_err(|_| invalid())
    }
    async fn verify(&self, password: String, hash: String) -> Result<bool> {
        if password.chars().count() > 128 {
            return Ok(false);
        }
        let permit = self
            .password_jobs
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            auth::verify_password(&password, &hash)
        })
        .await
        .map_err(|_| internal())
    }
}
fn busy() -> AdminError {
    AdminError(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "操作过于频繁，请稍后重试",
    )
}
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn constant_eq(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |a, (b, c)| a | (b ^ c))
            == 0
}

pub fn router(state: AdminState) -> Router {
    Router::new()
        .route("/admin/api/bootstrap", get(bootstrap))
        .route("/admin/api/setup", post(setup))
        .route("/admin/api/login", post(login))
        .route("/admin/api/session", get(session))
        .route("/admin/api/logout", post(logout))
        .route("/admin/api/password", post(change_own_password))
        .route("/admin/api/status", get(status))
        .route("/admin/api/config", get(config).patch(update_config))
        .route("/admin/api/usage-pricing", get(usage_pricing::read).patch(usage_pricing::save))
        .route("/admin/api/usage-pricing/backfill", post(usage_pricing::backfill))
        .route("/admin/api/config/check", post(check_config))
        .route("/admin/api/config/test-model", post(model_probe::test_model))
        .route("/admin/api/config/test-speech", post(model_probe::test_speech))
        .route("/admin/api/config/test-vision", post(model_probe::test_vision))
        .route("/admin/api/config/test-embedding", post(model_probe::test_embedding))
        .route("/admin/api/users", get(users).post(create_user))
        .route("/admin/api/users/{id}", axum::routing::patch(update_user))
        .route(
            "/admin/api/users/{id}/revoke-sessions",
            post(revoke_sessions),
        )
        .route("/admin/api/users/{id}/reset-password", post(reset_password))
        .route("/admin/api/invites", get(invites).post(create_invite))
        .route(
            "/admin/api/invites/{id}",
            axum::routing::delete(revoke_invite),
        )
        .route("/admin/api/diagnostics", get(diagnostics))
        .merge(backup::router())
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), security))
        .with_state(state)
}
pub fn public_router(state: AdminState) -> Router {
    Router::new()
        .route("/v1/instance", get(manifest))
        .route("/internal/config/runtime", get(runtime_config))
        .with_state(state)
}

#[derive(Clone)]
pub struct AdminSession {
    pub user_id: String,
    pub email: String,
    pub name: String,
    pub role: String,
    pub csrf_token: String,
    pub expires_at: i64,
    token_hash: String,
}
impl FromRequestParts<AdminState> for AdminSession {
    type Rejection = AdminError;
    async fn from_request_parts(parts: &mut Parts, state: &AdminState) -> Result<Self> {
        authenticate(state, &parts.headers).await
    }
}
fn cookie(headers: &HeaderMap) -> Option<String> {
    let mut values = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .filter_map(|p| p.trim().split_once('='))
        .filter(|(key, _)| *key == COOKIE)
        .map(|(_, value)| value);
    let value = values.next()?;
    if values.next().is_some() || !valid_token(value) {
        return None;
    }
    Some(value.into())
}
async fn authenticate(state: &AdminState, headers: &HeaderMap) -> Result<AdminSession> {
    let token = cookie(headers).ok_or_else(denied)?;
    let token_hash = auth::hash_token(&token);
    let row=sqlx::query("SELECT s.user_id,s.expires_at,u.email,u.name,r.role FROM admin_sessions s JOIN users u ON u.id=s.user_id JOIN admin_roles r ON r.user_id=u.id LEFT JOIN admin_user_controls c ON c.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>$2 AND COALESCE(c.disabled,0)=0")
        .bind(&token_hash).bind(now()).fetch_optional(&state.repository.pool()).await?.ok_or_else(denied)?;
    let role: String = row.get("role");
    if role != "owner" && role != "admin" {
        return Err(denied());
    }
    Ok(AdminSession {
        user_id: row.get("user_id"),
        email: row.get("email"),
        name: row.get("name"),
        role,
        csrf_token: csrf(&token),
        expires_at: row.get("expires_at"),
        token_hash,
    })
}
fn csrf(token: &str) -> String {
    auth::hash_token(&format!("tada-admin-csrf:{token}"))
}
async fn security(State(state): State<AdminState>, request: Request, next: Next) -> Response {
    // Body is Send but not Sync. Never borrow the request itself across the
    // asynchronous session/configuration checks in this middleware.
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let request_headers = request.headers().clone();
    let result = async {
        let public = matches!(
            path.as_str(),
            "/admin/api/bootstrap" | "/admin/api/setup" | "/admin/api/login"
        );
        if !matches!(method, Method::GET | Method::HEAD) {
            same_origin(&state, &request_headers).await?;
        }
        if !public {
            let session = authenticate(&state, &request_headers).await?;
            if !matches!(method, Method::GET | Method::HEAD) {
                let received = request_headers
                    .get("x-csrf-token")
                    .and_then(|h| h.to_str().ok())
                    .ok_or_else(forbidden)?;
                if !constant_eq(received, &session.csrf_token) {
                    return Err(forbidden());
                }
            }
        }
        Ok::<_, AdminError>(())
    }
    .await;
    let mut response = match result {
        Ok(()) => next.run(request).await,
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    for name in [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
    ] {
        headers.remove(name);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
async fn same_origin(_state: &AdminState, headers: &HeaderMap) -> Result<()> {
    if headers
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s != "same-origin" && s != "none")
    {
        return Err(forbidden());
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(forbidden)?;
    let url = url::Url::parse(origin).map_err(|_| forbidden())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(forbidden());
    }
    // Compare with the actual HTTP Host, never an attacker-supplied forwarded
    // host or an editable public URL. SSH tunnels remain manageable even when
    // the advertised mobile endpoint is a different canonical address.
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(forbidden)?;
    let request_url =
        url::Url::parse(&format!("{}://{host}", url.scheme())).map_err(|_| forbidden())?;
    if request_url.origin() != url.origin()
        || !request_url.username().is_empty()
        || request_url.password().is_some()
        || request_url.path() != "/"
        || request_url.query().is_some()
        || request_url.fragment().is_some()
    {
        return Err(forbidden());
    }
    Ok(())
}

async fn bootstrap(State(state): State<AdminState>) -> Result<Json<Value>> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_roles WHERE role='owner'")
        .fetch_one(&state.repository.pool())
        .await?;
    Ok(Json(
        json!({"initialized":count>0,"setup_required":count==0,"version":"1"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupInput {
    setup_token: String,
    email: String,
    password: String,
    name: String,
    instance_name: String,
}
async fn setup(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(input): Json<SetupInput>,
) -> Result<Response> {
    rate_limit(&state, "setup", 5).await?;
    if !valid_token(&input.setup_token) {
        return Err(forbidden());
    }
    let authorized:i64=sqlx::query_scalar("SELECT COUNT(*) FROM admin_bootstrap WHERE id=1 AND token_hash=$1 AND consumed_at=0 AND NOT EXISTS(SELECT 1 FROM admin_roles WHERE role='owner')").bind(auth::hash_token(&input.setup_token)).fetch_one(&state.repository.pool()).await?;
    if authorized != 1 {
        return Err(forbidden());
    }
    let email = validate_email(&input.email)?;
    let name = tomorrow_domain::validate_text(&input.name, "name", 80).map_err(|_| invalid())?;
    let instance_name = tomorrow_domain::validate_text(&input.instance_name, "instance", 80)
        .map_err(|_| invalid())?;
    let existing = state
        .repository
        .credentials(&email)
        .await
        .map_err(|_| internal())?;
    let (id, hash) = if let Some((user, hash)) = existing {
        if !state.verify(input.password, hash.clone()).await? {
            return Err(forbidden());
        }
        (user.id, hash)
    } else {
        (
            tomorrow_domain::new_id(),
            state.password_hash(input.password).await?,
        )
    };
    let mut tx = state.repository.pool().begin().await?;
    sqlx::query("UPDATE admin_guard SET revision=revision+1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_roles WHERE role='owner'")
        .fetch_one(&mut *tx)
        .await?;
    let valid: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM admin_bootstrap WHERE id=1 AND token_hash=$1 AND consumed_at=0",
    )
    .bind(auth::hash_token(&input.setup_token))
    .fetch_one(&mut *tx)
    .await?;
    if owners != 0 || valid != 1 {
        return Err(forbidden());
    }
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id=$1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if exists == 0 {
        sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,$3,$4,'Asia/Shanghai',$5)").bind(&id).bind(&email).bind(hash).bind(name).bind(now()).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO admin_roles(user_id,role,created_at) VALUES($1,'owner',$2)")
        .bind(&id)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE admin_bootstrap SET consumed_at=$1,token_hash='' WHERE id=1")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let _ = tokio::fs::remove_file(state.config_dir.join("setup-token")).await;
    // Installation identity can be retried in the settings page if a concurrent administrator changed config.
    if let Ok(snapshot) = state.settings.snapshot().await {
        let mut changes = HashMap::new();
        changes.insert("INSTANCE_NAME".into(), Some(instance_name));
        let _ = state.settings.update(snapshot.revision, changes).await;
    }
    issue_session(&state, &id, &headers, None).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginInput {
    email: String,
    password: String,
}
async fn login(
    State(state): State<AdminState>,
    headers: HeaderMap,
    Json(input): Json<LoginInput>,
) -> Result<Response> {
    rate_limit(&state, "login-global", 60).await?;
    let email = validate_email(&input.email).unwrap_or_default();
    rate_limit(&state, &format!("login:{}", auth::hash_token(&email)), 5).await?;
    let found=sqlx::query("SELECT u.id,u.password_hash FROM users u JOIN admin_roles r ON r.user_id=u.id LEFT JOIN admin_user_controls c ON c.user_id=u.id WHERE u.email=$1 AND r.role IN ('owner','admin') AND COALESCE(c.disabled,0)=0")
        .bind(email).fetch_optional(&state.repository.pool()).await?;
    let hash = found
        .as_ref()
        .map(|row| row.get::<String, _>("password_hash"))
        .unwrap_or_else(|| DUMMY_HASH.into());
    let verified = state.verify(input.password, hash.clone()).await?;
    if !verified || found.is_none() {
        return Err(AdminError(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "邮箱或密码错误",
        ));
    }
    issue_session(
        &state,
        &found.unwrap().get::<String, _>("id"),
        &headers,
        Some(&hash),
    )
    .await
}

/// The mobile email route shares the exact administrator attempt buckets and
/// CPU budget. Owner passwords must not be guessable through an easier route.
pub async fn email_login(
    state: &AdminState,
    email: &str,
    password: String,
) -> std::result::Result<tomorrow_domain::AuthSession, DomainError> {
    let map_error = |error: AdminError| match error.0 {
        StatusCode::TOO_MANY_REQUESTS => DomainError::LoginRateLimited { retry_after: 60 },
        StatusCode::BAD_REQUEST => DomainError::Unauthorized,
        _ => DomainError::Unavailable("登录服务暂时不可用".into()),
    };
    rate_limit(state, "login-global", 60)
        .await
        .map_err(map_error)?;
    let email = validate_email(email).unwrap_or_default();
    rate_limit(state, &format!("login:{}", auth::hash_token(&email)), 5)
        .await
        .map_err(map_error)?;
    let found = state.repository.credentials(&email).await?;
    let hash = found
        .as_ref()
        .map(|(_, hash)| hash.clone())
        .unwrap_or_else(|| DUMMY_HASH.into());
    let verified = state
        .verify(password, hash.clone())
        .await
        .map_err(map_error)?;
    if !verified || found.is_none() {
        return Err(DomainError::Unauthorized);
    }
    let (user, _) = found.ok_or(DomainError::Unauthorized)?;
    let token = state
        .repository
        .create_session_for_password(&user.id, &hash)
        .await?;
    Ok(tomorrow_domain::AuthSession { user, token })
}
async fn rate_limit(state: &AdminState, bucket: &str, limit: i64) -> Result<()> {
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    let at = now();
    sqlx::query("UPDATE admin_guard SET revision=revision+1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_rate_windows WHERE started_at<$1")
        .bind(at - 120)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO admin_rate_windows(bucket,started_at,attempts) VALUES($1,$2,1) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN admin_rate_windows.started_at<$3 THEN 1 ELSE admin_rate_windows.attempts+1 END,started_at=CASE WHEN admin_rate_windows.started_at<$3 THEN $2 ELSE admin_rate_windows.started_at END")
        .bind(bucket).bind(at).bind(at-60).execute(&mut *tx).await?;
    let attempts: i64 =
        sqlx::query_scalar("SELECT attempts FROM admin_rate_windows WHERE bucket=$1")
            .bind(bucket)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    if attempts > limit {
        Err(busy())
    } else {
        Ok(())
    }
}
async fn issue_session(
    state: &AdminState,
    id: &str,
    headers: &HeaderMap,
    verified_hash: Option<&str>,
) -> Result<Response> {
    let pool = state.repository.pool();
    let token = auth::generate_token();
    let at = now();
    sqlx::query("DELETE FROM admin_sessions WHERE expires_at<=$1")
        .bind(at)
        .execute(&pool)
        .await?;
    // Bound live sessions per administrator while preserving recently issued sessions.
    sqlx::query("DELETE FROM admin_sessions WHERE user_id=$1 AND token_hash NOT IN (SELECT token_hash FROM admin_sessions WHERE user_id=$1 ORDER BY created_at DESC,token_hash DESC LIMIT 9)").bind(id).execute(&pool).await?;
    let mut transaction = pool.begin().await?;
    // Administrator password resets use the same first-write guard. A login
    // verified just before a reset cannot recreate a session after revocation.
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *transaction)
        .await?;
    let inserted=sqlx::query("INSERT INTO admin_sessions(token_hash,user_id,expires_at,created_at) SELECT $1,u.id,$2,$3 FROM users u JOIN admin_roles r ON r.user_id=u.id LEFT JOIN admin_user_controls c ON c.user_id=u.id WHERE u.id=$4 AND COALESCE(c.disabled,0)=0 AND ($5='' OR u.password_hash=$5)")
        .bind(auth::hash_token(&token)).bind(at+SESSION_SECONDS).bind(at).bind(id).bind(verified_hash.unwrap_or("")).execute(&mut *transaction).await?.rows_affected();
    if inserted != 1 {
        return Err(denied());
    }
    transaction.commit().await?;
    let mut cookie_headers = headers.clone();
    cookie_headers.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{COOKIE}={token}")).map_err(|_| internal())?,
    );
    let authenticated = authenticate(state, &cookie_headers).await?;
    let mut response = Json(session_json(&authenticated)).into_response();
    let secure = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|origin| origin.starts_with("https://"));
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}{}",
            if secure { "; Secure" } else { "" }
        ))
        .map_err(|_| internal())?,
    );
    Ok(response)
}
fn session_json(session: &AdminSession) -> Value {
    json!({"user":{"id":session.user_id,"email":session.email,"name":session.name,"role":session.role},"csrf_token":session.csrf_token,"expires_at":session.expires_at})
}
async fn session(session: AdminSession) -> Json<Value> {
    Json(session_json(&session))
}
async fn logout(State(state): State<AdminState>, session: AdminSession) -> Result<Response> {
    sqlx::query("DELETE FROM admin_sessions WHERE token_hash=$1")
        .bind(session.token_hash)
        .execute(&state.repository.pool())
        .await?;
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "tada_admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0",
        ),
    );
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnPasswordInput {
    current_password: String,
    new_password: String,
}
async fn change_own_password(
    State(state): State<AdminState>,
    session: AdminSession,
    headers: HeaderMap,
    Json(input): Json<OwnPasswordInput>,
) -> Result<Response> {
    rate_limit(&state, &format!("own-password:{}", session.user_id), 3).await?;
    let current: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=$1")
        .bind(&session.user_id)
        .fetch_one(&state.repository.pool())
        .await?;
    if !state
        .verify(input.current_password, current.clone())
        .await?
    {
        return Err(AdminError(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "当前密码不正确",
        ));
    }
    let replacement = state.password_hash(input.new_password).await?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let changed=sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2 AND password_hash=$3 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=users.id AND c.disabled<>0)").bind(&replacement).bind(&session.user_id).bind(current).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Err(denied());
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(&session.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE user_id=$1")
        .bind(&session.user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    issue_session(&state, &session.user_id, &headers, Some(&replacement)).await
}
fn validate_email(input: &str) -> Result<String> {
    auth::normalize_email(input).map_err(|_| invalid())
}

async fn manifest(State(state): State<AdminState>) -> Result<Response> {
    let body = manifest_value(&state).await?;
    let mut response = Json(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
async fn manifest_value(state: &AdminState) -> Result<Value> {
    let (revision, values) = state.settings.effective_snapshot().await?;
    let mut methods = Vec::new();
    if values
        .get("EMAIL_PASSWORD_ENABLED")
        .is_some_and(|v| v == "true")
    {
        methods.push("email_password")
    }
    if values
        .get("PHONE_PASSWORD_ENABLED")
        .is_some_and(|v| v == "true")
    {
        methods.push("phone_password")
    }
    Ok(
        json!({"id":state.settings.instance_id(),"name":values.get("INSTANCE_NAME"),"deployment_mode":values.get("INSTANCE_MODE"),"api_version":1,"auth_methods":methods,"registration_policy":values.get("REGISTRATION_POLICY"),"public_url":values.get("INSTANCE_PUBLIC_URL").filter(|v|!v.is_empty()),"configuration_revision":revision,"dataflow":dataflow(&values)}),
    )
}
fn dataflow(values: &HashMap<String, String>) -> Value {
    let get = |key: &str| values.get(key).map(String::as_str).unwrap_or("").trim();
    let present = |key: &str| !get(key).is_empty();
    let destination = |base: &str, enabled: bool| -> Value {
        let parsed = url::Url::parse(base).ok();
        if !enabled || parsed.is_none() {
            return json!({"processor":"disabled","destination":null});
        }
        let host = parsed.and_then(|u| u.host_str().map(str::to_owned));
        json!({"processor":"configured_provider","destination":host})
    };
    let generic = present("MODEL_BASE_URL") || present("MODEL_NAME") || present("MODEL_API_KEY");
    let model_base = if generic {
        if present("MODEL_BASE_URL") {
            get("MODEL_BASE_URL")
        } else {
            "https://api.openai.com/v1"
        }
    } else if present("DEEPSEEK_BASE_URL") {
        get("DEEPSEEK_BASE_URL")
    } else {
        "https://api.deepseek.com"
    };
    let model_ready = if generic {
        present("MODEL_NAME") && (present("MODEL_API_KEY") || local_url(model_base))
    } else {
        present("DEEPSEEK_API_KEY")
    };
    let asr_base = get("ASR_BASE_URL");
    // The ASR adapter permits self-hosted anonymous services. Even without a
    // credential, a complete endpoint/model can receive audio and must be shown.
    let asr_ready = present("ASR_BASE_URL") && present("ASR_MODEL");
    let image_base = if present("PHOTO_VISION_BASE_URL") {
        get("PHOTO_VISION_BASE_URL")
    } else if get("ASR_PROTOCOL") == "qwen_asr" && official_qwen(asr_base) {
        asr_base
    } else {
        ""
    };
    let image_key = present("PHOTO_VISION_API_KEY")
        || (!present("PHOTO_VISION_BASE_URL") && official_qwen(asr_base) && present("ASR_API_KEY"));
    let embedding_base = if present("PHOTO_EMBEDDING_BASE_URL") {
        get("PHOTO_EMBEDDING_BASE_URL")
    } else if get("ASR_PROTOCOL") == "qwen_asr" && official_qwen(asr_base) {
        asr_base
    } else {
        ""
    };
    let embedding_key = present("PHOTO_EMBEDDING_API_KEY")
        || (!present("PHOTO_EMBEDDING_BASE_URL")
            && official_qwen(asr_base)
            && present("ASR_API_KEY"));
    json!({"conversation":destination(model_base,model_ready),"voice":destination(asr_base,asr_ready),"images":destination(image_base,get("PHOTO_VISION_ENABLED")=="true"&&image_key),"embeddings":destination(embedding_base,get("PHOTO_EMBEDDING_ENABLED")=="true"&&embedding_key),"files":{"processor":"this_server","destination":null},"official_server_fallback":false})
}
fn local_url(base: &str) -> bool {
    url::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|host| {
            matches!(
                host.as_str(),
                "localhost" | "ollama" | "vllm" | "lmstudio" | "host.docker.internal"
            ) || host.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
                std::net::IpAddr::V4(v) => v.is_loopback() || v.is_private(),
                std::net::IpAddr::V6(v) => v.is_loopback() || v.is_unique_local(),
            })
        })
}
fn official_qwen(base: &str) -> bool {
    url::Url::parse(base).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
            && u.path().trim_end_matches('/') == "/compatible-mode/v1"
            && u.host_str().is_some_and(|h| {
                ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].contains(&h)
                    || h.ends_with(".cn-beijing.maas.aliyuncs.com")
                    || h.ends_with(".ap-southeast-1.maas.aliyuncs.com")
            })
    })
}
async fn runtime_config(State(state): State<AdminState>, headers: HeaderMap) -> Result<Response> {
    let expected = std::env::var("AGENT_SERVICE_TOKEN").unwrap_or_default();
    let received = headers
        .get("x-agent-service")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if expected.len() < 32 || !constant_eq(&expected, received) {
        return Err(denied());
    }
    let (revision, values) = state.settings.effective_snapshot().await?;
    let values: HashMap<_, _> = values
        .into_iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "MODEL_BASE_URL"
                    | "MODEL_NAME"
                    | "MODEL_API_KEY"
                    | "DEEPSEEK_BASE_URL"
                    | "DEEPSEEK_MODEL"
                    | "DEEPSEEK_API_KEY"
                    | "DEEPSEEK_SEARCH_API_KEY"
                    | "DEEPSEEK_WEB_ENABLED"
                    | "AGENT_MAX_WEB_SEARCHES"
                    | "AGENT_MAX_WEB_FETCHES"
                    | "AGENT_MAX_TURNS"
                    | "AGENT_MAX_TOOLS"
                    | "AGENT_TIMEOUT_MS"
                    | "AGENT_MAX_CONCURRENT"
            )
        })
        .collect();
    let mut response = Json(json!({"revision":revision,"values":values})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}
async fn status(State(state): State<AdminState>, _: AdminSession) -> Result<Json<Value>> {
    let pool = state.repository.pool();
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await?;
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(&pool)
        .await?;
    let uploads: Option<i64> = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
        .fetch_one(&pool)
        .await
        .ok();
    let disabled: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM admin_user_controls WHERE disabled=1")
            .fetch_one(&pool)
            .await?;
    let instance = manifest_value(&state).await?;
    let readiness = state.settings.readiness().await?;
    let group_status = |id: &str| {
        readiness
            .groups
            .iter()
            .find(|g| g.id == id)
            .map(|g| g.status)
            .unwrap_or("not_configured")
    };
    Ok(Json(
        json!({"configuration_revision":instance["configuration_revision"],"instance":instance,"counts":{"users":users,"disabled_users":disabled,"tasks":tasks,"uploads":uploads},"services":{"database":"healthy","model":group_status("model"),"speech":group_status("speech"),"storage":"configured","sms":group_status("sms")},"readiness":readiness,"capabilities":{"backups":"encrypted_export","diagnostics":"redacted","paid_connection_tests":false}}),
    ))
}
async fn config(State(state): State<AdminState>, session: AdminSession) -> Result<Json<Value>> {
    require_owner(&session)?;
    Ok(Json(
        serde_json::to_value(state.settings.snapshot().await?).map_err(|_| internal())?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigInput {
    expected_revision: i64,
    changes: HashMap<String, Option<String>>,
}
async fn update_config(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    if input.changes.len() > 100 {
        return Err(invalid());
    }
    let snapshot = state
        .settings
        .update(input.expected_revision, input.changes)
        .await?;
    Ok(Json(
        serde_json::to_value(snapshot).map_err(|_| internal())?,
    ))
}
async fn check_config(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    let readiness = state
        .settings
        .preview_readiness(input.expected_revision, &input.changes)
        .await?;
    Ok(Json(
        json!({"ok":true,"validation":"schema","readiness":readiness,"network_requests":0,"paid_requests":0,"message":"格式检查通过。请查看各组配置是否完整；未验证连接，未调用模型或发送短信。"}),
    ))
}
fn require_owner(session: &AdminSession) -> Result<()> {
    if session.role == "owner" {
        Ok(())
    } else {
        Err(forbidden())
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct UserListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
}
async fn users(
    State(state): State<AdminState>,
    _: AdminSession,
    Query(query): Query<UserListQuery>,
) -> Result<Json<Value>> {
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(100);
    if offset < 0 || !(1..=500).contains(&limit) {
        return Err(invalid());
    }
    let pool = state.repository.pool();
    let total: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM users")
        .fetch_one(&pool).await?;
    let rows=sqlx::query("SELECT u.id,u.email,u.name,p.phone,u.created_at,COALESCE(c.disabled,0) AS disabled,COALESCE(r.role,'user') AS role FROM users u LEFT JOIN phone_identities p ON p.user_id=u.id LEFT JOIN admin_user_controls c ON c.user_id=u.id LEFT JOIN admin_roles r ON r.user_id=u.id ORDER BY u.created_at DESC,u.id LIMIT $1 OFFSET $2").bind(limit).bind(offset).fetch_all(&pool).await?;
    let items:Vec<Value>=rows.into_iter().map(|row|json!({"id":row.get::<String,_>("id"),"email":row.get::<String,_>("email"),"phone":row.get::<Option<String>,_>("phone"),"name":row.get::<String,_>("name"),"created_at":timestamp(row.get::<i64,_>("created_at")),"disabled":row.get::<i64,_>("disabled")!=0,"role":row.get::<String,_>("role")})).collect();
    let has_more = offset.saturating_add(items.len() as i64) < total;
    Ok(Json(json!({"items":items,"offset":offset,"limit":limit,"total":total,"has_more":has_more})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateUserInput {
    email: String,
    password: String,
    name: String,
    role: Option<String>,
}
async fn create_user(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<CreateUserInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    rate_limit(&state, "create-user", 20).await?;
    let role = input.role.unwrap_or_else(|| "user".into());
    if role != "user" && role != "admin" {
        return Err(invalid());
    }
    let email = validate_email(&input.email)?;
    let name = tomorrow_domain::validate_text(&input.name, "name", 80).map_err(|_| invalid())?;
    let hash = state.password_hash(input.password).await?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    let id = tomorrow_domain::new_id();
    sqlx::query("UPDATE admin_guard SET revision=revision+1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let duplicate: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email=$1")
        .bind(&email)
        .fetch_one(&mut *tx)
        .await?;
    if duplicate > 0 {
        return Err(AdminError(
            StatusCode::CONFLICT,
            "account_exists",
            "该邮箱已存在",
        ));
    }
    sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,$3,$4,'Asia/Shanghai',$5)").bind(&id).bind(&email).bind(hash).bind(&name).bind(now()).execute(&mut *tx).await?;
    if role == "admin" {
        sqlx::query("INSERT INTO admin_roles(user_id,role,created_at) VALUES($1,'admin',$2)")
            .bind(&id)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(
        json!({"id":id,"email":email,"name":name,"role":role,"disabled":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserUpdate {
    disabled: bool,
}
async fn protect_target(state: &AdminState, session: &AdminSession, id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(invalid());
    }
    let role: Option<String> = sqlx::query_scalar("SELECT role FROM admin_roles WHERE user_id=$1")
        .bind(id)
        .fetch_optional(&state.repository.pool())
        .await?;
    if id == session.user_id
        || role.as_deref() == Some("owner")
        || (role.as_deref() == Some("admin") && session.role != "owner")
    {
        return Err(forbidden());
    }
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id=$1")
        .bind(id)
        .fetch_one(&state.repository.pool())
        .await?;
    if exists == 0 {
        return Err(AdminError(StatusCode::NOT_FOUND, "not_found", "用户不存在"));
    }
    Ok(())
}
async fn update_user(
    State(state): State<AdminState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(input): Json<UserUpdate>,
) -> Result<Json<Value>> {
    protect_target(&state, &session, &id).await?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    // This must precede every write (including admin_guard). A login that
    // verified before disable must commit before this transaction deletes its
    // token, rather than reviving when the account is later enabled again.
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE admin_guard SET revision=revision+1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO admin_user_controls(user_id,disabled,updated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET disabled=$2,updated_at=$3").bind(&id).bind(if input.disabled{1i64}else{0}).bind(now()).execute(&mut *tx).await?;
    if input.disabled {
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM admin_sessions WHERE user_id=$1")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE schedules SET enabled=0 WHERE user_id=$1")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE tasks SET status='cancelled',claimed_until=0,updated_at=$1 WHERE user_id=$2 AND status IN ('queued','running','waiting_approval')").bind(now()).bind(&id).execute(&mut *tx).await?;
        sqlx::query("UPDATE agent_runs SET status='cancelled',lease_until=0,updated_at=$1 WHERE user_id=$2 AND status='running'").bind(now()).bind(&id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"disabled":input.disabled})))
}
async fn revoke_sessions(
    State(state): State<AdminState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    protect_target(&state, &session, &id).await?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE user_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResetPasswordInput {
    new_password: String,
}
async fn reset_password(
    State(state): State<AdminState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(input): Json<ResetPasswordInput>,
) -> Result<Json<Value>> {
    protect_target(&state, &session, &id).await?;
    rate_limit(&state, "reset-password", 20).await?;
    let hash = state.password_hash(input.new_password).await?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    // Serialize against the existing phone-password reset/login guard as well.
    sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?;
    let phone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM phone_identities WHERE user_id=$1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if phone > 0 {
        sqlx::query("INSERT INTO phone_credentials(user_id,password_hash,updated_at) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET password_hash=$2,updated_at=$3").bind(&id).bind(hash).bind(now()).execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2")
            .bind(hash)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM sessions WHERE user_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE user_id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
async fn invites(State(state): State<AdminState>, _: AdminSession) -> Result<Json<Value>> {
    let rows=sqlx::query("SELECT id,created_at,expires_at,uses_remaining FROM admin_invites ORDER BY created_at DESC LIMIT 100").fetch_all(&state.repository.pool()).await?;
    let items:Vec<_>=rows.into_iter().map(|r|json!({"id":r.get::<String,_>("id"),"created_at":r.get::<i64,_>("created_at"),"expires_at":r.get::<i64,_>("expires_at"),"uses_remaining":r.get::<i64,_>("uses_remaining")})).collect();
    Ok(Json(json!({"items":items})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InviteInput {
    expires_in_hours: Option<i64>,
    max_uses: Option<i64>,
}
async fn create_invite(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<InviteInput>,
) -> Result<Json<Value>> {
    rate_limit(&state, "create-invite", 20).await?;
    let hours = input.expires_in_hours.unwrap_or(72);
    let uses = input.max_uses.unwrap_or(1);
    if !(1..=720).contains(&hours) || !(1..=100).contains(&uses) {
        return Err(invalid());
    }
    let id = tomorrow_domain::new_id();
    let token = auth::generate_token();
    let expires = now() + hours * 3600;
    let pool = state.repository.pool();
    sqlx::query("DELETE FROM admin_invites WHERE expires_at<$1 OR uses_remaining<=0")
        .bind(now() - 86400)
        .execute(&pool)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admin_invites")
        .fetch_one(&pool)
        .await?;
    if count >= 1000 {
        return Err(busy());
    }
    sqlx::query("INSERT INTO admin_invites(id,token_hash,created_by,created_at,expires_at,uses_remaining) VALUES($1,$2,$3,$4,$5,$6)").bind(&id).bind(auth::hash_token(&token)).bind(session.user_id).bind(now()).bind(expires).bind(uses).execute(&pool).await?;
    Ok(Json(
        json!({"id":id,"invite_code":token,"expires_at":expires,"uses_remaining":uses}),
    ))
}
async fn revoke_invite(
    State(state): State<AdminState>,
    _: AdminSession,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    if uuid::Uuid::parse_str(&id).is_err() {
        return Err(invalid());
    }
    sqlx::query("DELETE FROM admin_invites WHERE id=$1")
        .bind(id)
        .execute(&state.repository.pool())
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn diagnostics(State(state): State<AdminState>, _: AdminSession) -> Result<Json<Value>> {
    let snapshot = state.settings.snapshot().await?;
    // Deliberately omit all values, URLs, paths, logs and user content.
    let settings: Vec<_> = snapshot
        .settings
        .into_iter()
        .map(|s| json!({"key":s.key,"configured":s.configured,"source":s.source,"locked":s.locked}))
        .collect();
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"configuration_revision":snapshot.revision,"settings":settings,"contains_user_content":false,"contains_credentials":false,"generated_at":timestamp(now())}),
    ))
}

pub async fn ensure_user_enabled(pool: &AnyPool, id: &str) -> std::result::Result<(), DomainError> {
    let disabled: Option<i64> =
        sqlx::query_scalar("SELECT disabled FROM admin_user_controls WHERE user_id=$1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    if disabled.unwrap_or(0) != 0 {
        Err(DomainError::Unauthorized)
    } else {
        Ok(())
    }
}

/// Email signup consumes the invitation and inserts the user/session in one transaction.
pub async fn register_email(
    state: &AdminState,
    email: &str,
    password: String,
    name: &str,
    timezone: &str,
    invite_code: Option<&str>,
) -> std::result::Result<tomorrow_domain::AuthSession, DomainError> {
    let email =
        validate_email(email).map_err(|_| DomainError::Validation("请输入有效邮箱".into()))?;
    let name = tomorrow_domain::validate_text(name, "昵称", 80)?;
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(DomainError::Validation("无效的 IANA 时区".into()));
    }
    let values = state
        .settings
        .effective_values()
        .await
        .map_err(|_| DomainError::Unavailable("配置暂时不可用".into()))?;
    if values
        .get("EMAIL_PASSWORD_ENABLED")
        .is_none_or(|v| v != "true")
    {
        return Err(DomainError::Forbidden);
    }
    let policy = values
        .get("REGISTRATION_POLICY")
        .map(String::as_str)
        .unwrap_or("closed");
    if !matches!(policy, "open" | "invite_only") {
        return Err(DomainError::Forbidden);
    }
    let invitation = if policy == "invite_only" {
        let token = invite_code
            .filter(|t| valid_token(t))
            .ok_or(DomainError::Forbidden)?;
        Some(auth::hash_token(token))
    } else {
        None
    };
    rate_limit(state, "email-register", 30)
        .await
        .map_err(|_| DomainError::LoginRateLimited { retry_after: 60 })?;
    let hash = state
        .password_hash(password)
        .await
        .map_err(|_| DomainError::Validation("密码长度须为 8～128 个字符".into()))?;
    let pool = state.repository.pool();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE admin_guard SET revision=revision+1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    if let Some(invitation) = invitation {
        let changed=sqlx::query("UPDATE admin_invites SET uses_remaining=uses_remaining-1 WHERE token_hash=$1 AND expires_at>$2 AND uses_remaining>0").bind(invitation).bind(now()).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(DomainError::Forbidden);
        }
    }
    let duplicate: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email=$1")
        .bind(&email)
        .fetch_one(&mut *tx)
        .await?;
    if duplicate > 0 {
        return Err(DomainError::Conflict("该邮箱已注册".into()));
    }
    let id = tomorrow_domain::new_id();
    let at = now();
    let token = auth::generate_token();
    sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,$3,$4,$5,$6)").bind(&id).bind(&email).bind(hash).bind(&name).bind(timezone).bind(at).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)",
    )
    .bind(auth::hash_token(&token))
    .bind(&id)
    .bind(at + 30 * 86400)
    .bind(at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(tomorrow_domain::AuthSession {
        token,
        user: tomorrow_domain::User {
            id,
            email,
            phone: None,
            name,
            timezone: timezone.into(),
            created_at: timestamp(at),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use tomorrow_settings::ConfigOptions;
    use tower::ServiceExt;
    struct Fixture {
        state: AdminState,
        _dir: tempfile::TempDir,
    }
    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("admin.db");
        let repository = Repository::connect(&format!(
            "sqlite:{}",
            path.to_string_lossy().replace('\\', "/")
        ))
        .await
        .unwrap();
        let config_dir = dir.path().join("config");
        let settings = ConfigStore::with_options(
            repository.pool(),
            ConfigOptions {
                environment: HashMap::new(),
                config_dir: config_dir.clone(),
                master_key: None,
            },
        )
        .await
        .unwrap();
        let state = AdminState::with_directory(repository, settings, config_dir)
            .await
            .unwrap();
        Fixture { state, _dir: dir }
    }
    async fn call(
        state: &AdminState,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: Option<&str>,
        csrf: Option<&str>,
        origin: &str,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "unit.test")
            .header(header::ORIGIN, origin);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie)
        }
        if let Some(csrf) = csrf {
            builder = builder.header("x-csrf-token", csrf)
        }
        let request = if let Some(body) = body {
            builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        };
        let response = router(state.clone()).oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, body)
    }
    async fn owner(state: &AdminState) -> (String, String, String) {
        let token = tokio::fs::read_to_string(state.config_dir.join("setup-token"))
            .await
            .unwrap();
        let (status,headers,body)=call(state,Method::POST,"/admin/api/setup",Some(json!({"setup_token":token,"email":"owner@example.test","password":"secure owner password","name":"Owner","instance_name":"Test home"})),None,None,"https://unit.test").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
        assert!(
            set.contains("HttpOnly") && set.contains("SameSite=Strict") && set.contains("Secure")
        );
        (
            set.split(';').next().unwrap().into(),
            body["csrf_token"].as_str().unwrap().into(),
            body["user"]["id"].as_str().unwrap().into(),
        )
    }

    #[tokio::test]
    async fn users_list_includes_real_phone_identities_without_changing_email_roles_or_pagination() {
        let f = fixture().await;
        let (cookie, csrf, owner_id) = owner(&f.state).await;
        let first = f.state.repository.create_phone_user("13800138000", "Same name", "Asia/Shanghai").await.unwrap();
        let second = f.state.repository.create_phone_user("13900139000", "Same name", "Asia/Shanghai").await.unwrap();
        let mut listed = HashMap::new();
        for offset in [0, 2] {
            let (status, _, body) = call(&f.state, Method::GET,
                &format!("/admin/api/users?offset={offset}&limit=2"), None,
                Some(&cookie), None, "https://unit.test").await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["total"], 3);
            assert_eq!(body["offset"], offset);
            assert_eq!(body["has_more"], offset == 0);
            for item in body["items"].as_array().unwrap() {
                assert!(listed.insert(item["id"].as_str().unwrap().to_owned(), item.clone()).is_none());
            }
        }
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[&first.id]["phone"], "+8613800138000");
        assert_eq!(listed[&second.id]["phone"], "+8613900139000");
        assert_eq!(listed[&first.id]["name"], listed[&second.id]["name"]);
        assert_eq!(listed[&first.id]["email"], first.email);
        assert_eq!(listed[&first.id]["role"], "user");
        assert_eq!(listed[&owner_id]["email"], "owner@example.test");
        assert_eq!(listed[&owner_id]["phone"], Value::Null);
        assert_eq!(listed[&owner_id]["role"], "owner");
        let (status, _, _) = call(&f.state, Method::POST,
            &format!("/admin/api/users/{}/reset-password", first.id),
            Some(json!({"new_password":"new phone fixture password"})),
            Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        let credentials: Vec<String> = sqlx::query_scalar("SELECT user_id FROM phone_credentials")
            .fetch_all(&f.state.repository.pool()).await.unwrap();
        assert_eq!(credentials, vec![first.id]);
    }

    #[tokio::test]
    async fn users_pagination_reaches_accounts_beyond_five_hundred() {
        let f = fixture().await;
        let (cookie, _, _) = owner(&f.state).await;
        let pool = f.state.repository.pool();
        let mut tx = pool.begin().await.unwrap();
        for index in 0..501 {
            sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at) VALUES($1,$2,$3,$4,'UTC',$5)")
                .bind(format!("e02-user-{index:04}"))
                .bind(format!("e02-{index:04}@example.test"))
                .bind(DUMMY_HASH)
                .bind(format!("Pagination {index}"))
                .bind(1_i64)
                .execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        let mut ids = std::collections::HashSet::new();
        for offset in (0..600).step_by(100) {
            let (status, _, body) = call(&f.state, Method::GET,
                &format!("/admin/api/users?offset={offset}&limit=100"), None,
                Some(&cookie), None, "https://unit.test").await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["total"], 502);
            assert_eq!(body["offset"], offset);
            assert_eq!(body["limit"], 100);
            assert_eq!(body["has_more"], offset < 500);
            let items = body["items"].as_array().unwrap();
            assert_eq!(items.len(), if offset < 500 { 100 } else { 2 });
            for item in items {
                assert!(ids.insert(item["id"].as_str().unwrap().to_owned()), "duplicate page item");
            }
        }
        assert_eq!(ids.len(), 502);
        assert!(ids.contains("e02-user-0500"));
        for query in ["offset=-1", "limit=0", "limit=501"] {
            let (status, _, _) = call(&f.state, Method::GET,
                &format!("/admin/api/users?{query}"), None, Some(&cookie), None,
                "https://unit.test").await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "accepted {query}");
        }
        let (status, _, body) = call(&f.state, Method::GET, "/admin/api/users?offset=1000", None,
            Some(&cookie), None, "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());
        assert_eq!(body["has_more"], false);
        assert_eq!(body["total"], 502);
    }

    #[tokio::test]
    async fn malformed_email_creation_is_rejected_before_persistence() {
        let f = fixture().await;
        let (cookie, csrf, _) = owner(&f.state).await;
        let before: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM users")
            .fetch_one(&f.state.repository.pool()).await.unwrap();
        for email in ["@", "qa@", "@example.test", "qa@@example.test", "qa@example", "qa\r\n@example.test"] {
            let (status, _, _) = call(&f.state, Method::POST, "/admin/api/users", Some(json!({
                "email": email, "password": "valid account password", "name": "Invalid mailbox"
            })), Some(&cookie), Some(&csrf), "https://unit.test").await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "accepted {email:?}");
        }
        let after: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM users")
            .fetch_one(&f.state.repository.pool()).await.unwrap();
        assert_eq!(before, after);
        let (status, _, body) = call(&f.state, Method::POST, "/admin/api/users", Some(json!({
            "email": " User+tag@Example.TEST ", "password": "valid account password", "name": "Valid mailbox"
        })), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["email"], "user+tag@example.test");
    }
    #[tokio::test]
    async fn model_connection_probe_requires_owner_csrf_and_never_saves_configuration() {
        let f = fixture().await;
        let (cookie, csrf, user_id) = owner(&f.state).await;
        let revision = f.state.settings.revision().await.unwrap();
        let input = json!({"expected_revision":revision,"changes":{}});
        let path = "/admin/api/config/test-model";
        let (status, _, _) = call(&f.state, Method::POST, path, Some(input.clone()), None, None, "https://unit.test").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = call(&f.state, Method::POST, path, Some(input.clone()), Some(&cookie), None, "https://unit.test").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, body) = call(&f.state, Method::POST, path, Some(input.clone()), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["code"], "not_configured");
        assert_eq!(body["ok"], false);
        let (status, _, voice) = call(&f.state, Method::POST, "/admin/api/config/test-speech", Some(input.clone()), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(voice["code"], "not_configured");
        let (status, _, voice) = call(&f.state, Method::POST, "/admin/api/config/test-speech", Some(json!({
            "expected_revision":revision,"changes":{"ASR_PROTOCOL":"qwen_asr","ASR_MODEL":"unsupported-model",
            "ASR_BASE_URL":"http://127.0.0.1:9/v1","ASR_API_KEY":"fixture-temporary-private-key",
            "ASR_USER_DAILY_LIMIT":"12","ASR_GLOBAL_DAILY_LIMIT":"100"}
        })), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(voice["code"], "unsupported_model");
        assert!(!voice.to_string().contains("fixture-temporary-private-key"));
        assert!(!f.state.settings.effective_values().await.unwrap().contains_key("ASR_API_KEY"));
        assert_eq!(f.state.settings.effective_values().await.unwrap().get("ASR_USER_DAILY_LIMIT").map(String::as_str), Some("1000"));
        assert_eq!(f.state.settings.revision().await.unwrap(), revision);
        let held = f.state.model_probe_jobs.clone().acquire_owned().await.unwrap();
        let (status, _, _) = call(&f.state, Method::POST, path, Some(input.clone()), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        drop(held);
        let (status, _, _) = call(&f.state, Method::POST, path, Some(json!({"expected_revision":revision,"changes":{"SMS_PROVIDER":"disabled"}})), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        sqlx::query("UPDATE admin_roles SET role='admin' WHERE user_id=$1").bind(user_id).execute(&f.state.repository.pool()).await.unwrap();
        let (status, _, _) = call(&f.state, Method::POST, path, Some(input), Some(&cookie), Some(&csrf), "https://unit.test").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    #[tokio::test]
    async fn auxiliary_probes_require_owner_csrf_revision_and_never_save_or_enable_features() {
        for service in ["vision", "embedding"] {
            let f = fixture().await;
            let (cookie, csrf, user_id) = owner(&f.state).await;
            let revision = f.state.settings.revision().await.unwrap();
            let before = f.state.settings.effective_values().await.unwrap();
            let input = json!({"expected_revision":revision,"changes":{}});
            let path = format!("/admin/api/config/test-{service}");
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(input.clone()),None,None,"https://unit.test").await;
            assert_eq!(status,StatusCode::UNAUTHORIZED);
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(input.clone()),Some(&cookie),None,"https://unit.test").await;
            assert_eq!(status,StatusCode::FORBIDDEN);
            let (status, _, body) = call(&f.state,Method::POST,&path,Some(input.clone()),Some(&cookie),Some(&csrf),"https://unit.test").await;
            assert_eq!(status,StatusCode::OK); assert_eq!(body["code"],"not_configured");
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(json!({"expected_revision":revision+1,"changes":{}})),Some(&cookie),Some(&csrf),"https://unit.test").await;
            assert_eq!(status,StatusCode::CONFLICT);
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(json!({"expected_revision":revision,"changes":{"SMS_PROVIDER":"disabled"}})),Some(&cookie),Some(&csrf),"https://unit.test").await;
            assert_eq!(status,StatusCode::BAD_REQUEST);
            let held = f.state.model_probe_jobs.clone().acquire_owned().await.unwrap();
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(input.clone()),Some(&cookie),Some(&csrf),"https://unit.test").await;
            assert_eq!(status,StatusCode::TOO_MANY_REQUESTS); drop(held);
            assert_eq!(f.state.settings.revision().await.unwrap(),revision);
            assert_eq!(f.state.settings.effective_values().await.unwrap(),before);
            sqlx::query("UPDATE admin_roles SET role='admin' WHERE user_id=$1").bind(user_id).execute(&f.state.repository.pool()).await.unwrap();
            let (status, _, _) = call(&f.state,Method::POST,&path,Some(input),Some(&cookie),Some(&csrf),"https://unit.test").await;
            assert_eq!(status,StatusCode::FORBIDDEN);
        }
    }
    #[tokio::test]
    async fn setup_is_one_use_separate_session_and_cookie_is_revoked() {
        let f = fixture().await;
        let (_, _, body) = call(
            &f.state,
            Method::GET,
            "/admin/api/bootstrap",
            None,
            None,
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(body["setup_required"], true);
        let token = tokio::fs::read_to_string(f.state.config_dir.join("setup-token"))
            .await
            .unwrap();
        let (cookie, csrf, id) = owner(&f.state).await;
        assert!(!f.state.config_dir.join("setup-token").exists());
        let (status,_,_)=call(&f.state,Method::POST,"/admin/api/setup",Some(json!({"setup_token":token,"email":"other@example.test","password":"secure other password","name":"Other","instance_name":"Other"})),None,None,"https://unit.test").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let mobile = f.state.repository.create_session(&id).await.unwrap();
        let (status, _, _) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(&format!("{COOKIE}={mobile}")),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, body) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["user"]["role"], "owner");
        let (status, _, _) = call(
            &f.state,
            Method::POST,
            "/admin/api/logout",
            Some(json!({})),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    #[tokio::test]
    async fn csrf_origin_secret_redaction_revision_and_no_paid_check() {
        let f = fixture().await;
        let (cookie, csrf, _) = owner(&f.state).await;
        let revision = f.state.settings.revision().await.unwrap();
        let change = json!({"expected_revision":revision,"changes":{"MODEL_API_KEY":"private test key value","MODEL_NAME":"unit-model"}});
        let (status, _, _) = call(
            &f.state,
            Method::PATCH,
            "/admin/api/config",
            Some(change.clone()),
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, headers, _) = call(
            &f.state,
            Method::PATCH,
            "/admin/api/config",
            Some(change.clone()),
            Some(&cookie),
            Some(&csrf),
            "https://attacker.test",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!headers.contains_key("access-control-allow-origin"));
        let (status, _, body) = call(
            &f.state,
            Method::POST,
            "/admin/api/config/check",
            Some(change.clone()),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["paid_requests"], 0);
        assert_eq!(f.state.settings.revision().await.unwrap(), revision);
        let (status, headers, body) = call(
            &f.state,
            Method::PATCH,
            "/admin/api/config",
            Some(change.clone()),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert!(!body.to_string().contains("private test key value"));
        let (status, _, _) = call(
            &f.state,
            Method::PATCH,
            "/admin/api/config",
            Some(change),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (_, _, diagnostics) = call(
            &f.state,
            Method::GET,
            "/admin/api/diagnostics",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert!(!diagnostics.to_string().contains("private test key value"));
        assert_eq!(diagnostics["contains_credentials"], false);
        let revision = f.state.settings.revision().await.unwrap();
        f.state
            .settings
            .update(
                revision,
                HashMap::from([(
                    "INSTANCE_PUBLIC_URL".into(),
                    Some("https://advertised.example".into()),
                )]),
            )
            .await
            .unwrap();
        let headers = HeaderMap::from_iter([
            (header::HOST, HeaderValue::from_static("unit.test")),
            (
                header::ORIGIN,
                HeaderValue::from_static("https://unit.test"),
            ),
        ]);
        assert!(
            same_origin(&f.state, &headers).await.is_ok(),
            "a configured public URL must not break same-origin local administration"
        );
        let mut attacked = headers;
        attacked.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.test"),
        );
        attacked.insert(
            "x-forwarded-host",
            HeaderValue::from_static("attacker.test"),
        );
        assert!(
            same_origin(&f.state, &attacked).await.is_err(),
            "untrusted forwarded hosts do not authorize another origin"
        );
    }
    #[tokio::test]
    async fn disable_revokes_both_sessions_and_owner_cannot_be_disabled() {
        let f = fixture().await;
        let (cookie, csrf, owner_id) = owner(&f.state).await;
        let (status,_,body)=call(&f.state,Method::POST,"/admin/api/users",Some(json!({"email":"member@example.test","password":"secure member password","name":"Member"})),Some(&cookie),Some(&csrf),"https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        let id = body["id"].as_str().unwrap();
        let token = f.state.repository.create_session(id).await.unwrap();
        let task = f
            .state
            .repository
            .create_task(
                id,
                tomorrow_domain::CreateTask {
                    instruction: "Test task".into(),
                    title: None,
                    kind: None,
                    approval_required: None,
                    client_request_id: None,
                },
            )
            .await
            .unwrap();
        let schedule = f
            .state
            .repository
            .create_schedule(
                id,
                tomorrow_domain::CreateSchedule {
                    title: "Daily".into(),
                    instruction: "Test reminder".into(),
                    frequency: "daily".into(),
                    time: "09:00".into(),
                    timezone: "Asia/Shanghai".into(),
                    enabled: Some(true),
                    client_request_id: None,
                },
            )
            .await
            .unwrap();
        let run = f
            .state
            .repository
            .begin_agent_run(id, "test-disabled-agent", "fixture", None, None)
            .await
            .unwrap();
        let (status, _, _) = call(
            &f.state,
            Method::PATCH,
            &format!("/admin/api/users/{id}"),
            Some(json!({"disabled":true})),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(f.state.repository.authenticate(&token).await.is_err());
        assert!(ensure_user_enabled(&f.state.repository.pool(), id)
            .await
            .is_err());
        assert_eq!(
            f.state.repository.task(id, &task.id).await.unwrap().status,
            "cancelled"
        );
        assert!(
            !f.state
                .repository
                .schedule(id, &schedule.id)
                .await
                .unwrap()
                .enabled
        );
        assert!(matches!(
            f.state
                .repository
                .agent_authority(&run.id, &run.token)
                .await,
            Err(DomainError::Forbidden)
        ));
        let (status, _, _) = call(
            &f.state,
            Method::PATCH,
            &format!("/admin/api/users/{owner_id}"),
            Some(json!({"disabled":true})),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, body) = call(
            &f.state,
            Method::GET,
            "/admin/api/users",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.to_string().contains("password_hash"));
    }
    #[tokio::test]
    async fn invite_signup_is_atomic_and_default_registration_is_closed() {
        let f = fixture().await;
        let (cookie, csrf, _) = owner(&f.state).await;
        assert!(matches!(
            register_email(
                &f.state,
                "closed@example.test",
                "secure member password".into(),
                "Member",
                "Asia/Shanghai",
                None
            )
            .await,
            Err(DomainError::Forbidden)
        ));
        let revision = f.state.settings.revision().await.unwrap();
        f.state
            .settings
            .update(
                revision,
                HashMap::from([("REGISTRATION_POLICY".into(), Some("invite_only".into()))]),
            )
            .await
            .unwrap();
        let (status, _, body) = call(
            &f.state,
            Method::POST,
            "/admin/api/invites",
            Some(json!({"max_uses":1})),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let invitation = body["invite_code"].as_str().unwrap();
        let (_, _, listed) = call(
            &f.state,
            Method::GET,
            "/admin/api/invites",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert!(!listed.to_string().contains(invitation));
        let (a, b) = tokio::join!(
            register_email(
                &f.state,
                "one@example.test",
                "secure member password".into(),
                "One",
                "Asia/Shanghai",
                Some(invitation)
            ),
            register_email(
                &f.state,
                "two@example.test",
                "secure member password".into(),
                "Two",
                "Asia/Shanghai",
                Some(invitation)
            )
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&f.state.repository.pool())
            .await
            .unwrap();
        assert_eq!(count, 2);
    }
    #[tokio::test]
    async fn login_attempt_window_is_persistent_and_expired_session_rejected() {
        let f = fixture().await;
        let (cookie, _, _) = owner(&f.state).await;
        for _ in 0..5 {
            let (status, _, _) = call(
                &f.state,
                Method::POST,
                "/admin/api/login",
                Some(json!({"email":"owner@example.test","password":"wrong owner password"})),
                None,
                None,
                "https://unit.test",
            )
            .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let (status, _, _) = call(
            &f.state,
            Method::POST,
            "/admin/api/login",
            Some(json!({"email":"owner@example.test","password":"secure owner password"})),
            None,
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(
            matches!(
                email_login(
                    &f.state,
                    "owner@example.test",
                    "secure owner password".into()
                )
                .await,
                Err(DomainError::LoginRateLimited { .. })
            ),
            "the ordinary email route cannot bypass administrator attempt limits"
        );
        sqlx::query("UPDATE admin_sessions SET expires_at=0")
            .execute(&f.state.repository.pool())
            .await
            .unwrap();
        let (status, _, _) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn changing_own_password_rotates_cookie_and_revokes_all_previous_sessions() {
        let f = fixture().await;
        let (cookie, csrf, id) = owner(&f.state).await;
        let mobile = f.state.repository.create_session(&id).await.unwrap();
        let(status,headers,body)=call(&f.state,Method::POST,"/admin/api/password",Some(json!({"current_password":"secure owner password","new_password":"new secure owner password"})),Some(&cookie),Some(&csrf),"https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        let new_cookie = headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        assert_ne!(new_cookie, cookie);
        assert_ne!(body["csrf_token"], csrf);
        assert!(matches!(
            f.state.repository.authenticate(&mobile).await,
            Err(DomainError::Unauthorized)
        ));
        let (status, _, _) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(&cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = call(
            &f.state,
            Method::GET,
            "/admin/api/session",
            None,
            Some(new_cookie),
            None,
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, hash) = f
            .state
            .repository
            .credentials("owner@example.test")
            .await
            .unwrap()
            .unwrap();
        assert!(auth::verify_password("new secure owner password", &hash));
        assert!(!auth::verify_password("secure owner password", &hash));
    }
    #[test]
    fn privacy_destinations_follow_actual_provider_precedence_and_feature_switches() {
        let mut values = HashMap::from([("DEEPSEEK_API_KEY".into(), "secret".into())]);
        assert_eq!(
            dataflow(&values)["conversation"]["destination"],
            "api.deepseek.com"
        );
        values.insert("MODEL_BASE_URL".into(), "https://custom.example/v1".into());
        values.insert("MODEL_NAME".into(), "custom".into());
        assert_eq!(
            dataflow(&values)["conversation"]["processor"],
            "disabled",
            "generic configuration never borrows the DeepSeek credential"
        );
        values.insert("MODEL_API_KEY".into(), "othersecret".into());
        assert_eq!(
            dataflow(&values)["conversation"]["destination"],
            "custom.example"
        );
        values.insert("ASR_PROTOCOL".into(), "qwen_asr".into());
        values.insert(
            "ASR_BASE_URL".into(),
            "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
        );
        values.insert("ASR_MODEL".into(), "qwen-asr".into());
        values.insert("ASR_API_KEY".into(), "speechsecret".into());
        values.insert("PHOTO_VISION_ENABLED".into(), "false".into());
        values.insert("PHOTO_EMBEDDING_ENABLED".into(), "true".into());
        assert_eq!(dataflow(&values)["images"]["processor"], "disabled");
        assert_eq!(
            dataflow(&values)["embeddings"]["destination"],
            "dashscope.aliyuncs.com"
        );
        values.insert("PHOTO_VISION_ENABLED".into(), "true".into());
        assert_eq!(
            dataflow(&values)["images"]["destination"],
            "dashscope.aliyuncs.com"
        );
        values.insert(
            "ASR_BASE_URL".into(),
            "https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1".into(),
        );
        assert_eq!(dataflow(&values)["images"]["processor"], "disabled");
        assert_eq!(dataflow(&values)["official_server_fallback"], false);
    }

    #[tokio::test]
    #[ignore = "Requires a fresh isolated tomorrow_admin_test_* PostgreSQL database; no SMS/model calls"]
    async fn postgres_disable_serializes_with_inflight_login_and_old_token_never_revives() {
        let database = std::env::var("TEST_ADMIN_DATABASE_URL")
            .expect("set a fresh disposable TEST_ADMIN_DATABASE_URL");
        let name = database
            .split('?')
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        assert!(
            (database.starts_with("postgres://") || database.starts_with("postgresql://"))
                && name.starts_with("tomorrow_admin_test_")
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
            "only an explicitly disposable admin test database is permitted"
        );
        let repository = Repository::connect(&database).await.unwrap();
        let pool = repository.pool();
        let actual: String = sqlx::query_scalar("SELECT CAST(current_database() AS TEXT)")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(actual, name);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "test requires a new empty database and will not clear existing users"
        );
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let settings = ConfigStore::with_options(
            pool.clone(),
            ConfigOptions {
                environment: HashMap::new(),
                config_dir: config_dir.clone(),
                master_key: None,
            },
        )
        .await
        .unwrap();
        let state = AdminState::with_directory(repository, settings, config_dir)
            .await
            .unwrap();
        let (cookie, csrf, owner_id) = owner(&state).await;
        let(status,_,body)=call(&state,Method::POST,"/admin/api/users",Some(json!({"email":"racing@example.test","password":"secure member password","name":"Race"})),Some(&cookie),Some(&csrf),"https://unit.test").await;
        assert_eq!(status, StatusCode::OK);
        let id = body["id"].as_str().unwrap().to_owned();
        let old_token = auth::generate_token();
        let mut pending = pool.begin().await.unwrap();
        sqlx::query("UPDATE phone_password_guard SET singleton=singleton WHERE id=1")
            .execute(&mut *pending)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)",
        )
        .bind(auth::hash_token(&old_token))
        .bind(&id)
        .bind(now() + 3600)
        .bind(now())
        .execute(&mut *pending)
        .await
        .unwrap();
        let other_state = state.clone();
        let other_id = id.clone();
        let other_cookie = cookie.clone();
        let other_csrf = csrf.clone();
        let mut disabling = tokio::spawn(async move {
            call(
                &other_state,
                Method::PATCH,
                &format!("/admin/api/users/{other_id}"),
                Some(json!({"disabled":true})),
                Some(&other_cookie),
                Some(&other_csrf),
                "https://unit.test",
            )
            .await
            .0
        });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), &mut disabling)
                .await
                .is_err(),
            "disable must wait for the in-flight login guard before deleting sessions"
        );
        pending.commit().await.unwrap();
        assert_eq!(disabling.await.unwrap(), StatusCode::OK);
        let (status, _, _) = call(
            &state,
            Method::PATCH,
            &format!("/admin/api/users/{id}"),
            Some(json!({"disabled":false})),
            Some(&cookie),
            Some(&csrf),
            "https://unit.test",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            matches!(
                state.repository.authenticate(&old_token).await,
                Err(DomainError::Unauthorized)
            ),
            "a pre-disable login token cannot revive on re-enable"
        );
        // Delete only the two exact fixtures; callers destroy the disposable DB.
        for fixture_id in [&id, &owner_id] {
            sqlx::query("DELETE FROM users WHERE id=$1")
                .bind(fixture_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool.close().await;
    }
}
