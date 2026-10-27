use serde_json::json;
use tomorrow_domain::{agent::AgentOutput, new_id, DomainError, Repository};

#[tokio::test]
#[ignore = "Requires explicit TEST_DATABASE_URL and a real PostgreSQL server"]
async fn postgres_agent_effects_are_atomic_under_concurrent_callbacks_and_survive_reopen() {
    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL must be explicit");
    assert!(url.starts_with("postgres"));
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user(
            &format!("pi-pg-{}@test.local", new_id()),
            "unused",
            "Pi PG",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let other = repo
        .create_user(
            &format!("pi-pg-other-{}@test.local", new_id()),
            "unused",
            "隔离",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let second = Repository::connect(&url).await.unwrap();
    let run = repo
        .begin_agent_run(&user.id, "pg-effects", "fixture", None, None)
        .await
        .unwrap();
    let args = json!({"title":"并发偏好","content":"喜欢简洁回答","kind":"preference"});
    let (a, b) = tokio::join!(
        repo.execute_agent_tool_at(&run.id, &run.token, "save_memory", args.clone(), Some(1)),
        second.execute_agent_tool_at(&run.id, &run.token, "save_memory", args.clone(), Some(1))
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a["value"]["id"], b["value"]["id"]);
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(repo.memories(&user.id).await.unwrap().len(), 1);
    assert!(repo.memories(&other.id).await.unwrap().is_empty());
    assert!(matches!(
        repo.agent_run(&other.id, &run.id).await,
        Err(DomainError::NotFound)
    ));
    repo.record_agent_event(&run.id, &run.token, 1, "started", &json!({"harness":"pi"}))
        .await
        .unwrap();
    repo.finish_agent_run(&run, None, Some("fixture interruption"))
        .await
        .unwrap();
    drop(repo);
    drop(second);
    let reopened = Repository::connect(&url).await.unwrap();
    let retry = reopened
        .begin_agent_run(&user.id, "pg-effects", "fixture", None, None)
        .await
        .unwrap();
    assert_eq!(retry.id, run.id);
    let result = reopened
        .execute_agent_tool_at(&retry.id, &retry.token, "save_memory", args, Some(1))
        .await
        .unwrap();
    assert_eq!(result["replayed"], true);
    reopened
        .finish_agent_run(
            &retry,
            Some(&AgentOutput {
                content: "完成".into(),
                usage: json!({"total_tokens":1}),
            }),
            None,
        )
        .await
        .unwrap();
    let view = reopened.agent_run(&user.id, &run.id).await.unwrap();
    assert_eq!(view.events.len(), 1);
    assert_eq!(view.operations.len(), 1);
    for id in [&user.id, &other.id] {
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(id)
            .execute(&reopened.pool())
            .await
            .unwrap();
    }
}
