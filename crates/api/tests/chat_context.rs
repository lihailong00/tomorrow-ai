use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{agent::AgentClient, new_id, ModelProvider, Repository};
use tower::ServiceExt;

async fn pi(State(seen): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>) -> Json<Value> {
    seen.lock().unwrap().push(body);
    Json(json!({"content":"收到本轮上下文","usage":{}}))
}
async fn send(router: &Router, token: &str, path: &str, body: Value) -> (StatusCode, String) {
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
async fn scoped_context_reaches_pi_on_both_chat_paths_but_not_history_or_memory_jobs() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "location@api.test",
            "unused",
            "Location QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let gateway = Router::new()
        .route("/v1/runs", post(pi))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let mut state = AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:");
    state.agent = Some(
        AgentClient::new(
            &url,
            "location-fixture-service-secret-at-least-32".into(),
            "fixture".into(),
        )
        .unwrap(),
    );
    let router = app(state);
    for path in ["/v1/chat", "/v1/chat/stream"] {
        let location = json!({"source":"device","latitude":31.2304,"longitude":121.4737,"accuracy_m":40,
            "coordinate_system":"wgs84","observed_at":chrono::Utc::now().to_rfc3339(),"label":"synthetic-origin-privacy-fixture"});
        let body = json!({"message":"从我这里去陆家嘴，普通车","client_request_id":new_id(),"client_context":{"timezone":"Asia/Tokyo","location":location}});
        let (status, response) = send(&router, &token, path, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        let captured = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!(captured["runtime_context"]["timezone"], "Asia/Tokyo");
        assert_eq!(
            captured["runtime_context"]["location"]["coordinate_system"],
            "wgs84"
        );
        assert_eq!(
            captured["runtime_context"]["location"]["map_coordinates"]["coordinate_system"],
            "gcj02"
        );
        assert!(captured["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| !m.to_string().contains("synthetic-origin-privacy-fixture")));
        let count = seen.lock().unwrap().len();
        assert_eq!(
            send(&router, &token, path, body.clone()).await.0,
            StatusCode::OK
        );
        assert_eq!(seen.lock().unwrap().len(), count);
        let mut changed = body;
        changed["client_context"]["location"]["latitude"] = json!(31.24);
        assert_eq!(
            send(&router, &token, path, changed).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(seen.lock().unwrap().len(), count);
    }
    // A later ordinary message receives time, never the previous request's coordinates.
    assert_eq!(
        send(
            &router,
            &token,
            "/v1/chat",
            json!({"message":"你好","client_request_id":new_id()})
        )
        .await
        .0,
        StatusCode::OK
    );
    let last = seen.lock().unwrap().last().unwrap().clone();
    assert!(last["runtime_context"].get("location").is_none());
    assert_eq!(last["runtime_context"]["timezone"], "Asia/Shanghai");
    for query in [
        "SELECT body FROM resources WHERE kind='message'",
        "SELECT source FROM memory_jobs",
        "SELECT fingerprint FROM chat_request_inputs",
        "SELECT fingerprint FROM agent_runs",
    ] {
        // Durable rows contain ordinary messages or hashes, never the context envelope.
        let rows: Vec<String> = sqlx::query_scalar(query)
            .fetch_all(&repo.pool())
            .await
            .unwrap();
        assert!(
            rows.iter()
                .all(|row| !row.contains("synthetic-origin-privacy-fixture")
                    && !row.contains("121.4737")
                    && !row.contains("runtime_context")),
            "{query}"
        );
    }
    for context in [
        json!({"timezone":"Not/AZone"}),
        json!({"timezone":"UTC","server_time_utc":"2099-01-01T00:00:00Z"}),
        json!({"timezone":"UTC","location":{"source":"manual","label":"上海站","observed_at":(chrono::Utc::now()-chrono::Duration::hours(25)).to_rfc3339()}}),
    ] {
        let count = seen.lock().unwrap().len();
        let (status, _) = send(
            &router,
            &token,
            "/v1/chat",
            json!({"message":"bad","client_request_id":new_id(),"client_context":context}),
        )
        .await;
        assert!(matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
        ));
        assert_eq!(seen.lock().unwrap().len(), count);
    }
    server.abort();
}
