use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
use serde_json::{Value, json};
use tomorrow_api::{AppState, app};
use tomorrow_domain::{ModelProvider, Repository, new_id, timestamp};
use tower::ServiceExt;

async fn get(router: axum::Router, token: &str, path: &str) -> (StatusCode, Value) {
    let response = router.oneshot(Request::builder().uri(path).header("authorization", format!("Bearer {token}")).body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn check_http(repository: Repository, database_url: &str) {
    let user = repository.create_user(&format!("messages-{}@api.test", new_id()), "test", "历史", "UTC").await.unwrap();
    let other = repository.create_user(&format!("foreign-{}@api.test", new_id()), "test", "隔离", "UTC").await.unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let other_token = repository.create_session(&other.id).await.unwrap();
    let conversation = repository.create_conversation(&user.id, "1004 messages").await.unwrap();
    let other_conversation = repository.create_conversation(&user.id, "unrelated messages").await.unwrap();
    let mut tx = repository.pool().begin().await.unwrap();
    for index in 0..1004_i64 {
        for chat in [&conversation.id, &other_conversation.id] {
            let id = format!("{chat}-{index:04}");
            let body = json!({"id":id,"conversation_id":chat,"role":"user","content":format!("sentinel-{index}"),"created_at":timestamp(1_790_000_000+index),"model_mode":null,
                "attachments":[{"upload_id":"missing-upload","name":"old-attachment.txt","mime_type":"text/plain","size":1,"unavailable":false}]});
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,'message',$3,$4,$4)").bind(id).bind(&user.id).bind(body.to_string()).bind(index).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let router = app(AppState::new(repository, ModelProvider::local(), database_url));
    let path = format!("/v1/conversations/{}/messages", conversation.id);
    let (status, legacy) = get(router.clone(), &token, &path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(legacy["items"].as_array().unwrap().len(), 1000);
    assert_eq!(legacy["items"][0]["content"], "sentinel-4");
    let mut offset = 0;
    let mut seen = std::collections::HashSet::new();
    loop {
        let (status, page) = get(router.clone(), &token, &format!("{path}?offset={offset}&limit=40")).await;
        assert_eq!(status, StatusCode::OK);
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 40);
        for item in items {
            assert_eq!(item["conversation_id"], conversation.id);
            assert_eq!(item["attachments"][0]["unavailable"], true);
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
        }
        match page["next_offset"].as_i64() { Some(next) => { assert_eq!(next, offset + 40); offset = next; }, None => break }
    }
    assert_eq!(seen.len(), 1004);
    assert!(seen.contains(&format!("{}-0000", conversation.id)));
    let (_, first) = get(router.clone(), &token, &format!("{path}?limit=40")).await;
    let before = first["next_before"].as_str().unwrap();
    let (_, older) = get(router.clone(), &token, &format!("{path}?before={before}&limit=40")).await;
    assert_eq!(older["items"][0]["content"], "sentinel-924");
    assert_eq!(get(router.clone(), &other_token, &format!("{path}?limit=40")).await.0, StatusCode::NOT_FOUND);
    for query in ["offset=-1", "limit=0", "limit=501", "offset=nope", "offset=9223372036854775807", "before="] {
        assert_eq!(get(router.clone(), &token, &format!("{path}?{query}")).await.0, StatusCode::BAD_REQUEST);
    }
    for before in ["missing".to_owned(), format!("{}-0000", other_conversation.id)] {
        assert_eq!(get(router.clone(), &token, &format!("{path}?limit=40&before={before}")).await.0, StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn sqlite_message_history_pages_over_http() {
    check_http(Repository::connect("sqlite::memory:").await.unwrap(), "sqlite::memory:").await;
}

#[tokio::test]
async fn postgres_message_history_pages_over_http() {
    let Ok(url) = std::env::var("TEST_E07_DATABASE_URL") else { return; };
    assert!(url.starts_with("postgres") && url.split('?').next().unwrap().ends_with("/tada_qa_e07_messages_r8"));
    check_http(Repository::connect(&url).await.unwrap(), &url).await;
}
