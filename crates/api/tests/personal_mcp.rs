use axum::{Router, body::{Body, to_bytes}, http::{Request, StatusCode}};
use serde_json::{Value, json};
use tomorrow_api::{AppState, app};
use tomorrow_connectors::personal_mcp::PersonalMcpState;
use tomorrow_domain::{ModelProvider, Repository, agent::{AgentClient, tool_definitions}};
use tower::ServiceExt;

const SERVICE: &str = "personal-mcp-fixture-service-token-at-least-32-characters";

async fn request(router: Router, method: &str, path: &str, token: &str, internal: bool, body: Value) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() { request = request.header("authorization", format!("Bearer {token}")); }
    if internal { request = request.header("x-agent-service", SERVICE); }
    let response = router.oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn fixture() -> (Router, Repository, String, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo.create_user("mcp-a@example.test", "unused", "A", "Asia/Shanghai").await.unwrap();
    let b = repo.create_user("mcp-b@example.test", "unused", "B", "Asia/Shanghai").await.unwrap();
    let session_a = repo.create_session(&a.id).await.unwrap();
    let session_b = repo.create_session(&b.id).await.unwrap();
    let mut state = AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:");
    state.personal_mcp = Some(PersonalMcpState::new(repo.clone()).await.unwrap().reconfigured(
        &std::collections::HashMap::from([("CONNECTOR_ENCRYPTION_KEY".into(), "42".repeat(32))])));
    state.agent = Some(AgentClient::new("http://127.0.0.1:9", SERVICE.into(), "fixture".into()).unwrap());
    (app(state), repo, a.id, b.id, session_a, session_b)
}

#[tokio::test]
async fn personal_mcp_routes_are_mounted_and_require_a_user_session() {
    let (router, _, _, _, session, _) = fixture().await;
    for (method, path, body) in [
        ("GET", "/v1/personal-mcp", json!({})),
        ("GET", "/v1/personal-mcp/actions", json!({})),
        ("POST", "/v1/personal-mcp/didi/connect", json!({"token":""})),
        ("POST", "/v1/personal-mcp/didi/test", json!({})),
        ("GET", "/v1/personal-mcp/didi/tools", json!({})),
        ("DELETE", "/v1/personal-mcp/didi", json!({})),
        ("POST", "/v1/personal-mcp/actions/not-owned/confirm", json!({})),
        ("POST", "/v1/personal-mcp/actions/not-owned/cancel", json!({})),
    ] {
        let (status, result) = request(router.clone(), method, path, "", false, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {result}");
    }
    let (status, result) = request(router.clone(), "GET", "/v1/personal-mcp", &session, false, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let items = result["items"].as_array().unwrap();
    assert!(items.iter().any(|item| item["id"] == "didi"));
    assert!(!result.to_string().contains("encrypted_credentials"));
    assert!(!result.to_string().contains("42424242"));
    let (status, capabilities) = request(router, "GET", "/v1/capabilities", &session, false, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(capabilities.to_string().contains("personal_mcp_didi"));
}

#[tokio::test]
async fn agent_mcp_bridge_is_run_scoped_and_cannot_confirm_operations() {
    let (router, repo, a, _, session_a, session_b) = fixture().await;
    let run = repo.begin_agent_run(&a, "mcp-fixture", "fixture", None, None).await.unwrap();
    let path = format!("/internal/agent/runs/{}/tools", run.id);
    let list = json!({"name":"list_mcp_connections","arguments":{}});
    assert_eq!(request(router.clone(), "POST", &path, &run.token, false, list.clone()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(request(router.clone(), "POST", &path, &session_b, true, list.clone()).await.0, StatusCode::FORBIDDEN);
    let (status, result) = request(router.clone(), "POST", &path, &run.token, true, list.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(result["items"].is_array());
    // Model arguments cannot select another account or grant approval.
    for arguments in [json!({"user_id":"another-user"}), json!({"confirmed":true}), json!({"token":"personal-secret"})] {
        assert_eq!(request(router.clone(), "POST", &path, &run.token, true,
            json!({"name":"list_mcp_connections","arguments":arguments})).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(request(router.clone(), "POST", "/v1/personal-mcp/actions/arbitrary/confirm", &run.token, false, json!({})).await.0,
        StatusCode::UNAUTHORIZED);
    assert_eq!(request(router.clone(), "POST", &path, &run.token, true,
        json!({"name":"confirm_mcp_action","arguments":{"id":"arbitrary"}})).await.0, StatusCode::FORBIDDEN);
    let (status, _) = request(router.clone(), "POST", &path, &run.token, true,
        json!({"name":"get_mcp_action","arguments":{"id":"another-users-action"}})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    repo.cancel_agent_run(&a, &run.id).await.unwrap();
    assert_eq!(request(router.clone(), "POST", &path, &run.token, true, list).await.0, StatusCode::FORBIDDEN);
    // A real user session remains valid, independently of a cancelled Agent run.
    assert_eq!(request(router, "GET", "/v1/personal-mcp", &session_a, false, json!({})).await.0, StatusCode::OK);
}

#[test]
fn personal_mcp_tools_are_in_the_model_contract_without_credential_or_confirmation_tools() {
    for scope in ["chat", "task"] {
        let definitions = tool_definitions(scope);
        for name in ["list_mcp_connections", "list_mcp_tools", "call_mcp_tool", "get_mcp_action"] {
            assert!(definitions.iter().any(|item| item.name == name));
        }
        assert!(definitions.len() <= 64);
        assert!(!definitions.iter().any(|item| item.name.contains("confirm_mcp") || item.name.contains("connect_mcp")));
    }
}
