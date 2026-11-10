//! Independent adversarial scenarios. No live accounts, models or transactions.
use super::{state::{McpTransport, PersonalMcpState}, transport::Credentials};
use crate::crypto::Crypto;
use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}, response::IntoResponse};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use tokio::sync::Notify;
use tomorrow_domain::{Repository, now};
use tower::ServiceExt;

type BoxResult<'a, T> = Pin<Box<dyn Future<Output = crate::Result<T>> + Send + 'a>>;
struct Fixture {
    mode: AtomicUsize,
    calls: AtomicUsize,
    started: Notify,
    release: Notify,
}
impl Fixture {
    fn new() -> Self { Self { mode: AtomicUsize::new(0), calls: AtomicUsize::new(0), started: Notify::new(), release: Notify::new() } }
}
impl McpTransport for Fixture {
    fn discover<'a>(&'a self, provider: &'a str, credentials: &'a Credentials) -> BoxResult<'a, Vec<Value>> {
        Box::pin(async move {
            if self.mode.load(Ordering::SeqCst) == 5 {
                return Err(crate::ConnectorError::new(StatusCode::BAD_GATEWAY, "fixture_failure", "测试上游拒绝凭证"));
            }
            let description = if self.mode.load(Ordering::SeqCst) == 4 { credentials.token.as_str() } else { "fixture tool" };
            if provider == "ima" {
                return Ok(vec![json!({"name":"ima_list_knowledge_bases","inputSchema":{"type":"object"}})]);
            }
            Ok(["taxi_create_order", "taxi_query_order", "taxi_get_driver_location", "unknown_read_claim"].into_iter().map(|name|
                json!({"name":name,"description":description,"inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}})).collect())
        })
    }
    fn call<'a>(&'a self, provider: &'a str, credentials: &'a Credentials, tool: &'a str, arguments: Value) -> BoxResult<'a, Value> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            if provider == "ima" {
                assert_eq!(tool, "ima_create_note");
                assert_eq!(arguments, json!({"title":"会后总结","content":"确认下一步"}));
                return Ok(json!({"structuredContent":{"data":{"note_id":"new-note"}}}));
            }
            match self.mode.load(Ordering::SeqCst) {
                1 => Ok(json!({"isError":true,"content":[{"type":"text","text":"account has no permission"}]})),
                2 => { self.release.notified().await; Ok(json!({"content":[{"type":"text","text":"done"}]})) },
                3 => Ok(json!({"content":[{"type":"text","text":credentials.token}]})),
                mode @ (6 | 7 | 8 | 9) => {
                    if tool != "taxi_create_order" { assert_eq!(arguments["order_id"], "fixture-ride"); }
                    if mode == 7 && tool != "taxi_create_order" {
                        let text = match tool {
                            "taxi_query_order" => "系统已为您匹配到司机。\n• 车牌：测试牌照\n约需03分钟到达。",
                            "taxi_get_driver_location" => "【司机位置】\n纬度：31.15\n经度：121.17\n",
                            _ => panic!("unexpected ride tool {tool}"),
                        };
                        return Ok(json!({"content":[{"type":"text","text":text}]}));
                    }
                    let result = match tool {
                        "taxi_create_order" => {
                            if mode == 8 {
                                assert_eq!(arguments, json!({"estimate_trace_id":"fixture-trace","product_category":"1"}));
                            }
                            if mode == 9 {
                                json!({"orderId":"fixture-ride","to":{"name":"目的地","longitude":121.45,"latitude":31.20}})
                            } else {
                                json!({"orderId":"fixture-ride"})
                            }
                        }
                        "taxi_query_order" if matches!(mode, 8 | 9) =>
                            json!({"statusCode":4,"map":{"eta":"12","distanceKm":"6.3"}}),
                        "taxi_query_order" => json!({"statusCode":1,"driver":{"carPlate":"测试牌照"},"map":{"eta":3}}),
                        "taxi_get_driver_location" => json!({"longitude":121.17,"latitude":31.15}),
                        _ => panic!("unexpected ride tool {tool}"),
                    };
                    Ok(json!({"content":[],"structuredContent":result}))
                }
                _ => Ok(json!({"content":[{"type":"text","text":"done"}]})),
            }
        })
    }
}
fn credentials(token: &str) -> Credentials { Credentials { token: token.into(), environment: "sandbox".into(), server_url: None, account: None, client_id: None } }
async fn fixture() -> (PersonalMcpState, Repository, String, Arc<Fixture>) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo.create_user("independent-mcp@example.test", "unused", "Tester", "Asia/Shanghai").await.unwrap();
    let transport = Arc::new(Fixture::new());
    let state = PersonalMcpState::with_transport(repo.clone(), Some(Crypto::from_hex(&"42".repeat(32)).unwrap()), transport.clone()).await.unwrap();
    state.connect(&user.id, "didi", credentials("independent-personal-token")).await.unwrap();
    (state, repo, user.id, transport)
}
fn action_id(value: &Value) -> String { value["action"]["id"].as_str().unwrap().into() }

#[tokio::test]
async fn ima_existing_connections_get_create_note_but_only_explicit_confirmation_executes_it() {
    let (state, _, user, transport) = fixture().await;
    state.connect(&user, "ima", Credentials {
        token: "ima-fixture-token".into(), environment: "production".into(), server_url: None,
        account: None, client_id: Some("ima-fixture-client".into()),
    }).await.unwrap();
    let tools = state.tools(&user, "ima").await.unwrap();
    assert!(tools["items"].as_array().unwrap().iter().any(|t| t["name"] == "ima_create_note" && t["requires_confirmation"] == true));
    let pending = state.invoke(&user, "ima", "ima_create_note", json!({"title":"会后总结","content":"确认下一步"})).await.unwrap();
    assert_eq!(pending["status"], "confirmation_required");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    let id = action_id(&pending);
    let confirmed = state.confirm(&user, &id).await.unwrap();
    assert_eq!(confirmed["status"], "completed");
    assert_eq!(confirmed["result"]["structuredContent"]["data"]["note_id"], "new-note");
    assert_eq!(state.confirm(&user, &id).await.unwrap()["status"], "completed");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ride_status_only_fetches_driver_position_on_request() {
    assert_ride_status(6).await;
}

#[tokio::test]
async fn ride_status_understands_official_sandbox_text_results() {
    assert_ride_status(7).await;
}

async fn assert_ride_status(fixture_mode: usize) {
    let (state, repo, user, transport) = fixture().await;
    transport.mode.store(fixture_mode, Ordering::SeqCst);
    let pending = state.invoke(&user, "didi", "taxi_create_order", json!({"from_name":"A"})).await.unwrap();
    let id = action_id(&pending);
    assert_eq!(state.confirm(&user, &id).await.unwrap()["status"], "completed");
    let session = repo.create_session(&user).await.unwrap();
    let router = super::router(state);
    for (query, expected_calls) in [("", 2), ("?include_vehicle=true", 4)] {
        let request = Request::builder().uri(format!("/v1/personal-mcp/actions/{id}/ride-status{query}"))
            .header("authorization", format!("Bearer {session}")).body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["plate"], "测试牌照");
        assert_eq!(value["eta"].as_f64(), Some(3.0));
        assert_eq!(value["vehicle"], if query.is_empty() { Value::Null } else { json!({"longitude":121.17,"latitude":31.15}) });
        assert_eq!(transport.calls.load(Ordering::SeqCst), expected_calls);
    }
}

#[tokio::test]
async fn ride_status_reads_the_dropoff_from_an_existing_order() {
    let (state, repo, user, transport) = fixture().await;
    transport.mode.store(9, Ordering::SeqCst);
    let pending = state.invoke(&user, "didi", "taxi_create_order",
        json!({"estimate_trace_id":"fixture-trace","product_category":"1"})).await.unwrap();
    let id = action_id(&pending);
    assert_eq!(state.confirm(&user, &id).await.unwrap()["status"], "completed");
    let session = repo.create_session(&user).await.unwrap();
    let request = Request::builder().uri(format!("/v1/personal-mcp/actions/{id}/ride-status?include_vehicle=true"))
        .header("authorization", format!("Bearer {session}")).body(Body::empty()).unwrap();
    let response = super::router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["status"], 4);
    assert_eq!(value["destination"], json!({"longitude":121.45,"latitude":31.20}));
    assert_eq!(value["vehicle"], json!({"longitude":121.17,"latitude":31.15}));
}

#[tokio::test]
async fn ride_status_uses_the_destination_bound_to_the_confirmed_order() {
    let (state, repo, user, transport) = fixture().await;
    transport.mode.store(8, Ordering::SeqCst);
    let (_, generation) = state.personal_form_catalog(&user, "didi").await.unwrap();
    let arguments = json!({"estimate_trace_id":"fixture-trace","product_category":"1"});
    let pending = state.prepare_didi_order(&user, arguments.clone(), "ride-test", generation,
        Some([121.45, 31.20])).await.unwrap();
    let id = action_id(&pending);
    assert_eq!(pending["action"]["arguments"], arguments);
    let completed = state.confirm(&user, &id).await.unwrap();
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["arguments"], arguments);

    let session = repo.create_session(&user).await.unwrap();
    let router = super::router(state);
    for (query, destination) in [("", Value::Null),
        ("?include_vehicle=true", json!({"longitude":121.45,"latitude":31.20}))] {
        let request = Request::builder().uri(format!("/v1/personal-mcp/actions/{id}/ride-status{query}"))
            .header("authorization", format!("Bearer {session}")).body(Body::empty()).unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], 4);
        assert_eq!(value["distance_km"], 6.3);
        assert_eq!(value["eta"], 12.0);
        assert_eq!(value["destination"], destination);
    }
}

#[tokio::test]
async fn business_tool_error_is_failed_and_cannot_be_executed_twice() {
    let (state, _, user, transport) = fixture().await;
    transport.mode.store(1, Ordering::SeqCst);
    let read = state.invoke(&user, "didi", "taxi_query_order", json!({"order_id":"fixture-order"})).await.unwrap();
    assert_eq!(read["status"], "failed", "isError is an explicit tool failure, never successful completion");
    let pending = state.invoke_scoped(&user, "didi", "taxi_create_order", json!({"from_name":"A","to_name":"B"}), "run-error:mcp:1").await.unwrap();
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1, "requesting a write must not call its provider");
    let id = action_id(&pending);
    let confirmed = state.confirm(&user, &id).await.unwrap();
    assert_eq!(confirmed["status"], "failed");
    assert_eq!(confirmed["result"]["isError"], true);
    assert_eq!(state.confirm(&user, &id).await.unwrap()["status"], "failed");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    assert!(state.actions(&user).await.unwrap()["items"].as_array().unwrap().iter().any(|item| item["id"] == id));
}

#[tokio::test]
async fn model_read_only_annotation_does_not_bypass_user_session_confirmation() {
    let (state, repo, user, transport) = fixture().await;
    let pending = state.invoke(&user, "didi", "unknown_read_claim", json!({"value":"requested"})).await.unwrap();
    assert_eq!(pending["status"], "confirmation_required");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    let id = action_id(&pending);
    let other = repo.create_user("other-independent@example.test", "unused", "Other", "Asia/Shanghai").await.unwrap();
    let other_session = repo.create_session(&other.id).await.unwrap();
    let own_session = repo.create_session(&user).await.unwrap();
    let router = super::router(state.clone());
    for (session, expected) in [("", StatusCode::UNAUTHORIZED), (other_session.as_str(), StatusCode::NOT_FOUND), (own_session.as_str(), StatusCode::OK)] {
        let mut request = Request::builder().method("POST").uri(format!("/v1/personal-mcp/actions/{id}/confirm"));
        if !session.is_empty() { request = request.header("authorization", format!("Bearer {session}")); }
        let response = router.clone().oneshot(request.body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        let body = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("independent-personal-token"));
    }
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn repeated_model_intent_coalesces_but_changed_replay_parameters_are_rejected() {
    let (state, _, user, transport) = fixture().await;
    let arguments = json!({"from_name":"same-start","to_name":"same-end"});
    let a = state.invoke_scoped(&user, "didi", "taxi_create_order", arguments.clone(), "same-run:mcp:1").await.unwrap();
    let b = state.invoke_scoped(&user, "didi", "taxi_create_order", arguments.clone(), "same-run:mcp:2").await.unwrap();
    assert_eq!(action_id(&a), action_id(&b));
    state.confirm(&user, &action_id(&a)).await.unwrap();
    let replay = state.invoke_scoped(&user, "didi", "taxi_create_order", arguments, "same-run:mcp:3").await.unwrap();
    assert_eq!(action_id(&replay), action_id(&a));
    assert_eq!(replay["status"], "completed", "a terminal replay must report its actual state, not request a second confirmation");
    assert_eq!(replay["action"]["status"], "completed");
    let error = state.invoke_scoped(&user, "didi", "taxi_create_order", json!({"to_name":"different-end"}), "same-run:mcp:1").await.err().unwrap();
    assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lost_confirmation_request_recovers_to_unknown_without_reexecuting() {
    let (state, repo, user, transport) = fixture().await;
    let pending = state.invoke(&user, "didi", "taxi_create_order", json!({"from_name":"A"})).await.unwrap();
    let id = action_id(&pending);
    transport.mode.store(2, Ordering::SeqCst);
    let operation = {
        let state = state.clone(); let user = user.clone(); let id = id.clone();
        tokio::spawn(async move { state.confirm(&user, &id).await })
    };
    transport.started.notified().await;
    assert_eq!(state.action(&user, &id).await.unwrap()["status"], "executing");
    operation.abort();
    let _ = operation.await;
    // Represents the persisted claim left by process termination past its lease.
    sqlx::query("UPDATE personal_mcp_actions SET started_at=$1 WHERE id=$2").bind(now()-91).bind(&id).execute(&repo.pool()).await.unwrap();
    let recovered = state.action(&user, &id).await.unwrap();
    assert_eq!(recovered["status"], "unknown_outcome");
    assert_eq!(state.confirm(&user, &id).await.unwrap()["status"], "unknown_outcome");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
    state.disconnect(&user, "didi").await.unwrap();
    let disconnected = state.action(&user, &id).await.unwrap();
    assert_eq!(disconnected["status"], "unknown_outcome", "disconnect cannot pretend an uncertain order was cancelled");
    assert_eq!(disconnected["arguments"], json!({}));
}

#[tokio::test]
async fn disconnect_removes_persisted_private_action_arguments_and_results() {
    let (state, repo, user, transport) = fixture().await;
    let pending = state.invoke(&user, "didi", "taxi_create_order", json!({"private_note":"confidential destination"})).await.unwrap();
    let id = action_id(&pending);
    state.confirm(&user, &id).await.unwrap();
    state.disconnect(&user, "didi").await.unwrap();
    let action = state.action(&user, &id).await.unwrap();
    assert_eq!(action["arguments"], json!({}));
    assert!(action.get("result").is_none());
    assert_eq!(action["status"], "completed", "disconnect clears credentials but does not cancel an already completed business operation");
    let (arguments, result): (String, String) = sqlx::query_as("SELECT encrypted_arguments,encrypted_result FROM personal_mcp_actions WHERE id=$1").bind(id).fetch_one(&repo.pool()).await.unwrap();
    assert!(arguments.is_empty() && result.is_empty());
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn json_escaped_personal_token_echo_is_rejected_in_tools_and_results() {
    let (state, _, user, transport) = fixture().await;
    transport.mode.store(4, Ordering::SeqCst);
    let private_token = "fixture-\"private-secret\\suffix";
    assert!(state.connect(&user, "didi", credentials(private_token)).await.is_err(), "token echo hidden behind JSON escaping must not be saved as a tool description");
    transport.mode.store(0, Ordering::SeqCst);
    state.connect(&user, "didi", credentials(private_token)).await.unwrap();
    transport.mode.store(3, Ordering::SeqCst);
    assert!(state.invoke(&user, "didi", "taxi_query_order", json!({"order_id":"fixture"})).await.is_err(), "decoded result strings must not expose the token");
}

#[tokio::test]
async fn failed_credential_replacement_fences_old_pending_writes_without_losing_working_account() {
    let (state, _, user, transport) = fixture().await;
    let old = state.invoke(&user, "didi", "taxi_create_order", json!({"from_name":"old-request"})).await.unwrap();
    transport.mode.store(5, Ordering::SeqCst);
    assert!(state.connect(&user, "didi", credentials("rejected-replacement-token")).await.is_err());
    let action = state.action(&user, &action_id(&old)).await.unwrap();
    assert_eq!(action["status"], "cancelled");
    assert_eq!(action["arguments"], json!({}));
    assert_eq!(state.confirm(&user, &action_id(&old)).await.unwrap()["status"], "cancelled");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    transport.mode.store(0, Ordering::SeqCst);
    let own = state.statuses(&user).await.unwrap().into_iter().find(|item| item["id"] == "didi").unwrap();
    assert_eq!(own["status"], "connected", "a failed replacement must preserve the previously working credential");
    assert_eq!(state.invoke(&user, "didi", "taxi_query_order", json!({"order_id":"existing"})).await.unwrap()["status"], "completed");
}
