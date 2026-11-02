//! Accounting at media-provider boundaries. Admission quotas are deliberately separate.
use crate::{AttachmentError, AttachmentsState};
use serde_json::Value;
use tomorrow_domain::{
    Repository,
    usage::{UsageDispatch, UsageIdentity, UsageMeasurements, UsageOutcome},
};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(crate) struct MediaUsage {
    repository: Repository,
    user: String,
    request_id: String,
    audio_ms: Option<i64>,
    image_count: Option<i64>,
}

impl MediaUsage {
    /// Call after all local validation, cache/consent and quota checks, immediately before send.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn dispatch(
        state: &AttachmentsState,
        user: &str,
        endpoint: &str,
        model: &str,
        capability: &str,
        purpose: &str,
        audio_ms: Option<i64>,
        image_count: Option<i64>,
    ) -> Result<Self, AttachmentError> {
        Self::begin(
            &state.repo,
            user,
            endpoint,
            model,
            capability,
            purpose,
            audio_ms,
            image_count,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn begin(
        repository: &Repository,
        user: &str,
        endpoint: &str,
        model: &str,
        capability: &str,
        purpose: &str,
        audio_ms: Option<i64>,
        image_count: Option<i64>,
    ) -> Result<Self, AttachmentError> {
        // Only a hostname is a display value. The core hashes the deployment;
        // neither URL paths/query credentials nor API keys enter the ledger.
        let provider = reqwest::Url::parse(endpoint)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| "configured-provider".into());
        let request_id = uuid::Uuid::new_v4().to_string();
        let deployment = deployment(endpoint);
        repository
            .usage_dispatch(
                user,
                UsageDispatch::new(
                    &request_id,
                    UsageIdentity::new(&deployment, model, model, &provider),
                    capability,
                    purpose,
                ),
            )
            .await
            .map_err(|_| AttachmentError::internal())?;
        Ok(Self {
            repository: repository.clone(),
            user: user.into(),
            request_id,
            audio_ms,
            image_count,
        })
    }

    pub(crate) async fn finish(
        &self,
        status: &str,
        envelope: Option<&Value>,
    ) -> Result<(), AttachmentError> {
        let mut measurements = envelope.map(measurements).unwrap_or_default();
        measurements.audio_ms = measurements.audio_ms.or(self.audio_ms);
        measurements.image_count = self.image_count;
        self.repository.usage_finish(&self.user, &self.request_id, UsageOutcome::new(status, measurements))
            .await.map_err(|_| {
                tracing::warn!(request_id = %self.request_id, "media usage finish could not be persisted; dispatched usage remains unknown");
                AttachmentError::internal()
            })
    }

    pub(crate) async fn transport_failure(
        &self,
        error: &reqwest::Error,
    ) -> Result<(), AttachmentError> {
        self.finish(
            if error.is_timeout() {
                "timeout"
            } else {
                "failed"
            },
            None,
        )
        .await
    }

    /// Error envelopes may still contain billable usage. Read only a small,
    /// time-bounded body and never return/log its provider-controlled contents.
    pub(crate) async fn rejected_response(&self, response: reqwest::Response) {
        if tokio::time::timeout(
            std::time::Duration::from_millis(500),
            self.read_json(response, 64 * 1024),
        )
        .await
        .is_err()
        {
            let _ = self.finish("failed", None).await;
        }
    }

    /// Persist the provider's counters before callers validate application content.
    /// If this future is cancelled, the durable dispatched/unknown row remains.
    pub(crate) async fn read_json(
        &self,
        mut response: reqwest::Response,
        limit: usize,
    ) -> Result<Value, AttachmentError> {
        let succeeded = response.status().is_success();
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if body.len() + chunk.len() <= limit => {
                    body.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                Err(error) => {
                    self.transport_failure(&error).await?;
                    return Err(response_error(error.is_timeout()));
                }
                _ => {
                    self.finish("failed", None).await?;
                    return Err(response_error(false));
                }
            }
        }
        let envelope = serde_json::from_slice::<Value>(&body);
        self.finish(
            if succeeded && envelope.is_ok() {
                "succeeded"
            } else {
                "failed"
            },
            envelope.as_ref().ok(),
        )
        .await?;
        if !succeeded {
            return Err(response_error(false));
        }
        envelope.map_err(|_| response_error(false))
    }
}

fn deployment(endpoint: &str) -> String {
    // Config adapters append these fixed paths to the configured provider base.
    // Recover that base so admin pricing and all capabilities share one identity.
    for suffix in ["/audio/transcriptions", "/chat/completions", "/embeddings"] {
        if let Some(base) = endpoint.strip_suffix(suffix) {
            return base.to_owned();
        }
    }
    endpoint.to_owned()
}

fn response_error(timeout: bool) -> AttachmentError {
    AttachmentError::new(
        if timeout {
            axum::http::StatusCode::GATEWAY_TIMEOUT
        } else {
            axum::http::StatusCode::BAD_GATEWAY
        },
        "media_provider_response",
        "模型服务响应未完成，请稍后重试",
    )
}

fn count(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_i64)
            .filter(|count| (0..=MAX_SAFE_INTEGER).contains(count))
    })
}

fn seconds_ms(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let seconds = value.pointer(path)?.as_f64()?;
        let millis = (seconds * 1000.0).round();
        (seconds.is_finite() && seconds >= 0.0 && millis <= MAX_SAFE_INTEGER as f64)
            .then_some(millis as i64)
    })
}

pub(crate) fn measurements(envelope: &Value) -> UsageMeasurements {
    UsageMeasurements {
        // OpenAI-compatible prompt/input totals already include cache tokens.
        input_tokens: count(envelope, &["/usage/prompt_tokens", "/usage/input_tokens"]),
        output_tokens: count(
            envelope,
            &["/usage/completion_tokens", "/usage/output_tokens"],
        ),
        cache_read_tokens: count(
            envelope,
            &[
                "/usage/prompt_tokens_details/cached_tokens",
                "/usage/input_tokens_details/cached_tokens",
                "/usage/cache_read_tokens",
                "/usage/prompt_cache_hit_tokens",
            ],
        ),
        cache_write_tokens: count(
            envelope,
            &[
                "/usage/cache_write_tokens",
                "/usage/cache_creation_input_tokens",
                "/usage/prompt_tokens_details/cache_write_tokens",
                "/usage/input_tokens_details/cache_write_tokens",
            ],
        ),
        // Qwen ASR/OpenAI duration-billed ASR: usage.seconds; verbose ASR: duration.
        // Audio token counts and network elapsed time are never durations.
        audio_ms: count(envelope, &["/usage/audio_ms"])
            .or_else(|| seconds_ms(envelope, &["/usage/seconds", "/duration"])),
        image_count: None,
    }
}

/// Measure PCM/IEEE float WAVE sample frames, never a heuristic from upload size.
/// Unsupported/compressed, truncated, or internally inconsistent containers stay unknown.
pub(crate) fn wav_duration_ms(bytes: &[u8]) -> Option<i64> {
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let read_u32 = |at: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    let read_u16 = |at: usize| -> Option<u16> {
        Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
    };
    let end = usize::try_from(read_u32(4)?).ok()?.checked_add(8)?;
    if end > bytes.len() {
        return None;
    }
    let mut offset: usize = 12;
    let mut format = None;
    let mut data_size: u64 = 0;
    let mut has_data = false;
    while offset.checked_add(8)? <= end {
        let size = usize::try_from(read_u32(offset + 4)?).ok()?;
        let start = offset.checked_add(8)?;
        let next = start.checked_add(size)?;
        if next > end {
            return None;
        }
        match bytes.get(offset..offset + 4)? {
            b"fmt " if size >= 16 => {
                let encoding = read_u16(start)?;
                let channels = u64::from(read_u16(start + 2)?);
                let rate = u64::from(read_u32(start + 4)?);
                let byte_rate = u64::from(read_u32(start + 8)?);
                let alignment = u64::from(read_u16(start + 12)?);
                let bits = u64::from(read_u16(start + 14)?);
                if ![1, 3].contains(&encoding)
                    || channels == 0
                    || rate == 0
                    || bits == 0
                    || bits % 8 != 0
                    || alignment != channels.checked_mul(bits / 8)?
                    || byte_rate != rate.checked_mul(alignment)?
                {
                    return None;
                }
                format = Some((rate, alignment));
            }
            b"data" => {
                data_size = data_size.checked_add(size as u64)?;
                has_data = true;
            }
            _ => {}
        }
        offset = next.checked_add(size % 2)?;
    }
    let (rate, alignment) = format?;
    if !has_data || data_size % alignment != 0 {
        return None;
    }
    let frames = data_size / alignment;
    let millis = frames.checked_mul(1000)?.checked_add(rate / 2)? / rate;
    i64::try_from(millis)
        .ok()
        .filter(|millis| *millis <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests;
