use chrono::Utc;
use sqlx::Row;
use tomorrow_domain::*;

async fn setup() -> (tempfile::TempDir, String, Repository, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("growth.db").to_string_lossy()
    );
    let repository = Repository::connect(&url).await.unwrap();
    let first = repository
        .create_user("growth-a@example.test", "fixture", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let second = repository
        .create_user("growth-b@example.test", "fixture", "乙", "America/New_York")
        .await
        .unwrap();
    (directory, url, repository, first.id, second.id)
}

async fn enable(repo: &Repository, user: &str, enabled: bool) {
    let old = repo.growth_preferences(user).await.unwrap();
    repo.update_growth_preferences(
        user,
        UpdateGrowthPreferences {
            version: old.version,
            enabled: Some(enabled),
            daily_minutes: None,
            use_existing_todos: None,
            goals: None,
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap();
}

async fn create(repo: &Repository, user: &str, kind: &str, title: &str) -> Todo {
    repo.create_todo(
        user,
        CreateTodo {
            title: title.into(),
            description: None,
            kind: Some(kind.into()),
            due_at: None,
            estimated_minutes: None,
            client_request_id: None,
        },
    )
    .await
    .unwrap()
}

async fn status(repo: &Repository, user: &str, todo: &Todo, state: &str) -> Todo {
    repo.update_todo(
        user,
        &todo.id,
        UpdateTodo {
            version: todo.version,
            status: Some(state.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

fn action(todo: &Todo, kind: &str, key: &str) -> ConfirmTodoAction {
    ConfirmTodoAction {
        kind: kind.into(),
        version: todo.version,
        client_request_id: key.into(),
        draft: None,
        actual_minutes: None,
        progress_notes: None,
    }
}

#[tokio::test]
async fn opt_in_has_no_seed_or_retroactive_note_edit_rewards_and_receipts_are_owned() {
    let (_dir, _url, repo, a, b) = setup().await;
    let todo = create(&repo, &a, "general", "开启前已完成").await;
    let todo = status(&repo, &a, &todo, "completed").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    enable(&repo, &a, true).await;
    let summary = repo.growth_summary(&a).await.unwrap();
    assert_eq!(
        (summary.total_xp, summary.level, summary.today.action_count),
        (0, 1, 0)
    );
    let todo = repo
        .update_todo(
            &a,
            &todo.id,
            UpdateTodo {
                version: todo.version,
                progress_notes: Some(Some("只更新旧完成的笔记".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    let todo = status(&repo, &a, &todo, "pending").await;
    let todo = status(&repo, &a, &todo, "completed").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    assert!(matches!(
        repo.growth_reward_state(&b, &todo.id).await,
        Err(DomainError::NotFound)
    ));
    assert_eq!(repo.growth_summary(&b).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn a_reward_failure_rolls_back_the_todo_version_and_completion() {
    let (_dir, _url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let todo = create(&repo, &a, "general", "事务验证").await;
    sqlx::raw_sql("CREATE TRIGGER reject_growth_fact BEFORE INSERT ON growth_events BEGIN SELECT RAISE(ABORT,'synthetic growth failure'); END;")
        .execute(&repo.pool()).await.unwrap();
    let result = repo
        .update_todo(
            &a,
            &todo.id,
            UpdateTodo {
                version: todo.version,
                status: Some("completed".into()),
                ..Default::default()
            },
        )
        .await;
    assert!(result.is_err());
    let current = repo.todo(&a, &todo.id).await.unwrap();
    assert_eq!(
        (
            current.status.as_str(),
            current.version,
            current.completed_at
        ),
        ("pending", todo.version, None)
    );
    let receipt = repo.growth_reward_state(&a, &todo.id).await.unwrap();
    assert!(receipt.reward.is_none());
    assert_eq!(receipt.total_xp, 0);
}

#[tokio::test]
async fn parallel_completion_undo_and_recompletion_keep_one_lifetime_entitlement() {
    let (_dir, url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let todo = create(&repo, &a, "learning", "真实学习行动").await;
    let other = Repository::connect(&url).await.unwrap();
    let first = repo.update_todo(
        &a,
        &todo.id,
        UpdateTodo {
            version: todo.version,
            status: Some("completed".into()),
            ..Default::default()
        },
    );
    let second = other.update_todo(
        &a,
        &todo.id,
        UpdateTodo {
            version: todo.version,
            status: Some("completed".into()),
            ..Default::default()
        },
    );
    let (one, two) = tokio::join!(first, second);
    assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM growth_rewards WHERE user_id=$1 AND todo_id=$2")
            .bind(&a)
            .bind(&todo.id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(count, 1);
    // A synthetic historical timestamp proves redo does not create a fresh day/award.
    sqlx::query("UPDATE growth_rewards SET earned_at=978307200,local_date='2001-01-01',timezone='UTC' WHERE user_id=$1 AND todo_id=$2")
        .bind(&a).bind(&todo.id).execute(&repo.pool()).await.unwrap();
    let current = repo.todo(&a, &todo.id).await.unwrap();
    let undone = status(&repo, &a, &current, "pending").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    enable(&repo, &a, false).await;
    let redone = status(&repo, &a, &undone, "completed").await;
    let receipt = repo
        .growth_reward_state(&a, &redone.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    assert_eq!(
        (
            receipt.xp,
            receipt.local_date.as_str(),
            receipt.timezone.as_str()
        ),
        (10, "2001-01-01", "UTC")
    );
    assert_eq!(receipt.earned_at, "2001-01-01T00:00:00+00:00");
    assert_eq!(repo.growth_summary(&a).await.unwrap().today.xp, 0);
    let off = create(&repo, &a, "general", "关闭时新完成").await;
    let _off = status(&repo, &a, &off, "completed").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
}

async fn focus_fixture(repo: &Repository, user: &str, todos: &[Todo]) {
    let day = Utc::now()
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .date_naive()
        .to_string();
    let plan = new_id();
    sqlx::query("INSERT INTO growth_daily_plans(id,user_id,local_date,timezone,status,context,created_at,updated_at)VALUES($1,$2,$3,'Asia/Shanghai','ready','{}',$4,$4)")
        .bind(&plan).bind(user).bind(day).bind(now()).execute(&repo.pool()).await.unwrap();
    for (index, todo) in todos.iter().enumerate() {
        sqlx::query("INSERT INTO growth_plan_items(id,plan_id,user_id,todo_id,body,status,slot,focus,version,created_at)VALUES($1,$2,$3,$4,'{}','suggested',$5,1,1,$6)")
            .bind(new_id()).bind(&plan).bind(user).bind(&todo.id).bind(index as i64).bind(now()).execute(&repo.pool()).await.unwrap();
    }
}

#[tokio::test]
async fn focus_bonus_is_reserved_once_and_undo_does_not_free_a_second_bonus() {
    let (_dir, url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let first = create(&repo, &a, "general", "重点一").await;
    let second = create(&repo, &a, "general", "重点二").await;
    focus_fixture(&repo, &a, &[first.clone(), second.clone()]).await;
    let other = Repository::connect(&url).await.unwrap();
    let (one, two) = tokio::join!(
        repo.update_todo(
            &a,
            &first.id,
            UpdateTodo {
                version: first.version,
                status: Some("completed".into()),
                ..Default::default()
            }
        ),
        other.update_todo(
            &a,
            &second.id,
            UpdateTodo {
                version: second.version,
                status: Some("completed".into()),
                ..Default::default()
            }
        )
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 30);
    let receipt_one = repo
        .growth_reward_state(&a, &one.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    let receipt_two = repo
        .growth_reward_state(&a, &two.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    let mut points = [receipt_one.xp, receipt_two.xp];
    points.sort();
    assert_eq!(points, [10, 20]);
    let winner = if receipt_one.xp == 20 { one } else { two };
    let undone = status(&repo, &a, &winner, "pending").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    let third = create(&repo, &a, "general", "不能再领重点奖").await;
    // Add a further candidate to the existing synthetic plan, representing defensive input.
    let plan: String = sqlx::query_scalar("SELECT id FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    sqlx::query("INSERT INTO growth_plan_items(id,plan_id,user_id,todo_id,body,status,slot,focus,version,created_at)VALUES($1,$2,$3,$4,'{}','suggested',2,1,1,$5)")
        .bind(new_id()).bind(plan).bind(&a).bind(&third.id).bind(now()).execute(&repo.pool()).await.unwrap();
    let _third = status(&repo, &a, &third, "completed").await;
    let _restored = status(&repo, &a, &undone, "completed").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 40);
}

#[tokio::test]
async fn explicit_reply_is_a_stage_fact_and_generic_waiting_or_later_closure_never_double_awards() {
    let (_dir, _url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let todo = create(&repo, &a, "communication", "回复后等待反馈").await;
    let waiting = status(&repo, &a, &todo, "waiting").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    let replied = repo
        .confirm_todo_action(&a, &todo.id, action(&waiting, "replied", "reply-first"))
        .await
        .unwrap();
    assert_eq!(replied.todo.status, "waiting");
    assert!(replied.actions.replied);
    let receipt = replied.reward.unwrap();
    assert_eq!(receipt.xp, 10);
    let repeated = repo
        .confirm_todo_action(
            &a,
            &todo.id,
            action(&replied.todo, "replied", "reply-second"),
        )
        .await
        .unwrap();
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    assert_eq!(repeated.reward.unwrap().version, receipt.version);
    let closed = status(&repo, &a, &repeated.todo, "completed").await;
    let reopened = status(&repo, &a, &closed, "pending").await;
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    for kind in ["completed", "restored"] {
        let body: String = sqlx::query_scalar("SELECT body FROM growth_events WHERE user_id=$1 AND todo_id=$2 AND event_kind=$3 ORDER BY created_at DESC LIMIT 1")
            .bind(&a).bind(&todo.id).bind(kind).fetch_one(&repo.pool()).await.unwrap();
        let fact: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(fact["xp_delta"], 0);
        assert!(fact.get("draft").is_none());
        assert!(fact.get("progress_notes").is_none());
    }
    let waiting = status(&repo, &a, &reopened, "waiting").await;
    let undone = repo
        .confirm_todo_action(&a, &todo.id, action(&waiting, "undo_replied", "reply-undo"))
        .await
        .unwrap();
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
    let restored = repo
        .confirm_todo_action(&a, &todo.id, action(&undone.todo, "replied", "reply-redo"))
        .await
        .unwrap();
    assert_eq!(
        restored.reward.as_ref().unwrap().earned_at,
        receipt.earned_at
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    repo.delete_todo(&a, &todo.id).await.unwrap();
    let erased = repo
        .growth_reward_state(&a, &todo.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    assert!(!erased.active);
    assert!(erased.title.is_empty());
    assert_eq!(erased.minutes, None);
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn exercise_uses_only_a_typed_actual_duration_and_corrections_preserve_the_receipt() {
    let (_dir, _url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let todo = create(&repo, &a, "exercise", "活动记录").await;
    let todo = repo
        .update_todo(
            &a,
            &todo.id,
            UpdateTodo {
                version: todo.version,
                status: Some("completed".into()),
                progress_notes: Some(Some("实际运动 99 分钟（自行记录）".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        repo.growth_summary(&a).await.unwrap().week.exercise_minutes,
        0
    );
    let mut todo = status(&repo, &a, &todo, "pending").await;
    for invalid in [0, 361, 1000] {
        let mut input = action(&todo, "exercise_completed", &format!("invalid-{invalid}"));
        input.actual_minutes = Some(invalid);
        assert!(repo.confirm_todo_action(&a, &todo.id, input).await.is_err());
        assert_eq!(repo.todo(&a, &todo.id).await.unwrap().version, todo.version);
    }
    let mut input = action(&todo, "exercise_completed", "exercise-first");
    input.actual_minutes = Some(23);
    input.progress_notes = Some(Some("普通笔记，不能作为分钟来源".into()));
    let completed = repo.confirm_todo_action(&a, &todo.id, input).await.unwrap();
    todo = completed.todo;
    assert_eq!(
        repo.growth_summary(&a).await.unwrap().week.exercise_minutes,
        23
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
    let mut input = action(&todo, "exercise_completed", "exercise-corrected");
    input.actual_minutes = Some(30);
    let corrected = repo.confirm_todo_action(&a, &todo.id, input).await.unwrap();
    assert_eq!(
        repo.growth_summary(&a).await.unwrap().week.exercise_minutes,
        30
    );
    assert_eq!(
        corrected.reward.as_ref().unwrap().earned_at,
        completed.reward.as_ref().unwrap().earned_at
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 10);
}

#[tokio::test]
async fn exercise_action_json_notes_preserve_clear_and_replace_without_minting_rewards() {
    let (_dir, _url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    let original = create(&repo, &a, "exercise", "有活动笔记的待办").await;
    let mut current = repo
        .update_todo(
            &a,
            &original.id,
            UpdateTodo {
                version: original.version,
                progress_notes: Some(Some("先前保留的活动笔记".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(current.progress_notes.is_some());
    let mut receipt: Option<GrowthReward> = None;
    for (key, notes_field, expected) in [
        ("notes-null", Some(serde_json::Value::Null), None),
        ("notes-omitted-empty", None, None),
        (
            "notes-string",
            Some(serde_json::json!("今天走路后状态很好")),
            Some("今天走路后状态很好"),
        ),
        ("notes-omitted-retained", None, Some("今天走路后状态很好")),
    ] {
        let mut wire_input = serde_json::json!({
            "kind":"exercise_completed",
            "version":current.version,
            "client_request_id":key,
            "actual_minutes":16
        });
        if let Some(notes) = notes_field {
            wire_input["progress_notes"] = notes;
        }
        let input: ConfirmTodoAction = serde_json::from_value(wire_input).unwrap();
        let result = repo
            .confirm_todo_action(&a, &current.id, input)
            .await
            .unwrap();
        current = repo.todo(&a, &current.id).await.unwrap();
        assert_eq!(current.progress_notes.as_deref(), expected, "{key}");
        assert_eq!(result.todo.progress_notes, current.progress_notes);
        let reward = result.reward.unwrap();
        if let Some(first) = &receipt {
            assert_eq!(
                (&reward.id, &reward.earned_at, reward.xp),
                (&first.id, &first.earned_at, first.xp),
                "notes corrections must preserve the one lifetime receipt"
            );
        } else {
            receipt = Some(reward);
        }
        let summary = repo.growth_summary(&a).await.unwrap();
        assert_eq!(summary.total_xp, 10, "{key}");
        assert_eq!(summary.today.action_count, 1, "{key}");
        assert_eq!(summary.week.exercise_minutes, 16, "{key}");
    }
    let receipts: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM growth_rewards WHERE user_id=$1 AND todo_id=$2")
            .bind(&a)
            .bind(&current.id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(receipts, 1);
}

#[tokio::test]
async fn summary_totals_are_not_limited_by_the_hundred_record_preview() {
    let (_dir, _url, repo, a, _b) = setup().await;
    enable(&repo, &a, true).await;
    for n in 0..101 {
        let todo = create(&repo, &a, "learning", &format!("真实确认学习 {n}")).await;
        let _todo = status(&repo, &a, &todo, "completed").await;
    }
    let summary = repo.growth_summary(&a).await.unwrap();
    assert_eq!(summary.week.records.len(), 100);
    assert_eq!(summary.week.learning_actions, 101);
    assert_eq!(summary.today.action_count, 101);
    assert_eq!(summary.total_xp, 1010);
    assert_eq!((summary.level, summary.level_xp), (17, 50));
    let row = sqlx::query("SELECT COUNT(*) AS n FROM growth_rewards WHERE user_id=$1 AND active=1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("n"), 101);
}

#[tokio::test]
#[ignore = "Requires explicit disposable localhost growth_qa_* PostgreSQL database; no model/SMS calls"]
async fn postgres_growth_reward_transactions_and_summary_types() {
    let url = std::env::var("GROWTH_REWARDS_TEST_DATABASE_URL")
        .expect("set GROWTH_REWARDS_TEST_DATABASE_URL to a disposable local growth_qa_* database");
    let parsed = reqwest::Url::parse(&url).unwrap();
    assert!(matches!(parsed.scheme(), "postgres" | "postgresql"));
    assert!(matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    ));
    assert!(parsed
        .path()
        .trim_start_matches('/')
        .starts_with("growth_qa_"));
    let repo = Repository::connect(&url).await.unwrap();
    let token = new_id();
    let a = repo
        .create_user(
            &format!("pg-growth-{token}@example.test"),
            "fixture",
            "PG甲",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let b = repo
        .create_user(
            &format!("pg-other-{token}@example.test"),
            "fixture",
            "PG乙",
            "UTC",
        )
        .await
        .unwrap()
        .id;
    enable(&repo, &a, true).await;
    let first = create(&repo, &a, "learning", "PG重点一").await;
    let second = create(&repo, &a, "general", "PG重点二").await;
    focus_fixture(&repo, &a, &[first.clone(), second.clone()]).await;
    let peer = Repository::connect(&url).await.unwrap();
    let (one, two) = tokio::join!(
        repo.update_todo(
            &a,
            &first.id,
            UpdateTodo {
                version: first.version,
                status: Some("completed".into()),
                ..Default::default()
            }
        ),
        peer.update_todo(
            &a,
            &second.id,
            UpdateTodo {
                version: second.version,
                status: Some("completed".into()),
                ..Default::default()
            }
        )
    );
    let one = one.unwrap();
    two.unwrap();
    let summary = repo.growth_summary(&a).await.unwrap();
    assert_eq!(
        (
            summary.total_xp,
            summary.today.action_count,
            summary.week.learning_actions
        ),
        (30, 2, 1)
    );
    assert_eq!(summary.week.records.len(), 2);
    assert!(matches!(
        repo.growth_reward_state(&b, &first.id).await,
        Err(DomainError::NotFound)
    ));
    let exercise = create(&repo, &a, "exercise", "PG明确活动记录").await;
    let mut input = action(
        &exercise,
        "exercise_completed",
        &format!("exercise-{token}"),
    );
    input.actual_minutes = Some(21);
    repo.confirm_todo_action(&a, &exercise.id, input)
        .await
        .unwrap();
    let summary = repo.growth_summary(&a).await.unwrap();
    assert_eq!(summary.total_xp, 40);
    assert_eq!(summary.week.exercise_minutes, 21);
    let sunrise = repo
        .update_growth_preferences(
            &a,
            UpdateGrowthPreferences {
                version: repo.growth_preferences(&a).await.unwrap().version,
                enabled: None,
                daily_minutes: None,
                use_existing_todos: None,
                goals: None,
                paused_today: None,
                halo: Some("sunrise".into()),
            },
        )
        .await;
    assert!(matches!(sunrise, Err(DomainError::Validation(_))));
    let before = repo
        .growth_reward_state(&a, &one.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    let undone = status(&repo, &a, &one, "pending").await;
    let _redo = status(&repo, &a, &undone, "completed").await;
    let after = repo
        .growth_reward_state(&a, &one.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    assert_eq!(
        (after.xp, after.earned_at, after.local_date),
        (before.xp, before.earned_at, before.local_date)
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 40);
    // Remove only the two users this test created, never reset the shared database.
    sqlx::query("DELETE FROM users WHERE id=$1 OR id=$2")
        .bind(&a)
        .bind(&b)
        .execute(&repo.pool())
        .await
        .unwrap();
}
