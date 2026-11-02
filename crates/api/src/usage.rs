use crate::{AppState, Auth, Result};
use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use std::sync::Arc;
use tomorrow_domain::{
    usage::{UpdateUsageReminder, UsageQuery, UsageReminder, UsageReport},
    DomainError,
};

pub(crate) fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/usage", get(report))
        .route("/usage/reminder", get(reminder).patch(update_reminder))
}

pub(crate) async fn report(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    query: std::result::Result<Query<UsageQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<UsageReport>> {
    let Query(query) =
        query.map_err(|_| DomainError::Validation("无效的用量统计查询参数".into()))?;
    Ok(Json(
        state.repository.usage_report(&auth.user_id, query).await?,
    ))
}

pub(crate) async fn reminder(
    State(state): State<Arc<AppState>>,
    auth: Auth,
) -> Result<Json<UsageReminder>> {
    Ok(Json(state.repository.usage_reminder(&auth.user_id).await?))
}

pub(crate) async fn update_reminder(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    input: std::result::Result<Json<UpdateUsageReminder>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<UsageReminder>> {
    let Json(input) = input.map_err(|_| DomainError::Validation("无效的用量提醒设置".into()))?;
    Ok(Json(
        state
            .repository
            .update_usage_reminder(&auth.user_id, input)
            .await?,
    ))
}
