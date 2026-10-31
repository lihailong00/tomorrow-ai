//! Atomic, public destination disclosure and fail-closed photo consent.
use super::*;
#[cfg(test)]
mod tests;

pub(super) struct Snapshot {
    pub revision: Option<i64>,
    pub scope: String,
    pub image: Option<semantic::Config>,
    pub embedding: Option<semantic::Config>,
}
pub(super) struct Consent {
    pub configuration: Snapshot,
    pub enabled: bool,
    pub epoch: i64,
    pub allowed: bool,
    pub required: bool,
    pub reason: Option<&'static str>,
}

impl Snapshot {
    fn new(
        revision: Option<i64>,
        image: Option<semantic::Config>,
        embedding: Option<semantic::Config>,
    ) -> Self {
        // Consent is about destinations, not secret rotation or vector math.
        let destinations = (
            image.as_ref().map(|c| c.destination()),
            embedding.as_ref().map(|c| c.destination()),
        );
        let scope = format!(
            "photo-consent-v1:{}",
            semantic::hash(&serde_json::to_vec(&destinations).expect("destinations serialize"))
        );
        Self {
            revision,
            scope,
            image,
            embedding,
        }
    }
    pub fn disclosure(&self) -> serde_json::Value {
        let describe = |config: &Option<semantic::Config>| {
            json!({
                "processor":if config.is_some(){"configured_provider"}else{"not_configured"},
                "destination":config.as_ref().and_then(|c|c.public_destination()),
            })
        };
        json!({"images":describe(&self.image),"embeddings":describe(&self.embedding)})
    }
}

pub(super) async fn current(state: &AttachmentsState) -> Result<Snapshot, AttachmentError> {
    if let Some(load) = &state.photo_configuration {
        let (revision, values) = load().await.ok_or_else(changed)?;
        let get = |name: &str| values.get(name).cloned();
        // Optional provider errors disable that external capability, matching
        // reconfigured(). They must not prevent local OCR/keyword operations.
        return Ok(Snapshot::new(
            Some(revision),
            vision::config_from(get).unwrap_or(None),
            semantic::config_from(get).unwrap_or(None),
        ));
    }
    Ok(Snapshot::new(
        None,
        state.photo_vision.config.clone(),
        state.photo_index.config.clone(),
    ))
}

pub(super) fn changed() -> AttachmentError {
    AttachmentError::new(
        StatusCode::CONFLICT,
        "photo_cloud_consent_changed",
        "云端处理目标或授权已变化，请更新客户端并重新查看图片与文字处理服务，再确认授权",
    )
}

/// Resolve settings before taking the SQLite transaction's only connection.
pub(super) async fn refresh(
    state: &AttachmentsState,
    user: &str,
    device: &str,
) -> Result<Consent, AttachmentError> {
    let configuration = current(state).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE photo_index_devices SET epoch=epoch WHERE user_id=$1 AND device_id=$2")
        .bind(user)
        .bind(device)
        .execute(&mut *tx)
        .await?;
    let row: Option<(i64,i64)> = sqlx::query_as("SELECT CAST(enabled AS BIGINT),CAST(epoch AS BIGINT) FROM photo_index_devices WHERE user_id=$1 AND device_id=$2")
        .bind(user).bind(device).fetch_optional(&mut *tx).await?;
    let (enabled, mut epoch) = row.unwrap_or((0, 0));
    let grant: Option<(i64,Option<String>,i64)> = sqlx::query_as("SELECT CAST(epoch AS BIGINT),provider_scope,CAST(invalidated AS BIGINT) FROM photo_cloud_consents WHERE user_id=$1 AND device_id=$2")
        .bind(user).bind(device).fetch_optional(&mut *tx).await?;
    let mut allowed = false;
    let mut required = false;
    let mut reason = None;
    if enabled == 1 {
        if let Some((accepted_epoch, scope, invalidated)) = grant {
            allowed = invalidated == 0
                && accepted_epoch == epoch
                && scope.as_deref() == Some(&configuration.scope);
            if !allowed {
                required = true;
                reason = Some(if scope.as_deref().is_none_or(str::is_empty) {
                    "legacy_consent"
                } else {
                    "provider_changed"
                });
                if invalidated == 0 {
                    epoch += 1;
                    sqlx::query(
                        "UPDATE photo_index_devices SET epoch=$3 WHERE user_id=$1 AND device_id=$2",
                    )
                    .bind(user)
                    .bind(device)
                    .bind(epoch)
                    .execute(&mut *tx)
                    .await?;
                    sqlx::query("UPDATE photo_cloud_consents SET invalidated=1 WHERE user_id=$1 AND device_id=$2")
                        .bind(user).bind(device).execute(&mut *tx).await?;
                    for table in ["photo_embedding_jobs", "photo_vision_jobs"] {
                        sqlx::query(&format!(
                            "DELETE FROM {table} WHERE user_id=$1 AND device_id=$2"
                        ))
                        .bind(user)
                        .bind(device)
                        .execute(&mut *tx)
                        .await?;
                    }
                    sqlx::query("UPDATE photo_vision_task_state SET status='failed' WHERE user_id=$1 AND device_id=$2 AND status='processing'")
                        .bind(user).bind(device).execute(&mut *tx).await?;
                }
            }
        }
    }
    tx.commit().await?;
    Ok(Consent {
        configuration,
        enabled: enabled == 1,
        epoch,
        allowed,
        required,
        reason,
    })
}

pub(super) async fn authorize(
    state: &AttachmentsState,
    user: &str,
    device: &str,
    epoch: i64,
    config: &semantic::Config,
    image: bool,
) -> Result<String, AttachmentError> {
    let consent = refresh(state, user, device).await?;
    let current = if image {
        &consent.configuration.image
    } else {
        &consent.configuration.embedding
    };
    let protocol = if image {
        "openai-vision-v1"
    } else {
        "openai-embeddings-v1"
    };
    if !consent.allowed
        || consent.epoch != epoch
        || current.as_ref().map(|c| c.identity(protocol)) != Some(config.identity(protocol))
    {
        return Err(changed());
    }
    Ok(consent.configuration.scope)
}
