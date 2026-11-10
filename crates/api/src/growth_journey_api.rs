use crate::{AppState, Auth, Result};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use std::sync::Arc;
use tomorrow_domain::*;

#[utoipa::path(get,path="/v1/growth/journeys",responses((status=200,body=GrowthJourneys)))]
pub(crate) async fn list(State(s): State<Arc<AppState>>, a: Auth) -> Result<Json<GrowthJourneys>> {
    Ok(Json(s.repository.growth_journeys(&a.user_id).await?))
}
#[utoipa::path(post,path="/v1/growth/journeys",request_body=StartGrowthJourney,responses((status=200,body=GrowthJourney)))]
pub(crate) async fn create(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Json(i): Json<StartGrowthJourney>,
) -> Result<Json<GrowthJourney>> {
    crate::todo_api::configured_provider(&s).await?;
    Ok(Json(
        s.repository.start_growth_journey(&a.user_id, i).await?,
    ))
}
#[utoipa::path(post,path="/v1/growth/journeys/{id}/commands",params(("id"=String,Path)),request_body=GrowthJourneyCommand,responses((status=200,body=GrowthJourney)))]
pub(crate) async fn command(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
    Json(i): Json<GrowthJourneyCommand>,
) -> Result<Json<GrowthJourney>> {
    if i.action == "retry" {
        crate::todo_api::configured_provider(&s).await?;
    }
    Ok(Json(
        s.repository
            .command_growth_journey(&a.user_id, &id, i)
            .await?,
    ))
}
#[utoipa::path(post,path="/v1/growth/journeys/{id}/steps/{step}/start",params(("id"=String,Path),("step"=String,Path)),request_body=DailyItemCommand,responses((status=200,body=Todo)))]
pub(crate) async fn start(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path((id, step)): Path<(String, String)>,
    Json(i): Json<DailyItemCommand>,
) -> Result<Json<Todo>> {
    Ok(Json(
        s.repository
            .start_growth_step(&a.user_id, &id, &step, i)
            .await?,
    ))
}
#[utoipa::path(post,path="/v1/growth/journeys/{id}/steps/{step}/commands",params(("id"=String,Path),("step"=String,Path)),request_body=GrowthJourneyCommand,responses((status=200,body=GrowthJourney)))]
pub(crate) async fn feedback(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path((id, step)): Path<(String, String)>,
    Json(i): Json<GrowthJourneyCommand>,
) -> Result<Json<GrowthJourney>> {
    Ok(Json(
        s.repository
            .command_growth_step(&a.user_id, &id, &step, i)
            .await?,
    ))
}
#[derive(Deserialize)]
pub(crate) struct HistoryQuery {
    period: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}
#[utoipa::path(get,path="/v1/growth/history",params(("period"=Option<String>,Query),("offset"=Option<i64>,Query),("limit"=Option<i64>,Query)),responses((status=200,body=GrowthHistory)))]
pub(crate) async fn history(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<GrowthHistory>> {
    Ok(Json(
        s.repository
            .growth_history(
                &a.user_id,
                q.period.as_deref().unwrap_or("week"),
                q.offset.unwrap_or(0),
                q.limit.unwrap_or(30),
            )
            .await?,
    ))
}
