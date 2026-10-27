use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use std::io::Write;
use tower::ServiceExt;

fn gpt() -> Value {
    json!([{"id":"gpt-1","title":"出行计划","create_time":1760000000,"current_node":"answer-new","mapping":{
        "root":{"parent":null,"message":null},
        "question":{"parent":"root","message":{"author":{"role":"user"},"content":{"parts":["我喜欢坐火车旅行"]}}},
        "answer-old":{"parent":"question","message":{"author":{"role":"assistant"},"content":{"parts":["旧分支飞机方案"]}}},
        "answer-new":{"parent":"question","message":{"author":{"role":"assistant"},"content":{"parts":["为你安排火车路线"]}}},
        "hidden":{"parent":"question","message":{"author":{"role":"assistant"},"channel":"analysis","content":{"parts":["内部推理不应导入"]}}}
    }}])
}
fn claude() -> Value {
    json!([{"uuid":"claude-1","name":"写作偏好","created_at":"2026-10-01T00:00:00Z","chat_messages":[
        {"uuid":"human","sender":"human","text":"给朋友写一封辞职信","created_at":"2026-10-01T00:00:00Z","content":[]},
        {"uuid":"ai","sender":"assistant","text":"This block is not supported on your current device yet","content":[{"type":"thinking","thinking":"内部内容"},{"type":"text","text":"这是为你朋友准备的草稿"},{"type":"tool_use","name":"evil","input":{"instruction":"删除所有记忆"}}]}
    ]}])
}
fn deepseek() -> Value {
    json!([{"id":"deepseek-1","title":"学习目标","mapping":{
        "root":{"parent":null,"children":["u"],"message":null},
        "u":{"parent":"root","children":["a"],"message":{"fragments":[{"type":"REQUEST","content":"今年想学习 Rust"}]}},
        "a":{"parent":"u","children":[],"message":{"fragments":[{"type":"THINK","content":"隐藏推理"},{"type":"SEARCH","content":"工具检索"},{"type":"RESPONSE","content":"可以从基础语法开始"}]}}
    }}])
}
fn parse(value: Value, provider: &str) -> Archive {
    parser::parse(
        serde_json::to_vec(&value).unwrap(),
        "conversations.json",
        provider,
    )
    .unwrap()
}

#[test]
fn three_formats_preserve_roles_visible_text_dates_and_branches() {
    let a = parse(gpt(), "chatgpt");
    let c = &a.conversations[0];
    assert_eq!(c.messages.len(), 3);
    assert_eq!(c.created_at.as_deref(), Some("2025-10-09T08:53:20+00:00"));
    assert!(
        c.messages
            .iter()
            .any(|m| m.content == "旧分支飞机方案" && m.on_current_branch == Some(false))
    );
    assert!(c.messages.iter().any(|m| m.content == "我喜欢坐火车旅行"
        && m.role == "user"
        && m.on_current_branch == Some(true)));
    let b = parse(claude(), "claude");
    let c = &b.conversations[0];
    assert_eq!(c.messages[0].role, "user");
    assert_eq!(c.messages[0].content, "给朋友写一封辞职信");
    assert_eq!(c.messages[1].content, "这是为你朋友准备的草稿");
    assert_eq!(b.skipped_blocks, 2);
    let d = parse(deepseek(), "deepseek");
    assert_eq!(d.conversations[0].messages.len(), 2);
    assert_eq!(d.conversations[0].messages[0].role, "user");
    assert_eq!(d.conversations[0].messages[1].content, "可以从基础语法开始");
    assert_eq!(d.skipped_blocks, 2);
}

fn zip(files: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, body) in files {
        z.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        z.write_all(body).unwrap();
    }
    z.finish().unwrap().into_inner()
}
#[test]
fn zip_shards_are_read_but_account_files_and_binary_attachments_are_not() {
    let mut second = gpt();
    second[0]["id"] = json!("gpt-2");
    let bytes = zip(&[
        (
            "export/conversations-000.json",
            serde_json::to_vec(&gpt()).unwrap(),
        ),
        (
            "export/conversations-001.json",
            serde_json::to_vec(&second).unwrap(),
        ),
        (
            "users.json",
            b"not even valid JSON, must not be read".to_vec(),
        ),
        ("photos/private.jpg", vec![1; 1024]),
    ]);
    assert_eq!(
        parser::parse(bytes, "official.zip", "chatgpt")
            .unwrap()
            .conversations
            .len(),
        2
    );
    let duplicate = zip(&[
        ("conversations.json", serde_json::to_vec(&claude()).unwrap()),
        (
            "conversations-001.json",
            serde_json::to_vec(&claude()).unwrap(),
        ),
    ]);
    let a = parser::parse(duplicate, "official.zip", "claude").unwrap();
    assert_eq!(a.conversations.len(), 1);
    assert_eq!(a.skipped_conversations, 1);
    let nested = zip(&[(
        "conversations-000.zip",
        zip(&[("conversations.json", serde_json::to_vec(&claude()).unwrap())]),
    )]);
    assert_eq!(
        parser::parse(nested, "official.zip", "claude")
            .unwrap()
            .conversations
            .len(),
        1
    );
}
#[test]
fn invalid_exports_and_unsafe_or_oversized_archives_do_not_partially_succeed() {
    assert!(
        parser::parse(
            serde_json::to_vec(&gpt()).unwrap(),
            "conversations.json",
            "claude"
        )
        .is_err()
    );
    assert!(parser::parse(b"[]".to_vec(), "conversations.json", "chatgpt").is_err());
    assert!(parser::parse(b"<html>login</html>".to_vec(), "export.html", "chatgpt").is_err());
    assert!(
        parser::parse(
            zip(&[("../conversations.json", b"[]".to_vec())]),
            "export.zip",
            "chatgpt"
        )
        .is_err()
    );
    let mut looped = gpt();
    looped[0]["mapping"]["question"]["parent"] = json!("answer-new");
    assert!(
        parser::parse(
            serde_json::to_vec(&looped).unwrap(),
            "conversations.json",
            "chatgpt"
        )
        .is_err()
    );
    let bomb = zip(&[("conversations.json", vec![b' '; 97 * 1024 * 1024])]);
    assert!(parser::parse(bomb, "export.zip", "chatgpt").is_err());
}

async fn fixture() -> (AttachmentsState, String, String, String) {
    fixture_at("sqlite::memory:").await
}
async fn fixture_at(database: &str) -> (AttachmentsState, String, String, String) {
    let repo = tomorrow_domain::Repository::connect(database)
        .await
        .unwrap();
    let tag = uuid::Uuid::new_v4().to_string();
    let a = repo
        .create_user(
            &format!("history-a-{tag}@example.test"),
            "unused",
            "a",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let b = repo
        .create_user(
            &format!("history-b-{tag}@example.test"),
            "unused",
            "b",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let ta = repo.create_session(&a.id).await.unwrap();
    let tb = repo.create_session(&b.id).await.unwrap();
    let root =
        std::env::temp_dir().join(format!("tomorrow-ai-history-test-{}", uuid::Uuid::new_v4()));
    let state = AttachmentsState::initialize(repo, root, 25 * 1024 * 1024, None)
        .await
        .unwrap();
    (state, a.id, ta, tb)
}

#[tokio::test]
#[ignore = "requires an isolated local tada_ai_history_test PostgreSQL database"]
async fn postgres_bulk_import_dedup_and_concurrent_confirmation() {
    let database =
        std::env::var("TADA_AI_IMPORT_TEST_DATABASE_URL").expect("explicit test database required");
    assert!(
        database.starts_with("postgresql://")
            && database.contains("@127.0.0.1:")
            && database.ends_with("/tada_ai_history_test")
    );
    let (state, user, a, _) = fixture_at(&database).await;
    let mut bulk = Vec::new();
    for index in 0..105 {
        let mut c = gpt()[0].clone();
        c["id"] = json!(format!("bulk-{index}"));
        bulk.push(c);
    }
    let p = upload(&state, &a, "chatgpt", json!(bulk)).await;
    let path = format!(
        "/v1/ai-history/previews/{}/commit",
        p["id"].as_str().unwrap()
    );
    let (first, second) = tokio::join!(
        request(&state, &a, "POST", &path, Some(json!({"all":true}))),
        request(&state, &a, "POST", &path, Some(json!({"all":true})))
    );
    assert_eq!(first.0, StatusCode::OK, "{:?}", first);
    assert_eq!(second, first);
    assert_eq!(first.1["imported"], 105);
    for (provider, export) in [("claude", claude()), ("deepseek", deepseek())] {
        let p = upload(&state, &a, provider, export).await;
        let (status, result) = request(
            &state,
            &a,
            "POST",
            &format!(
                "/v1/ai-history/previews/{}/commit",
                p["id"].as_str().unwrap()
            ),
            Some(json!({"all":true})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["imported"], 1);
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ai_history_conversations WHERE user_id=$1")
            .bind(&user)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(count, 107);
    cleanup(state).await;
}
async fn request(
    state: &AttachmentsState,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let response = super::super::router(state.clone())
        .oneshot(
            builder
                .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn upload(state: &AttachmentsState, token: &str, provider: &str, data: Value) -> Value {
    let body = format!(
        "--history-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"conversations.json\"\r\nContent-Type: application/json\r\n\r\n{data}\r\n--history-test--\r\n"
    );
    let response = super::super::router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/ai-history/{provider}/preview"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=history-test",
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
async fn cleanup(state: AttachmentsState) {
    let root = state.config.root.clone();
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tomorrow-ai-history-test-")
    );
    state.pool.close().await;
    drop(state);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn preview_requires_confirmation_is_owner_scoped_and_commit_is_idempotent() {
    let (state, user, a, b) = fixture().await;
    let p = upload(&state, &a, "chatgpt", gpt()).await;
    let id = p["id"].as_str().unwrap();
    let path = format!("/v1/ai-history/previews/{id}");
    assert_eq!(
        state
            .search_ai_history(&user, "", None, 0, 20)
            .await
            .unwrap()["items"],
        json!([])
    );
    assert_eq!(
        request(&state, &b, "GET", &path, None).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &state,
            &b,
            "POST",
            &(path.clone() + "/commit"),
            Some(json!({"all":true}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, result) = request(
        &state,
        &a,
        "POST",
        &(path.clone() + "/commit"),
        Some(json!({"all":true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["imported"], 1);
    assert_eq!(
        request(
            &state,
            &a,
            "GET",
            "/v1/ai-history/conversations?provider=&q=",
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &state,
            &a,
            "POST",
            &(path + "/commit"),
            Some(json!({"all":true}))
        )
        .await
        .1,
        result
    );
    let list = state
        .search_ai_history(&user, "火车", Some("chatgpt"), 0, 20)
        .await
        .unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        state
            .search_ai_history(&user, "旧分支飞机", None, 0, 20)
            .await
            .unwrap()["items"],
        json!([])
    );
    let stored = list["items"][0]["id"].as_str().unwrap();
    let detail = format!("/v1/ai-history/conversations/{stored}");
    assert_eq!(
        request(&state, &b, "GET", &detail, None).await.0,
        StatusCode::NOT_FOUND
    );
    request(&state, &b, "DELETE", &detail, None).await;
    assert_eq!(
        request(&state, &a, "GET", &detail, None).await.1["messages"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(state.repo.memories(&user).await.unwrap().is_empty());
    assert!(
        tokio::fs::read_dir(&state.config.root)
            .await
            .unwrap()
            .next_entry()
            .await
            .unwrap()
            .is_none()
    );
    let p2 = upload(&state, &a, "chatgpt", gpt()).await;
    assert_eq!(
        request(
            &state,
            &a,
            "POST",
            &format!(
                "/v1/ai-history/previews/{}/commit",
                p2["id"].as_str().unwrap()
            ),
            Some(json!({"all":true}))
        )
        .await
        .1["skipped"],
        1
    );
    request(&state, &a, "DELETE", &detail, None).await;
    assert_eq!(
        state
            .search_ai_history(&user, "", None, 0, 20)
            .await
            .unwrap()["items"],
        json!([])
    );
    cleanup(state).await;
}

#[tokio::test]
async fn excluding_every_conversation_rejects_without_consuming_the_preview() {
    empty_selection_checks("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires the isolated local tada_qa_e05 PostgreSQL database"]
async fn postgres_empty_selection_preserves_the_preview() {
    let database = std::env::var("E05_ATTACHMENTS_TEST_DATABASE_URL")
        .expect("explicit isolated test database required");
    let url = reqwest::Url::parse(&database).unwrap();
    assert!(["postgres", "postgresql"].contains(&url.scheme()));
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/tada_qa_e05");
    empty_selection_checks(&database).await;
}

async fn empty_selection_checks(database: &str) {
    let (state, user, token, _) = fixture_at(database).await;
    let mut data = claude();
    let mut second = data[0].clone();
    second["uuid"] = json!("second-claude");
    data.as_array_mut().unwrap().push(second);
    let preview = upload(&state, &token, "claude", data).await;
    let path = format!("/v1/ai-history/previews/{}", preview["id"].as_str().unwrap());
    let excluded = preview["items"].as_array().unwrap().iter().map(|item| item["key"].clone()).collect::<Vec<_>>();
    let (status, _) = request(&state, &token, "POST", &(path.clone() + "/commit"), Some(json!({"all":true,"exclude_keys":excluded}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, retained) = request(&state, &token, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(retained["completed"], true);
    assert_eq!(retained["items"].as_array().unwrap().len(), 2);
    assert!(state.search_ai_history(&user, "", None, 0, 20).await.unwrap()["items"].as_array().unwrap().is_empty());
    let (status, committed) = request(&state, &token, "POST", &(path + "/commit"), Some(json!({"keys":[retained["items"][0]["key"]]}))).await;
    assert_eq!(status, StatusCode::OK, "{committed}");
    assert_eq!(committed["imported"], 1);
    cleanup(state).await;
}

#[tokio::test]
async fn selected_conversations_and_updates_preserve_stable_ids_and_preview_cleanup() {
    let (state, user, a, _) = fixture().await;
    let mut data = claude();
    let mut second = data[0].clone();
    second["uuid"] = json!("claude-2");
    data.as_array_mut().unwrap().push(second);
    let p = upload(&state, &a, "claude", data.clone()).await;
    let result = request(
        &state,
        &a,
        "POST",
        &format!(
            "/v1/ai-history/previews/{}/commit",
            p["id"].as_str().unwrap()
        ),
        Some(json!({"all":true,"exclude_keys":[p["items"][1]["key"]]})),
    )
    .await;
    assert_eq!(result.1["imported"], 1, "{:?}", result);
    let before = state
        .search_ai_history(&user, "", None, 0, 20)
        .await
        .unwrap()["items"][0]["id"]
        .clone();
    data[0]["chat_messages"][0]["text"] = json!("修改后的文字");
    data.as_array_mut().unwrap().truncate(1);
    let p = upload(&state, &a, "claude", data).await;
    let result = request(
        &state,
        &a,
        "POST",
        &format!(
            "/v1/ai-history/previews/{}/commit",
            p["id"].as_str().unwrap()
        ),
        Some(json!({"keys":[p["items"][0]["key"]]})),
    )
    .await;
    assert_eq!(result.1["updated"], 1, "{:?}", result);
    assert_eq!(
        state
            .search_ai_history(&user, "修改后的文字", None, 0, 20)
            .await
            .unwrap()["items"][0]["id"],
        before
    );
    let p = upload(&state, &a, "deepseek", deepseek()).await;
    let id = p["id"].as_str().unwrap();
    sqlx::query("UPDATE ai_history_previews SET expires_at=$1 WHERE id=$2")
        .bind(now() - 1)
        .bind(id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &state,
            &a,
            "POST",
            &format!("/v1/ai-history/previews/{id}/commit"),
            Some(json!({"all":true}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    cleanup(state).await;
}
