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
    client_model: Option<String>,
}
async fn tool(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ToolInput>,
) -> Result<Json<Value>> {
    let token = credentials(&state, &headers)?;
    let (user_id, _scope) = state.repository.agent_authority(&id, &token).await?;
    if matches!(input.name.as_str(), "list_mcp_connections" | "list_mcp_tools" | "call_mcp_tool" | "get_mcp_action") {
        // The account owner comes from the authenticated run, never model arguments.
        // There is intentionally no agent-side confirmation or credential endpoint.
        let mcp = state.personal_mcp.as_ref()
            .ok_or_else(|| DomainError::Validation("个人 MCP 连接服务尚未配置".into()))?;
        let object = input.arguments.as_object()
            .ok_or_else(|| DomainError::Validation("MCP 工具参数必须为对象".into()))?;
        let allowed: &[&str] = match input.name.as_str() {
            "list_mcp_connections" => &[],
            "list_mcp_tools" => &["provider", "offset", "limit"],
            "get_mcp_action" => &["id", "result_offset", "result_limit"],
            _ => &["provider", "tool", "arguments"],
        };
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err(DomainError::Validation("MCP 工具包含不支持的参数".into()).into());
        }
        let text = |key: &str| -> Result<&str> {
            object.get(key).and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control))
                .ok_or_else(|| DomainError::Validation(format!("缺少或无效的 MCP 参数：{key}")).into())
        };
        let result = match input.name.as_str() {
            "list_mcp_connections" => json!({"items":mcp.statuses(&user_id).await.map_err(tomorrow_connectors::ConnectorError::into_domain)?}),
            "list_mcp_tools" => {
                let offset = mcp_integer(object, "offset", 0, 0, 128)?;
                let limit = mcp_integer(object, "limit", 10, 1, 20)?;
                mcp_tool_page(mcp.tools(&user_id, text("provider")?).await
                    .map_err(tomorrow_connectors::ConnectorError::into_domain)?, offset, limit)?
            }
            "get_mcp_action" => {
                let offset = mcp_integer(object, "result_offset", 0, 0, 100_000)?;
                let limit = mcp_integer(object, "result_limit", 4000, 1, 8000)?;
                mcp_action_page(mcp.action(&user_id, text("id")?).await
                    .map_err(tomorrow_connectors::ConnectorError::into_domain)?, offset, limit)?
            }
            _ => {
                let arguments = object.get("arguments").filter(|value| value.is_object())
                    .ok_or_else(|| DomainError::Validation("缺少 MCP 调用参数".into()))?;
                let mut arguments = arguments.clone();
                if text("provider")? == "tencent_meeting" {
                    let model = input.client_model.as_deref().unwrap_or("not_provided");
                    if model.len() > 200 || model.chars().any(char::is_control) {
                        return Err(DomainError::Validation("模型标识无效".into()).into());
                    }
                    // The Pi service supplies the actual model from this run's
                    // frozen settings. Model-generated client metadata is replaced.
                    arguments["_client_info"] = json!({"os":std::env::consts::OS,"agent":"Tada","model":model});
                }
                let operation_key = format!("{id}:mcp:{}", input.operation_index.unwrap_or(0));
                mcp.invoke_scoped(&user_id, text("provider")?, text("tool")?, arguments, &operation_key).await
                    .map_err(tomorrow_connectors::ConnectorError::into_domain)?
            }
        };
        state.repository.agent_authority(&id, &token).await?;
        return Ok(Json(result));
    }
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

fn mcp_integer(object: &serde_json::Map<String, Value>, key: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    match object.get(key) {
        None => Ok(default),
        Some(value) => value.as_u64().filter(|value| *value >= min as u64 && *value <= max as u64)
            .map(|value| value as usize)
            .ok_or_else(|| DomainError::Validation(format!("MCP 分页参数无效：{key}")).into()),
    }
}

// Tool discovery is paged before entering the model context. A provider can
// expose far more schemas than fit in a single Pi tool-result budget.
fn mcp_tool_page(mut value: Value, offset: usize, limit: usize) -> Result<Value> {
    let all = value.get_mut("items").and_then(Value::as_array_mut)
        .ok_or_else(|| DomainError::External("MCP 工具目录格式无效".into()))?;
    let total = all.len();
    if offset > total { return Err(DomainError::Validation("MCP 工具偏移超出范围".into()).into()); }
    let mut page = Vec::new();
    let mut bytes = 0;
    for item in all.iter().skip(offset).take(limit) {
        let size = item.to_string().len();
        if bytes + size > 36_000 { break; }
        bytes += size;
        page.push(item.clone());
    }
    if page.is_empty() && offset < total {
        return Ok(json!({"error":{"code":"mcp_schema_too_large","message":"此工具参数定义超出对话预算，暂不能通过对话调用"},
            "tool":all[offset]["name"],"offset":offset,"next_offset":offset+1,"total":total,"has_more":offset+1<total}));
    }
    let end = offset + page.len();
    Ok(json!({"items":page,"offset":offset,"limit":limit,"next_offset":if end<total{Some(end)}else{None},
        "has_more":end<total,"total":total,"result_budget_bytes":36_000}))
}

fn mcp_action_page(mut value: Value, offset: usize, limit: usize) -> Result<Value> {
    if let Some(result) = value.get("result") {
        let encoded = result.to_string();
        let length = encoded.chars().count();
        if offset > length { return Err(DomainError::Validation("MCP 结果偏移超出范围".into()).into()); }
        if encoded.len() > 8000 || offset > 0 {
            let text: String = encoded.chars().skip(offset).take(limit).collect();
            let end = (offset + limit).min(length);
            value.as_object_mut().expect("action is object").remove("result");
            value["result_json"] = json!(text);
            value["result_offset"] = json!(offset);
            value["result_length"] = json!(length);
            value["result_next_offset"] = json!(if end < length { Some(end) } else { None });
            value["result_encoding"] = json!("JSON text paged by Unicode characters; join pages before decoding");
        }
    } else if offset != 0 {
        return Err(DomainError::Validation("此 MCP 操作尚无执行结果".into()).into());
    }
    Ok(value)
}

#[cfg(test)]
mod mcp_pagination_tests {
    use super::*;

    #[test]
    fn schema_pages_are_bounded_and_continue_without_skipping_tools() {
        let catalog = json!({"items":(0..30).map(|id|json!({"name":format!("tool_{id}"),"inputSchema":{"type":"object","description":"x".repeat(5000)}})).collect::<Vec<_>>()});
        let first = mcp_tool_page(catalog.clone(), 0, 20).unwrap_or_else(|_| panic!("valid first tool page"));
        let next = first["next_offset"].as_u64().unwrap() as usize;
        assert!(next > 0 && next < 20);
        assert!(first.to_string().len() < 40_000);
        let second = mcp_tool_page(catalog.clone(), next, 20).unwrap_or_else(|_| panic!("valid next tool page"));
        assert_eq!(second["items"][0]["name"], format!("tool_{next}"));
        assert!(mcp_tool_page(catalog, 31, 10).is_err());
    }

    #[test]
    fn large_action_result_keeps_status_and_pages_unicode_without_losing_content() {
        let original = json!({"text":"中文😀".repeat(5000)});
        let action = json!({"id":"action","status":"completed","result":original});
        let mut offset = 0;
        let mut joined = String::new();
        loop {
            let page = mcp_action_page(action.clone(), offset, 1000).unwrap_or_else(|_| panic!("valid result page"));
            assert_eq!(page["status"], "completed");
            joined.push_str(page["result_json"].as_str().unwrap());
            match page["result_next_offset"].as_u64() { Some(next) => offset=next as usize, None => break }
        }
        assert_eq!(serde_json::from_str::<Value>(&joined).unwrap(), original);
    }
}
