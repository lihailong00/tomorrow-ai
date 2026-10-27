use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

async fn fixture() -> (Router, Repository, String, String) {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository
        .create_user(
            "chat-integrity@example.test",
            "test-hash",
            "Chat integrity",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let router = app(AppState::new(
        repository.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    (router, repository, user.id, token)
}
async fn call(router: &Router, token: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn chat_retries_use_one_canonical_id_and_canonical_defaults() {
    let (router, repository, user, token) = fixture().await;
    let (status, first) = call(
        &router,
        &token,
        json!({"message":"  A canonical message  ","client_request_id":"  canonical-id  "}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status,retry)=call(&router,&token,json!({"message":"A canonical message","client_request_id":"canonical-id","remember":false,"upload_ids":[]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, retry);
    let conversations = repository.conversations(&user).await.unwrap();
    assert_eq!(conversations.len(), 1);
    let messages = repository
        .messages(&user, &conversations[0].id)
        .await
        .unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "A canonical message");
}

#[tokio::test]
async fn changed_chat_input_is_rejected_before_any_new_side_effects() {
    let (router, repository, user, token) = fixture().await;
    let (status,first)=call(&router,&token,json!({"message":"Remember this synthetic fact","remember":true,"client_request_id":"bound-input"})).await;
    assert_eq!(status, StatusCode::OK);
    for change in [
        json!({"message":"A different question","remember":true,"client_request_id":"bound-input"}),
        json!({"message":"Remember this synthetic fact","remember":false,"client_request_id":"bound-input"}),
        json!({"message":"Remember this synthetic fact","remember":true,"conversation_id":first["conversation_id"],"client_request_id":"bound-input"}),
        json!({"message":"Remember this synthetic fact","remember":true,"upload_ids":["different-upload"],"client_request_id":"bound-input"}),
    ] {
        let (status, response) = call(&router, &token, change).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(response["error"]["code"], "conflict");
    }
    assert_eq!(repository.memories(&user).await.unwrap().len(), 1);
    assert_eq!(repository.conversations(&user).await.unwrap().len(), 1);
    assert_eq!(
        repository
            .messages(&user, first["conversation_id"].as_str().unwrap())
            .await
            .unwrap()
            .len(),
        2
    );
    let (status,retry)=call(&router,&token,json!({"message":"Remember this synthetic fact","remember":true,"client_request_id":"bound-input"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, retry);
}

#[tokio::test]
async fn invalid_input_does_not_leave_a_reserved_request() {
    let (router, repository, user, token) = fixture().await;
    for input in [
        json!({"message":"  ","client_request_id":"available-id"}),
        json!({"message":"Valid text","client_request_id":"   "}),
    ] {
        let (status, _) = call(&router, &token, input).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_requests WHERE user_id=$1")
        .bind(&user)
        .fetch_one(&repository.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    let (status, _) = call(
        &router,
        &token,
        json!({"message":"Valid text","client_request_id":"available-id"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn old_cached_requests_without_input_binding_fail_closed() {
    let (router, repository, user, token) = fixture().await;
    sqlx::query(
        "INSERT INTO chat_requests(request_key,user_id,response,created_at)VALUES($1,$2,$3,$4)",
    )
    .bind(format!("{user}:legacy-request"))
    .bind(&user)
    .bind("{}")
    .bind(tomorrow_domain::now())
    .execute(&repository.pool())
    .await
    .unwrap();
    let (status, response) = call(
        &router,
        &token,
        json!({"message":"An unrelated new message","client_request_id":"legacy-request"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(response["error"]["code"], "conflict");
    assert!(repository.conversations(&user).await.unwrap().is_empty());
}
