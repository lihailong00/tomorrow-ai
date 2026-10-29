use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, Semaphore},
};
use tomorrow_domain::*;
use tomorrow_settings::{ConfigOptions, ConfigStore};
use tomorrow_worker::WorkerEngine;

async fn owner() -> (Repository, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "growth-worker@example.test",
            "fixture",
            "owner",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    repo.update_growth_preferences(
        &user,
        UpdateGrowthPreferences {
            version: 0,
            enabled: Some(true),
            daily_minutes: Some(15),
            use_existing_todos: Some(false),
            goals: Some(vec![GrowthGoal {
                kind: "learning".into(),
                title: "理解Rust借用".into(),
            }]),
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap();
    (repo, user)
}
async fn request(stream: &mut tokio::net::TcpStream) -> String {
    let mut bytes = vec![];
    loop {
        let mut chunk = [0; 8192];
        let size = stream.read(&mut chunk).await.unwrap();
        assert!(size > 0);
        bytes.extend_from_slice(&chunk[..size]);
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&bytes[..end]);
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return String::from_utf8(bytes[end + 4..end + 4 + length].to_vec()).unwrap();
            }
        }
    }
}
fn result() -> String {
    serde_json::json!({"items":[{"todo_id":null,"title":"练习一个Rust借用示例","description":"阅读一个例子，并自己修改一次。","kind":"learning","reason":"你选择了理解Rust借用的目标","estimated_minutes":5}]}).to_string()
}
async fn reply(stream: &mut tokio::net::TcpStream, status: &str, content: &str) {
    let body = serde_json::json!({"choices":[{"message":{"role":"assistant","content":content}}]})
        .to_string();
    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn daily_worker_uses_effective_admin_model_without_tools_and_creates_only_candidates() {
    let (repo, user) = owner().await;
    let dir = tempfile::tempdir().unwrap();
    let settings = ConfigStore::with_options(
        repo.pool(),
        ConfigOptions {
            environment: HashMap::new(),
            config_dir: dir.path().join("config"),
            master_key: None,
        },
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    settings
        .update(
            0,
            HashMap::from([
                ("MODEL_BASE_URL".into(), Some(format!("http://{addr}/v1"))),
                ("MODEL_NAME".into(), Some("daily-admin-fixture".into())),
                ("MODEL_API_KEY".into(), Some("synthetic-key".into())),
            ]),
        )
        .await
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let body = request(&mut stream).await;
        reply(&mut stream, "200 OK", &result()).await;
        body
    });
    repo.ensure_daily_plan(&user, EnsureDailyPlan::default())
        .await
        .unwrap();
    let agent = tomorrow_domain::agent::AgentClient::new(
        "http://127.0.0.1:1",
        "test-only-closed-agent-000000000000000".into(),
        "unused".into(),
    )
    .unwrap();
    let engine = WorkerEngine::new(repo.clone(), ModelProvider::local())
        .with_agent(Some(agent))
        .with_settings(settings);
    let claim = engine.claim().await.unwrap().unwrap();
    assert_eq!(claim.task.kind, "daily_plan");
    assert!(engine.execute(&claim).await.unwrap());
    let body = server.await.unwrap();
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["model"], "daily-admin-fixture");
    assert!(body.get("tools").is_none());
    let context_message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "user")
        .unwrap();
    let context: serde_json::Value =
        serde_json::from_str(context_message["content"].as_str().unwrap()).unwrap();
    assert_eq!(context["existing_todos"].as_array().unwrap().len(), 0);
    let plan = repo.daily_plan(&user).await.unwrap();
    assert_eq!(plan.status, "ready");
    assert_eq!(plan.items.len(), 1);
    assert!(plan.items[0].todo_id.is_none());
    assert!(
        repo.todos_page(&user, "all", "all", 0, 100)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert_eq!(repo.growth_summary(&user).await.unwrap().total_xp, 0);
    let private_context: String =
        sqlx::query_scalar("SELECT context FROM growth_daily_plans WHERE id=$1")
            .bind(plan.id.unwrap())
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert!(!private_context.contains("理解Rust借用"));
}

#[tokio::test]
async fn daily_model_failure_is_not_automatically_retried_or_turned_into_a_document() {
    let (repo, user) = owner().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        observed.fetch_add(1, Ordering::SeqCst);
        reply(&mut stream, "503 Service Unavailable", "ignored").await;
    });
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{address}/v1")),
        "MODEL_NAME" => Some("daily-failure-fixture".into()),
        "MODEL_API_KEY" => Some("fixture".into()),
        _ => None,
    });
    let engine = WorkerEngine::new(repo.clone(), provider);
    repo.ensure_daily_plan(&user, EnsureDailyPlan::default())
        .await
        .unwrap();
    let claim = engine.claim().await.unwrap().unwrap();
    assert!(engine.execute(&claim).await.is_err());
    server.await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(engine.claim().await.unwrap().is_none());
    assert_eq!(
        repo.task(&user, &claim.task.id).await.unwrap().status,
        "failed"
    );
    let plan = repo.daily_plan(&user).await.unwrap();
    assert_eq!(plan.status, "failed");
    assert!(plan.can_retry);
    assert!(plan.items.is_empty());
    let artifacts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM resources WHERE user_id=$1 AND kind IN ('artifact','memory')",
    )
    .bind(&user)
    .fetch_one(&repo.pool())
    .await
    .unwrap();
    assert_eq!(artifacts, 0);
}

#[tokio::test]
async fn disabling_while_daily_model_is_inflight_fences_publication() {
    let (repo, user) = owner().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let seen = started.clone();
    let gate = release.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        seen.notify_one();
        gate.acquire().await.unwrap().forget();
        reply(&mut stream, "200 OK", &result()).await;
    });
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{addr}/v1")),
        "MODEL_NAME" => Some("daily-gated-fixture".into()),
        "MODEL_API_KEY" => Some("fixture".into()),
        _ => None,
    });
    let engine = WorkerEngine::new(repo.clone(), provider);
    repo.ensure_daily_plan(&user, EnsureDailyPlan::default())
        .await
        .unwrap();
    let claim = engine.claim().await.unwrap().unwrap();
    let task = tokio::spawn(async move { engine.execute(&claim).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    let prefs = repo.growth_preferences(&user).await.unwrap();
    repo.update_growth_preferences(
        &user,
        UpdateGrowthPreferences {
            version: prefs.version,
            enabled: Some(false),
            daily_minutes: None,
            use_existing_todos: None,
            goals: None,
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap();
    release.add_permits(1);
    assert!(task.await.unwrap().is_err());
    server.await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items WHERE user_id=$1")
        .bind(&user)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(repo.daily_plan(&user).await.unwrap().status, "disabled");
    assert_eq!(repo.growth_summary(&user).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn deleting_daily_source_inflight_rejects_goal_output_and_finishes_failed() {
    let (repo, user) = owner().await;
    let prefs = repo.growth_preferences(&user).await.unwrap();
    repo.update_growth_preferences(
        &user,
        UpdateGrowthPreferences {
            version: prefs.version,
            enabled: None,
            daily_minutes: None,
            use_existing_todos: Some(true),
            goals: None,
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap();
    let original = repo
        .create_todo(
            &user,
            CreateTodo {
                title: "用户准备删除的原始事项".into(),
                description: None,
                kind: Some("learning".into()),
                due_at: None,
                estimated_minutes: Some(5),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let seen = started.clone();
    let gate = release.clone();
    let original_id = original.id.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let body = request(&mut stream).await;
        assert!(body.contains(&original_id));
        seen.notify_one();
        gate.acquire().await.unwrap().forget();
        // No todo_id: deleting the source must also fence derived goal output.
        reply(&mut stream, "200 OK", &result()).await;
    });
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{addr}/v1")),
        "MODEL_NAME" => Some("daily-deletion-fixture".into()),
        "MODEL_API_KEY" => Some("fixture".into()),
        _ => None,
    });
    let engine = WorkerEngine::new(repo.clone(), provider);
    repo.ensure_daily_plan(&user, EnsureDailyPlan::default())
        .await
        .unwrap();
    let claim = engine.claim().await.unwrap().unwrap();
    let task_id = claim.task.id.clone();
    let task = tokio::spawn(async move { engine.execute(&claim).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    repo.delete_todo(&user, &original.id).await.unwrap();
    release.add_permits(1);
    assert!(!task.await.unwrap().unwrap());
    server.await.unwrap();
    assert_eq!(repo.task(&user, &task_id).await.unwrap().status, "failed");
    let plan = repo.daily_plan(&user).await.unwrap();
    assert_eq!(plan.status, "failed");
    assert!(plan.items.is_empty());
    assert!(plan.can_retry);
}

#[tokio::test]
async fn cancellation_after_begin_respects_model_mode_guard_before_model_io() {
    let (repo, user) = owner().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{addr}/v1")),
        "MODEL_NAME" => Some("daily-cancel-fixture".into()),
        "MODEL_API_KEY" => Some("fixture".into()),
        _ => None,
    });
    let engine = WorkerEngine::new(repo.clone(), provider);
    repo.ensure_daily_plan(&user, EnsureDailyPlan::default())
        .await
        .unwrap();
    let claim = engine.claim().await.unwrap().unwrap();
    // A deterministic test-only interleaving: begin commits a real context,
    // cancellation wins before record_task_model_mode checks the running guard.
    sqlx::raw_sql("CREATE TRIGGER cancel_after_daily_begin AFTER UPDATE OF context ON growth_daily_plans WHEN NEW.status='generating' AND NEW.context<>'' BEGIN UPDATE tasks SET status='cancelled',claimed_until=0 WHERE id=NEW.task_id; END;")
        .execute(&repo.pool()).await.unwrap();
    assert!(!engine.execute(&claim).await.unwrap());
    assert_eq!(
        repo.task(&user, &claim.task.id).await.unwrap().status,
        "cancelled"
    );
    assert_eq!(repo.daily_plan(&user).await.unwrap().status, "failed");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
}
