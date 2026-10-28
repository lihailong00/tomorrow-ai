use super::{AppState, Auth, Result};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tomorrow_domain::{agent::AgentRunView, DomainError};

pub fn public_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/agent-runs", get(list_runs))
        .route("/agent-runs/{id}", get(get_run))
        .route("/agent-runs/{id}/cancel", post(cancel_run))
}
pub fn internal_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/internal/agent/runs/{id}/state", get(state))
        .route("/internal/agent/runs/{id}/events", post(event))
        .route("/internal/agent/runs/{id}/tools", post(tool))
}

fn credentials(state: &AppState, headers: &HeaderMap) -> Result<String> {
    let agent = state.agent.as_ref().ok_or(DomainError::Forbidden)?;
    agent.authenticate_service(
        headers
            .get("x-agent-service")
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
    )?;
    Ok(headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(tomorrow_domain::auth::bearer_token)
        .ok_or(DomainError::Unauthorized)?
        .to_owned())
}

#[utoipa::path(get,path="/v1/agent-runs",responses((status=200,description="Current user's recent Agent runs")))]
pub async fn list_runs(State(state): State<Arc<AppState>>, auth: Auth) -> Result<Json<Value>> {
    // The repository enforces ownership; credentials and run capability tokens are never returned.
    Ok(Json(
        json!({"items":state.repository.agent_run_summaries(&auth.user_id).await?}),
    ))
}

#[utoipa::path(get,path="/v1/agent-runs/{id}",params(("id"=String,Path)),responses((status=200,body=AgentRunView)))]
pub async fn get_run(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<AgentRunView>> {
    Ok(Json(state.repository.agent_run(&auth.user_id, &id).await?))
}

#[utoipa::path(post,path="/v1/agent-runs/{id}/cancel",params(("id"=String,Path)),responses((status=200,body=AgentRunView)))]
pub async fn cancel_run(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    Path(id): Path<String>,
) -> Result<Json<AgentRunView>> {
    Ok(Json(
        state
            .repository
            .cancel_agent_run(&auth.user_id, &id)
            .await?,
    ))
}

async fn state(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let token = credentials(&state, &headers)?;
    state.repository.agent_authority(&id, &token).await?;
    Ok(Json(
        json!({"next_sequence":state.repository.next_agent_sequence(&id).await?}),
    ))
}

#[derive(Deserialize)]
struct EventInput {
    sequence: i64,
    kind: String,
    body: Value,
}
async fn event(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<EventInput>,
) -> Result<Json<Value>> {
    let token = credentials(&state, &headers)?;
    state
        .repository
        .record_agent_event(&id, &token, input.sequence, &input.kind, &input.body)
        .await?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
struct ToolInput {
    name: String,
    arguments: Value,
    operation_index: Option<u32>,
    operation_slot: Option<u32>,
}
async fn tool(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ToolInput>,
) -> Result<Json<Value>> {
    let token = credentials(&state, &headers)?;
    let (user_id, _scope) = state.repository.agent_authority(&id, &token).await?;
    if matches!(input.name.as_str(), "search_ai_history" | "read_ai_history") {
        let attachments = state.attachments.as_ref()
            .ok_or_else(|| DomainError::Validation("对话导入服务尚未配置".into()))?;
        let offset = input.arguments.get("offset").and_then(Value::as_u64).unwrap_or(0).min(100_000) as usize;
        let result = if input.name == "search_ai_history" {
            attachments.search_ai_history(&user_id,
                input.arguments.get("query").and_then(Value::as_str).unwrap_or(""),
                input.arguments.get("provider").and_then(Value::as_str), offset, 20).await
        } else {
            let conversation = input.arguments.get("id").and_then(Value::as_str)
                .ok_or_else(|| DomainError::Validation("缺少导入对话编号".into()))?;
            attachments.read_ai_history(&user_id,conversation,offset,30,true).await
        }.map_err(tomorrow_attachments::AttachmentError::into_domain)?;
        state.repository.agent_authority(&id,&token).await?;
        return Ok(Json(result));
    }
    if matches!(input.name.as_str(), "list_integrations" | "search_imports" | "read_integration") {
        let integrations = state.integrations.as_ref()
            .ok_or_else(|| DomainError::Validation("手机资料接入服务尚未配置".into()))?;
        let result = match input.name.as_str() {
            "list_integrations" => json!({"items":integrations.statuses(&user_id).await.map_err(tomorrow_connectors::ConnectorError::into_domain)?}),
            "search_imports" => integrations.imports(&user_id,tomorrow_connectors::domestic::ImportQuery {
                q:input.arguments.get("query").and_then(Value::as_str).map(str::to_owned),
                source_app:input.arguments.get("source_app").and_then(Value::as_str).map(str::to_owned),
            }).await.map_err(tomorrow_connectors::ConnectorError::into_domain)?,
            _ => {
                let provider = input.arguments.get("provider").and_then(Value::as_str)
                    .ok_or_else(|| DomainError::Validation("缺少应用编号".into()))?;
                let query = input.arguments.get("query").filter(|value|value.is_object()).cloned()
                    .ok_or_else(|| DomainError::Validation("缺少读取参数".into()))?;
                integrations.read(&user_id,provider,query).await.map_err(tomorrow_connectors::ConnectorError::into_domain)?
            }
        };
        // Cancellation/expiry while a provider request ran must suppress the response.
        state.repository.agent_authority(&id,&token).await?;
        return Ok(Json(result));
    }
    if tomorrow_domain::agent::is_mutating_tool(&input.name) && input.operation_index.is_none() {
        return Err(DomainError::Validation("写入工具必须提供本次执行的操作编号".into()).into());
    }
    if input.name == "read_attachment" {
        let upload_id = input
            .arguments
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| DomainError::Validation("缺少附件编号".into()))?;
        let attachments = state
            .attachments
            .as_ref()
            .ok_or_else(|| DomainError::Validation("附件服务未配置".into()))?;
        let text = attachments
            .read_text(&user_id, upload_id)
            .await
            .map_err(tomorrow_attachments::AttachmentError::into_domain)?;
        return Ok(Json(
            json!({"upload_id":text.upload_id,"name":text.name,"text":text.text}),
        ));
    }
    Ok(Json(
        state
            .repository
            .execute_agent_tool_with_slot(
                &id,
                &token,
                &input.name,
                input.arguments,
                input.operation_index,
                input.operation_slot,
            )
            .await?,
    ))
}
