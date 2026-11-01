use super::*;
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request},
    routing::any,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

const PAGE: &str = "b55c9c91-384d-452b-81db-d1ef79372b75";
const PARENT: &str = "a55c9c91-384d-452b-81db-d1ef79372b75";

fn credentials() -> Credentials {
    Credentials {
        token: "ntn-synthetic-only-not-a-real-token".into(),
        environment: "production".into(),
        server_url: None,
    }
}
fn page() -> Value {
    json!({"object":"page","id":PAGE,"url":format!("https://www.notion.so/{}",PAGE.replace('-',"")),"parent":{"type":"page_id","page_id":PARENT},"properties":{"title":{"type":"title","title":[{"plain_text":"测试日记"}]}},"in_trash":false})
}
fn markdown() -> Value {
    json!({"object":"page_markdown","id":PAGE,"markdown":"# 日记\n\n今天写了一篇文章。","truncated":false,"unknown_block_ids":[]})
}

#[derive(Clone, Default)]
struct Fixture {
    replies: Arc<Mutex<VecDeque<(StatusCode, Value)>>>,
    requests: Arc<Mutex<Vec<(String, String, HeaderMap, Value)>>>,
}
async fn server(State(f): State<Fixture>, request: Request<Body>) -> (StatusCode, Json<Value>) {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 128 * 1024).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    f.requests.lock().unwrap().push((
        parts.method.to_string(),
        parts.uri.to_string(),
        parts.headers,
        body,
    ));
    let (status, value) = f
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected extra provider request");
    (status, Json(value))
}
async fn fixture(replies: Vec<(StatusCode, Value)>) -> (Api, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture::default();
    f.replies.lock().unwrap().extend(replies);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().fallback(any(server)).with_state(f.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        Api::new(Url::parse(&format!("http://{address}/v1/")).unwrap()).unwrap(),
        f,
        task,
    )
}

#[tokio::test]
async fn connection_validation_reads_real_identity_and_rejects_invalid_token() {
    let (api, f, task) = fixture(vec![
        (StatusCode::OK, json!({"object":"user","id":"bot-test"})),
        (
            StatusCode::UNAUTHORIZED,
            json!({"message":"never expose provider diagnostics or tokens"}),
        ),
    ])
    .await;
    let catalog = discover_with(&api, &credentials()).await.unwrap();
    assert_eq!(catalog.len(), 9);
    assert!(
        catalog
            .iter()
            .any(|tool| tool["name"] == "notion_create_page")
    );
    assert!(discover_with(&api, &credentials()).await.is_err());
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        (&calls[0].0, &calls[0].1),
        (&"GET".to_string(), &"/v1/users/me".to_string())
    );
    assert_eq!(calls[0].2["notion-version"], VERSION);
    assert_eq!(
        calls[0].2["authorization"],
        format!("Bearer {}", credentials().token)
    );
    assert_eq!(
        catalog
            .iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] == true)
            .count(),
        5
    );
    task.abort();
}

#[tokio::test]
async fn create_sends_markdown_title_and_exact_parent_then_returns_real_page_link() {
    let (api, f, task) = fixture(vec![(StatusCode::OK, page())]).await;
    let body = "# 测试文章\n\n| 项目 | 内容 |\n| --- | --- |\n| 今天 | 写作 |";
    let result = call_with(
        &api,
        &credentials(),
        "notion_create_page",
        json!({"parent_page_id":PARENT,"title":"测试日记","content":body}),
    )
    .await
    .unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["id"], PAGE);
    assert!(
        result["structuredContent"]["url"]
            .as_str()
            .unwrap()
            .starts_with("https://www.notion.so/")
    );
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "POST");
    assert_eq!(calls[0].1, "/v1/pages");
    assert_eq!(calls[0].3["parent"]["page_id"], PARENT);
    assert_eq!(
        calls[0].3["properties"]["title"]["title"][0]["text"]["content"],
        "测试日记"
    );
    assert_eq!(calls[0].3["markdown"], body);
    assert!(calls[0].3.get("children").is_none());
    assert!(!result.to_string().contains(&credentials().token));
    task.abort();
}

#[tokio::test]
async fn search_retains_pagination_and_reads_retains_incomplete_content_markers() {
    let mut partial = markdown();
    partial["truncated"] = json!(true);
    partial["unknown_block_ids"] = json!([PARENT]);
    let (api, f, task) = fixture(vec![
        (
            StatusCode::OK,
            json!({"object":"list","results":[page()],"has_more":true,"next_cursor":"cursor-next"}),
        ),
        (StatusCode::OK, partial),
    ])
    .await;
    let result = call_with(
        &api,
        &credentials(),
        "notion_search_pages",
        json!({"query":"日记","page_size":7,"start_cursor":"cursor-prior"}),
    )
    .await
    .unwrap();
    assert_eq!(result["structuredContent"]["items"][0]["title"], "测试日记");
    assert_eq!(result["structuredContent"]["has_more"], true);
    assert_eq!(result["structuredContent"]["next_cursor"], "cursor-next");
    assert_eq!(result["structuredContent"]["search_scope"], "title");
    let result = call_with(
        &api,
        &credentials(),
        "notion_read_page",
        json!({"page_id":PAGE}),
    )
    .await
    .unwrap();
    assert_eq!(result["structuredContent"]["truncated"], true);
    assert_eq!(
        result["structuredContent"]["unknown_block_ids"],
        json!([PARENT])
    );
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls[0].3["start_cursor"], "cursor-prior");
    assert_eq!(calls[0].3["page_size"], 7);
    assert_eq!(
        calls[1].1,
        format!("/v1/pages/{PAGE}/markdown?markdown_version=v2")
    );
    task.abort();
}

#[tokio::test]
async fn update_rename_trash_and_restore_are_single_explicit_requests() {
    let mut trash = page();
    trash["in_trash"] = json!(true);
    let (api, f, task) = fixture(vec![
        (StatusCode::OK, markdown()),
        (StatusCode::OK, page()),
        (StatusCode::OK, trash),
        (StatusCode::OK, page()),
    ])
    .await;
    call_with(
        &api,
        &credentials(),
        "notion_update_page_content",
        json!({"page_id":PAGE,"content":"新正文"}),
    )
    .await
    .unwrap();
    call_with(
        &api,
        &credentials(),
        "notion_rename_page",
        json!({"page_id":PAGE,"title":"新标题"}),
    )
    .await
    .unwrap();
    let trashed = call_with(
        &api,
        &credentials(),
        "notion_trash_page",
        json!({"page_id":PAGE,"in_trash":true}),
    )
    .await
    .unwrap();
    let restored = call_with(
        &api,
        &credentials(),
        "notion_trash_page",
        json!({"page_id":PAGE,"in_trash":false}),
    )
    .await
    .unwrap();
    assert_eq!(trashed["structuredContent"]["in_trash"], true);
    assert_eq!(restored["structuredContent"]["in_trash"], false);
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert!(calls.iter().all(|call| call.0 == "PATCH"));
    assert_eq!(calls[0].3["replace_content"]["new_str"], "新正文");
    assert_eq!(
        calls[0].3["replace_content"]["allow_deleting_content"],
        false
    );
    assert_eq!(calls[0].3["allow_async"], false);
    assert_eq!(calls[2].3, json!({"in_trash":true}));
    assert_eq!(calls[3].3, json!({"in_trash":false}));
    task.abort();
}

#[test]
fn bad_arguments_cannot_escape_paths_or_request_unreviewed_operations() {
    for (name, args) in [
        (
            "notion_create_page",
            json!({"parent_page_id":PARENT,"title":"x"}),
        ),
        ("notion_get_page", json!({"page_id":"../../users/me"})),
        (
            "notion_get_page",
            json!({"page_id":PAGE,"base_url":"http://127.0.0.1"}),
        ),
        ("notion_search_pages", json!({"page_size":0})),
        ("notion_search_pages", json!({"page_size":51})),
        (
            "notion_trash_page",
            json!({"page_id":PAGE,"in_trash":"true"}),
        ),
        ("notion_delete_everything", json!({})),
        (
            "notion_update_page_content",
            json!({"page_id":PAGE,"content":"x","allow_deleting_content":true}),
        ),
    ] {
        assert!(validate_arguments(name, &args).is_err(), "{name}: {args}");
    }
    assert!(
        validate_arguments("notion_get_page", &json!({"page_id":PAGE.replace('-',"")})).is_ok()
    );
}

#[tokio::test]
async fn definitive_rejections_are_failures_but_server_errors_remain_unknown_and_never_retry() {
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let (api, f, task) = fixture(vec![(status, json!({"message":credentials().token}))]).await;
        let result = call_with(
            &api,
            &credentials(),
            "notion_trash_page",
            json!({"page_id":PAGE,"in_trash":true}),
        )
        .await
        .unwrap();
        assert_eq!(result["isError"], true);
        assert!(!result.to_string().contains(&credentials().token));
        assert_eq!(f.requests.lock().unwrap().len(), 1);
        task.abort();
    }
    let (api, f, task) = fixture(vec![(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"message":"ambiguous mutation"}),
    )])
    .await;
    assert!(
        call_with(
            &api,
            &credentials(),
            "notion_trash_page",
            json!({"page_id":PAGE,"in_trash":true})
        )
        .await
        .is_err()
    );
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    task.abort();
}

#[tokio::test]
async fn transient_reads_retry_once_while_mutations_are_never_replayed() {
    let (api, f, task) = fixture(vec![
        (StatusCode::BAD_GATEWAY, json!({})),
        (StatusCode::OK, json!({"object":"user","id":"owner"})),
        (StatusCode::SERVICE_UNAVAILABLE, json!({})),
        (StatusCode::SERVICE_UNAVAILABLE, json!({})),
        (StatusCode::BAD_GATEWAY, json!({})),
    ])
    .await;
    assert!(discover_with(&api, &credentials()).await.is_ok());
    assert_eq!(f.requests.lock().unwrap().len(), 2);
    assert!(discover_with(&api, &credentials()).await.is_err());
    assert_eq!(f.requests.lock().unwrap().len(), 4);
    assert!(
        call_with(
            &api,
            &credentials(),
            "notion_trash_page",
            json!({"page_id":PAGE,"in_trash":true})
        )
        .await
        .is_err()
    );
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 5);
    assert_eq!(calls[4].0, "PATCH");
    assert!(
        calls
            .iter()
            .all(|call| call.2["authorization"] == format!("Bearer {}", credentials().token))
    );
    task.abort();
}

#[tokio::test]
async fn malformed_success_and_missing_pagination_are_not_reported_as_completed() {
    for value in [
        json!({"ok":true}),
        json!({"object":"list","results":[],"has_more":true,"next_cursor":null}),
    ] {
        let (api, _, task) = fixture(vec![(StatusCode::OK, value)]).await;
        assert!(
            call_with(&api, &credentials(), "notion_search_pages", json!({}))
                .await
                .is_err()
        );
        task.abort();
    }
    let (api, _, task) = fixture(vec![(
        StatusCode::ACCEPTED,
        json!({"object":"async_task","id":"pending"}),
    )])
    .await;
    assert!(
        call_with(
            &api,
            &credentials(),
            "notion_update_page_content",
            json!({"page_id":PAGE,"content":"x"})
        )
        .await
        .is_err()
    );
    task.abort();
}

#[tokio::test]
async fn long_notes_can_be_read_by_block_pagination_without_losing_child_markers() {
    let (api,f,task)=fixture(vec![(StatusCode::OK,json!({"object":"list","results":[{"object":"block","id":PAGE,"has_children":true,"type":"paragraph","paragraph":{"rich_text":[{"plain_text":"正文片段"}]}}],"has_more":true,"next_cursor":"cursor-next"}))]).await;
    let result = call_with(
        &api,
        &credentials(),
        "notion_list_blocks",
        json!({"block_id":PAGE,"page_size":3,"start_cursor":"cursor/value?&"}),
    )
    .await
    .unwrap();
    assert_eq!(
        result["structuredContent"]["results"][0]["has_children"],
        true
    );
    assert_eq!(result["structuredContent"]["next_cursor"], "cursor-next");
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls[0].0, "GET");
    assert!(
        calls[0]
            .1
            .ends_with("?page_size=3&start_cursor=cursor%2Fvalue%3F%26")
    );
    task.abort();
}

#[tokio::test]
async fn notion_writes_use_owner_token_confirmation_deduplication_and_disconnect_fences() {
    use crate::{
        crypto::Crypto,
        personal_mcp::state::{McpTransport, PersonalMcpState},
    };
    use std::{future::Future, pin::Pin};
    use tomorrow_domain::Repository;

    struct Proxy(Arc<Api>);
    impl McpTransport for Proxy {
        fn discover<'a>(
            &'a self,
            _provider: &'a str,
            credentials: &'a Credentials,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>>> + Send + 'a>> {
            Box::pin(discover_with(&self.0, credentials))
        }
        fn call<'a>(
            &'a self,
            _provider: &'a str,
            credentials: &'a Credentials,
            tool: &'a str,
            arguments: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>> {
            Box::pin(call_with(&self.0, credentials, tool, arguments))
        }
    }
    let (api, f, task) = fixture(vec![
        (StatusCode::OK, json!({"object":"user","id":"owner-a"})),
        (StatusCode::OK, json!({"object":"user","id":"owner-b"})),
        (StatusCode::OK, page()),
        (
            StatusCode::FORBIDDEN,
            json!({"message":"a private page not shared with owner-b"}),
        ),
    ])
    .await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("notion-a@example.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("notion-b@example.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let state = PersonalMcpState::with_transport(
        repo,
        Some(Crypto::from_hex(&"ce".repeat(32)).unwrap()),
        Arc::new(Proxy(Arc::new(api))),
    )
    .await
    .unwrap();
    let owner_a = credentials();
    let mut owner_b = credentials();
    owner_b.token = "ntn-other-user-synthetic-token".into();
    state
        .connect(&a.id, "notion", owner_a.clone())
        .await
        .unwrap();
    state
        .connect(&b.id, "notion", owner_b.clone())
        .await
        .unwrap();
    let args = json!({"parent_page_id":PARENT,"title":"测试日记","content":"写作".repeat(3000)});
    assert!(
        args.to_string().len() > 16 * 1024,
        "Chinese article must exercise the note-specific body budget"
    );
    let pending = state
        .invoke(&a.id, "notion", "notion_create_page", args.clone())
        .await
        .unwrap();
    assert_eq!(pending["status"], "confirmation_required");
    assert_eq!(
        f.requests.lock().unwrap().len(),
        2,
        "no write before owner confirmation"
    );
    let repeated = state
        .invoke(&a.id, "notion", "notion_create_page", args)
        .await
        .unwrap();
    assert_eq!(pending["action"]["id"], repeated["action"]["id"]);
    let id = pending["action"]["id"].as_str().unwrap();
    assert!(state.confirm(&b.id, id).await.is_err());
    assert_eq!(
        state.confirm(&a.id, id).await.unwrap()["status"],
        "completed"
    );
    assert_eq!(
        state.confirm(&a.id, id).await.unwrap()["status"],
        "completed"
    );
    assert_eq!(
        f.requests.lock().unwrap().len(),
        3,
        "duplicate confirmation must not create another page"
    );
    let denied = state
        .invoke(&b.id, "notion", "notion_get_page", json!({"page_id":PAGE}))
        .await
        .unwrap();
    assert_eq!(denied["status"], "failed");
    let next = state
        .invoke(
            &a.id,
            "notion",
            "notion_rename_page",
            json!({"page_id":PAGE,"title":"不应被执行"}),
        )
        .await
        .unwrap();
    state.disconnect(&a.id, "notion").await.unwrap();
    assert_eq!(
        state
            .confirm(&a.id, next["action"]["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "cancelled"
    );
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 4);
    assert_eq!(
        calls[2].2["authorization"],
        format!("Bearer {}", owner_a.token)
    );
    assert_eq!(
        calls[3].2["authorization"],
        format!("Bearer {}", owner_b.token)
    );
    task.abort();
}
