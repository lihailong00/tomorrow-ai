use crate::{AppState, Auth, Result};
use axum::{
    Json,
    extract::{Path, State},
};
use std::sync::Arc;
use tomorrow_domain::*;

#[utoipa::path(get,path="/v1/growth/preferences",responses((status=200,body=GrowthPreferences)))]
pub(crate) async fn preferences(
    State(s): State<Arc<AppState>>,
    a: Auth,
) -> Result<Json<GrowthPreferences>> {
    Ok(Json(s.repository.growth_preferences(&a.user_id).await?))
}
#[utoipa::path(patch,path="/v1/growth/preferences",request_body=UpdateGrowthPreferences,responses((status=200,body=GrowthPreferences)))]
pub(crate) async fn update_preferences(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Json(i): Json<UpdateGrowthPreferences>,
) -> Result<Json<GrowthPreferences>> {
    Ok(Json(
        s.repository
            .update_growth_preferences(&a.user_id, i)
            .await?,
    ))
}
#[utoipa::path(get,path="/v1/growth/summary",responses((status=200,body=GrowthSummary)))]
pub(crate) async fn summary(
    State(s): State<Arc<AppState>>,
    a: Auth,
) -> Result<Json<GrowthSummary>> {
    Ok(Json(s.repository.growth_summary(&a.user_id).await?))
}
#[utoipa::path(get,path="/v1/growth/todos/{id}",params(("id"=String,Path)),responses((status=200,body=GrowthRewardState)))]
pub(crate) async fn reward(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
) -> Result<Json<GrowthRewardState>> {
    Ok(Json(
        s.repository.growth_reward_state(&a.user_id, &id).await?,
    ))
}
#[utoipa::path(get,path="/v1/todos/{id}/actions",params(("id"=String,Path)),responses((status=200,body=TodoActions)))]
pub(crate) async fn actions(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
) -> Result<Json<TodoActions>> {
    Ok(Json(s.repository.todo_actions(&a.user_id, &id).await?))
}
#[utoipa::path(post,path="/v1/todos/{id}/actions",params(("id"=String,Path)),request_body=ConfirmTodoAction,responses((status=200,body=TodoActionResult)))]
pub(crate) async fn confirm_action(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
    Json(i): Json<ConfirmTodoAction>,
) -> Result<Json<TodoActionResult>> {
    Ok(Json(
        s.repository.confirm_todo_action(&a.user_id, &id, i).await?,
    ))
}
#[utoipa::path(get,path="/v1/daily-plan",responses((status=200,body=DailyPlan)))]
pub(crate) async fn plan(State(s): State<Arc<AppState>>, a: Auth) -> Result<Json<DailyPlan>> {
    Ok(Json(s.repository.daily_plan(&a.user_id).await?))
}
#[utoipa::path(post,path="/v1/daily-plan/ensure",request_body=EnsureDailyPlan,responses((status=200,body=DailyPlan)))]
pub(crate) async fn ensure(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Json(i): Json<EnsureDailyPlan>,
) -> Result<Json<DailyPlan>> {
    // No model call or queue admission on an unconfigured instance.
    crate::todo_api::configured_provider(&s).await?;
    Ok(Json(s.repository.ensure_daily_plan(&a.user_id, i).await?))
}
#[utoipa::path(post,path="/v1/daily-plan/items/{id}/accept",params(("id"=String,Path)),request_body=DailyItemCommand,responses((status=200,body=AcceptDailyItem)))]
pub(crate) async fn accept(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
    Json(i): Json<DailyItemCommand>,
) -> Result<Json<AcceptDailyItem>> {
    Ok(Json(
        s.repository.accept_daily_item(&a.user_id, &id, i).await?,
    ))
}
#[utoipa::path(post,path="/v1/daily-plan/items/{id}/skip",params(("id"=String,Path)),request_body=DailyItemCommand,responses((status=200,body=DailyPlan)))]
pub(crate) async fn skip(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
    Json(i): Json<DailyItemCommand>,
) -> Result<Json<DailyPlan>> {
    Ok(Json(
        s.repository.skip_daily_item(&a.user_id, &id, i).await?,
    ))
}
#[utoipa::path(post,path="/v1/daily-plan/items/{id}/replace",params(("id"=String,Path)),request_body=DailyItemCommand,responses((status=200,body=DailyPlan)))]
pub(crate) async fn replace(
    State(s): State<Arc<AppState>>,
    a: Auth,
    Path(id): Path<String>,
    Json(i): Json<DailyItemCommand>,
) -> Result<Json<DailyPlan>> {
    Ok(Json(
        s.repository.replace_daily_item(&a.user_id, &id, i).await?,
    ))
}
