use super::{run_chat_inner, ApiError, AppState, Auth, ChatInput, Result};
use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    Json,
};
use futures_util::stream;
use serde_json::{json, Value};
use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};
use tomorrow_domain::{
    chat_stream::{ChatStreamEvent, ChatStreamView, CHAT_STREAM_LIFETIME_SECONDS},
    validate_text, DomainError,
};

/// Starts once or reattaches to the durable request. Acquisition and producer
/// launch share one detached task, so losing HTTP during COMMIT cannot orphan it.
#[utoipa::path(post,path="/v1/chat/stream",request_body=ChatInput,
    description="client_request_id is required by this endpoint. Repeat the same immutable ChatInput to reconnect; a running producer is reattached and a completed response is replayed. Explicit retry retains conversation/message IDs and the durable operation journal.",
    params(("Last-Event-ID"=Option<i64>,Header,description="Nonnegative sequence cursor for this owner-bound request; the initial snapshot always replaces client content."),
        ("X-Chat-Retry"=Option<String>,Header,description="Set to 1 to explicitly retry an interrupted or expired attempt; an active producer is reattached.")),
    responses((status=200,description="SSE snapshot/accepted/text_start/text_delta/tool_start/tool_end/retrying/done/error. Text deltas are genuine upstream visible content; snapshots include attempt, partial content, previous_content, tool status and optional completed response.",body=String,content_type="text/event-stream",
        headers(("Cache-Control"=String,description="no-cache, no-store"),("X-Accel-Buffering"=String,description="no")))))]
pub(super) async fn chat_stream(
    State(state): State<Arc<AppState>>,
    auth: Auth,
    headers: HeaderMap,
    Json(mut input): Json<ChatInput>,
) -> Result<Response> {
    input.message = validate_text(&input.message, "消息", 20000)?;
    input.client_request_id = Some(validate_text(
        input.client_request_id.as_deref().unwrap_or(""),
        "请求编号",
        120,
    )?);
    input.remember = Some(input.remember.unwrap_or(false));
    super::client_context::validate_input(&state.repository, &auth.user_id, input.client_request_id.as_deref(), input.client_context.as_ref()).await?;
    if input.remember == Some(true) {
        validate_text(&input.message, "记忆内容", 10000)?;
    }
    let cursor = headers
        .get("last-event-id")
        .map(|h| {
            h.to_str()
                .ok()
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|n| *n >= 0)
                .ok_or_else(|| DomainError::Validation("消息游标无效".into()))
        })
        .transpose()?;
    let retry = headers
        .get("x-chat-retry")
        .map(|h| match h.to_str().ok() {
            Some("1") => Ok(true),
            Some("0") => Ok(false),
            _ => Err(DomainError::Validation("重试标记无效".into())),
        })
        .transpose()?
        .unwrap_or(false);
    let fingerprint = serde_json::to_string(&input)
        .map_err(|_| DomainError::Validation("消息格式无效".into()))?;
    let request_id = input
        .client_request_id
        .clone()
        .expect("validated request id");
    let interactive = input.interaction_mode.is_some() || input.didi_order_confirmation_supported == Some(true)
        || input.action_confirmation_supported == Some(true)
        || input.app_permission_inspection_supported == Some(true) || input.app_permission_tool_supported == Some(true);
    if cursor.is_some_and(|n| n > 0) {
        let view = state
            .repository
            .chat_stream(&auth.user_id, &request_id)
            .await?;
        if cursor.is_some_and(|n| n > view.sequence) {
            return Err(DomainError::Conflict("消息游标超出当前进度".into()).into());
        }
    }
    let producer_state = state.clone();
    let user_id = auth.user_id;
    let owner = user_id.clone();
    let request = request_id.clone();
    tokio::spawn(async move {
        let producer = producer_state
            .repository
            .begin_chat_stream_retry(&owner, &request, &fingerprint, retry)
            .await?;
        if let Some(producer) = producer {
            let state = producer_state.clone();
            tokio::spawn(async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(CHAT_STREAM_LIFETIME_SECONDS),
                    run_chat_inner(
                        &state,
                        &owner,
                        input,
                        &producer.attempt_token,
                        Some(&producer),
                    ),
                )
                .await;
                let message = match result {
                    Ok(Ok(_)) => return,
                    Ok(Err(ApiError(DomainError::Validation(message)))) => message,
                    Ok(Err(ApiError(DomainError::Conflict(message)))) => message,
                    Ok(Err(ApiError(DomainError::NotFound))) => "原消息或对话已不存在，请重新打开后发送".into(),
                    Ok(Err(ApiError(DomainError::AgentReplayConflict))) => {
                        DomainError::AgentReplayConflict.to_string()
                    }
                    Ok(Err(_)) => "回复中断，已保留收到的内容；可重试此回复".into(),
                    Err(_) => "回复超时，已保留收到的内容；可重试此回复".into(),
                };
                if let Err(error) = state
                    .repository
                    .interrupt_chat_stream(&producer, &message)
                    .await
                {
                    tracing::warn!(error=%error,"chat stream interruption checkpoint failed");
                }
            });
        }
        Ok::<(), DomainError>(())
    })
    .await
    .map_err(|_| DomainError::Internal("消息启动中断".into()))??;
    let view = state.repository.chat_stream(&user_id, &request_id).await?;
    if cursor.is_some_and(|n| n > view.sequence) {
        return Err(DomainError::Conflict("消息游标超出当前进度".into()).into());
    }
    let card = interaction(&state, &user_id, &view, interactive);
    let interaction_id = card.as_ref().map(|card| card.id.clone());
    let initial = snapshot(&view, card);
    let tail = Tail {
        state,
        user_id,
        request_id,
        cursor: view.sequence,
        pending: VecDeque::from([initial]),
        terminal: view.status != "running",
        interactive,
        interaction_id,
        deadline: tokio::time::Instant::now()
            + Duration::from_secs(CHAT_STREAM_LIFETIME_SECONDS + 10),
    };
    let events = stream::unfold(tail, |mut tail| async move {
        loop {
            if let Some(event) = tail.pending.pop_front() {
                return Some((Ok::<Event, Infallible>(event), tail));
            }
            if tail.terminal || tokio::time::Instant::now() >= tail.deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
            let view = match tail
                .state
                .repository
                .chat_stream(&tail.user_id, &tail.request_id)
                .await
            {
                Ok(view) => view,
                Err(_) => {
                    tail.terminal = true;
                    return Some((
                        Ok(sse(
                            "error",
                            tail.cursor,
                            json!({"sequence":tail.cursor,"message":"消息连接暂时不可用，请重新连接","partial":true,"retryable":true}),
                        )),
                        tail,
                    ));
                }
            };
            let events = match tail
                .state
                .repository
                .chat_stream_events(&tail.user_id, &tail.request_id, tail.cursor, view.sequence)
                .await
            {
                Ok(events) => events,
                Err(_) => {
                    tail.terminal = true;
                    return Some((
                        Ok(sse(
                            "error",
                            tail.cursor,
                            json!({"sequence":tail.cursor,"message":"消息连接暂时不可用，请重新连接","partial":true,"retryable":true}),
                        )),
                        tail,
                    ));
                }
            };
            if events
                .first()
                .is_some_and(|event| event.sequence != tail.cursor + 1)
                || (events.is_empty() && view.sequence > tail.cursor)
            {
                tail.cursor = view.sequence;
                tail.pending.push_back(snapshot(&view, interaction(&tail.state, &tail.user_id, &view, tail.interactive)));
            } else {
                for ChatStreamEvent {
                    sequence,
                    kind,
                    body,
                } in events
                {
                    tail.cursor = sequence;
                    tail.pending.push_back(sse(&kind, sequence, body));
                }
            }
            tail.terminal = view.status != "running" && tail.cursor >= view.sequence;
            if tail.interactive && !tail.terminal {
                let card = interaction(&tail.state, &tail.user_id, &view, true);
                let id = card.as_ref().map(|card| card.id.clone());
                if tail.interaction_id != id {
                    tail.interaction_id = id;
                    // Interaction state is ephemeral and independent of the durable replay cursor.
                    tail.pending.push_back(sse("interaction", tail.cursor, json!({"card":card})));
                }
            }
        }
    });
    let mut response = Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(10))
                .text("keep-alive"),
        )
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store"),
    );
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

struct Tail {
    state: Arc<AppState>,
    user_id: String,
    request_id: String,
    cursor: i64,
    pending: VecDeque<Event>,
    terminal: bool,
    interactive: bool,
    interaction_id: Option<String>,
    deadline: tokio::time::Instant,
}

fn sse(kind: &str, sequence: i64, body: Value) -> Event {
    Event::default()
        .id(sequence.to_string())
        .event(kind)
        .data(body.to_string())
}

fn interaction(state: &AppState, user: &str, view: &ChatStreamView, enabled: bool) -> Option<super::chat_interaction::Card> {
    if !enabled || view.status != "running" { return None; }
    let run = view.accepted.as_ref()?["agent_run_id"].as_str()?;
    state.interactions.pending(user, run)
}

fn snapshot(view: &ChatStreamView, card: Option<super::chat_interaction::Card>) -> Event {
    let mut body = json!({"sequence":view.sequence,"attempt":view.attempt,"previous_content":view.previous_content,"status":view.status,"content":view.content,"error":view.error,"response":view.response,"tool_status":view.tool_status,
        "conversation_id":null,"user_message":null,"message_id":null,"message_created_at":null,"agent_run_id":null,"interaction":card});
    if let Some(accepted) = &view.accepted {
        for field in [
            "conversation_id",
            "user_message",
            "message_id",
            "message_created_at",
            "agent_run_id",
            "removed_message_ids",
        ] {
            body[field] = accepted[field].clone();
        }
    }
    if !body["removed_message_ids"].is_array() {body["removed_message_ids"]=json!([]);}
    sse("snapshot", view.sequence, body)
}
