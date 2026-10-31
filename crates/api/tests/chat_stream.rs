use axum::{
    extract::State,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tomorrow_api::{app, AppState};
use tomorrow_domain::{agent::AgentClient, new_id, DomainError, ModelProvider, Repository};

const SECRET: &str = "synthetic-streaming-fixture-service-token";

#[derive(Clone)]
struct Pi {
    repo: Repository,
    release: Arc<Notify>,
    calls: Arc<AtomicUsize>,
    fail_first: bool,
}
async fn pi(State(pi): State<Pi>, Json(body): Json<Value>) -> Response {
    assert_eq!(
        body["operation_slots"], true,
        "new stream must opt in to globally ordered mutation replay"
    );
    let call = pi.calls.fetch_add(1, Ordering::SeqCst);
    if body["messages"][0]["content"]
        .as_str()
        .is_some_and(|s| s.starts_with("history-"))
    {
        let context = body["messages"].as_array().unwrap();
        assert_eq!(context.len(), 40);
        assert_eq!(context[0]["content"], "history-965");
        assert_eq!(context[38]["content"], "history-1003");
        assert_eq!(
            context
                .iter()
                .filter(|m| m["content"] == "Synthetic streaming request")
                .count(),
            1
        );
    }
    let run = body["run_id"].as_str().unwrap();
    let token = body["run_token"].as_str().unwrap();
    let mut seq = pi.repo.next_agent_sequence(run).await.unwrap();
    for (kind, data) in [
        ("started", json!({})),
        ("text_start", json!({"turn":1})),
        ("text_delta", json!({"turn":1,"delta":"第一段"})),
        (
            "tool_start",
            json!({"tool":"create_task","tool_call_id":"fixture-one","arguments":{"private":"not exposed"}}),
        ),
    ] {
        pi.repo
            .record_agent_event(run, token, seq, kind, &data)
            .await
            .unwrap();
        seq += 1;
    }
    let task = pi
        .repo
        .execute_agent_tool_with_slot(
            run,
            token,
            "create_task",
            json!({"title":"Synthetic task","instruction":"Synthetic request only"}),
            Some(1),
            Some(1),
        )
        .await
        .unwrap();
    assert!(task.is_object());
    // The final result literally does not exist until the HTTP consumer has seen
    // a real callback delta. A buffered/fake-stream implementation deadlocks here.
    pi.release.notified().await;
    if pi.fail_first && call == 0 {
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({"error":"synthetic interrupted upstream"})),
        )
            .into_response();
    }
    for (kind, data) in [
        (
            "tool_end",
            json!({"tool":"create_task","tool_call_id":"fixture-one","is_error":false}),
        ),
        ("text_start", json!({"turn":2})),
        ("text_delta", json!({"turn":2,"delta":"第二段"})),
        ("finished", json!({})),
    ] {
        pi.repo
            .record_agent_event(run, token, seq, kind, &data)
            .await
            .unwrap();
        seq += 1;
    }
    Json(json!({"content":"第一段\n\n第二段","usage":{}})).into_response()
}

async fn until(response: &mut reqwest::Response, needle: &str) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .unwrap()
                .expect("SSE ended before expected event");
            bytes.extend_from_slice(&chunk);
            if let Ok(text) = std::str::from_utf8(&bytes) {
                if text.contains(needle) && text.ends_with("\n\n") {
                    return text.to_owned();
                }
            }
        }
    })
    .await
    .expect("first real delta did not arrive while final was gated")
}

async fn checks(repo: Repository, database: &str, fail_first: bool) {
    checks_with_history(repo, database, fail_first, false).await
}

async fn checks_with_history(repo: Repository, database: &str, fail_first: bool, history: bool) {
    let owner = repo
        .create_user(
            &format!("stream-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let other = repo
        .create_user(
            &format!("stream-other-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&owner.id).await.unwrap();
    let other_token = repo.create_session(&other.id).await.unwrap();
    let history_conversation = if history {
        let conversation = repo
            .create_conversation(&owner.id, "Long history")
            .await
            .unwrap();
        let pool = repo.pool();
        let mut tx = pool.begin().await.unwrap();
        for index in 0..1004_i64 {
            let date = chrono::DateTime::from_timestamp(
                1_790_000_000 + index,
                if index == 1003 { 9 } else { 123_456_789 },
            )
            .unwrap();
            let created = if index % 2 == 0 {
                date.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
                    .to_rfc3339_opts(chrono::SecondsFormat::Nanos, false)
            } else {
                date.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
            };
            let id = new_id();
            let message = json!({"id":id,"conversation_id":conversation.id,"role":"assistant","content":format!("history-{index}"),"created_at":created,"model_mode":"llm","attachments":[]});
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'message',$3,$4,$4)")
                .bind(id).bind(&owner.id).bind(message.to_string()).bind(1004-index).execute(&mut *tx).await.unwrap();
        }
        tx.commit().await.unwrap();
        Some(conversation.id)
    } else {
        None
    };
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pi_url = format!("http://{}", listener.local_addr().unwrap());
    let gateway = Router::new().route("/v1/runs", post(pi)).with_state(Pi {
        repo: repo.clone(),
        release: release.clone(),
        calls: calls.clone(),
        fail_first,
    });
    let pi_server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
    let mut state = AppState::new(repo.clone(), ModelProvider::local(), database);
    state.agent = Some(AgentClient::new(&pi_url, SECRET.into(), "synthetic".into()).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/chat/stream", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let request_id = new_id();
    let body = json!({"message":"Synthetic streaming request","client_request_id":request_id,"conversation_id":history_conversation});
    let mut response = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let early = until(&mut response, "event: text_delta").await;
    assert!(early.contains("第一段"));
    assert!(!early.contains("第二段"));
    let accepted = repo.chat_stream(&owner.id, &request_id).await.unwrap();
    assert_eq!(accepted.status, "running");
    assert_eq!(accepted.content, "第一段");
    let conversation = accepted.accepted.as_ref().unwrap()["conversation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        repo.messages(&owner.id, &conversation).await.unwrap().len(),
        if history { 1000 } else { 1 },
        "user message must be durable before final generation"
    );
    drop(response); // Real transport subscriber disconnect; producer must survive.
    let mut reconnect = client
        .post(&url)
        .bearer_auth(&token)
        .header("last-event-id", accepted.sequence.to_string())
        .json(&body)
        .send()
        .await
        .unwrap();
    let snapshot = until(&mut reconnect, "event: snapshot").await;
    assert!(snapshot.contains("第一段"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "reattachment must not start another Pi/model call"
    );
    let foreign = client
        .post(&url)
        .bearer_auth(&other_token)
        .header("last-event-id", accepted.sequence.to_string())
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), reqwest::StatusCode::NOT_FOUND);
    let ahead = client
        .post(&url)
        .bearer_auth(&token)
        .header("last-event-id", "9999999")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(ahead.status(), reqwest::StatusCode::CONFLICT);
    let changed = client
        .post(&url)
        .bearer_auth(&token)
        .json(&json!({"message":"changed","client_request_id":request_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(changed.status(), reqwest::StatusCode::CONFLICT);
    release.notify_one();
    if fail_first {
        let failed = until(&mut reconnect, "event: error").await;
        assert!(failed.contains("partial"));
        let interrupted = repo.chat_stream(&owner.id, &request_id).await.unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(interrupted.content, "第一段");
        assert_eq!(repo.tasks(&owner.id).await.unwrap().len(), 1);
        reconnect = client
            .post(&url)
            .bearer_auth(&token)
            .header("x-chat-retry", "1")
            .json(&body)
            .send()
            .await
            .unwrap();
        let retry = until(&mut reconnect, "\"replace\":true").await;
        assert!(retry.contains("第一段"));
        let resumed = repo.chat_stream(&owner.id, &request_id).await.unwrap();
        assert_eq!(resumed.attempt, 2);
        assert_eq!(resumed.previous_content.as_deref(), Some("第一段"));
        assert_eq!(
            resumed.accepted, interrupted.accepted,
            "retry must reuse every stable message/conversation ID"
        );
        assert_eq!(
            repo.tasks(&owner.id).await.unwrap().len(),
            1,
            "retry must replay the same durable task operation"
        );
        assert_eq!(
            repo.messages(&owner.id, &conversation).await.unwrap().len(),
            if history { 1000 } else { 1 }
        );
        release.notify_one();
    }
    let final_events = until(&mut reconnect, "event: done").await;
    assert!(final_events.contains("第二段"));
    assert!(!final_events.contains("private"));
    let completed = repo.chat_stream(&owner.id, &request_id).await.unwrap();
    assert_eq!(completed.status, "done");
    assert_eq!(completed.content, "第一段\n\n第二段");
    assert_eq!(
        repo.messages(&owner.id, &conversation).await.unwrap().len(),
        if history { 1000 } else { 2 }
    );
    assert_eq!(repo.tasks(&owner.id).await.unwrap().len(), 1);
    let cached = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(cached.contains("\"status\":\"done\""));
    assert!(cached.contains("第二段"));
    assert_eq!(calls.load(Ordering::SeqCst), if fail_first { 2 } else { 1 });
    server.abort();
    pi_server.abort();
}

#[tokio::test]
async fn sqlite_real_http_first_delta_disconnect_resume_and_once_only_effects() {
    checks(
        Repository::connect("sqlite::memory:").await.unwrap(),
        "sqlite::memory:",
        false,
    )
    .await;
}

#[tokio::test]
async fn postgres_real_http_first_delta_disconnect_resume_and_once_only_effects() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    if !url.starts_with("postgres") {
        return;
    }
    checks(Repository::connect(&url).await.unwrap(), &url, false).await;
}

#[tokio::test]
async fn sqlite_real_http_explicit_retry_keeps_ids_and_replays_task_once() {
    checks(
        Repository::connect("sqlite::memory:").await.unwrap(),
        "sqlite::memory:",
        true,
    )
    .await;
}

#[tokio::test]
async fn sqlite_long_history_uses_only_the_latest_39_plus_one_current_user_in_timestamp_order() {
    checks_with_history(
        Repository::connect("sqlite::memory:").await.unwrap(),
        "sqlite::memory:",
        true,
        true,
    )
    .await;
}

#[tokio::test]
async fn postgres_real_http_explicit_retry_keeps_ids_and_replays_task_once() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    if !url.starts_with("postgres") {
        return;
    }
    checks(Repository::connect(&url).await.unwrap(), &url, true).await;
}

#[tokio::test]
async fn interrupted_checkpoint_survives_expiry_and_rejects_legacy_reexecution() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            &format!("stream-expire-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let id = new_id();
    let producer = repo
        .begin_chat_stream(&user.id, &id, "same input")
        .await
        .unwrap()
        .unwrap();
    repo.append_chat_stream_delta(&producer, "保留的部分".into())
        .await
        .unwrap();
    sqlx::query("UPDATE chat_streams SET lease_until=0 WHERE request_key=$1")
        .bind(&producer.request_key)
        .execute(&repo.pool())
        .await
        .unwrap();
    sqlx::query("UPDATE chat_requests SET created_at=0 WHERE request_key=$1")
        .bind(&producer.request_key)
        .execute(&repo.pool())
        .await
        .unwrap();
    let view = repo.chat_stream(&user.id, &id).await.unwrap();
    assert_eq!(view.status, "interrupted");
    assert_eq!(view.content, "保留的部分");
    assert!(repo
        .begin_chat_stream(&user.id, &id, "same input")
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        repo.reserve_chat_owned(&user.id, &id, "same input").await,
        Err(DomainError::Conflict(_))
    ));
    assert!(repo
        .append_chat_stream_delta(&producer, "不能追加".into())
        .await
        .is_err());
}
