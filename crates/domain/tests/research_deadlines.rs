use serde_json::json;
use sqlx::Row;
use tomorrow_domain::{
    agent::{
        AgentOutput, AGENT_EXECUTION_TIMEOUT_SECONDS, AGENT_HTTP_TIMEOUT_SECONDS,
        AGENT_RUN_LEASE_SECONDS,
    },
    chat_stream::CHAT_STREAM_LIFETIME_SECONDS,
    new_id, now, CreateTask, DomainError, Repository,
};

async fn fixture() -> (Repository, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user(
            &format!("research-{}@example.test", new_id()),
            "unused",
            "Synthetic research",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    (repo, owner.id)
}

#[tokio::test]
async fn research_authority_survives_old_deadline_but_cancel_and_expiry_still_revoke_it() {
    let (repo, owner) = fixture().await;
    let run = repo
        .begin_agent_run(&owner, "research-duration", "synthetic", None, None)
        .await
        .unwrap();
    let row = sqlx::query("SELECT created_at,lease_until FROM agent_runs WHERE id=$1")
        .bind(&run.id)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    let duration = row.get::<i64, _>("lease_until") - row.get::<i64, _>("created_at");
    assert!((AGENT_RUN_LEASE_SECONDS - 1..=AGENT_RUN_LEASE_SECONDS).contains(&duration));
    assert!(AGENT_HTTP_TIMEOUT_SECONDS > AGENT_EXECUTION_TIMEOUT_SECONDS);
    assert!(CHAT_STREAM_LIFETIME_SECONDS > AGENT_HTTP_TIMEOUT_SECONDS);
    assert!(AGENT_RUN_LEASE_SECONDS > CHAT_STREAM_LIFETIME_SECONDS as i64);

    // Simulate a persisted run older than the previous150s deadline, without sleeping.
    let started = now() - 180;
    sqlx::query("UPDATE agent_runs SET created_at=$1,updated_at=$1,lease_until=$2 WHERE id=$3")
        .bind(started)
        .bind(started + duration)
        .bind(&run.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        repo.agent_authority(&run.id, &run.token).await.unwrap().0,
        owner
    );
    repo.record_agent_event(
        &run.id,
        &run.token,
        1,
        "turn",
        &json!({"after_old_deadline":true}),
    )
    .await
    .unwrap();
    repo.finish_agent_run(
        &run,
        Some(&AgentOutput {
            content: "Finished".into(),
            usage: json!({}),
        }),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        repo.agent_run(&owner, &run.id).await.unwrap().status,
        "succeeded"
    );

    let cancelled = repo
        .begin_agent_run(&owner, "cancel-research", "synthetic", None, None)
        .await
        .unwrap();
    repo.cancel_agent_run(&owner, &cancelled.id).await.unwrap();
    assert!(matches!(
        repo.agent_authority(&cancelled.id, &cancelled.token).await,
        Err(DomainError::Forbidden)
    ));
    assert!(repo
        .record_agent_event(&cancelled.id, &cancelled.token, 1, "turn", &json!({}))
        .await
        .is_err());

    let expired = repo
        .begin_agent_run(&owner, "expired-research", "synthetic", None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE agent_runs SET lease_until=$1 WHERE id=$2")
        .bind(now() - 1)
        .bind(&expired.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(matches!(
        repo.agent_authority(&expired.id, &expired.token).await,
        Err(DomainError::Forbidden)
    ));
    assert!(repo
        .finish_agent_run(&expired, None, Some("late"))
        .await
        .is_err());
}

#[tokio::test]
async fn long_chat_remains_reattachable_without_duplicate_producer_then_expires() {
    let (repo, owner) = fixture().await;
    let request = new_id();
    let producer = repo
        .begin_chat_stream(&owner, &request, "same input")
        .await
        .unwrap()
        .unwrap();
    let row = sqlx::query("SELECT created_at,lease_until FROM chat_streams WHERE request_key=$1")
        .bind(&producer.request_key)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    let duration = row.get::<i64, _>("lease_until") - row.get::<i64, _>("created_at");
    let expected = CHAT_STREAM_LIFETIME_SECONDS as i64 + 5;
    assert!((expected - 1..=expected).contains(&duration));
    let started = now() - 180;
    sqlx::query(
        "UPDATE chat_streams SET created_at=$1,updated_at=$1,lease_until=$2 WHERE request_key=$3",
    )
    .bind(started)
    .bind(started + duration)
    .bind(&producer.request_key)
    .execute(&repo.pool())
    .await
    .unwrap();
    repo.append_chat_stream_delta(&producer, "Progress after old deadline".into())
        .await
        .unwrap();
    assert!(repo
        .begin_chat_stream_retry(&owner, &request, "same input", true)
        .await
        .unwrap()
        .is_none());
    let view = repo.chat_stream(&owner, &request).await.unwrap();
    assert_eq!(view.status, "running");
    assert_eq!(view.content, "Progress after old deadline");
    assert_eq!(view.attempt, 1);
    sqlx::query("UPDATE chat_streams SET lease_until=$1 WHERE request_key=$2")
        .bind(now() - 1)
        .bind(&producer.request_key)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        repo.chat_stream(&owner, &request).await.unwrap().status,
        "interrupted"
    );
    assert!(repo
        .append_chat_stream_delta(&producer, "stale".into())
        .await
        .is_err());
    let replacement = repo
        .begin_chat_stream_retry(&owner, &request, "same input", true)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(producer.attempt_token, replacement.attempt_token);
    repo.interrupt_chat_stream(&replacement, "fixture complete")
        .await
        .unwrap();
}

#[tokio::test]
async fn one_hundred_searches_and_reads_fit_the_task_journal_without_unbounded_retention() {
    let (repo, owner) = fixture().await;
    let task = repo
        .create_task(
            &owner,
            CreateTask {
                instruction: "Synthetic research".into(),
                title: None,
                kind: None,
                approval_required: Some(false),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    assert_eq!(claim.task.id, task.id);
    let run = repo
        .begin_agent_run(
            &owner,
            "research-tools",
            "synthetic",
            None,
            Some((&task.id, claim.attempt)),
        )
        .await
        .unwrap();
    let mut sequence = 1;
    repo.record_agent_event(&run.id, &run.token, sequence, "started", &json!({}))
        .await
        .unwrap();
    sequence += 1;
    for index in 0..200 {
        let tool = if index < 100 {
            "web_search"
        } else {
            "web_fetch"
        };
        for (kind, body) in [
            ("turn", json!({"turn":index+1})),
            (
                "tool_start",
                json!({"tool":tool,"tool_call_id":format!("fixture-{index}")}),
            ),
            (
                "tool_end",
                json!({"tool":tool,"tool_call_id":format!("fixture-{index}"),"is_error":false}),
            ),
        ] {
            repo.record_agent_event(&run.id, &run.token, sequence, kind, &body)
                .await
                .unwrap();
            sequence += 1;
        }
    }
    for kind in ["turn", "finished"] {
        repo.record_agent_event(&run.id, &run.token, sequence, kind, &json!({}))
            .await
            .unwrap();
        sequence += 1;
    }
    assert_eq!(sequence - 1, 603);
    let trace = repo.agent_run(&owner, &run.id).await.unwrap();
    assert_eq!(trace.events.len(), 500);
    assert_eq!(trace.events.first().unwrap()["sequence"], 104);
    assert_eq!(trace.events.last().unwrap()["sequence"], 603);
    repo.finish_agent_run(
        &run,
        Some(&AgentOutput {
            content: "Done".into(),
            usage: json!({"web_search_requests":100,"web_fetch_requests":100}),
        }),
        None,
    )
    .await
    .unwrap();
}
