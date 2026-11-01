use crate::{AppState, Auth, Result};
use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tomorrow_domain::{ModelProvider, Repository, automatic_memory::Preferences};

pub async fn undo(
    State(s): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    s.repository
        .undo_automatic_memory(&auth.user_id, &id)
        .await?;
    Ok(Json(json!({"ok":true})))
}

pub async fn preferences(State(s): State<Arc<AppState>>, auth: Auth) -> Result<Json<Preferences>> {
    Ok(Json(s.repository.memory_preferences(&auth.user_id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    enabled: bool,
}
pub async fn update_preferences(
    State(s): State<Arc<AppState>>,
    auth: Auth,
    Json(i): Json<Input>,
) -> Result<Json<Preferences>> {
    Ok(Json(
        s.repository
            .set_memory_preferences(&auth.user_id, i.enabled)
            .await?,
    ))
}
pub async fn receipts(
    State(s): State<Arc<AppState>>,
    auth: Auth,
    Path(reply): Path<String>,
) -> Result<Json<Value>> {
    let pending:i64=sqlx::query_scalar("SELECT COUNT(*) FROM memory_jobs j JOIN memory_preferences p ON p.user_id=j.user_id AND p.epoch=j.epoch AND p.enabled=1 WHERE j.user_id=$1 AND j.reply_id=$2 AND j.status='queued' AND j.attempts<3")
        .bind(&auth.user_id).bind(&reply).fetch_one(&s.repository.pool()).await.map_err(tomorrow_domain::DomainError::from)?;
    Ok(Json(
        json!({"items":s.repository.memory_receipts(&auth.user_id,&reply).await?,"pending":pending>0}),
    ))
}
pub async fn get_memory(
    State(s): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<tomorrow_domain::Memory>> {
    Ok(Json(s.repository.saved_memory(&auth.user_id, &id).await?))
}
pub fn start_worker(repo: Repository, settings: tomorrow_settings::ConfigStore) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let Ok((_, values)) = settings.effective_snapshot().await else {
                continue;
            };
            let provider = ModelProvider::from_lookup(|key| values.get(key).cloned());
            // No credentials, source content or provider response in diagnostics.
            if repo.automatic_memory_step(&provider).await.is_err() {
                tracing::warn!("automatic memory processing deferred");
            }
        }
    });
}
