use super::{
    router,
    state::{McpTransport, PersonalMcpState},
    transport::Credentials,
};
use crate::{ConnectorError, crypto::Crypto};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use tomorrow_domain::Repository;
use tower::ServiceExt;

#[derive(Default)]
struct FixtureTransport {
    discoveries: AtomicUsize,
    calls: AtomicUsize,
    fail: AtomicBool,
    echo: AtomicBool,
    large: AtomicBool,
    block_discovery: AtomicBool,
    block_call: AtomicBool,
    started: Notify,
    release: Notify,
}
impl McpTransport for FixtureTransport {
    fn discover<'a>(
        &'a self,
        _provider: &'a str,
        credentials: &'a Credentials,
    ) -> Pin<Box<dyn Future<Output = crate::Result<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            self.discoveries.fetch_add(1, Ordering::SeqCst);
            if self.block_discovery.load(Ordering::SeqCst) {
                self.started.notify_one();
                self.release.notified().await;
            }
            if self.fail.load(Ordering::SeqCst) || credentials.token.starts_with("invalid") {
                return Err(ConnectorError::new(
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    "账号校验失败",
                ));
            }
            let mut tools = vec![
                json!({"name":"maps_textsearch","description":"查找地点","inputSchema":{"type":"object"}}),
                json!({"name":"taxi_create_order","description":"创建订单","inputSchema":{"type":"object"}}),
            ];
            if self.echo.load(Ordering::SeqCst) {
                tools[0]["description"] = json!(credentials.token);
            }
            if self.large.load(Ordering::SeqCst) {
                for i in 0..38 {
                    tools.push(json!({"name":format!("query_extra_{i}"),"description":"x".repeat(6000),"inputSchema":{"type":"object"}}));
                }
            }
            Ok(tools)
        })
    }
    fn call<'a>(
        &'a self,
        _provider: &'a str,
        credentials: &'a Credentials,
        _tool: &'a str,
        arguments: Value,
    ) -> Pin<Box<dyn Future<Output = crate::Result<Value>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.block_call.load(Ordering::SeqCst) {
                self.started.notify_one();
                self.release.notified().await;
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err(ConnectorError::new(
                    StatusCode::BAD_GATEWAY,
                    "provider_error",
                    "请求失败",
                ));
            }
            if self.echo.load(Ordering::SeqCst) {
                return Ok(json!({"content":[{"type":"text","text":credentials.token}]}));
            }
            Ok(json!({"content":[{"type":"text","text":"真实模拟服务结果"}],"arguments":arguments}))
        })
    }
}
async fn fixture() -> (
    PersonalMcpState,
    Repository,
    Arc<FixtureTransport>,
    String,
    String,
    String,
    String,
) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("mcp-a@example.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("mcp-b@example.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let ta = repo.create_session(&a.id).await.unwrap();
    let tb = repo.create_session(&b.id).await.unwrap();
    let transport = Arc::new(FixtureTransport::default());
    let state = PersonalMcpState::with_transport(
        repo.clone(),
        Some(Crypto::from_hex(&"ab".repeat(32)).unwrap()),
        transport.clone(),
    )
    .await
    .unwrap();
    (state, repo, transport, a.id, b.id, ta, tb)
}
fn credentials() -> Credentials {
    Credentials {
        token: "owner-personal-token-very-private".into(),
        environment: "production".into(),
        server_url: None, account: None, client_id: None,
    }
}
async fn request(
    state: &PersonalMcpState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router(state.clone())
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn personal_form_binds_account_generation_and_replays_without_duplicate_writes() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    state.connect(&a, "didi", credentials()).await.unwrap();
    let (_, generation) = state.personal_form_catalog(&a, "didi").await.unwrap();
    let arguments = json!({"contactName":"测试收件人","phone":"13800000000","address":"测试市测试路1号"});
    let pending = state.invoke_personal_form(&a,"didi","taxi_create_order",arguments.clone(),"form-test:mcp:personal:1",generation).await.unwrap();
    assert_eq!(pending["status"],"confirmation_required");
    assert_eq!(transport.calls.load(Ordering::SeqCst),0);
    let id = pending["id"].as_str().unwrap();
    let result = state.confirm(&a,id).await.unwrap();
    assert_eq!(result["status"],"completed");
    assert_eq!(result["result"]["arguments"],arguments);
    state.confirm(&a,id).await.unwrap();
    let replay = state.invoke_personal_form(&a,"didi","taxi_create_order",arguments.clone(),"form-test:mcp:personal:1",generation).await.unwrap();
    assert_eq!(replay["status"],"completed");
    assert_eq!(transport.calls.load(Ordering::SeqCst),1);
    state.connect(&a, "didi", credentials()).await.unwrap();
    assert!(state.invoke_personal_form(&a,"didi","taxi_create_order",arguments,"form-test:mcp:personal:2",generation).await.is_err());
    assert_eq!(transport.calls.load(Ordering::SeqCst),1);
}

#[tokio::test]
async fn all_routes_require_a_user_session() {
    let (state, _, transport, _, _, _, _) = fixture().await;
    for (method, path) in [
        ("GET", "/v1/personal-mcp"),
        ("GET", "/v1/personal-mcp/actions"),
        ("POST", "/v1/personal-mcp/didi/connect"),
        ("POST", "/v1/personal-mcp/didi/test"),
        ("GET", "/v1/personal-mcp/didi/tools"),
        ("POST", "/v1/personal-mcp/didi/call"),
        ("DELETE", "/v1/personal-mcp/didi"),
        ("POST", "/v1/personal-mcp/actions/not-owned/confirm"),
        ("POST", "/v1/personal-mcp/actions/not-owned/cancel"),
    ] {
        assert_eq!(
            request(&state, method, path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(transport.discoveries.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn connect_verifies_then_encrypts_and_never_returns_personal_secrets() {
    let (state, repo, transport, a, b, ta, tb) = fixture().await;
    let (status, value) = request(
        &state,
        "POST",
        "/v1/personal-mcp/didi/connect",
        Some(&ta),
        json!({"token":credentials().token}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["status"], "connected");
    assert_eq!(value["tool_count"], 2);
    assert!(!value.to_string().contains(&credentials().token));
    assert_eq!(transport.discoveries.load(Ordering::SeqCst), 1);
    let row=sqlx::query("SELECT encrypted_credentials,encrypted_tools FROM personal_mcp_accounts WHERE user_id=$1 AND provider='didi'").bind(&a).fetch_one(&repo.pool()).await.unwrap();
    assert!(
        !row.get::<String, _>("encrypted_credentials")
            .contains(&credentials().token)
    );
    assert!(
        !row.get::<String, _>("encrypted_tools")
            .contains("maps_textsearch")
    );
    let (_, catalog) = request(&state, "GET", "/v1/personal-mcp", Some(&tb), json!({})).await;
    assert_eq!(
        catalog["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "didi")
            .unwrap()["status"],
        "not_connected"
    );
    assert!(state.tools(&b, "didi").await.is_err());
    let (_, tools) = request(
        &state,
        "GET",
        "/v1/personal-mcp/didi/tools",
        Some(&ta),
        json!({}),
    )
    .await;
    assert_eq!(tools["items"][0]["requires_confirmation"], false);
    assert_eq!(tools["items"][1]["requires_confirmation"], true);
    let result = state
        .invoke(&a, "didi", "maps_textsearch", json!({"keywords":"图书馆"}))
        .await
        .unwrap();
    assert_eq!(result["status"], "completed");
    assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn copied_credentials_and_tools_cannot_be_opened_by_another_user() {
    let (state, repo, _, a, b, _, _) = fixture().await;
    state.connect(&a, "didi", credentials()).await.unwrap();
    state.connect(&b, "didi", credentials()).await.unwrap();
    let row=sqlx::query("SELECT encrypted_credentials,encrypted_tools FROM personal_mcp_accounts WHERE user_id=$1 AND provider='didi'").bind(&a).fetch_one(&repo.pool()).await.unwrap();
    sqlx::query("UPDATE personal_mcp_accounts SET encrypted_credentials=$1,encrypted_tools=$2 WHERE user_id=$3 AND provider='didi'").bind(row.get::<String,_>("encrypted_credentials")).bind(row.get::<String,_>("encrypted_tools")).bind(&b).execute(&repo.pool()).await.unwrap();
    assert!(state.tools(&b, "didi").await.is_err());
    assert_eq!(
        state
            .statuses(&b)
            .await
            .unwrap()
            .iter()
            .find(|v| v["id"] == "didi")
            .unwrap()["status"],
        "needs_reconnect"
    );
    assert!(state.tools(&a, "didi").await.is_ok());
}

#[tokio::test]
async fn failed_reconnect_preserves_previous_working_credentials() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    state.connect(&a, "didi", credentials()).await.unwrap();
    let mut bad = credentials();
    bad.token = "invalid-personal-token".into();
    assert!(state.connect(&a, "didi", bad).await.is_err());
    assert_eq!(
        state
            .statuses(&a)
            .await
            .unwrap()
            .iter()
            .find(|v| v["id"] == "didi")
            .unwrap()["status"],
        "connected"
    );
    assert!(
        state
            .invoke(&a, "didi", "maps_textsearch", json!({}))
            .await
            .is_ok()
    );
    assert_eq!(transport.discoveries.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn disconnect_fences_a_connect_still_verifying() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    transport.block_discovery.store(true, Ordering::SeqCst);
    let start = transport.started.notified();
    let task = {
        let state = state.clone();
        let a = a.clone();
        tokio::spawn(async move { state.connect(&a, "didi", credentials()).await })
    };
    start.await;
    state.disconnect(&a, "didi").await.unwrap();
    transport.release.notify_one();
    assert!(task.await.unwrap().is_err());
    assert_eq!(
        state
            .statuses(&a)
            .await
            .unwrap()
            .iter()
            .find(|v| v["id"] == "didi")
            .unwrap()["status"],
        "not_connected"
    );
}

#[tokio::test]
async fn disconnect_fences_a_read_and_test_in_flight() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    state.connect(&a, "didi", credentials()).await.unwrap();
    transport.block_call.store(true, Ordering::SeqCst);
    let start = transport.started.notified();
    let task = {
        let state = state.clone();
        let a = a.clone();
        tokio::spawn(async move { state.invoke(&a, "didi", "maps_textsearch", json!({})).await })
    };
    start.await;
    state.disconnect(&a, "didi").await.unwrap();
    transport.release.notify_one();
    assert!(task.await.unwrap().is_err());
    state.connect(&a, "didi", credentials()).await.unwrap();
    transport.block_discovery.store(true, Ordering::SeqCst);
    let start = transport.started.notified();
    let task = {
        let state = state.clone();
        let a = a.clone();
        tokio::spawn(async move { state.test(&a, "didi").await })
    };
    start.await;
    state.disconnect(&a, "didi").await.unwrap();
    transport.release.notify_one();
    assert!(task.await.unwrap().is_err());
}

#[tokio::test]
async fn tools_and_results_cannot_echo_escaped_personal_tokens() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    let mut token = credentials();
    token.token = "private-quote\"slash\\token".into();
    transport.echo.store(true, Ordering::SeqCst);
    assert!(state.connect(&a, "didi", token.clone()).await.is_err());
    transport.echo.store(false, Ordering::SeqCst);
    state.connect(&a, "didi", token).await.unwrap();
    transport.echo.store(true, Ordering::SeqCst);
    assert!(
        state
            .invoke(&a, "didi", "maps_textsearch", json!({}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn tool_schema_vault_supports_bounded_multi_chunk_catalogs() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    transport.large.store(true, Ordering::SeqCst);
    let value = state.connect(&a, "didi", credentials()).await.unwrap();
    assert_eq!(value["tool_count"], 40);
    let tools = state.tools(&a, "didi").await.unwrap();
    assert_eq!(tools["items"].as_array().unwrap().len(), 40);
    assert_eq!(
        tools["items"][2]["description"].as_str().unwrap().len(),
        6000
    );
}

#[tokio::test]
async fn test_connection_really_discovers_again_and_failed_test_is_visible() {
    let (state, _, transport, a, _, _, _) = fixture().await;
    state.connect(&a, "didi", credentials()).await.unwrap();
    state.test(&a, "didi").await.unwrap();
    assert_eq!(transport.discoveries.load(Ordering::SeqCst), 2);
    transport.fail.store(true, Ordering::SeqCst);
    assert!(state.test(&a, "didi").await.is_err());
    assert_eq!(
        state
            .statuses(&a)
            .await
            .unwrap()
            .iter()
            .find(|v| v["id"] == "didi")
            .unwrap()["status"],
        "needs_reconnect"
    );
    transport.fail.store(false, Ordering::SeqCst);
    assert_eq!(state.test(&a, "didi").await.unwrap()["status"], "connected");
}

#[tokio::test]
async fn unavailable_encryption_never_contacts_provider() {
    let (_, repo, transport, a, _, _, _) = fixture().await;
    let state = PersonalMcpState::with_transport(repo, None, transport.clone())
        .await
        .unwrap();
    assert!(state.connect(&a, "didi", credentials()).await.is_err());
    assert_eq!(transport.discoveries.load(Ordering::SeqCst), 0);
    assert_eq!(
        state.statuses(&a).await.unwrap()[0]["status"],
        "not_configured"
    );
}
