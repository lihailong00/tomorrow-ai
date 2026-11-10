use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tomorrow_domain::*;
use tomorrow_worker::WorkerEngine;

#[tokio::test]
async fn native_worker_prepares_one_real_route_from_mock_model_without_completing_a_todo() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = vec![];
        let request = loop {
            let mut chunk = [0; 4096];
            let n = stream.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&bytes[..end])
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break serde_json::from_slice::<serde_json::Value>(
                        &bytes[end + 4..end + 4 + length],
                    )
                    .unwrap();
                }
            }
        };
        assert!(request["messages"].to_string().contains("测试Rust借用目标"));
        assert!(request["messages"].to_string().contains("不承诺几天精通"));
        let content=json!({"steps":(0..3).map(|n|json!({"title":format!("借用练习{n}"),"description":"运行一个小示例并修改一次","criterion":"留下自己的解释和代码","estimated_minutes":5})).collect::<Vec<_>>()}).to_string();
        let body =
            json!({"choices":[{"message":{"role":"assistant","content":content}}]}).to_string();
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
    });
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("journey-worker@example.test", "fixture", "A", "UTC")
        .await
        .unwrap()
        .id;
    let j = repo
        .start_growth_journey(
            &user,
            StartGrowthJourney {
                goal: "测试Rust借用目标".into(),
                kind: "learning".into(),
                daily_minutes: 15,
                preferences_version: 0,
                client_request_id: "worker-route".into(),
            },
        )
        .await
        .unwrap();
    let provider = ModelProvider::from_lookup(|key| match key {
        "MODEL_BASE_URL" => Some(format!("http://{address}")),
        "MODEL_API_KEY" => Some("fixture".into()),
        "MODEL_NAME" => Some("fixture".into()),
        _ => None,
    });
    let worker = WorkerEngine::new(repo.clone(), provider);
    let claim = worker.claim().await.unwrap().unwrap();
    assert!(worker.execute(&claim).await.unwrap());
    upstream.await.unwrap();
    let saved = repo.growth_journey(&user, &j.id).await.unwrap();
    assert_eq!(saved.status, "ready");
    assert_eq!(saved.steps.len(), 3);
    assert!(saved.steps.iter().all(|s| s.todo.is_none()));
    assert_eq!(saved.completed_steps, 0);
    assert_eq!(repo.growth_summary(&user).await.unwrap().total_xp, 0);
    assert!(worker.claim().await.unwrap().is_none());
}
#[tokio::test]
async fn an_unconfigured_worker_never_invents_a_route_or_automatically_retries_paid_generation() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("journey-offline@example.test", "fixture", "A", "UTC")
        .await
        .unwrap()
        .id;
    let j = repo
        .start_growth_journey(
            &user,
            StartGrowthJourney {
                goal: "学习一小步".into(),
                kind: "learning".into(),
                daily_minutes: 5,
                preferences_version: 0,
                client_request_id: "offline".into(),
            },
        )
        .await
        .unwrap();
    let worker = WorkerEngine::new(repo.clone(), ModelProvider::from_lookup(|_| None));
    let claim = worker.claim().await.unwrap().unwrap();
    assert!(!worker.execute(&claim).await.unwrap());
    assert!(worker.claim().await.unwrap().is_none());
    let saved = repo.growth_journey(&user, &j.id).await.unwrap();
    assert_eq!(saved.status, "failed");
    assert!(saved.steps.is_empty());
    assert_eq!(repo.growth_summary(&user).await.unwrap().total_xp, 0);
}
