use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tomorrow_domain::{CreateTodo, ModelProvider, PrepareTodo, Repository, agent::AgentClient};
use tomorrow_settings::{ConfigOptions, ConfigStore};
use tomorrow_worker::WorkerEngine;

#[tokio::test]
async fn todo_preparation_uses_saved_admin_model_and_bypasses_tool_agent() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("worker-todo@test.invalid", "test", "owner", "UTC")
        .await
        .unwrap()
        .id;
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
    let address = listener.local_addr().unwrap();
    settings
        .update(
            0,
            HashMap::from([
                (
                    "MODEL_BASE_URL".into(),
                    Some(format!("http://{address}/v1")),
                ),
                ("MODEL_NAME".into(), Some("saved-admin-model".into())),
                ("MODEL_API_KEY".into(), Some("local-test-key".into())),
            ]),
        )
        .await
        .unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 8192];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&chunk[..count]);
            if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..end]);
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse().unwrap())
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"根据你的目标，先练习所有权与借用；以下是解释与练习草稿。"}}]}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
    });
    let todo = repo
        .create_todo(
            &user,
            CreateTodo {
                title: "学习Rust所有权".into(),
                description: Some("我刚开始学习".into()),
                kind: Some("learning".into()),
                due_at: None,
                estimated_minutes: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    repo.prepare_todo(&user, &todo.id, PrepareTodo::default())
        .await
        .unwrap();
    // This agent endpoint is deliberately closed. Any tool-agent execution fails the test.
    let agent = AgentClient::new(
        "http://127.0.0.1:1",
        "test-only-internal-token-00000000000000".into(),
        "unused-agent".into(),
    )
    .unwrap();
    let engine = WorkerEngine::new(repo.clone(), ModelProvider::local())
        .with_agent(Some(agent))
        .with_settings(settings);
    let claim = engine.claim().await.unwrap().unwrap();
    assert!(engine.execute(&claim).await.unwrap());
    let request = server.await.unwrap();
    assert!(request.starts_with("POST /v1/chat/completions"));
    assert!(request.contains("saved-admin-model"));
    assert!(request.contains("不得编造之前学习进度"));
    assert!(!request.contains("\"tools\""));
    let saved = repo.todo(&user, &todo.id).await.unwrap();
    assert!(saved.draft.as_deref().unwrap().contains("解释与练习草稿"));
    assert_eq!(saved.status, "pending");
    assert!(saved.completed_at.is_none());
    let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_runs WHERE user_id=$1")
        .bind(&user)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(runs, 0);
}

#[tokio::test]
async fn todo_preparation_cannot_publish_an_offline_stub_as_a_generated_draft() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("worker-offline-todo@test.invalid", "test", "owner", "UTC")
        .await
        .unwrap()
        .id;
    let todo = repo
        .create_todo(
            &user,
            CreateTodo {
                title: "回复客户".into(),
                description: None,
                kind: Some("communication".into()),
                due_at: None,
                estimated_minutes: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    repo.prepare_todo(&user, &todo.id, PrepareTodo::default())
        .await
        .unwrap();
    let engine = WorkerEngine::new(repo.clone(), ModelProvider::local());
    let claim = engine.claim().await.unwrap().unwrap();
    assert!(engine.execute(&claim).await.is_err());
    let saved = repo.todo(&user, &todo.id).await.unwrap();
    assert!(saved.draft.is_none());
    assert_eq!(saved.status, "pending");
    assert!(saved.completed_at.is_none());
}
