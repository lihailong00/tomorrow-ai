//! Backend-only transcription adapters and durable attempted-call admission.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::sync::LazyLock;
use tokio::sync::Semaphore;

pub(super) static ACTIVE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));
const WINDOW: i64 = 86400;
const DAILY_LIMIT: i64 = 50;
const USER_LIMIT: i64 = 20;
pub(super) const MAX_AUDIO_BYTES: u64 = 7 * 1024 * 1024;

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
        "CREATE TABLE IF NOT EXISTS asr_jobs(upload_id TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at BIGINT NOT NULL)",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    Ok(())
}

pub(super) fn limited(seconds: i64) -> AttachmentError {
    let mut error = AttachmentError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "语音转写繁忙或已达今日额度，请稍后重试",
    );
    error.retry_after = Some(seconds.max(1));
    error
}

/// Serialize check+reservation across processes. Failed/ambiguous calls keep quota.
/// Returns an already-completed transcript after waiting for the lock, if present.
pub(super) async fn reserve(
    state: &AttachmentsState,
    user: &str,
    upload: &str,
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
    if let Some(at) = pending {
        if at > now - 150 {
            return Err(limited(at.saturating_add(150).saturating_sub(now)));
        }
    }
    sqlx::query("DELETE FROM asr_attempts WHERE requested_at<=$1")
        .bind(now - WINDOW)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM asr_jobs WHERE updated_at<=$1")
        .bind(now - WINDOW)
        .execute(&mut *tx)
        .await?;
    for (scope, limit) in [(None, DAILY_LIMIT), (Some(user), USER_LIMIT)] {
        let blocking: Option<i64> = if let Some(user) = scope {
            sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM asr_attempts WHERE user_id=$1 ORDER BY requested_at DESC LIMIT 1 OFFSET $2")
                .bind(user).bind(limit-1).fetch_optional(&mut *tx).await?
        } else {
            sqlx::query_scalar("SELECT CAST(requested_at AS BIGINT) FROM asr_attempts ORDER BY requested_at DESC LIMIT 1 OFFSET $1")
                .bind(limit-1).fetch_optional(&mut *tx).await?
        };
        if let Some(at) = blocking {
            return Err(limited(at.saturating_add(WINDOW).saturating_sub(now)));
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
    let mut response = request.send().await.map_err(|_| {
        AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_unavailable",
            "语音识别连接失败或超时，录音仍可重试",
        )
    })?;
    if !response.status().is_success() {
        return Err(AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_failed",
            "语音识别服务未接受请求，请稍后重试",
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        AttachmentError::new(
            StatusCode::BAD_GATEWAY,
            "asr_failed",
            "语音识别响应中断，请重试",
        )
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
