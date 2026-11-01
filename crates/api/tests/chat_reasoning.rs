use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tomorrow_api::{AppState, app};
use tomorrow_domain::{ModelProvider, Repository, agent::AgentClient, new_id};
use tower::ServiceExt;

async fn fake_pi(
    State(seen): State<Arc<Mutex<Vec<Value>>>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    seen.lock().unwrap().push(body);
    Json(json!({"content":"验证通过", "usage":{}}))
}

async fn call(router: &Router, token: &str, path: &str, body: Value) -> (StatusCode, String) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        to_bytes(response.into_body(), 1024 * 1024),
    )
    .await
    .unwrap()
    .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn choices_reach_pi_for_json_and_sse_and_retries_keep_the_original_strength() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user(
            "reasoning@example.test",
            "unused",
            "Reasoning QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&owner.id).await.unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let gateway = Router::new()
        .route("/v1/runs", post(fake_pi))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, gateway).await.unwrap();
    });
    let mut state = AppState::new(repo, ModelProvider::local(), "sqlite::memory:");
    state.agent = Some(
        AgentClient::new(
            &url,
            "reasoning-fixture-service-token-at-least-32".into(),
            "fixture".into(),
        )
        .unwrap(),
    );
    let router = app(state);
    for path in ["/v1/chat", "/v1/chat/stream"] {
        for effort in [None, Some("off"), Some("low"), Some("high"), Some("max")] {
            let mut body = json!({"message":"分析测试计划", "client_request_id":new_id()});
            if let Some(effort) = effort {
                body["reasoning_effort"] = json!(effort);
            }
            let (status, response) = call(&router, &token, path, body.clone()).await;
            assert_eq!(status, StatusCode::OK, "{response}");
            assert!(response.contains("验证通过"), "{response}");
            assert_eq!(
                seen.lock().unwrap().last().unwrap()["reasoning_effort"],
                effort.unwrap_or("off")
            );
            let count = seen.lock().unwrap().len();
            // An omitted choice and explicit off have the same durable fingerprint.
            body["reasoning_effort"] = json!(effort.unwrap_or("off"));
            let (status, response) = call(&router, &token, path, body.clone()).await;
            assert_eq!(status, StatusCode::OK, "{response}");
            assert_eq!(seen.lock().unwrap().len(), count);
            // A retry with a new strength cannot silently regenerate or rerun tools.
            body["reasoning_effort"] = json!(if effort == Some("max") { "low" } else { "max" });
            let (status, response) = call(&router, &token, path, body).await;
            assert_eq!(status, StatusCode::CONFLICT, "{response}");
            assert_eq!(seen.lock().unwrap().len(), count);
        }
        for invalid in [json!("auto"), json!("medium"), json!(null), json!(42)] {
            let count = seen.lock().unwrap().len();
            let (status, response) = call(&router, &token, path,
                json!({"message":"bad choice", "client_request_id":new_id(), "reasoning_effort":invalid})).await;
            assert!(
                matches!(
                    status,
                    StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
                ),
                "{path} {invalid}: {status} {response}"
            );
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["error"]["code"],
                "invalid_request"
            );
            assert_eq!(seen.lock().unwrap().len(), count);
        }
    }
    server.abort();
}
