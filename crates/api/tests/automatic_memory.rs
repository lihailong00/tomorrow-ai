use axum::{
    Json, Router,
    body::{Body, to_bytes},
    http::Request,
    routing::post,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tomorrow_api::{AppState, app};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

async fn call(router: &Router, token: &str, method: &str, path: &str, body: Value) -> (u16, Value) {
    let response = router
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
    let status = response.status().as_u16();
    let data = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&data).unwrap())
}

#[tokio::test]
async fn default_chat_memory_extracts_once_recalls_and_forgets_without_opt_in_or_external_api() {
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = requests.clone();
    let upstream=Router::new().route("/chat/completions",post(move|Json(body):Json<Value>|{let captured=captured.clone();async move{
        captured.lock().unwrap().push(body.clone());
        let extracting=body["messages"].as_array().unwrap().iter().any(|m|m["content"].as_str().unwrap_or("").starts_with("你是记忆提取器"));
        let content=if extracting{json!([{"topic":"纳斯达克基金近况","memory_id":null,"content":"近期在购买纳斯达克基金","quote":"我最近在买纳斯达克基金","kind":"fact","recent":true}]).to_string()}else{"测试回复".into()};
        Json(json!({"choices":[{"message":{"content":content}}]}))
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{address}")),
        "MODEL_NAME" => Some("fixture-model".into()),
        _ => None,
    });
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("api@memory.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let foreign = repo
        .create_user("foreign@memory.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let foreign_token = repo.create_session(&foreign.id).await.unwrap();
    let router = app(AppState::new(
        repo.clone(),
        provider.clone(),
        "sqlite::memory:",
    ));
    assert_eq!(
        call(&router, &token, "GET", "/v1/memory/preferences", json!({}))
            .await
            .1,
        json!({"enabled":true,"configured":false})
    );
    let input = json!({"message":"我最近在买纳斯达克基金","client_request_id":"memory-once"});
    let (status, response) = call(&router, &token, "POST", "/v1/chat", input.clone()).await;
    assert_eq!(status, 200, "{response}");
    assert_eq!(
        call(&router, &token, "POST", "/v1/chat", input).await.1,
        response
    );
    assert!(repo.automatic_memory_step(&provider).await.unwrap());
    assert!(!repo.automatic_memory_step(&provider).await.unwrap());
    let saved = repo.memories(&user.id).await.unwrap();
    assert_eq!(saved.len(), 1);
    let id = &saved[0].id;
    let path = format!("/v1/memories/{id}");
    assert_eq!(
        call(&router, &foreign_token, "GET", &path, json!({}))
            .await
            .0,
        404
    );
    let receipts = format!(
        "/v1/memory/receipts/{}",
        response["message"]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&router, &token, "GET", &receipts, json!({})).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(&router, &foreign_token, "GET", &receipts, json!({}))
            .await
            .1["items"],
        json!([])
    );
    let (status, _) = call(
        &router,
        &token,
        "POST",
        "/v1/chat",
        json!({"message":"我之前关注什么基金？","client_request_id":"fresh-conversation"}),
    )
    .await;
    assert_eq!(status, 200);
    let captured = requests.lock().unwrap().clone();
    assert!(
        captured.last().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "system"
                && m["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains("近期在购买纳斯达克基金"))
    );
    let receipt = repo
        .memory_receipts(&user.id, response["message"]["id"].as_str().unwrap())
        .await
        .unwrap()
        .remove(0);
    let undo = format!("/v1/memory/receipts/{}/undo", receipt.id);
    assert_eq!(
        call(&router, &foreign_token, "POST", &undo, json!({}))
            .await
            .0,
        404
    );
    assert_eq!(call(&router, &token, "POST", &undo, json!({})).await.0, 200);
    assert!(
        repo.recall_memories(&user.id, "基金")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&router, &token, "GET", &receipts, json!({})).await.1["items"],
        json!([])
    );
    task.abort();
}
