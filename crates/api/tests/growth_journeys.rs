use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;
async fn call(router: &Router, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status().as_u16();
    let bytes = to_bytes(r.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
#[tokio::test]
async fn journey_routes_are_owned_and_history_parameters_are_validated() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("journey-api@example.test", "fixture", "A", "UTC")
        .await
        .unwrap()
        .id;
    let b = repo
        .create_user("journey-api-b@example.test", "fixture", "B", "UTC")
        .await
        .unwrap()
        .id;
    let token = repo.create_session(&a).await.unwrap();
    let foreign = repo.create_session(&b).await.unwrap();
    let provider = ModelProvider::from_lookup(|k| match k {
        "MODEL_BASE_URL" => Some("http://127.0.0.1:1".into()),
        "MODEL_API_KEY" => Some("fixture".into()),
        "MODEL_NAME" => Some("fixture".into()),
        _ => None,
    });
    let router = app(AppState::new(repo, provider, "sqlite::memory:"));
    assert_eq!(
        call(&router, "invalid", "GET", "/v1/growth/journeys", json!({}))
            .await
            .0,
        401
    );
    assert_eq!(
        call(&router, &token, "GET", "/v1/growth/journeys", json!({}))
            .await
            .1,
        json!({"active":null,"past":[]})
    );
    let input = json!({"goal":"看懂Rust借用示例","kind":"learning","daily_minutes":15,"preferences_version":0,"client_request_id":"api-journey"});
    let (status, j) = call(
        &router,
        &token,
        "POST",
        "/v1/growth/journeys",
        input.clone(),
    )
    .await;
    assert_eq!(status, 200, "{j}");
    assert_eq!(
        call(&router, &token, "POST", "/v1/growth/journeys", input)
            .await
            .1["id"],
        j["id"]
    );
    let path = format!("/v1/growth/journeys/{}/commands", j["id"].as_str().unwrap());
    assert_eq!(
        call(
            &router,
            &foreign,
            "POST",
            &path,
            json!({"action":"archive","version":1,"client_request_id":"foreign"})
        )
        .await
        .0,
        404
    );
    for p in ["week", "month", "all"] {
        let (status, data) = call(
            &router,
            &token,
            "GET",
            &format!("/v1/growth/history?period={p}&offset=0&limit=30"),
            json!({}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(data["action_count"], 0);
        assert_eq!(data["records"], json!([]));
    }
    assert_eq!(
        call(
            &router,
            &token,
            "GET",
            "/v1/growth/history?period=invalid",
            json!({})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(
            &router,
            &token,
            "GET",
            "/v1/growth/history?period=all&limit=10000",
            json!({})
        )
        .await
        .0,
        400
    );
}
