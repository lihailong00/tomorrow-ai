use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{
    usage::{UsageDispatch, UsageIdentity},
    ModelProvider, Repository,
};
use tower::ServiceExt;

async fn request(
    router: axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let status = response.status();
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn usage_api_authentication_ownership_validation_and_persisted_reminder() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let first = repo
        .create_user("usage-a@api.test", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let second = repo
        .create_user("usage-b@api.test", "unused", "乙", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&first.id).await.unwrap();
    let other = repo.create_session(&second.id).await.unwrap();
    repo.usage_dispatch(
        &first.id,
        UsageDispatch::new(
            "actual-attempt",
            UsageIdentity::new("fixture", "model", "模型", "服务"),
            "llm",
            "chat",
        ),
    )
    .await
    .unwrap();
    let router = app(AppState::new(
        repo,
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    for path in ["/v1/usage", "/v1/usage/reminder"] {
        assert_eq!(
            request(router.clone(), "GET", path, None, json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(router.clone(), "GET", path, Some("invalid"), json!({}))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let (status, own) = request(router.clone(), "GET", "/v1/usage", Some(&token), json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(own["totals"]["call_count"], 1);
    assert_eq!(own["totals"]["cost_status"], "unknown");
    assert!(own["totals"]["estimated_cost_cny_micros"].is_null());
    let (_, other_report) =
        request(router.clone(), "GET", "/v1/usage", Some(&other), json!({})).await;
    assert_eq!(other_report["totals"]["call_count"], 0);
    let (status, _) = request(
        router.clone(),
        "GET",
        "/v1/usage?period=custom&start=2026-02-30&end=2026-03-01",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = request(
        router.clone(),
        "GET",
        "/v1/usage?period=month&start=2026-01-01",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = request(
        router.clone(),
        "GET",
        "/v1/usage?user_id=other",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, saved) = request(
        router.clone(),
        "PATCH",
        "/v1/usage/reminder",
        Some(&token),
        json!({"enabled":false,"threshold_cny_micros":5_000_000}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["enabled"], false);
    assert_eq!(saved["threshold_cny_micros"], 5_000_000);
    assert!(saved["month"].is_string());
    let (_, saved_again) = request(
        router.clone(),
        "GET",
        "/v1/usage/reminder",
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(saved, saved_again);
    let (_, other_reminder) = request(
        router.clone(),
        "GET",
        "/v1/usage/reminder",
        Some(&other),
        json!({}),
    )
    .await;
    assert_eq!(other_reminder["enabled"], true);
    assert_eq!(other_reminder["threshold_cny_micros"], 20_000_000);
    let (status, _) = request(
        router,
        "PATCH",
        "/v1/usage/reminder",
        Some(&token),
        json!({"enabled":true,"threshold_cny_micros":1}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
