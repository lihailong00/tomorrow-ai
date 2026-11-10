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
    let (user_id, scope) = state.repository.agent_authority(&id, &token).await?;
    let simulated = state.personal_mcp.as_ref().is_some_and(|mcp| mcp.uses_tencent_docs_fixture(&user_id));
    if simulated && (scope != "chat" ||
        !matches!(input.name.as_str(), "list_mcp_connections" | "list_mcp_tools" | "call_mcp_tool" | "ask_user_choice" | "recent_chat_tool_receipts") ||
        matches!(input.name.as_str(), "list_mcp_tools" | "call_mcp_tool") && input.arguments["provider"] != "tencent_docs") {
        return Err(DomainError::Forbidden.into());
    }
    if input.name == "read_github_repository" {
        if scope != "chat" { return Err(DomainError::Forbidden.into()); }
        let result = tomorrow_connectors::github::read_public(id.clone(), input.arguments)
            .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?;
        state.repository.agent_authority(&id, &token).await?;
        return Ok(Json(result));
    }
    if input.name == tomorrow_domain::agent::AKSHARE_TOOL {
        if scope != "chat" { return Err(DomainError::Forbidden.into()); }
        let akshare = state.akshare.as_ref().ok_or(DomainError::Forbidden)?;
        let result = akshare.query(input.arguments)
            .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?;
        state.repository.agent_authority(&id, &token).await?;
        return Ok(Json(result));
    }
    if input.name == "prepare_personal_tool" {
        if scope != "chat" { return Err(DomainError::Forbidden.into()); }
        let operation = input.operation_index.filter(|n| *n > 0 && *n <= 100)
            .ok_or_else(|| DomainError::Validation("资料操作需要有效的执行编号".into()))?;
        return Ok(Json(super::personal_autofill::execute(&state, &id, &token, &user_id, operation, input.arguments).await?));
    }
    if scope == "chat" && matches!(input.name.as_str(), "request_location" | "ask_user_choice") {
        return super::chat_interaction::tool(&state, &id, &token, &user_id, &input.name, input.arguments).await;
    }
    if input.name == tomorrow_domain::agent::APP_PERMISSION_TOOL {
        if scope != "chat" { return Err(DomainError::Forbidden.into()); }
        let input: super::app_permission_intent::InspectionRequest = serde_json::from_value(input.arguments)
            .map_err(|_| DomainError::Validation("应用权限检查参数无效".into()))?;
        return Ok(Json(super::chat_interaction::inspect_app_permissions(&state, &id, &token, &user_id, input).await?));
    }
    if input.name == tomorrow_domain::agent::SYSTEM_SETTINGS_TOOL {
        if scope != "chat" { return Err(DomainError::Forbidden.into()); }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SettingsInput { destination: super::app_permission_intent::SettingsDestination }
        let input: SettingsInput = serde_json::from_value(input.arguments)
            .map_err(|_| DomainError::Validation("系统设置入口无效".into()))?;
        return Ok(Json(super::chat_interaction::open_system_settings(&state, &id, &token, &user_id, input.destination).await?));
    }
    if crate::wallet_tools::is_wallet_tool(&input.name) {
        if scope == "chat" && input.name == "prepare_alipay_payment" && !state.interactions.supports_action_confirmation(&id, &user_id) {
            return Ok(Json(json!({"status":"unavailable","message":"本次对话无法显示付款确认卡，尚未提交付款。"})));
        }
        let wallet=state.personal_wallet.as_ref().ok_or_else(||DomainError::Validation("支付宝钱包接入尚未配置".into()))?;
        let mut result=crate::wallet_tools::execute(wallet,&user_id,&id,input.operation_index.unwrap_or(0),&input.name,&input.arguments).await?;
        if scope == "chat" && input.name == "prepare_alipay_payment" {
            result = super::chat_confirmation::wallet_payment(&state, &id, &token, &user_id, wallet, result).await?;
        }
        state.repository.agent_authority(&id,&token).await?;
        return Ok(Json(result));
    }
    if input.name == "recent_chat_tool_receipts" {
        if !input.arguments.as_object().is_some_and(|args|args.is_empty()) {
            return Err(DomainError::Validation("历史工具回执不接受额外参数".into()).into());
        }
        return Ok(Json(state.repository.recent_chat_tool_receipts(&user_id,&id).await?));
    }
    if matches!(input.name.as_str(), "list_mcp_connections" | "list_mcp_tools" | "call_mcp_tool" | "get_mcp_action") {
        // The account owner comes from the authenticated run, never model arguments.
        // There is intentionally no agent-side confirmation or credential endpoint.
        let mcp = state.personal_mcp.as_ref()
            .ok_or_else(|| DomainError::Validation("个人 MCP 连接服务尚未配置".into()))?;
        let object = input.arguments.as_object()
            .ok_or_else(|| DomainError::Validation("MCP 工具参数必须为对象".into()))?;
        let allowed: &[&str] = match input.name.as_str() {
            "list_mcp_connections" => &[],
            "list_mcp_tools" => &["provider", "offset", "limit", "query"],
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
                let offset = mcp_integer(object, "offset", 0, 0, 256)?;
                let limit = mcp_integer(object, "limit", 10, 1, 20)?;
                let query = object.get("query").map(|_| text("query")).transpose()?;
                let catalog = mcp.tools(&user_id, text("provider")?).await
                    .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
                let catalog = mcp_tool_search(catalog, query)?;
                let mut page = mcp_tool_page(catalog.clone(), offset, limit)?;
                if let Some(query) = query {
                    page["query"] = json!(query);
                    page["catalog_total"] = catalog["catalog_total"].clone();
                }
                page
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
                let (provider, tool) = (text("provider")?, text("tool")?);
                if provider == "didi" && state.interactions.supports_didi_order(&id, &user_id) && tool == "taxi_estimate" {
                    let (quote, generation, sandbox) = mcp.didi_quote(&user_id, arguments.clone(), &operation_key)
                        .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?;
                    state.interactions.remember_didi_quote(&id, &user_id,
                        super::didi_order::Quote::read(&arguments, &quote, generation, sandbox));
                    quote
                } else if provider == "didi" && state.interactions.supports_didi_order(&id, &user_id) && tool == "taxi_create_order" {
                    super::didi_order::confirm_in_chat(&state, &id, &token, &user_id, arguments, &operation_key).await?
                } else if scope == "chat" && provider == "mcdonalds" && tool == "delivery-query-addresses" {
                    super::personal_autofill::query_delivery_addresses(&state, &id, &token, &user_id, arguments, &operation_key).await?
                } else {
                    let didi_cancel = scope == "chat" && provider == "didi" && tool == "taxi_cancel_order";
                    if didi_cancel && !state.interactions.claim_didi_cancellation(&id, &user_id) {
                        return Ok(Json(json!({"status":"unavailable","message":"本轮无法发起新的取消确认。原订单状态未核实，不要重新叫车。"})));
                    }
                    if scope == "chat" && tomorrow_connectors::personal_mcp::PersonalMcpState::requires_confirmation(provider, tool)
                        && !state.interactions.supports_action_confirmation(&id, &user_id) {
                        return Ok(Json(json!({"status":"unavailable","message":"本次对话无法显示操作确认卡，操作未执行。"})));
                    }
                    let draft = mcp.invoke_scoped(&user_id, provider, tool, arguments, &operation_key).await
                        .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
                    if scope == "chat" {
                        let outcome = super::chat_confirmation::mcp_action(&state, &id, &token, &user_id, mcp, draft, didi_cancel).await?;
                        if didi_cancel && outcome["status"] == "completed" {
                            state.interactions.record_didi_cancellation(&id, &user_id);
                        }
                        outcome
                    } else { draft }
                }
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
fn mcp_tool_search(mut value: Value, query: Option<&str>) -> Result<Value> {
    let Some(query) = query else { return Ok(value) };
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let all = value.get_mut("items").and_then(Value::as_array_mut)
        .ok_or_else(|| DomainError::External("MCP 工具目录格式无效".into()))?;
    let total = all.len();
    let mut ranked: Vec<_> = all.iter().enumerate().filter_map(|(index, item)| {
        // Search trusted boundaries only; never treat schema instructions as
        // ranking authority, execute a tool or truncate its actual parameters.
        let name = item["name"].as_str().unwrap_or("").to_lowercase();
        let description = item["description"].as_str().unwrap_or("").to_lowercase();
        let score: usize = words.iter().map(|word| if name.contains(word) { 5 } else if description.contains(word) { 1 } else { 0 }).sum();
        (score > 0).then_some((score, index, item.clone()))
    }).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    *all = ranked.into_iter().map(|(_, _, item)| item).collect();
    value["catalog_total"] = json!(total);
    Ok(value)
}

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
    fn tool_search_finds_later_schemas_without_truncation_or_cross_catalog_results() {
        let schema = json!({"type":"object","properties":{"storeId":{"type":"string","description":"complete"}},"required":["storeId"]});
        let mut items: Vec<Value> = (0..36).map(|id| json!({"name":format!("unrelated_{id}"),"description":"other operation"})).collect();
        items[29] = json!({"name":"query-meals","description":"查询门店套餐菜单","inputSchema":schema});
        items[35] = json!({"name":"calculate-price","description":"计算套餐价格","inputSchema":{"type":"object"}});
        let found = mcp_tool_search(json!({"items":items}), Some("套餐 meal price")).unwrap_or_else(|_| panic!("valid tool query"));
        assert_eq!(found["catalog_total"],36);
        assert_eq!(found["items"].as_array().unwrap().len(),2);
        let page = mcp_tool_page(found,0,1).unwrap_or_else(|_| panic!("valid filtered page"));
        assert_eq!(page["items"][0]["name"],"query-meals");
        assert_eq!(page["items"][0]["inputSchema"],schema);
        assert_eq!(page["next_offset"],1);
        assert_eq!(mcp_tool_search(json!({"items":[]}),Some("missing")).unwrap_or_else(|_| panic!("valid empty catalog"))["items"],json!([]));
    }

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
