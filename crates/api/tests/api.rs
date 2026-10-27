use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

async fn request(
    app: axum::Router,
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
    let response = app
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn authenticated_api_isolates_accounts_and_reports_local_mode() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(AppState::new(
        repository,
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    let (status, body) = request(router.clone(), "GET", "/v1/today", None, json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    let (status, first) = request(
        router.clone(),
        "POST",
        "/v1/auth/register",
        None,
        json!({"email":"first@api.test","password":"valid-passphrase"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = first["token"].as_str().unwrap();
    assert!(first["user"].get("password_hash").is_none());
    let (_, second) = request(
        router.clone(),
        "POST",
        "/v1/auth/register",
        None,
        json!({"email":"second@api.test","password":"valid-passphrase"}),
    )
    .await;
    let other = second["token"].as_str().unwrap();
    let (status, memory) = request(
        router.clone(),
        "POST",
        "/v1/memories",
        Some(token),
        json!({"content":"喜欢中文","kind":"preference"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, list) = request(
        router.clone(),
        "GET",
        "/v1/memories",
        Some(other),
        json!({}),
    )
    .await;
    assert!(list["items"].as_array().unwrap().is_empty());
    let (status, _) = request(
        router.clone(),
        "DELETE",
        &format!("/v1/memories/{}", memory["id"].as_str().unwrap()),
        Some(other),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, reply) = request(
        router.clone(),
        "POST",
        "/v1/chat",
        Some(token),
        json!({"message":"你好","client_request_id":"same-request"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["message"]["model_mode"], "local");
    let (_, retry) = request(
        router.clone(),
        "POST",
        "/v1/chat",
        Some(token),
        json!({"message":"你好","client_request_id":"same-request"}),
    )
    .await;
    assert_eq!(reply, retry);
    let (_, home) = request(router.clone(), "GET", "/v1/today", Some(token), json!({})).await;
    assert_eq!(home["runtime"]["model_mode"], "local");
    assert_eq!(home["stats"]["memory_count"], 1);
    let (_, capabilities) = request(
        router.clone(),
        "GET",
        "/v1/capabilities",
        Some(token),
        json!({}),
    )
    .await;
    assert_eq!(capabilities["runtime"]["model_mode"], "local");
    request(
        router.clone(),
        "POST",
        "/v1/auth/logout",
        Some(token),
        json!({}),
    )
    .await;
    let (status, _) = request(router, "GET", "/v1/me", Some(token), json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_json_errors_use_the_contract_shape() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(AppState::new(
        repository,
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    let response = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/auth/login")
                .header("content-type", "application/json")
                .body(Body::from("not-json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert!(serde_json::from_slice::<Value>(&body).unwrap()["error"]["message"].is_string());
}

#[test]
fn generated_contract_covers_mutations_and_bearer_auth() {
    let document = serde_json::to_value(tomorrow_api::openapi_document()).unwrap();
    assert!(document["paths"]["/v1/tasks/{id}/approve"]["post"].is_object());
    assert!(document["paths"]["/v1/memories/{id}"]["patch"].is_object());
    assert_eq!(
        document["components"]["securitySchemes"]["bearer_auth"]["scheme"],
        "bearer"
    );
    assert!(document["paths"]["/v1/tasks"]["post"]["security"].is_array());
    assert!(document["paths"]["/v1/auth/register"]["post"]
        .get("security")
        .is_none());
}

#[tokio::test]
async fn failed_model_request_can_retry_without_duplicating_messages_or_memories() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository
        .create_user(
            "retry@api.test",
            "not-used-in-this-test",
            "重试用户",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let failed = app(AppState::new(
        repository.clone(),
        ModelProvider::from_settings(
            "http://127.0.0.1:9/v1".into(),
            Some("test-only-key".into()),
            Some("test-model".into()),
        ),
        "sqlite::memory:",
    ));
    let input = json!({"message":"记住我的目标","remember":true,"client_request_id":"provider-failure-retry"});
    let (status, _) = request(failed, "POST", "/v1/chat", Some(&token), input.clone()).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(repository.conversations(&user.id).await.unwrap().is_empty());
    assert!(repository.memories(&user.id).await.unwrap().is_empty());
    let recovered = app(AppState::new(
        repository.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    let (status, response) = request(
        recovered.clone(),
        "POST",
        "/v1/chat",
        Some(&token),
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, same) = request(recovered, "POST", "/v1/chat", Some(&token), input).await;
    assert_eq!(same, response);
    assert_eq!(repository.conversations(&user.id).await.unwrap().len(), 1);
    assert_eq!(repository.memories(&user.id).await.unwrap().len(), 1);
    assert_eq!(
        repository
            .messages(&user.id, response["conversation_id"].as_str().unwrap())
            .await
            .unwrap()
            .len(),
        2
    );
}
