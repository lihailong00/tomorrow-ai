use crate::{AppState, Auth, PagedItems, Result};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use std::sync::Arc;
use tomorrow_domain::*;

#[derive(Deserialize)]
pub(crate) struct TodoFilter {
    filter: Option<String>,
    scope: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
}

#[utoipa::path(get,path="/v1/todos",params(("filter"=Option<String>,Query),("scope"=Option<String>,Query),("offset"=Option<i64>,Query),("limit"=Option<i64>,Query)),responses((status=200,body=PagedItems<Todo>)))]
pub(crate) async fn list(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Query(query): Query<TodoFilter>,
) -> Result<Json<PagedItems<Todo>>> {
    let (items, next_offset) = state
        .repository
        .todos_page(
            &auth.user_id,
            query.filter.as_deref().unwrap_or("all"),
            query.scope.as_deref().unwrap_or("all"),
            query.offset.unwrap_or(0),
            query.limit.unwrap_or(100),
        )
        .await?;
    Ok(Json(PagedItems { items, next_offset }))
}

#[utoipa::path(get,path="/v1/todos/{id}",params(("id"=String,Path)),responses((status=200,body=Todo)))]
pub(crate) async fn get(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<Todo>> {
    Ok(Json(state.repository.todo(&auth.user_id, &id).await?))
}

#[utoipa::path(post,path="/v1/todos",request_body=CreateTodo,responses((status=200,body=Todo)))]
pub(crate) async fn create(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Json(input): Json<CreateTodo>,
) -> Result<Json<Todo>> {
    Ok(Json(
        state.repository.create_todo(&auth.user_id, input).await?,
    ))
}

#[utoipa::path(patch,path="/v1/todos/{id}",params(("id"=String,Path)),request_body=UpdateTodo,responses((status=200,body=Todo)))]
pub(crate) async fn update(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
    Json(input): Json<UpdateTodo>,
) -> Result<Json<Todo>> {
    Ok(Json(
        state
            .repository
            .update_todo(&auth.user_id, &id, input)
            .await?,
    ))
}

#[utoipa::path(delete,path="/v1/todos/{id}",params(("id"=String,Path)),responses((status=200,description="Deleted")))]
pub(crate) async fn delete(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    state.repository.delete_todo(&auth.user_id, &id).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn configured_provider(state: &AppState) -> std::result::Result<ModelProvider, DomainError> {
    let provider = match &state.settings {
        Some(settings) => {
            let values = settings
                .effective_values()
                .await
                .map_err(|_| DomainError::Unavailable("模型配置暂时不可用".into()))?;
            ModelProvider::from_lookup(|key| values.get(key).cloned())
        }
        None => state.provider.clone(),
    };
    if !provider.is_configured() {
        return Err(DomainError::Unavailable(
            "请先在管理后台配置可用模型；待办和原始资料已保留".into(),
        ));
    }
    Ok(provider)
}

#[utoipa::path(post,path="/v1/todos/{id}/prepare",params(("id"=String,Path)),request_body=PrepareTodo,responses((status=200,body=Todo)))]
pub(crate) async fn prepare(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
    Json(input): Json<PrepareTodo>,
) -> Result<Json<Todo>> {
    // Check ownership before inspecting model readiness.
    state.repository.todo(&auth.user_id, &id).await?;
    configured_provider(&state).await?;
    Ok(Json(
        state
            .repository
            .prepare_todo(&auth.user_id, &id, input)
            .await?,
    ))
}

#[utoipa::path(post,path="/v1/todos/extract",request_body=ExtractTodos,responses((status=200,body=ExtractedTodos)))]
pub(crate) async fn extract(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Json(input): Json<ExtractTodos>,
) -> Result<Json<ExtractedTodos>> {
    // Repository checks source ownership even when no model is configured.
    let provider = match &state.settings {
        Some(settings) => {
            let values = settings
                .effective_values()
                .await
                .map_err(|_| DomainError::Unavailable("模型配置暂时不可用".into()))?;
            ModelProvider::from_lookup(|key| values.get(key).cloned())
        }
        None => state.provider.clone(),
    };
    Ok(Json(
        state
            .repository
            .extract_todos(&auth.user_id, input, &provider)
            .await?,
    ))
}
