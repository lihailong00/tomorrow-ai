use tomorrow_domain::{Repository, usage::{UsageIdentity, UsageMeasurements, UsageOutcome}};
use sqlx::Row;

#[tokio::test]
async fn cancelled_run_only_allows_exact_previously_dispatched_attempt_to_finish() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo.create_user("usage-agent@test.local", "unused", "fixture", "Asia/Shanghai").await.unwrap().id;
    let ticket = repo.begin_agent_run(&user, "usage-run", "fixture", None, None).await.unwrap();
    let identity = UsageIdentity::new("https://fixture.invalid/v1", "fixture", "fixture", "fixture");
    repo.dispatch_agent_usage(&ticket.id, &ticket.token, 1, identity.clone()).await.unwrap();
    repo.dispatch_agent_usage(&ticket.id, &ticket.token, 1, identity.clone()).await.unwrap();
    repo.cancel_agent_run(&user, &ticket.id).await.unwrap();
    assert!(repo.dispatch_agent_usage(&ticket.id, &ticket.token, 2, identity).await.is_err());
    let outcome = UsageOutcome::new("cancelled", UsageMeasurements { input_tokens: Some(100), output_tokens: Some(7), cache_read_tokens: Some(30), cache_write_tokens: Some(0), ..Default::default() });
    repo.finish_agent_usage(&ticket.id, &ticket.token, 1, outcome.clone()).await.unwrap();
    repo.finish_agent_usage(&ticket.id, &ticket.token, 1, outcome.clone()).await.unwrap();
    assert!(repo.finish_agent_usage(&ticket.id, &"b".repeat(64), 1, outcome.clone()).await.is_err());
    assert!(repo.finish_agent_usage(&ticket.id, &ticket.token, 2, outcome).await.is_err());
    let rows = sqlx::query("SELECT outcome_json FROM usage_requests WHERE user_id=$1").bind(&user).fetch_all(&repo.pool()).await.unwrap();
    assert_eq!(rows.len(), 1);
    let saved: UsageOutcome = serde_json::from_str(&rows[0].get::<String, _>("outcome_json")).unwrap();
    assert_eq!(saved.measurements.input_tokens, Some(100));
}

#[tokio::test]
async fn rotated_generation_counts_real_new_attempt_but_preserves_old_completion() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo.create_user("usage-retry@test.local", "unused", "fixture", "Asia/Shanghai").await.unwrap().id;
    let old = repo.begin_agent_run(&user, "usage-run", "fixture", None, None).await.unwrap();
    let identity = UsageIdentity::new("https://fixture.invalid/v1", "fixture", "fixture", "fixture");
    repo.dispatch_agent_usage(&old.id, &old.token, 1, identity.clone()).await.unwrap();
    repo.finish_agent_run(&old, None, Some("fixture failure")).await.unwrap();
    let new = repo.begin_agent_run(&user, "usage-run", "fixture", None, None).await.unwrap();
    assert_ne!(new.token, old.token);
    assert!(repo.dispatch_agent_usage(&old.id, &old.token, 2, identity.clone()).await.is_err());
    repo.dispatch_agent_usage(&new.id, &new.token, 1, identity).await.unwrap();
    repo.finish_agent_usage(&old.id, &old.token, 1, UsageOutcome::new("failed", UsageMeasurements { input_tokens: Some(2), ..Default::default() })).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usage_requests WHERE user_id=$1").bind(&user).fetch_one(&repo.pool()).await.unwrap();
    assert_eq!(count, 2);
}
