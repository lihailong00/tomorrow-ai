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
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "message-actions@example.test",
            "synthetic",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    (
        app(AppState::new(
            repo.clone(),
            ModelProvider::local(),
            "sqlite::memory:",
        )),
        repo,
        user.id,
        token,
    )
}
async fn request(
    router: &Router,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, String) {
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
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}
async fn chat(router: &Router, token: &str, input: Value) -> Value {
    let (status, body) = request(router, token, "POST", "/v1/chat", input).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).unwrap()
}

#[tokio::test]
async fn streamed_edit_is_durable_stable_and_old_requests_cannot_replay() {
    let (router, repo, user, token) = fixture().await;
    let original_input = json!({"message":"Original question","client_request_id":"first"});
    let first = chat(&router, &token, original_input.clone()).await;
    let cid = first["conversation_id"].as_str().unwrap();
    let mid = first["user_message"]["id"].as_str().unwrap();
    let second=chat(&router,&token,json!({"message":"A later unrelated turn","conversation_id":cid,"client_request_id":"later"})).await;
    let edit = json!({"message":"Edited question","conversation_id":cid,"replace_message_id":mid,"client_request_id":"edit-first"});
    let (status, sse) = request(&router, &token, "POST", "/v1/chat/stream", edit.clone()).await;
    assert_eq!(status, StatusCode::OK, "{sse}");
    assert!(sse.contains("event: accepted"), "{sse}");
    let done: Value = sse
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|v| v.get("response").cloned())
        .find(|v| v["user_message"]["content"] == "Edited question" && v.get("message").is_some())
        .expect("done response");
    assert_eq!(done["user_message"]["id"], first["user_message"]["id"]);
    assert_eq!(
        done["user_message"]["created_at"],
        first["user_message"]["created_at"]
    );
    assert_eq!(
        done["message"]["created_at"],
        first["message"]["created_at"]
    );
    assert_ne!(done["message"]["id"], first["message"]["id"]);
    assert_eq!(
        done["removed_message_ids"],
        json!([mid, first["message"]["id"]])
    );
    let messages = repo.messages(&user, cid).await.unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages.iter().find(|m| m.id == mid).unwrap().content,
        "Edited question"
    );
    assert!(!messages
        .iter()
        .any(|m| m.id == first["message"]["id"].as_str().unwrap()));
    assert!(messages
        .iter()
        .any(|m| m.id == second["message"]["id"].as_str().unwrap()));
    assert_eq!(
        repo.conversation(&user, cid).await.unwrap().title,
        "Edited question"
    );
    let (status, retry) = request(&router, &token, "POST", "/v1/chat/stream", edit).await;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert!(retry.contains(done["message"]["id"].as_str().unwrap()));
    assert_eq!(repo.messages(&user, cid).await.unwrap().len(), 4);
    for path in ["/v1/chat", "/v1/chat/stream"] {
        let (status, body) = request(&router, &token, "POST", path, original_input.clone()).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert!(!body.contains("Original question"));
    }
}

#[tokio::test]
async fn delete_turn_is_owner_scoped_idempotent_and_preserves_other_turns() {
    let (router, repo, user, token) = fixture().await;
    let first = chat(
        &router,
        &token,
        json!({"message":"First","client_request_id":"first"}),
    )
    .await;
    let cid = first["conversation_id"].as_str().unwrap();
    let mid = first["user_message"]["id"].as_str().unwrap();
    let second = chat(
        &router,
        &token,
        json!({"message":"Second","conversation_id":cid,"client_request_id":"second"}),
    )
    .await;
    let foreign = repo
        .create_user(
            "foreign-actions@example.test",
            "synthetic",
            "Other",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let foreign_token = repo.create_session(&foreign.id).await.unwrap();
    let path = format!("/v1/conversations/{cid}/messages/{mid}");
    let (status, _) = request(&router, &foreign_token, "DELETE", &path, json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = request(
        &router,
        &token,
        "DELETE",
        &format!(
            "/v1/conversations/{cid}/messages/{}",
            first["message"]["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for _ in 0..2 {
        let (status, body) = request(&router, &token, "DELETE", &path, json!({})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["removed_message_ids"],
            json!([mid, first["message"]["id"]])
        );
    }
    let messages = repo.messages(&user, cid).await.unwrap();
    assert_eq!(messages.len(), 2);
    assert!(messages
        .iter()
        .any(|m| m.id == second["user_message"]["id"].as_str().unwrap()));
    assert_eq!(repo.conversation(&user, cid).await.unwrap().title, "Second");
    let (status, body) = request(
        &router,
        &token,
        "POST",
        "/v1/chat",
        json!({"message":"First","client_request_id":"first"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
}

#[tokio::test]
async fn replacement_id_is_bound_to_request_fingerprint_and_requires_original_conversation() {
    let (router, repo, user, token) = fixture().await;
    let first = chat(
        &router,
        &token,
        json!({"message":"First","client_request_id":"first"}),
    )
    .await;
    let (status,_)=request(&router,&token,"POST","/v1/chat",json!({"message":"First","client_request_id":"first","replace_message_id":first["user_message"]["id"],"conversation_id":first["conversation_id"]})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status,_)=request(&router,&token,"POST","/v1/chat",json!({"message":"Changed","client_request_id":"invalid","replace_message_id":first["user_message"]["id"]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        repo.messages(&user, first["conversation_id"].as_str().unwrap())
            .await
            .unwrap()[0]
            .content,
        "First"
    );
}

#[tokio::test]
async fn edited_reply_forwards_real_upstream_deltas_before_atomic_commit() {
    use futures_util::StreamExt;
    use std::{
        convert::Infallible,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    let (local, repo, user, token) = fixture().await;
    let first = chat(
        &local,
        &token,
        json!({"message":"Original","client_request_id":"first"}),
    )
    .await;
    let cid = first["conversation_id"].as_str().unwrap();
    let mid = first["user_message"]["id"].as_str().unwrap();
    let release = Arc::new(tokio::sync::Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let notify = release.clone();
    let count = calls.clone();
    let gateway=Router::new().route("/v1/chat/completions",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
        let release=notify.clone();count.fetch_add(1,Ordering::SeqCst);
        async move {
            assert_eq!(body["stream"],true);
            assert_eq!(body["messages"].as_array().unwrap().iter().filter(|m|m["role"]=="user"&&m["content"]=="Edited").count(),1);
            assert!(!body["messages"].as_array().unwrap().iter().any(|m|m["content"]=="Original"));
            let chunks=futures_util::stream::unfold((0,release),|(step,release)|async move{
                let chunk=match step {0=>"data: {\"choices\":[{\"delta\":{\"content\":\"NEW_PART\"}}]}\n\n",1=>{release.notified().await;"data: {\"choices\":[{\"delta\":{\"content\":\"_END\"}}]}\n\ndata: [DONE]\n\n"},_=>return None};
                Some((Ok::<_,Infallible>(chunk),(step+1,release)))
            });
            axum::response::Response::builder().header("content-type","text/event-stream").body(Body::from_stream(chunks)).unwrap()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let router = app(AppState::new(
        repo.clone(),
        ModelProvider::from_settings(
            format!("http://127.0.0.1:{port}/v1"),
            Some("synthetic-fixture-key".into()),
            Some("synthetic-model".into()),
        ),
        "sqlite::memory:",
    ));
    let input = json!({"message":"Edited","conversation_id":cid,"replace_message_id":mid,"client_request_id":"real-edit"});
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/chat/stream")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut chunks = response.into_body().into_data_stream();
    let mut text = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !text.contains("NEW_PART") {
            let chunk = chunks.next().await.unwrap().unwrap();
            text.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    })
    .await
    .unwrap();
    assert!(!text.contains("event: done"));
    assert_eq!(
        repo.messages(&user, cid).await.unwrap()[0].content,
        "Original",
        "a partial edited answer must not destroy the old durable turn"
    );
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(chunk) = chunks.next().await {
            text.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
        }
    })
    .await
    .unwrap();
    assert!(text.contains("event: done"));
    let messages = repo.messages(&user, cid).await.unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "Edited");
    assert_eq!(messages[1].content, "NEW_PART_END");
    let (status, replayed) = request(&router, &token, "POST", "/v1/chat/stream", input).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}
