//! Backend-only transcription adapters and durable attempted-call admission.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::LazyLock;
use tokio::sync::{Semaphore, SemaphorePermit};

pub(super) static ACTIVE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));
const WINDOW: i64 = 86400;
pub(super) const RUNNING_LEASE_SECONDS: i64 = 150;
pub(super) const OPERATION_TIMEOUT_SECONDS: u64 = 130;
pub(super) const QUEUE_WAIT_SECONDS: u64 = 15;
pub(super) const MAX_AUDIO_BYTES: u64 = 7 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Limits {
    pub user_daily: i64,
    pub global_daily: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { user_daily: 1000, global_daily: 5000 }
    }
}

impl Limits {
    pub(super) fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, AttachmentError> {
        let parse = |key, default| match get(key).filter(|value| !value.trim().is_empty()) {
            None => Ok(default),
            Some(value) => value.trim().parse::<i64>().ok().filter(|value| (1..=1_000_000).contains(value))
                .ok_or_else(|| AttachmentError::validation(format!("{key} 须为 1 到 1000000 之间的整数"))),
        };
        Ok(Self {
            user_daily: parse("ASR_USER_DAILY_LIMIT", Self::default().user_daily)?,
            global_daily: parse("ASR_GLOBAL_DAILY_LIMIT", Self::default().global_daily)?,
        })
    }
}

#[derive(Clone, Copy)]
pub(super) enum Protocol {
    Multipart,
    Qwen,
}

pub(super) async fn initialize(pool: &AnyPool) -> Result<(), AttachmentError> {
    for statement in [
        "CREATE TABLE IF NOT EXISTS asr_guard(id BIGINT PRIMARY KEY, singleton BIGINT NOT NULL)",
        "INSERT INTO asr_guard(id,singleton) VALUES(1,0) ON CONFLICT(id) DO NOTHING",
        "CREATE TABLE IF NOT EXISTS asr_attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,upload_id TEXT NOT NULL,requested_at BIGINT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS asr_attempts_time ON asr_attempts(requested_at)",
        "CREATE INDEX IF NOT EXISTS asr_attempts_user_time ON asr_attempts(user_id,requested_at)",
        "CREATE INDEX IF NOT EXISTS asr_attempts_user_upload ON asr_attempts(user_id,upload_id)",
        "CREATE TABLE IF NOT EXISTS asr_jobs(upload_id TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at BIGINT NOT NULL)",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

fn retryable(status: StatusCode, code: &'static str, message: &'static str, seconds: i64) -> AttachmentError {
    let mut error = AttachmentError::new(
        status, code, message,
    );
    error.retry_after = Some(seconds.max(1));
    error
}

pub(super) fn timed_out() -> AttachmentError {
    AttachmentError::new(StatusCode::GATEWAY_TIMEOUT, "asr_timeout", "语音识别等待超时，录音已保留；请手动重试")
}

pub(super) async fn acquire(semaphore: &Semaphore, wait: Duration) -> Result<SemaphorePermit<'_>, AttachmentError> {
    match tokio::time::timeout(wait, semaphore.acquire()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(retryable(StatusCode::SERVICE_UNAVAILABLE, "asr_busy", "语音转写排队繁忙，尚未调用识别服务；请稍后重试", 2)),
    }
}

fn pending_error(updated_at: i64, now: i64) -> Option<AttachmentError> {
    (updated_at > now - RUNNING_LEASE_SECONDS).then(|| retryable(
        StatusCode::TOO_MANY_REQUESTS, "asr_in_progress",
        "这条录音正在转写，请稍后重试查看结果，不必重新录音",
        updated_at.saturating_add(RUNNING_LEASE_SECONDS).saturating_sub(now),
    ))
}

/// Snapshot the attempted-call generation before queueing. This prevents a
/// queued duplicate from silently becoming a paid retry after its peer fails.
pub(super) async fn observe(state: &AttachmentsState, user: &str, upload: &str) -> Result<i64, AttachmentError> {
    let attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM asr_attempts WHERE user_id=$1 AND upload_id=$2")
        .bind(user).bind(upload).fetch_one(&state.pool).await?;
    let pending: Option<i64> = sqlx::query_scalar("SELECT CAST(updated_at AS BIGINT) FROM asr_jobs WHERE upload_id=$1 AND status='running'")
        .bind(upload).fetch_optional(&state.pool).await?;
    if let Some(error) = pending.and_then(|at| pending_error(at, chrono::Utc::now().timestamp())) {
        return Err(error);
    }
    Ok(attempts)
}

/// Serialize check+reservation across processes. Failed/ambiguous calls keep quota.
/// Returns an already-completed transcript after waiting for the lock, if present.
pub(super) async fn reserve(
    state: &AttachmentsState,
    user: &str,
    upload: &str,
    limits: Limits,
    observed_attempts: i64,
) -> Result<Option<String>, AttachmentError> {
    let mut tx = state.pool.begin().await?;
    if sqlx::query("UPDATE asr_guard SET singleton=singleton WHERE id=1")
        .execute(&mut *tx)
        .await?
        .rows_affected()
        != 1
    {
        return Err(AttachmentError::internal());
    }
    let now = chrono::Utc::now().timestamp();
    let cached: Option<String> =
        sqlx::query_scalar("SELECT transcript FROM uploads WHERE id=$1 AND user_id=$2")
            .bind(upload)
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    if cached.is_some() {
        tx.commit().await?;
        return Ok(cached);
    }
    let pending: Option<i64> = sqlx::query_scalar(
        "SELECT CAST(updated_at AS BIGINT) FROM asr_jobs WHERE upload_id=$1 AND status='running'",
    )
    .bind(upload)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(error) = pending.and_then(|at| pending_error(at, now)) { return Err(error); }
    let current_attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM asr_attempts WHERE user_id=$1 AND upload_id=$2")
        .bind(user).bind(upload).fetch_one(&mut *tx).await?;
    if current_attempts != observed_attempts {
        return Err(AttachmentError::new(StatusCode::CONFLICT, "asr_retry_required",
            "上次语音转写未完成，录音已保留；请点击重试，不会自动重复调用识别服务"));
    }
    // Expiry is a query boundary, not deletion: failed and ambiguous attempts
    // remain auditable and still count until their own 24-hour window expires.
    for (scope, limit) in [(Some(user), limits.user_daily), (None, limits.global_daily)] {
        let blocking: Option<i64> = if let Some(user) = scope {
            sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM asr_attempts WHERE user_id=$1 AND requested_at>$2 ORDER BY requested_at DESC LIMIT 1 OFFSET $3")
                .bind(user).bind(now-WINDOW).bind(limit-1).fetch_optional(&mut *tx).await?
        } else {
            sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM asr_attempts WHERE requested_at>$1 ORDER BY requested_at DESC LIMIT 1 OFFSET $2")
                .bind(now-WINDOW).bind(limit-1).fetch_optional(&mut *tx).await?
        };
        if let Some(at) = blocking {
            let (code, message) = if scope.is_some() {
                ("asr_user_daily_limit", "当前账号最近 24 小时的语音转写次数已达上限，请在额度恢复后重试")
            } else {
                ("asr_global_daily_limit", "这台服务器最近 24 小时的语音转写额度已用完，请稍后重试或联系管理员")
            };
            return Err(retryable(StatusCode::TOO_MANY_REQUESTS, code, message, at.saturating_add(WINDOW).saturating_sub(now)));
        }
    }
    sqlx::query("INSERT INTO asr_attempts(id,user_id,upload_id,requested_at) VALUES($1,$2,$3,$4)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(user)
        .bind(upload)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO asr_jobs(upload_id,status,updated_at) VALUES($1,'running',$2) ON CONFLICT(upload_id) DO UPDATE SET status='running',updated_at=$2")
        .bind(upload).bind(now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(None)
}

pub(super) async fn perform(
    state: &AttachmentsState,
    config: &AsrConfig,
    upload: &Upload,
    bytes: Vec<u8>,
) -> Result<String, AttachmentError> {
    let operation_id = uuid::Uuid::new_v4();
    let mut request = match config.protocol {
        Protocol::Multipart => {
            let part = reqwest::multipart::Part::bytes(bytes).file_name(upload.name.clone()).mime_str(&upload.mime_type)
                .map_err(|_| AttachmentError::validation("无效的音频格式"))?;
            state.client.post(&config.endpoint).multipart(reqwest::multipart::Form::new()
                .part("file",part).text("model",config.model.clone()).text("response_format","json"))
        },
        Protocol::Qwen => state.client.post(&config.endpoint).json(&serde_json::json!({
            "model":config.model,"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":format!("data:{};base64,{}",upload.mime_type,STANDARD.encode(bytes))}}]}],
            "stream":false,"asr_options":{"enable_itn":true}
        })),
    };
    if let Some(key) = &config.api_key {
        request = request.bearer_auth(key);
    }
    let mut response = request.send().await.map_err(|error| {
        let is_timeout = error.is_timeout();
        tracing::warn!(%operation_id, timeout = is_timeout, "ASR provider connection did not complete");
        if is_timeout { timed_out() } else { AttachmentError::new(
            StatusCode::BAD_GATEWAY, "asr_unavailable", "无法连接语音识别服务，录音已保留；请手动重试",
        ) }
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let error = provider_error(status, response.headers());
        // Only locally generated correlation and numeric status are logged.
        // Never read/echo an upstream error body, token or reflected header.
        tracing::warn!(%operation_id, upstream_status = status.as_u16(), code = error.code, "ASR provider rejected the operation");
        return Err(error);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        tracing::warn!(%operation_id, timeout = error.is_timeout(), "ASR provider response did not complete");
        if error.is_timeout() { timed_out() } else { AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_failed",
            "语音识别响应中断，录音已保留；请手动重试",
        ) }
    })? {
        if body.len() + chunk.len() > MAX_TRANSCRIPT_BYTES {
            return Err(AttachmentError::new(
                StatusCode::BAD_GATEWAY,
                "asr_response_too_large",
                "识别文字过长，请分段录制",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let result: serde_json::Value = serde_json::from_slice(&body).map_err(|_| {
        AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_invalid_response",
            "语音识别返回了无效结果",
        )
    })?;
    let text = match config.protocol {
        Protocol::Multipart => result.get("text").and_then(|s| s.as_str()),
        Protocol::Qwen => result
            .pointer("/choices/0/message/content")
            .and_then(|s| s.as_str()),
    }
    .ok_or_else(|| {
        AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_invalid_response",
            "语音识别返回了无效结果",
        )
    })?
    .trim()
    .to_owned();
    if text.is_empty() {
        return Err(AttachmentError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_speech",
            "未听清语音，请靠近麦克风后重试",
        ));
    }
    Ok(text)
}

fn provider_retry_after(headers: &HeaderMap) -> i64 {
    let Some(value) = headers.get(header::RETRY_AFTER).and_then(|value| value.to_str().ok()) else { return 30; };
    let seconds = value.trim().parse::<i64>().ok().or_else(|| chrono::DateTime::parse_from_rfc2822(value).ok()
        .map(|at| at.timestamp().saturating_sub(chrono::Utc::now().timestamp())));
    seconds.unwrap_or(30).clamp(1, 86400)
}

fn provider_error(status: StatusCode, headers: &HeaderMap) -> AttachmentError {
    match status.as_u16() {
        401 | 403 => AttachmentError::new(StatusCode::BAD_GATEWAY, "asr_provider_auth", "语音识别服务的密钥无效或权限不足，请联系管理员检查配置"),
        402 => AttachmentError::new(StatusCode::BAD_GATEWAY, "asr_provider_quota", "语音识别服务商的余额或额度不足，请联系管理员"),
        429 => retryable(StatusCode::SERVICE_UNAVAILABLE, "asr_provider_rate_limited", "语音识别服务商正在限流，录音已保留；请稍后手动重试", provider_retry_after(headers)),
        408 | 500..=599 => retryable(StatusCode::SERVICE_UNAVAILABLE, "asr_provider_unavailable", "语音识别服务商暂时不可用，录音已保留；请稍后手动重试", provider_retry_after(headers)),
        300..=399 => AttachmentError::new(StatusCode::BAD_GATEWAY, "asr_provider_redirect", "语音识别地址返回重定向，已停止请求以保护密钥，请联系管理员"),
        _ => AttachmentError::new(StatusCode::BAD_GATEWAY, "asr_failed", "语音识别服务未接受请求，录音已保留；请检查音频格式或联系管理员"),
    }
}
