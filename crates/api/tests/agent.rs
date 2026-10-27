use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{agent::AgentClient, ModelProvider, Repository};
use tower::ServiceExt;

const SECRET: &str = "fixture-service-token-32-characters-long";
async fn request(
    router: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    service: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(service) = service {
        request = request.header("x-agent-service", service);
    }
    let response = router
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn fixture(url: &str) -> (Repository, Router, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("pi-api-a@local.test", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let other = repo
        .create_user("pi-api-b@local.test", "unused", "乙", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let other_token = repo.create_session(&other.id).await.unwrap();
    let mut state = AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:");
    state.agent = Some(AgentClient::new(url, SECRET.into(), "fixture-model".into()).unwrap());
    (repo, app(state), user.id, token, other_token)
}

#[tokio::test]
async fn internal_tools_require_both_service_and_scoped_run_authority() {
    let (repo, router, user, token, other) = fixture("http://127.0.0.1:9").await;
    let run = repo
        .begin_agent_run(&user, "auth", "fixture", None, None)
        .await
        .unwrap();
    let path = format!("/internal/agent/runs/{}/tools", run.id);
    let body = json!({"name":"save_memory","operation_index":1,"arguments":{"title":"测试","content":"不泄露","kind":"fact"}});
    assert_eq!(
        request(
            router.clone(),
            "POST",
            &path,
            Some(&run.token),
            None,
            body.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            router.clone(),
            "POST",
            &path,
            Some(&token),
            Some(SECRET),
            body.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            router.clone(),
            "POST",
            &path,
            Some(&run.token),
            Some(SECRET),
            body.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let public_path = format!("/v1/agent-runs/{}", run.id);
    assert_eq!(
        request(
            router.clone(),
            "GET",
            &public_path,
            Some(&other),
            None,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (_, view) = request(
        router.clone(),
        "GET",
        &public_path,
        Some(&token),
        None,
        json!({}),
    )
    .await;
    assert!(!view.to_string().contains(&run.token));
    assert!(!view.to_string().contains(SECRET));
    request(
        router.clone(),
        "POST",
        &format!("{public_path}/cancel"),
        Some(&token),
        None,
        json!({}),
    )
    .await;
    assert_eq!(
        request(router, "POST", &path, Some(&run.token), Some(SECRET), body)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(repo.memories(&user).await.unwrap().len(), 1);
}

#[tokio::test]
async fn unavailable_pi_returns_error_without_local_fallback_or_chat_commit() {
    let (repo, router, user, token, _) = fixture("http://127.0.0.1:9").await;
    let (status, _) = request(
        router.clone(),
        "POST",
        "/v1/chat",
        Some(&token),
        None,
        json!({"message":"帮我创建任务","client_request_id":"unavailable"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(repo.conversations(&user).await.unwrap().is_empty());
    assert!(repo.tasks(&user).await.unwrap().is_empty());
    let runs = repo.agent_run_summaries(&user).await.unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], "failed");
    let (_, health) = request(router, "GET", "/v1/health", None, None, json!({})).await;
    assert_eq!(health["runtime"]["agent_harness"], "pi");
    assert_eq!(health["runtime"]["model_name"], "fixture-model");
}

#[derive(Clone)]
struct Gateway {
    repo: Repository,
    calls: Arc<AtomicUsize>,
}
async fn flaky_gateway(
    State(state): State<Gateway>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(
        headers.get("authorization").unwrap().to_str().unwrap(),
        format!("Bearer {SECRET}")
    );
    assert!(body.get("user_id").is_none());
    let value = state
        .repo
        .execute_agent_tool(
            body["run_id"].as_str().unwrap(),
            body["run_token"].as_str().unwrap(),
            "save_memory",
            json!({"title":"重试偏好","content":"操作已持久保存","kind":"preference"}),
        )
        .await
        .unwrap();
    if state.calls.fetch_add(1, Ordering::SeqCst) == 0 {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"fixture failure after effect"})),
        )
    } else {
        assert_eq!(value["replayed"], true);
        (
            StatusCode::OK,
            Json(json!({"content":"已保存偏好","usage":{"total_tokens":12}})),
        )
    }
}

#[tokio::test]
async fn gateway_retry_reuses_effects_and_commit_then_caches_entire_chat_response() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (repo, router, user, token, _) = fixture(&format!("http://{address}")).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = Router::new()
        .route("/v1/runs", post(flaky_gateway))
        .with_state(Gateway {
            repo: repo.clone(),
            calls: calls.clone(),
        });
    let server = tokio::spawn(async move {
        axum::serve(listener, gateway).await.unwrap();
    });
    let input = json!({"message":"请保存偏好","client_request_id":"same-logical-turn"});
    assert_eq!(
        request(
            router.clone(),
            "POST",
            "/v1/chat",
            Some(&token),
            None,
            input.clone()
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert!(repo.conversations(&user).await.unwrap().is_empty());
    assert_eq!(repo.memories(&user).await.unwrap().len(), 1);
    let (status, recovered) = request(
        router.clone(),
        "POST",
        "/v1/chat",
        Some(&token),
        None,
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(recovered["agent_run_id"].is_string());
    let (_, cached) = request(router, "POST", "/v1/chat", Some(&token), None, input).await;
    assert_eq!(cached, recovered);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        repo.messages(&user, recovered["conversation_id"].as_str().unwrap())
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(repo.memories(&user).await.unwrap().len(), 1);
    server.abort();
}
