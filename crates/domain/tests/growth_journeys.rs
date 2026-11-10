use serde_json::json;
use tomorrow_domain::*;

async fn setup(url: &str) -> (Repository, String, String) {
    let repo = Repository::connect(url).await.unwrap();
    let key = new_id();
    let a = repo
        .create_user(
            &format!("journey-a-{key}@example.test"),
            "fixture",
            "A",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let b = repo
        .create_user(
            &format!("journey-b-{key}@example.test"),
            "fixture",
            "B",
            "UTC",
        )
        .await
        .unwrap()
        .id;
    (repo, a, b)
}
fn start(version: i64, key: &str) -> StartGrowthJourney {
    StartGrowthJourney {
        goal: "看懂一个Rust借用示例".into(),
        kind: "learning".into(),
        daily_minutes: 15,
        preferences_version: version,
        client_request_id: key.into(),
    }
}
fn command(version: i64, key: &str, action: &str) -> GrowthJourneyCommand {
    GrowthJourneyCommand {
        version,
        client_request_id: key.into(),
        action: action.into(),
    }
}
fn proposal() -> String {
    json!({"steps":[
    {"title":"读一个借用示例","description":"先观察引用如何使用","criterion":"写下一句自己的解释","estimated_minutes":5},
    {"title":"修改一次引用","description":"改一个参数并观察编译结果","criterion":"保存一次修改结果","estimated_minutes":10},
    {"title":"留下一份学习记录","description":"整理自己的代码与解释","criterion":"写出一个仍然困惑的问题","estimated_minutes":5}
]}).to_string()
}
async fn ready(repo: &Repository, user: &str) -> GrowthJourney {
    let pref = repo.growth_preferences(user).await.unwrap();
    let j = repo
        .start_growth_journey(user, start(pref.version, "start-one"))
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    assert_eq!(claim.task.kind, "growth_journey");
    let context = repo.begin_growth_journey(&claim).await.unwrap().unwrap();
    assert!(repo.begin_growth_journey(&claim).await.unwrap().is_none());
    assert!(repo
        .complete_growth_journey(&claim, &context, &proposal())
        .await
        .unwrap());
    repo.growth_journey(user, &j.id).await.unwrap()
}
async fn lifecycle(url: &str) {
    let (repo, a, b) = setup(url).await;
    let journey = ready(&repo, &a).await;
    assert_eq!(journey.steps.len(), 3);
    assert_eq!(journey.completed_steps, 0);
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    assert!(matches!(
        repo.growth_journey(&b, &journey.id).await,
        Err(DomainError::NotFound)
    ));
    let first = &journey.steps[0];
    let second = &journey.steps[1];
    assert!(repo
        .start_growth_step(
            &a,
            &journey.id,
            &second.id,
            DailyItemCommand {
                version: second.version,
                client_request_id: "too-early".into()
            }
        )
        .await
        .is_err());
    assert!(repo
        .command_growth_step(
            &a,
            &journey.id,
            &second.id,
            command(second.version, "skip-future", "skip")
        )
        .await
        .is_err());
    let input = DailyItemCommand {
        version: first.version,
        client_request_id: "start-first".into(),
    };
    let todo = repo
        .start_growth_step(&a, &journey.id, &first.id, input)
        .await
        .unwrap();
    assert_eq!(todo.source_kind, "growth_journey");
    let same = repo
        .start_growth_step(
            &a,
            &journey.id,
            &first.id,
            DailyItemCommand {
                version: first.version,
                client_request_id: "start-first".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(same.id, todo.id);
    let other = repo
        .start_growth_step(
            &a,
            &journey.id,
            &first.id,
            DailyItemCommand {
                version: first.version,
                client_request_id: "double-tap".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(other.id, todo.id);
    let pending = repo.growth_journey(&a, &journey.id).await.unwrap();
    assert_eq!(pending.completed_steps, 0);
    let done = repo
        .update_todo(
            &a,
            &todo.id,
            UpdateTodo {
                version: todo.version,
                status: Some("completed".into()),
                progress_notes: Some(Some("我自己写下的一句话".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let progress = repo.growth_journey(&a, &journey.id).await.unwrap();
    assert_eq!(progress.completed_steps, 1);
    assert_eq!(progress.steps[1].status, "current");
    let score = repo.growth_summary(&a).await.unwrap().total_xp;
    assert_eq!(score, 10);
    let rated = repo
        .command_growth_step(
            &a,
            &journey.id,
            &first.id,
            command(progress.steps[0].version, "rate-first", "just_right"),
        )
        .await
        .unwrap();
    assert_eq!(rated.steps[0].difficulty.as_deref(), Some("just_right"));
    let skipped = repo
        .command_growth_step(
            &a,
            &journey.id,
            &second.id,
            command(rated.steps[1].version, "skip-second", "skip"),
        )
        .await
        .unwrap();
    assert_eq!(skipped.skipped_steps, 1);
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, score);
    assert!(repo
        .start_growth_step(
            &a,
            &journey.id,
            &second.id,
            DailyItemCommand {
                version: skipped.steps[1].version,
                client_request_id: "start-skipped".into()
            }
        )
        .await
        .is_err());
    let history = repo.growth_history(&a, "all", 0, 1).await.unwrap();
    assert_eq!(history.action_count, 1);
    assert_eq!(
        history.records[0].note.as_deref(),
        Some("我自己写下的一句话")
    );
    assert_eq!(
        repo.growth_history(&b, "all", 0, 30)
            .await
            .unwrap()
            .action_count,
        0
    );
    repo.update_todo(
        &a,
        &todo.id,
        UpdateTodo {
            version: done.version,
            status: Some("pending".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let undone = repo.growth_journey(&a, &journey.id).await.unwrap();
    assert_eq!(undone.completed_steps, 0);
    assert_eq!(undone.steps[0].status, "current");
    assert_eq!(
        repo.growth_history(&a, "all", 0, 30)
            .await
            .unwrap()
            .action_count,
        0
    );
    repo.command_growth_journey(
        &a,
        &journey.id,
        command(undone.version, "archive-one", "archive"),
    )
    .await
    .unwrap();
    assert!(repo.growth_journeys(&a).await.unwrap().active.is_none());
    assert!(repo.todo(&a, &todo.id).await.is_ok());
}
#[tokio::test]
async fn journey_lifecycle_preserves_owned_todos_and_derives_progress_from_real_completions() {
    lifecycle("sqlite::memory:").await;
}
#[tokio::test]
async fn postgres_journey_lifecycle() {
    if let Ok(url) = std::env::var("TADA_GROWTH_JOURNEY_TEST_DATABASE_URL") {
        lifecycle(&url).await;
    } else {
        eprintln!("PostgreSQL integration not configured");
    }
}
#[tokio::test]
async fn generation_is_fenced_bounded_and_explicitly_retried() {
    let (repo, a, _) = setup("sqlite::memory:").await;
    let one = repo
        .start_growth_journey(&a, start(0, "same-intent"))
        .await
        .unwrap();
    let replay = repo
        .start_growth_journey(&a, start(0, "same-intent"))
        .await
        .unwrap();
    assert_eq!(one.id, replay.id);
    let pref = repo.growth_preferences(&a).await.unwrap();
    assert!(pref.enabled);
    assert_eq!(pref.goals[0].title, one.goal);
    assert!(repo
        .start_growth_journey(&a, start(pref.version, "second-goal"))
        .await
        .is_err());
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    let context = repo.begin_growth_journey(&claim).await.unwrap().unwrap();
    assert!(repo
        .complete_growth_journey(&claim, &context, &json!({"steps":[]}).to_string())
        .await
        .is_err());
    assert!(repo
        .complete_growth_journey(
            &claim,
            &context,
            &proposal().replace("\"estimated_minutes\":5", "\"estimated_minutes\":999")
        )
        .await
        .is_err());
    repo.fail_growth_journey(&claim, "synthetic failure")
        .await
        .unwrap();
    let failed = repo.growth_journey(&a, &one.id).await.unwrap();
    assert!(failed.can_retry);
    let retry = repo
        .command_growth_journey(&a, &one.id, command(failed.version, "one-retry", "retry"))
        .await
        .unwrap();
    let again = repo
        .command_growth_journey(&a, &one.id, command(failed.version, "one-retry", "retry"))
        .await
        .unwrap();
    assert_eq!(retry.version, again.version);
    let claim2 = repo.claim_task(90).await.unwrap().unwrap();
    let _ = repo.begin_growth_journey(&claim2).await.unwrap().unwrap();
    repo.fail_growth_journey(&claim2, "second failure")
        .await
        .unwrap();
    let failed = repo.growth_journey(&a, &one.id).await.unwrap();
    assert!(!failed.can_retry);
    assert!(repo
        .command_growth_journey(
            &a,
            &one.id,
            command(failed.version, "third-attempt", "retry")
        )
        .await
        .is_err());
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}
#[tokio::test]
async fn archive_and_opt_out_reject_late_generation_and_deleted_steps_do_not_respawn() {
    let (repo, a, _) = setup("sqlite::memory:").await;
    let j = repo
        .start_growth_journey(&a, start(0, "one"))
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    let context = repo.begin_growth_journey(&claim).await.unwrap().unwrap();
    repo.command_growth_journey(&a, &j.id, command(j.version, "archive", "archive"))
        .await
        .unwrap();
    assert!(!repo
        .complete_growth_journey(&claim, &context, &proposal())
        .await
        .unwrap());
    let j = ready(&repo, &a).await;
    let first = &j.steps[0];
    let todo = repo
        .start_growth_step(
            &a,
            &j.id,
            &first.id,
            DailyItemCommand {
                version: first.version,
                client_request_id: "begin".into(),
            },
        )
        .await
        .unwrap();
    repo.delete_todo(&a, &todo.id).await.unwrap();
    let deleted = repo.growth_journey(&a, &j.id).await.unwrap();
    assert_eq!(deleted.steps[0].status, "deleted");
    assert!(repo
        .start_growth_step(
            &a,
            &j.id,
            &first.id,
            DailyItemCommand {
                version: deleted.steps[0].version,
                client_request_id: "try-respawn".into()
            }
        )
        .await
        .is_err());
    let pref = repo.growth_preferences(&a).await.unwrap();
    repo.update_growth_preferences(
        &a,
        UpdateGrowthPreferences {
            version: pref.version,
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
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}
#[tokio::test]
async fn history_filters_and_pages_count_all_owned_facts_without_fabricated_notes() {
    let (repo, a, _) = setup("sqlite::memory:").await;
    let _ = repo
        .start_growth_journey(&a, start(0, "history-optin"))
        .await
        .unwrap();
    for n in 0..3 {
        let todo = repo
            .create_todo(
                &a,
                CreateTodo {
                    title: format!("真实行动{n}"),
                    description: None,
                    kind: Some("general".into()),
                    due_at: None,
                    estimated_minutes: None,
                    client_request_id: None,
                },
            )
            .await
            .unwrap();
        repo.update_todo(
            &a,
            &todo.id,
            UpdateTodo {
                version: todo.version,
                status: Some("completed".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    let first = repo.growth_history(&a, "week", 0, 2).await.unwrap();
    let next = repo
        .growth_history(&a, "week", first.next_offset.unwrap(), 2)
        .await
        .unwrap();
    assert_eq!(first.action_count, 3);
    assert_eq!(first.records.len(), 2);
    assert_eq!(next.records.len(), 1);
    assert_eq!(next.next_offset, None);
    assert!(first.records.iter().all(|v| v.note.is_none()));
    for p in ["week", "month", "all"] {
        assert_eq!(
            repo.growth_history(&a, p, 0, 50)
                .await
                .unwrap()
                .action_count,
            3
        );
    }
    assert!(repo.growth_history(&a, "invalid", 0, 30).await.is_err());
    assert!(repo.growth_history(&a, "all", 0, 51).await.is_err());
    assert!(repo.growth_history(&a, "all", -1, 30).await.is_err());
}

#[tokio::test]
async fn completed_routes_unlock_a_factual_souvenir_and_corrections_do_not_displace_a_new_goal() {
    let (repo, a, _) = setup("sqlite::memory:").await;
    let journey = ready(&repo, &a).await;
    let mut first = None;
    for step in &journey.steps {
        let todo = repo
            .start_growth_step(
                &a,
                &journey.id,
                &step.id,
                DailyItemCommand {
                    version: step.version,
                    client_request_id: format!("begin-{}", step.id),
                },
            )
            .await
            .unwrap();
        let done = repo
            .update_todo(
                &a,
                &todo.id,
                UpdateTodo {
                    version: todo.version,
                    status: Some("completed".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if first.is_none() {
            first = Some(done);
        }
    }
    let all = repo.growth_journeys(&a).await.unwrap();
    assert!(all.active.is_none());
    assert_eq!(all.past[0].completed_steps, 3);
    assert!(
        repo.growth_summary(&a)
            .await
            .unwrap()
            .milestones
            .iter()
            .find(|m| m.id == "first_journey")
            .unwrap()
            .unlocked
    );
    let prefs = repo.growth_preferences(&a).await.unwrap();
    let next = repo
        .start_growth_journey(&a, start(prefs.version, "next-real-goal"))
        .await
        .unwrap();
    let old = first.unwrap();
    repo.update_todo(
        &a,
        &old.id,
        UpdateTodo {
            version: old.version,
            status: Some("pending".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        repo.growth_journey(&a, &journey.id).await.unwrap().status,
        "archived"
    );
    assert_eq!(
        repo.growth_journeys(&a).await.unwrap().active.unwrap().id,
        next.id
    );
    assert!(
        !repo
            .growth_summary(&a)
            .await
            .unwrap()
            .milestones
            .iter()
            .find(|m| m.id == "first_journey")
            .unwrap()
            .unlocked
    );
}

#[tokio::test]
async fn skipping_the_whole_route_never_earns_a_completion_badge_or_growth_points() {
    let (repo, a, _) = setup("sqlite::memory:").await;
    let mut j = ready(&repo, &a).await;
    for n in 0..j.steps.len() {
        let step = j.steps[n].clone();
        j = repo
            .command_growth_step(
                &a,
                &j.id,
                &step.id,
                command(step.version, &format!("skip-{n}"), "skip"),
            )
            .await
            .unwrap();
    }
    assert_eq!(j.status, "completed");
    assert_eq!(j.completed_steps, 0);
    assert_eq!(j.skipped_steps, 3);
    let summary = repo.growth_summary(&a).await.unwrap();
    assert_eq!(summary.total_xp, 0);
    assert!(
        !summary
            .milestones
            .iter()
            .find(|m| m.id == "first_journey")
            .unwrap()
            .unlocked
    );
}
