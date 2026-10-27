use sqlx::Row;
use tomorrow_domain::*;

fn patch(value: serde_json::Value) -> UpdateSchedule {
    serde_json::from_value(value).unwrap()
}

async fn owner(repo: &Repository) -> String {
    repo.create_user(&format!("schedule-patch-{}@qa.test", new_id()), "test", "Schedule", "UTC")
        .await.unwrap().id
}

async fn schedule(repo: &Repository, user: &str, frequency: &str) -> Schedule {
    repo.create_schedule(user, CreateSchedule {
        title: "Original title".into(), instruction: "Original instruction".into(),
        frequency: frequency.into(), time: "09:00".into(), timezone: "UTC".into(),
        enabled: Some(true), client_request_id: None,
    }).await.unwrap()
}

async fn set_due(repo: &Repository, id: &str, due: i64) {
    sqlx::query("UPDATE schedules SET next_run_at=$1,last_run_at=NULL WHERE id=$2")
        .bind(due).bind(id).execute(&repo.pool()).await.unwrap();
}

async fn check_overdue_metadata(repo: &Repository) {
    let user = owner(repo).await;
    for frequency in ["once", "daily", "weekly", "weekdays"] {
        let plan = schedule(repo, &user, frequency).await;
        let due = now() - 15 * 86400;
        set_due(repo, &plan.id, due).await;
        for body in [
            serde_json::json!({"title":"Renamed plan"}),
            serde_json::json!({"instruction":"Revised instruction"}),
            serde_json::json!({"frequency":frequency,"time":"09:00","timezone":"UTC","enabled":true}),
            serde_json::json!({"title":null,"instruction":null,"enabled":null}),
            serde_json::json!({}),
        ] {
            let updated = repo.update_schedule(&user, &plan.id, patch(body)).await.unwrap();
            assert_eq!(updated.next_run_at, timestamp(due), "{frequency} lost its due occurrence");
            assert!(updated.enabled);
            assert_eq!(updated.last_run_at, None);
        }
        let row = sqlx::query("SELECT * FROM schedules WHERE id=$1").bind(&plan.id)
            .fetch_one(&repo.pool()).await.unwrap();
        assert_eq!(row.get::<i64, _>("next_run_at"), due);
        assert_eq!(row.get::<Option<i64>, _>("last_run_at"), None);
        assert_eq!(row.get::<String, _>("title"), "Renamed plan");
        assert_eq!(row.get::<String, _>("prompt"), "Revised instruction");
        repo.tick_schedules().await.unwrap();
        let tasks = sqlx::query("SELECT title,prompt,idempotency_key FROM tasks WHERE schedule_id=$1")
            .bind(&plan.id).fetch_all(&repo.pool()).await.unwrap();
        assert_eq!(tasks.len(), 1, "{frequency} overdue edit did not dispatch exactly once");
        assert_eq!(tasks[0].get::<String, _>("title"), "Renamed plan");
        assert_eq!(tasks[0].get::<String, _>("prompt"), "Revised instruction");
        assert_eq!(tasks[0].get::<String, _>("idempotency_key"), format!("schedule:{}:{due}", plan.id));
        let consumed = repo.schedule(&user, &plan.id).await.unwrap();
        assert_eq!(consumed.enabled, frequency != "once");
        assert!(consumed.last_run_at.is_some());
        assert!(chrono::DateTime::parse_from_rfc3339(&consumed.next_run_at).unwrap().timestamp() > now());
        repo.update_schedule(&user, &plan.id, patch(serde_json::json!({"title":"After dispatch"}))).await.unwrap();
        let after_edit = repo.schedule(&user, &plan.id).await.unwrap();
        assert_eq!(after_edit.next_run_at, consumed.next_run_at);
        assert_eq!(after_edit.enabled, consumed.enabled);
        assert_eq!(after_edit.last_run_at, consumed.last_run_at);
        repo.tick_schedules().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE schedule_id=$1")
            .bind(&plan.id).fetch_one(&repo.pool()).await.unwrap();
        assert_eq!(count, 1);
        repo.delete_schedule(&user, &plan.id).await.unwrap();
    }
}

async fn check_pause_resume_and_timing(repo: &Repository) {
    let user = owner(repo).await;
    for frequency in ["once", "daily", "weekly", "weekdays"] {
        let plan = schedule(repo, &user, frequency).await;
        let due = now() - 15 * 86400;
        set_due(repo, &plan.id, due).await;
        let paused = repo.update_schedule(&user, &plan.id, patch(serde_json::json!({"enabled":false}))).await.unwrap();
        assert!(!paused.enabled);
        assert_eq!(paused.next_run_at, timestamp(due));
        for body in [serde_json::json!({"title":"Paused rename"}), serde_json::json!({"enabled":false})] {
            let edited = repo.update_schedule(&user, &plan.id, patch(body)).await.unwrap();
            assert!(!edited.enabled);
            assert_eq!(edited.next_run_at, timestamp(due));
        }
        repo.tick_schedules().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE schedule_id=$1")
            .bind(&plan.id).fetch_one(&repo.pool()).await.unwrap();
        assert_eq!(count, 0, "paused {frequency} dispatched");
        let before = now();
        let resumed = repo.update_schedule(&user, &plan.id, patch(serde_json::json!({"enabled":true}))).await.unwrap();
        let expected = if frequency == "weekly" {
            tomorrow_domain::repository::next_weekly_execution("09:00", "UTC", due, before).unwrap()
        } else {
            tomorrow_domain::repository::next_execution(frequency, "09:00", "UTC", before, false).unwrap()
        };
        assert!(resumed.enabled);
        assert_eq!(resumed.next_run_at, timestamp(expected));
        set_due(repo, &plan.id, due).await;
        let changed = repo.update_schedule(&user, &plan.id, patch(serde_json::json!({"time":"10:30"}))).await.unwrap();
        let expected = if frequency == "weekly" {
            tomorrow_domain::repository::next_weekly_execution("10:30", "UTC", due, now()).unwrap()
        } else {
            tomorrow_domain::repository::next_execution(frequency, "10:30", "UTC", now(), false).unwrap()
        };
        assert_eq!(changed.next_run_at, timestamp(expected));
        assert_eq!(changed.title, "Paused rename");
        repo.delete_schedule(&user, &plan.id).await.unwrap();
    }
}

async fn check_concurrent_patches(first: &Repository, second: &Repository) {
    let user = owner(first).await;
    for iteration in 0..32 {
        let plan = schedule(first, &user, "once").await;
        let due = now() - 120;
        set_due(first, &plan.id, due).await;
        let title = format!("Concurrent rename {iteration}");
        let (pause, rename) = tokio::join!(
            first.update_schedule(&user, &plan.id, patch(serde_json::json!({"enabled":false}))),
            second.update_schedule(&user, &plan.id, patch(serde_json::json!({"title":title}))),
        );
        pause.unwrap(); rename.unwrap();
        let persisted = first.schedule(&user, &plan.id).await.unwrap();
        assert!(!persisted.enabled, "rename undid pause on trial {iteration}");
        assert_eq!(persisted.title, title, "pause undid rename on trial {iteration}");
        assert_eq!(persisted.next_run_at, timestamp(due));
        assert_eq!(persisted.last_run_at, None);
        first.tick_schedules().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE schedule_id=$1")
            .bind(&plan.id).fetch_one(&first.pool()).await.unwrap();
        assert_eq!(count, 0);
        let (resume, edit) = tokio::join!(
            first.update_schedule(&user, &plan.id, patch(serde_json::json!({"enabled":true}))),
            second.update_schedule(&user, &plan.id, patch(serde_json::json!({"instruction":"Concurrent instruction"}))),
        );
        resume.unwrap(); edit.unwrap();
        let persisted = first.schedule(&user, &plan.id).await.unwrap();
        assert!(persisted.enabled);
        assert_eq!(persisted.title, title);
        assert_eq!(persisted.instruction, "Concurrent instruction");
        assert!(chrono::DateTime::parse_from_rfc3339(&persisted.next_run_at).unwrap().timestamp() > now());
        first.delete_schedule(&user, &plan.id).await.unwrap();
    }
    // A dispatcher and metadata editor may win in either order. Neither may
    // restore the consumed once occurrence or produce a duplicate task.
    for _ in 0..16 {
        let plan = schedule(first, &user, "once").await;
        let due = now() - 120;
        set_due(first, &plan.id, due).await;
        let (dispatch, edit) = tokio::join!(
            first.tick_schedules(),
            second.update_schedule(&user, &plan.id, patch(serde_json::json!({"title":"Racing dispatch"}))),
        );
        dispatch.unwrap(); edit.unwrap();
        first.tick_schedules().await.unwrap();
        let persisted = first.schedule(&user, &plan.id).await.unwrap();
        assert!(!persisted.enabled);
        assert_eq!(persisted.title, "Racing dispatch");
        assert!(persisted.last_run_at.is_some());
        let keys = sqlx::query("SELECT idempotency_key FROM tasks WHERE schedule_id=$1")
            .bind(&plan.id).fetch_all(&first.pool()).await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].get::<String, _>("idempotency_key"), format!("schedule:{}:{due}", plan.id));
        first.delete_schedule(&user, &plan.id).await.unwrap();
    }
}

#[tokio::test]
async fn sqlite_schedule_partial_patches_preserve_occurrences_and_concurrent_fields() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}", directory.path().join("schedules.db").to_string_lossy());
    let first = Repository::connect(&url).await.unwrap();
    let second = Repository::connect(&url).await.unwrap();
    check_overdue_metadata(&first).await;
    check_pause_resume_and_timing(&first).await;
    check_concurrent_patches(&first, &second).await;
}

#[tokio::test]
async fn postgres_schedule_partial_patches_preserve_occurrences_and_concurrent_fields() {
    let Ok(url) = std::env::var("TEST_E07_DATABASE_URL") else { return; };
    assert!(url.starts_with("postgres") && url.split('?').next().unwrap().ends_with("/tada_qa_e07"),
        "E07 requires its dedicated disposable database");
    let first = Repository::connect(&url).await.unwrap();
    let second = Repository::connect(&url).await.unwrap();
    check_overdue_metadata(&first).await;
    check_pause_resume_and_timing(&first).await;
    check_concurrent_patches(&first, &second).await;
}
