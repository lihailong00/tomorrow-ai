use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};
use tokio::sync::{mpsc, Notify};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{agent::{AgentClient, AgentOutput}, auth, new_id, now, ChatTurn, DomainError, Message, ModelProvider, Repository};
use tower::ServiceExt;

const SECRET: &str = "isolated-disconnect-fixture-service-token";

#[derive(Clone)]
struct Gateway {
    repo: Repository,
    entered: mpsc::UnboundedSender<Value>,
    release: Arc<Notify>,
    calls: Arc<AtomicUsize>,
}

async fn gateway(State(state): State<Gateway>, Json(mut body): Json<Value>) -> Json<Value> {
    state.calls.fetch_add(1, Ordering::SeqCst);
    body["effect"] = state.repo.execute_agent_tool_at(
        body["run_id"].as_str().unwrap(), body["run_token"].as_str().unwrap(), "save_memory",
        json!({"title":"Before abort", "content":"Synthetic durable effect", "kind":"fact"}), Some(1),
    ).await.unwrap();
    state.entered.send(body).unwrap();
    state.release.notified().await;
    Json(json!({"content":"Synthetic completed answer", "usage":{}}))
}

async fn call(router: Router, token: String, body: Value) -> (StatusCode, Value) {
    let request = Request::builder().method("POST").uri("/v1/chat")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(body.to_string())).unwrap();
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn eventually(mut predicate: impl AsyncFnMut() -> bool) {
    for _ in 0..100 {
        if predicate().await { return; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("owned cancellation cleanup did not complete within one second");
}

fn turn(conversation: tomorrow_domain::Conversation, key: String) -> ChatTurn {
    let message = |role: &str| Message {
        id: new_id(), conversation_id: conversation.id.clone(), role: role.into(),
        content: format!("Synthetic {role}"), created_at: tomorrow_domain::timestamp(now()),
        model_mode: None, attachments: Vec::new(),
    };
    ChatTurn {
        user_message: message("user"), assistant_message: message("assistant"),
        conversation, memory: None, request_id: Some(key), response: json!({"committed":true}),
    }
}

async fn checks(repo: Repository) {
    let user = repo.create_user(&format!("disconnect-{}@example.test", new_id()), "unused", "QA", "Asia/Shanghai").await.unwrap();
    let other = repo.create_user(&format!("disconnect-{}@example.test", new_id()), "unused", "QA", "Asia/Shanghai").await.unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let key = new_id();
    // Cancellation before any provider call releases only this user's reservation.
    let before = repo.reserve_chat_owned(&user.id, &key, "same input").await.unwrap();
    let other_reservation = repo.reserve_chat_owned(&other.id, &key, "same input").await.unwrap();
    drop(before);
    eventually(async || sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chat_requests WHERE user_id=$1")
        .bind(&user.id).fetch_one(&repo.pool()).await.unwrap() == 0).await;
    assert!(matches!(repo.reserve_chat_owned(&other.id, &key, "same input").await, Err(DomainError::Conflict(_))));
    drop(other_reservation);

    // Identical-input TTL takeover must fence both stale release and stale commit.
    let stale = repo.reserve_chat_owned(&user.id, &key, "same input").await.unwrap();
    sqlx::query("UPDATE chat_requests SET created_at=$1 WHERE user_id=$2 AND request_key=$3")
        .bind(now()-301).bind(&user.id).bind(format!("{}:{key}", user.id)).execute(&repo.pool()).await.unwrap();
    let replacement = repo.reserve_chat_owned(&user.id, &key, "same input").await.unwrap();
    let conversation = repo.create_conversation(&user.id, "test").await.unwrap();
    let chat_turn = turn(conversation.clone(), key.clone());
    assert!(matches!(repo.commit_chat_turn_attempt(&user.id, &chat_turn, "same input", stale.attempt_token()).await, Err(DomainError::Conflict(_))));
    assert!(repo.messages(&user.id, &conversation.id).await.unwrap().is_empty());
    drop(stale);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert!(matches!(repo.reserve_chat_owned(&user.id, &key, "same input").await, Err(DomainError::Conflict(_))));
    repo.commit_chat_turn_attempt(&user.id, &chat_turn, "same input", replacement.attempt_token()).await.unwrap();
    // Simulate disconnect after COMMIT, before acknowledgement/disarm.
    drop(replacement);
    assert_eq!(repo.reserve_chat_owned(&user.id, &key, "same input").await.unwrap().cached.as_ref(), Some(&json!({"committed":true})));

    // An old run's cleanup cannot revoke a newer token, success or explicit cancel.
    let run_key = new_id();
    let old = repo.begin_agent_run(&user.id, &run_key, "run", None, None).await.unwrap();
    sqlx::query("UPDATE agent_runs SET lease_until=$1 WHERE id=$2").bind(now()-1).bind(&old.id).execute(&repo.pool()).await.unwrap();
    let new = repo.begin_agent_run(&user.id, &run_key, "run", None, None).await.unwrap();
    drop(old);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert!(repo.agent_authority(&new.id, &new.token).await.is_ok());
    repo.cancel_agent_run(&user.id, &new.id).await.unwrap();
    let cancelled_id = new.id.clone(); drop(new);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert_eq!(repo.agent_run(&user.id, &cancelled_id).await.unwrap().status, "cancelled");
    let succeeded = repo.begin_agent_run(&user.id, &new_id(), "success", None, None).await.unwrap();
    repo.finish_agent_run(&succeeded, Some(&AgentOutput {content:"answer".into(), usage:json!({})}), None).await.unwrap();
    let succeeded_id = succeeded.id.clone(); drop(succeeded);
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert_eq!(repo.agent_run(&user.id, &succeeded_id).await.unwrap().status, "succeeded");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (entered, mut incoming) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway_app = Router::new().route("/v1/runs", post(gateway)).with_state(Gateway {repo:repo.clone(), entered, release:release.clone(), calls:calls.clone()});
    let server = tokio::spawn(async move { axum::serve(listener, gateway_app).await.unwrap(); });
    let mut state = AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:");
    state.agent = Some(AgentClient::new(&format!("http://{address}"), SECRET.into(), "fixture".into()).unwrap());
    let router = app(state);
    for request_key in [Some(new_id()), None] {
        let mut body = json!({"message":"Synthetic cancellation control"});
        if let Some(key) = &request_key { body["client_request_id"] = json!(key); }
        let pending = tokio::spawn(call(router.clone(), token.clone(), body.clone()));
        let active = incoming.recv().await.unwrap();
        let run_id = active["run_id"].as_str().unwrap();
        let run_token = active["run_token"].as_str().unwrap();
        let original_conversation = repo.agent_run(&user.id, run_id).await.unwrap().conversation_id.unwrap();
        let memory_count = repo.memories(&user.id).await.unwrap().len();
        if request_key.is_some() {
            assert_eq!(call(router.clone(), token.clone(), body.clone()).await.0, StatusCode::CONFLICT);
        }
        pending.abort(); assert!(pending.await.unwrap_err().is_cancelled());
        eventually(async || repo.agent_run(&user.id, run_id).await.unwrap().status == "failed").await;
        assert!(repo.agent_authority(run_id, run_token).await.is_err());
        if let Some(key) = &request_key {
            eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM chat_requests WHERE request_key=$1")
                .bind(format!("{}:{key}",user.id)).fetch_one(&repo.pool()).await.unwrap() == 0).await;
        }
        let retried = tokio::spawn(call(router.clone(), token.clone(), body.clone()));
        let retry_run = incoming.recv().await.unwrap();
        if request_key.is_some() {
            assert_eq!(retry_run["run_id"], active["run_id"]);
            assert_eq!(retry_run["effect"]["value"]["id"], active["effect"]["value"]["id"]);
            assert_eq!(retry_run["effect"]["replayed"], true);
            assert_eq!(repo.memories(&user.id).await.unwrap().len(), memory_count);
        }
        release.notify_waiters();
        let (status, completed) = retried.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        if request_key.is_some() {
            assert_eq!(completed["conversation_id"], original_conversation);
            let before = calls.load(Ordering::SeqCst);
            assert_eq!(call(router.clone(), token.clone(), body).await, (StatusCode::OK, completed.clone()));
            assert_eq!(calls.load(Ordering::SeqCst), before);
        }
        assert_eq!(repo.messages(&user.id, completed["conversation_id"].as_str().unwrap()).await.unwrap().len(), 2);
    }
    server.abort();
    // SQL stores hashes of fingerprints; owned cleanup keeps that input binding intact.
    let fingerprint: String = sqlx::query_scalar("SELECT fingerprint FROM chat_request_inputs WHERE request_key=$1")
        .bind(format!("{}:{key}",user.id)).fetch_one(&repo.pool()).await.unwrap();
    assert_eq!(fingerprint, auth::hash_token("same input"));
}

#[tokio::test]
async fn sqlite_chat_disconnect_cleanup_and_attempt_fences() {
    checks(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
#[ignore = "Requires isolated TEST_E04_DATABASE_URL PostgreSQL database"]
async fn postgres_chat_disconnect_cleanup_and_attempt_fences() {
    let url = std::env::var("TEST_E04_DATABASE_URL").unwrap();
    let name = url.split('?').next().unwrap().rsplit('/').next().unwrap();
    assert!(url.starts_with("postgres") && name == "tada_qa_e04_r4");
    let repo = Repository::connect(&url).await.unwrap();
    checks(repo.clone()).await;
    postgres_acquisition_commit_cancellation(&repo).await;
}

async fn postgres_acquisition_commit_cancellation(repo: &Repository) {
    let user = repo.create_user(&format!("commit-{}@example.test",new_id()), "unused", "QA", "UTC").await.unwrap();
    // A deferred trigger pauses COMMIT after INSERT, while the new row is still
    // invisible to independent cleanup. Only an owned acquisition task can safely
    // clean up after the cancelled caller without missing the later commit.
    sqlx::raw_sql("CREATE OR REPLACE FUNCTION e04_pause_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(41804011); RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER e04_chat_commit AFTER INSERT ON chat_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e04_pause_commit();
        CREATE CONSTRAINT TRIGGER e04_run_commit AFTER INSERT ON agent_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e04_pause_commit();")
        .execute(&repo.pool()).await.unwrap();
    let mut blocker = repo.pool().acquire().await.unwrap();
    for agent in [false, true] {
        sqlx::query("SELECT pg_advisory_lock(41804011)").execute(&mut *blocker).await.unwrap();
        let key = format!("commit-{}",new_id());
        let task_repo = repo.clone(); let owner = user.id.clone(); let task_key = key.clone();
        let pending = tokio::spawn(async move {
            if agent { drop(task_repo.begin_agent_run(&owner, &task_key, "test", None, None).await.unwrap()); }
            else { drop(task_repo.reserve_chat_owned(&owner, &task_key, "test").await.unwrap()); }
        });
        eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND query='COMMIT' AND wait_event='advisory'")
            .fetch_one(&repo.pool()).await.unwrap() > 0).await;
        pending.abort(); assert!(pending.await.unwrap_err().is_cancelled());
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        sqlx::query("SELECT pg_advisory_unlock(41804011)").execute(&mut *blocker).await.unwrap();
        if agent {
            eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM agent_runs WHERE user_id=$1 AND run_key=$2 AND status='failed'")
                .bind(&user.id).bind(format!("{}:{key}",user.id)).fetch_one(&repo.pool()).await.unwrap() == 1).await;
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM chat_requests WHERE user_id=$1 AND request_key=$2")
                .bind(&user.id).bind(format!("{}:{key}",user.id)).fetch_one(&repo.pool()).await.unwrap() == 0).await;
        }
    }
    sqlx::raw_sql("DROP TRIGGER e04_chat_commit ON chat_requests; DROP TRIGGER e04_run_commit ON agent_runs;")
        .execute(&repo.pool()).await.unwrap();
    let key = new_id();
    let mut reservation = repo.reserve_chat_owned(&user.id, &key, "commit turn").await.unwrap();
    let conversation = repo.create_conversation(&user.id, "Commit cancellation").await.unwrap();
    let chat_turn = turn(conversation.clone(), key.clone());
    sqlx::raw_sql("CREATE CONSTRAINT TRIGGER e04_turn_commit AFTER UPDATE ON chat_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e04_pause_commit();")
        .execute(&repo.pool()).await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(41804011)").execute(&mut *blocker).await.unwrap();
    let task_repo = repo.clone(); let owner = user.id.clone();
    let committing = tokio::spawn(async move {
        task_repo.commit_chat_turn_attempt(&owner, &chat_turn, "commit turn", reservation.attempt_token()).await.unwrap();
        reservation.committed();
    });
    eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND query='COMMIT' AND wait_event='advisory'")
        .fetch_one(&repo.pool()).await.unwrap() > 0).await;
    committing.abort(); assert!(committing.await.unwrap_err().is_cancelled());
    tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    sqlx::query("SELECT pg_advisory_unlock(41804011)").execute(&mut *blocker).await.unwrap();
    // COMMIT was sent before cancellation. Cleanup must wait for the row lock,
    // recheck response IS NULL, and preserve the atomically committed response.
    eventually(async || sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM chat_requests WHERE user_id=$1 AND request_key=$2 AND response IS NOT NULL")
        .bind(&user.id).bind(format!("{}:{key}",user.id)).fetch_one(&repo.pool()).await.unwrap() == 1).await;
    assert_eq!(repo.messages(&user.id, &conversation.id).await.unwrap().len(), 2);
    assert_eq!(repo.reserve_chat_owned(&user.id, &key, "commit turn").await.unwrap().cached.as_ref(), Some(&json!({"committed":true})));
    sqlx::raw_sql("DROP TRIGGER e04_turn_commit ON chat_requests; DROP FUNCTION e04_pause_commit();")
        .execute(&repo.pool()).await.unwrap();
}
