use serde_json::json;
use tomorrow_domain::{DomainError, Repository, agent::AgentOutput, new_id};

async fn journal_recovery_contract(repo: Repository) {
    let user = repo
        .create_user(
            &format!("journal-{}@test.local", new_id()),
            "unused",
            "事件测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let key = format!("journal-{}", new_id());
    let args = json!({"title":"重试保存一次","content":"同一逻辑执行","kind":"fact"});
    let mut previous_token: Option<String> = None;
    let mut run_id: Option<String> = None;
    let mut sequence = 1;
    for attempt in 0..7 {
        let run = repo
            .begin_agent_run(&user.id, &key, "same instruction", None, None)
            .await
            .unwrap();
        if let Some(id) = &run_id {
            assert_eq!(&run.id, id);
        }
        run_id = Some(run.id.clone());
        if let Some(token) = &previous_token {
            assert!(matches!(
                repo.record_agent_event(&run.id, token, sequence, "started", &json!({}))
                    .await,
                Err(DomainError::Forbidden)
            ));
        }
        assert_eq!(repo.next_agent_sequence(&run.id).await.unwrap(), sequence);
        let effect = repo
            .execute_agent_tool_at(&run.id, &run.token, "save_memory", args.clone(), Some(1))
            .await
            .unwrap();
        assert_eq!(effect["replayed"], attempt > 0);
        for event in 0..97 {
            repo.record_agent_event(
                &run.id,
                &run.token,
                sequence,
                if event == 0 { "started" } else { "turn" },
                &json!({"attempt":attempt,"event":event}),
            )
            .await
            .unwrap();
            sequence += 1;
        }
        let trace = repo.agent_run(&user.id, &run.id).await.unwrap();
        assert_eq!(trace.events.len(), ((attempt + 1) * 97).min(500));
        assert_eq!(trace.events.last().unwrap()["sequence"], sequence - 1);
        assert!(
            trace
                .events
                .windows(2)
                .all(|pair| pair[1]["sequence"].as_i64().unwrap()
                    == pair[0]["sequence"].as_i64().unwrap() + 1)
        );
        repo.finish_agent_run(&run, None, Some("transient provider failure"))
            .await
            .unwrap();
        previous_token = Some(run.token);
    }
    let retry = repo
        .begin_agent_run(&user.id, &key, "same instruction", None, None)
        .await
        .unwrap();
    assert_eq!(repo.next_agent_sequence(&retry.id).await.unwrap(), 680);
    repo.record_agent_event(
        &retry.id,
        &retry.token,
        680,
        "started",
        &json!({"healthy":true}),
    )
    .await
    .unwrap();
    repo.record_agent_event(&retry.id, &retry.token, 681, "finished", &json!({}))
        .await
        .unwrap();
    repo.finish_agent_run(
        &retry,
        Some(&AgentOutput {
            content: "已恢复".into(),
            usage: json!({}),
        }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.agent_run(&user.id, &retry.id)
            .await
            .unwrap()
            .events
            .len(),
        500
    );
    assert_eq!(repo.memories(&user.id).await.unwrap().len(), 1);
    assert_eq!(
        repo.agent_run(&user.id, &retry.id)
            .await
            .unwrap()
            .operations
            .len(),
        1
    );
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(&user.id)
        .execute(&repo.pool())
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_retries_keep_bounded_history_and_recover_after_500_lifetime_events() {
    journal_recovery_contract(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
#[ignore = "Requires explicit disposable TEST_DATABASE_URL"]
async fn postgres_retries_keep_bounded_history_and_recover_after_500_lifetime_events() {
    let url = std::env::var("TEST_DATABASE_URL").expect("explicit disposable PostgreSQL URL");
    assert!(url.starts_with("postgres"));
    journal_recovery_contract(Repository::connect(&url).await.unwrap()).await;
}

#[tokio::test]
async fn chat_attempt_limit_sequence_guards_and_pruned_history_recovery() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "journal-budget@test.local",
            "unused",
            "测试",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let first = repo
        .begin_agent_run(&user.id, "budget", "fixture", None, None)
        .await
        .unwrap();
    for sequence in 1..=500 {
        repo.record_agent_event(
            &first.id,
            &first.token,
            sequence,
            "turn",
            &json!({"sequence":sequence}),
        )
        .await
        .unwrap();
    }
    // Delivery retries are accepted exactly once, without consuming more of the budget.
    repo.record_agent_event(
        &first.id,
        &first.token,
        500,
        "turn",
        &json!({"sequence":500}),
    )
    .await
    .unwrap();
    assert!(matches!(
        repo.record_agent_event(
            &first.id,
            &first.token,
            500,
            "turn",
            &json!({"changed":true})
        )
        .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repo.record_agent_event(&first.id, &first.token, 502, "turn", &json!({}))
            .await,
        Err(DomainError::Conflict(_))
    ));
    // Real chat text updates have a larger attempt budget; retention stays 500.
    for sequence in 501..=2500 {
        repo.record_agent_event(&first.id,&first.token,sequence,"turn",&json!({})).await.unwrap();
    }
    assert!(matches!(repo.record_agent_event(&first.id,&first.token,2501,"turn",&json!({})).await,Err(DomainError::Validation(_))));
    repo.finish_agent_run(&first, None, Some("failure"))
        .await
        .unwrap();
    // Recover a cursor from its retained tail without reusing pruned sequences.
    sqlx::query("DELETE FROM agent_event_cursors WHERE run_id=$1")
        .bind(&first.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    let retry = repo
        .begin_agent_run(&user.id, "budget", "fixture", None, None)
        .await
        .unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(repo.next_agent_sequence(&retry.id).await.unwrap(), 2501);
    assert!(matches!(
        repo.record_agent_event(
            &retry.id,
            &retry.token,
            500,
            "turn",
            &json!({"sequence":500})
        )
        .await,
        Err(DomainError::Conflict(_))
    ));
    repo.record_agent_event(&retry.id, &retry.token, 2501, "started", &json!({}))
        .await
        .unwrap();
    assert!(
        repo.record_agent_event(&first.id, &first.token, 502, "turn", &json!({}))
            .await
            .is_err()
    );
    let trace = repo.agent_run(&user.id, &retry.id).await.unwrap();
    assert_eq!(trace.events.len(), 500);
    assert_eq!(trace.events[0]["sequence"], 2002);
    assert_eq!(trace.events.last().unwrap()["sequence"], 2501);
}
