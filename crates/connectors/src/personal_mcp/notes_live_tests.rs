//! Explicit opt-in tests. They create only uniquely named test notes. No model
//! calls are made. Tokens are read from the child process and never printed.
use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use tower::ServiceExt;

async fn fixture() -> (PersonalMcpState, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user(
            "notes-owner@example.test",
            "unused",
            "笔记测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let b = repo
        .create_user(
            "notes-other@example.test",
            "unused",
            "其他账号",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token_a = repo.create_session(&a.id).await.unwrap();
    let token_b = repo.create_session(&b.id).await.unwrap();
    let state = PersonalMcpState::with_transport(
        repo,
        Some(Crypto::from_hex(&"ac".repeat(32)).unwrap()),
        Arc::new(OfficialTransport),
    )
    .await
    .unwrap();
    (state, token_a, token_b)
}
async fn http(
    state: &PersonalMcpState,
    session: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {session}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = to_bytes(response.into_body(), 512 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn invoke(
    state: &PersonalMcpState,
    session: &str,
    provider: &str,
    tool: &str,
    args: Value,
) -> Value {
    println!("NOTES_LIVE_CALL: {provider}/{tool}");
    let (status, value) = http(
        state,
        session,
        "POST",
        &format!("/v1/personal-mcp/{provider}/call"),
        json!({"tool":tool,"arguments":args}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "provider tool {provider}/{tool} HTTP call failed: {value}"
    );
    value
}
// Each invocation represents a fresh user-requested Agent turn. Repeating the
// confirmation itself remains idempotent, but trash -> restore -> trash are
// separate intentions, not retries of the first manual call's dedupe window.
async fn agent_intent(
    state: &PersonalMcpState,
    session: &str,
    provider: &str,
    tool: &str,
    args: Value,
) -> Value {
    println!("NOTES_LIVE_AGENT_INTENT: {provider}/{tool}");
    let user = state.0.repo.authenticate(session).await.unwrap();
    state
        .invoke_scoped(
            &user,
            provider,
            tool,
            args,
            &format!("{}:mcp:0", random_secret()),
        )
        .await
        .unwrap()
}
async fn confirm(state: &PersonalMcpState, session: &str, pending: &Value) -> Value {
    assert_eq!(pending["status"], "confirmation_required");
    let id = pending["action"]["id"].as_str().unwrap();
    let (status, value) = http(
        state,
        session,
        "POST",
        &format!("/v1/personal-mcp/actions/{id}/confirm"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        value["status"], "completed",
        "provider did not complete: {value}"
    );
    value
}
fn payload(raw: &Value) -> Value {
    if raw["structuredContent"].is_object() {
        return raw["structuredContent"].clone();
    }
    raw["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|part| part["text"].as_str())
        .find_map(|text| serde_json::from_str(text).ok())
        .expect("provider must return structured note data")
}

#[tokio::test]
#[ignore = "requires an explicitly provided Memos test instance and MEMOS_TEST_TOKEN"]
async fn real_memos_account_crud_through_authenticated_http_and_confirmation() {
    let server = std::env::var("MEMOS_TEST_SERVER_URL").expect("MEMOS_TEST_SERVER_URL");
    let secret = std::env::var("MEMOS_TEST_TOKEN").expect("MEMOS_TEST_TOKEN");
    let (state, a, b) = fixture().await;
    let (status, connected) = http(
        &state,
        &a,
        "POST",
        "/v1/personal-mcp/memos/connect",
        json!({"token":secret,"environment":"production","server_url":server}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "Memos connection failed: {connected}"
    );
    assert_eq!(connected["status"], "connected");
    assert_eq!(connected["tool_count"], 6);
    assert!(!connected.to_string().contains(&secret));
    let (_, other) = http(&state, &b, "GET", "/v1/personal-mcp", json!({})).await;
    assert!(
        other["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "memos" && item["status"] == "not_connected")
    );
    let (bad_status,_)=http(&state,&b,"POST","/v1/personal-mcp/memos/connect",json!({"token":"memos_pat_invalid-synthetic-test","environment":"production","server_url":server})).await;
    assert!(
        !bad_status.is_success(),
        "listing public tools must not validate a bad personal token"
    );
    let (status, _) = http(&state, &a, "POST", "/v1/personal-mcp/memos/test", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let current = invoke(&state, &a, "memos", "auth_get_current_user", json!({})).await;
    assert_eq!(current["status"], "completed");
    let current = payload(&current["result"]);
    let owner = current["user"]["name"].as_str().unwrap();
    let marker = format!("TADA-connector-test-{}", &random_secret()[..12]);
    let content = format!(
        "# {marker}\n\n这是一条自动验收日记。\n\n| 项目 | 状态 |\n| --- | --- |\n| 写作 | 完成 |"
    );
    let draft = invoke(
        &state,
        &a,
        "memos",
        "memo_create_memo",
        json!({"body":{"content":content}}),
    )
    .await;
    assert_eq!(
        draft["action"]["arguments"]["body"]["visibility"],
        "PRIVATE"
    );
    let action_id = draft["action"]["id"].as_str().unwrap();
    let (status, _) = http(
        &state,
        &b,
        "POST",
        &format!("/v1/personal-mcp/actions/{action_id}/confirm"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let created = confirm(&state, &a, &draft).await;
    let memo = payload(&created["result"]);
    let name = memo["name"].as_str().unwrap();
    let id = name.strip_prefix("memos/").unwrap();
    assert_eq!(memo["content"], content);
    assert_eq!(memo["visibility"], "PRIVATE");
    let (_, replayed) = http(
        &state,
        &a,
        "POST",
        &format!("/v1/personal-mcp/actions/{action_id}/confirm"),
        json!({}),
    )
    .await;
    assert_eq!(payload(&replayed["result"])["name"], name);
    let list=invoke(&state,&a,"memos","memo_list_memos",json!({"filter":format!("creator == {owner:?} && content.contains({marker:?})"),"pageSize":20})).await;
    assert_eq!(list["status"], "completed");
    let found = payload(&list["result"]);
    assert_eq!(
        found["memos"].as_array().unwrap().len(),
        1,
        "duplicate confirmation must not create duplicate notes"
    );
    let read = invoke(&state, &a, "memos", "memo_get_memo", json!({"memo":id})).await;
    assert_eq!(payload(&read["result"])["content"], content);
    let updated_content = format!("# {marker}\n\n已修改，保留 Markdown 正文。");
    let update = invoke(
        &state,
        &a,
        "memos",
        "memo_update_memo",
        json!({"memo":id,"body":{"content":updated_content},"updateMask":"content"}),
    )
    .await;
    confirm(&state, &a, &update).await;
    let read = invoke(&state, &a, "memos", "memo_get_memo", json!({"memo":id})).await;
    assert_eq!(payload(&read["result"])["content"], updated_content);
    let delete = invoke(&state, &a, "memos", "memo_delete_memo", json!({"memo":id})).await;
    confirm(&state, &a, &delete).await;
    let read = invoke(&state, &a, "memos", "memo_get_memo", json!({"memo":id})).await;
    assert_eq!(read["status"], "failed");
    let pending = invoke(
        &state,
        &a,
        "memos",
        "memo_create_memo",
        json!({"body":{"content":"取消后不得保存的测试笔记"}}),
    )
    .await;
    let pending_id = pending["action"]["id"].as_str().unwrap();
    let (status, _) = http(&state, &a, "DELETE", "/v1/personal-mcp/memos", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (_, fenced) = http(
        &state,
        &a,
        "POST",
        &format!("/v1/personal-mcp/actions/{pending_id}/confirm"),
        json!({}),
    )
    .await;
    assert_eq!(fenced["status"], "cancelled");
    println!(
        "REAL_MEMOS_VERIFIED: identity; bad-token rejection; six audited tools; owner isolation; confirmation; private Markdown create; search; read; update; delete; duplicate prevention; disconnect fence"
    );
}

#[tokio::test]
#[ignore = "requires NOTION_API_KEY or NOTION_API_TOKEN and an authorized NOTION_TEST_PARENT_PAGE_ID"]
async fn real_notion_account_crud_with_a_unique_test_page() {
    let secret = std::env::var("NOTION_API_KEY")
        .or_else(|_| std::env::var("NOTION_API_TOKEN"))
        .expect("NOTION_API_KEY or NOTION_API_TOKEN");
    let parent = std::env::var("NOTION_TEST_PARENT_PAGE_ID").expect("NOTION_TEST_PARENT_PAGE_ID");
    let (state, a, _) = fixture().await;
    let (status, connected) = http(
        &state,
        &a,
        "POST",
        "/v1/personal-mcp/notion/connect",
        json!({"token":secret,"environment":"production"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "Notion connection failed: {connected}"
    );
    assert_eq!(connected["status"], "connected");
    assert_eq!(connected["tool_count"], 9);
    assert!(!connected.to_string().contains(&secret));
    let current = invoke(&state, &a, "notion", "notion_get_current_user", json!({})).await;
    assert_eq!(current["status"], "completed");
    assert!(current["result"]["structuredContent"]["id"].is_string());
    let search_query = std::env::var("NOTION_TEST_SEARCH_QUERY").unwrap_or_default();
    let search = invoke(
        &state,
        &a,
        "notion",
        "notion_search_pages",
        json!({"query":search_query,"page_size":20}),
    )
    .await;
    assert_eq!(search["status"], "completed");
    if !search_query.is_empty() {
        assert!(
            !search["result"]["structuredContent"]["items"]
                .as_array()
                .unwrap()
                .is_empty(),
            "An indexed existing-page title must be searchable"
        );
    }
    let title = format!("TADA-connector-test-{}", &random_secret()[..12]);
    let content =
        "# 接入测试\n\n这是一篇测试文章。\n\n| 项目 | 结果 |\n| --- | --- |\n| 保存 | 成功 |";
    let create = agent_intent(
        &state,
        &a,
        "notion",
        "notion_create_page",
        json!({"parent_page_id":parent,"title":title,"content":content}),
    )
    .await;
    let created = confirm(&state, &a, &create).await;
    let page = created["result"]["structuredContent"]["id"]
        .as_str()
        .unwrap();
    let read = invoke(
        &state,
        &a,
        "notion",
        "notion_read_page",
        json!({"page_id":page}),
    )
    .await;
    assert_eq!(read["status"], "completed");
    assert!(
        read["result"]["structuredContent"]["markdown"]
            .as_str()
            .unwrap()
            .contains("测试文章")
    );
    let blocks = invoke(
        &state,
        &a,
        "notion",
        "notion_list_blocks",
        json!({"block_id":page,"page_size":1}),
    )
    .await;
    assert_eq!(blocks["status"], "completed");
    assert!(
        !blocks["result"]["structuredContent"]["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(blocks["result"]["structuredContent"]["has_more"], true);
    let cursor = blocks["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .unwrap();
    let next_blocks = invoke(
        &state,
        &a,
        "notion",
        "notion_list_blocks",
        json!({"block_id":page,"page_size":1,"start_cursor":cursor}),
    )
    .await;
    assert_eq!(next_blocks["status"], "completed");
    assert_ne!(
        blocks["result"]["structuredContent"]["results"][0]["id"],
        next_blocks["result"]["structuredContent"]["results"][0]["id"]
    );
    let renamed_title = format!("{title}-renamed");
    let rename = agent_intent(
        &state,
        &a,
        "notion",
        "notion_rename_page",
        json!({"page_id":page,"title":renamed_title}),
    )
    .await;
    confirm(&state, &a, &rename).await;
    let metadata = invoke(
        &state,
        &a,
        "notion",
        "notion_get_page",
        json!({"page_id":page}),
    )
    .await;
    assert_eq!(
        metadata["result"]["structuredContent"]["title"],
        renamed_title
    );
    let update = agent_intent(
        &state,
        &a,
        "notion",
        "notion_update_page_content",
        json!({"page_id":page,"content":"# 修改后的文章\n\n已完成修改验证。"}),
    )
    .await;
    confirm(&state, &a, &update).await;
    let read = invoke(
        &state,
        &a,
        "notion",
        "notion_read_page",
        json!({"page_id":page}),
    )
    .await;
    assert!(
        read["result"]["structuredContent"]["markdown"]
            .as_str()
            .unwrap()
            .contains("修改验证")
    );
    for in_trash in [true, false, true] {
        let pending = agent_intent(
            &state,
            &a,
            "notion",
            "notion_trash_page",
            json!({"page_id":page,"in_trash":in_trash}),
        )
        .await;
        let completed = confirm(&state, &a, &pending).await;
        assert_eq!(
            completed["result"]["structuredContent"]["in_trash"],
            in_trash
        );
    }
    println!(
        "REAL_NOTION_VERIFIED: identity; existing-page title search; Markdown create/read/update; block pagination; rename; metadata; trash; restore; final test page left in trash"
    );
}
