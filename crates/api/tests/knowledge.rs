use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{CreateMemory, ModelProvider, Repository};
use tower::ServiceExt;

async fn request(
    router: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn graph_routes_require_auth_and_preserve_source_ownership() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("graph-api-a@test.local", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("graph-api-b@test.local", "unused", "乙", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&a.id).await.unwrap();
    let other = repo.create_session(&b.id).await.unwrap();
    let memory = repo
        .create_memory(
            &a.id,
            CreateMemory {
                title: Some("Tomorrow".into()),
                content: "王伟确认 Tomorrow 的方案V3。".into(),
                kind: "project".into(),
                source: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let router = app(AppState::new(
        repo.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    let input = json!({"memory_id":memory.id,"version":1,"scope":"Tomorrow","entities":[{"key":"p","name":"王伟","kind":"person"},{"key":"v","name":"方案V3","kind":"plan"}],"facts":[{"subject":"p","relation":"CONFIRMED","object":"v","status":"confirmed","quote":memory.content}]});
    assert_eq!(
        request(
            router.clone(),
            "GET",
            "/v1/knowledge-graph/search",
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            router.clone(),
            "POST",
            "/v1/knowledge-graph/index",
            Some(&other),
            input.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            router.clone(),
            "POST",
            "/v1/knowledge-graph/index",
            Some(&token),
            input.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let found = request(
        router.clone(),
        "GET",
        "/v1/knowledge-graph/search?scope=Tomorrow",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(found.0, StatusCode::OK);
    assert_eq!(found.1["facts"][0]["source"]["id"], memory.id);
    let other_found = request(
        router.clone(),
        "GET",
        "/v1/knowledge-graph/search",
        Some(&other),
        Value::Null,
    )
    .await;
    assert_eq!(other_found.1["facts"], json!([]));
    assert_eq!(
        request(
            router.clone(),
            "GET",
            "/v1/knowledge-graph/search?limit=0",
            Some(&token),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let path = format!("/v1/knowledge-graph/memories/{}", memory.id);
    assert_eq!(
        request(router.clone(), "DELETE", &path, Some(&other), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(router.clone(), "DELETE", &path, Some(&token), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(repo.memories(&a.id).await.unwrap().len(), 1);
    assert_eq!(
        request(
            router,
            "GET",
            "/v1/knowledge-graph/search",
            Some(&token),
            Value::Null
        )
        .await
        .1["facts"],
        json!([])
    );
    let document = serde_json::to_value(tomorrow_api::openapi_document()).unwrap();
    assert!(document["paths"]["/v1/knowledge-graph/index"]["post"].is_object());
    assert!(document["paths"]["/v1/knowledge-graph/search"]["get"].is_object());
    assert!(document["components"]["schemas"]["GraphIndexInput"].is_object());
}
