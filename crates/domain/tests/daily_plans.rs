use chrono::Timelike;
use serde_json::{json, Value};
use sqlx::Row;
use tomorrow_domain::*;

async fn setup() -> (tempfile::TempDir, String, Repository, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("daily-plans.db").to_string_lossy()
    );
    let repo = Repository::connect(&url).await.unwrap();
    let a = repo
        .create_user("daily-a@example.test", "fixture", "甲", "Asia/Shanghai")
        .await
        .unwrap()
        .id;
    let b = repo
        .create_user("daily-b@example.test", "fixture", "乙", "UTC")
        .await
        .unwrap()
        .id;
    (directory, url, repo, a, b)
}

async fn configure(repo: &Repository, user: &str, use_existing: bool) -> GrowthPreferences {
    let old = repo.growth_preferences(user).await.unwrap();
    repo.update_growth_preferences(
        user,
        UpdateGrowthPreferences {
            version: old.version,
            enabled: Some(true),
            daily_minutes: Some(15),
            use_existing_todos: Some(use_existing),
            goals: Some(vec![
                GrowthGoal {
                    kind: "learning".into(),
                    title: "练习旅行英语".into(),
                },
                GrowthGoal {
                    kind: "exercise".into(),
                    title: "多走动一点".into(),
                },
                GrowthGoal {
                    kind: "general".into(),
                    title: "让生活有条理".into(),
                },
            ]),
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap()
}

async fn todo(repo: &Repository, user: &str, title: &str) -> Todo {
    repo.create_todo(
        user,
        CreateTodo {
            title: title.into(),
            description: Some("用户真实保留的说明".into()),
            kind: Some("communication".into()),
            due_at: None,
            estimated_minutes: Some(5),
            client_request_id: None,
        },
    )
    .await
    .unwrap()
}

fn proposal(title: &str, kind: &str, minutes: i64, reference: Option<&str>) -> Value {
    json!({"title":title,"description":"根据明确目标提出的小行动","kind":kind,"reason":"与用户选择的目标一致","estimated_minutes":minutes,"todo_id":reference})
}

async fn begin(repo: &Repository, user: &str) -> (ClaimedTask, DailyPlanContext) {
    let plan = repo
        .ensure_daily_plan(user, EnsureDailyPlan::default())
        .await
        .unwrap();
    assert_eq!(plan.status, "queued");
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    assert_eq!(claim.user_id, user);
    assert_eq!(claim.task.kind, "daily_plan");
    let context = repo.begin_daily_generation(&claim).await.unwrap().unwrap();
    (claim, context)
}

async fn generate(repo: &Repository, user: &str, proposals: Vec<Value>) -> DailyPlan {
    let (claim, context) = begin(repo, user).await;
    assert!(repo
        .complete_daily_generation(&claim, &context, &json!({"items":proposals}).to_string())
        .await
        .unwrap());
    repo.daily_plan(user).await.unwrap()
}

fn command(item: &DailyPlanItem, key: &str) -> DailyItemCommand {
    DailyItemCommand {
        version: item.version,
        client_request_id: key.into(),
    }
}

#[tokio::test]
async fn default_is_disabled_and_reading_or_rejected_ensure_never_enqueues_work() {
    let (_dir, _url, repo, a, _b) = setup().await;
    let prefs = repo.growth_preferences(&a).await.unwrap();
    assert!(!prefs.enabled);
    for _ in 0..3 {
        let plan = repo.daily_plan(&a).await.unwrap();
        assert_eq!(plan.status, "disabled");
        assert!(plan.id.is_none());
        assert!(plan.items.is_empty());
    }
    assert!(repo
        .ensure_daily_plan(&a, EnsureDailyPlan::default())
        .await
        .is_err());
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    let plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_daily_plans")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!((tasks, plans), (0, 0));
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn concurrent_ensure_reserves_one_plan_task_and_model_start_per_local_day() {
    let (_dir, url, repo, a, _b) = setup().await;
    configure(&repo, &a, false).await;
    let peer = Repository::connect(&url).await.unwrap();
    let (one, two) = tokio::join!(
        repo.ensure_daily_plan(&a, EnsureDailyPlan::default()),
        peer.ensure_daily_plan(&a, EnsureDailyPlan::default())
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_eq!(one.id, two.id);
    let plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    let tasks: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE user_id=$1 AND kind='daily_plan'")
            .bind(&a)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!((plans, tasks), (1, 1));
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    let context = repo.begin_daily_generation(&claim).await.unwrap().unwrap();
    assert!(repo.begin_daily_generation(&claim).await.unwrap().is_none());
    assert!(context.existing_todos.is_empty());
    let count: i64 = sqlx::query_scalar("SELECT attempts FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn bounded_generation_keeps_real_source_and_replaces_from_spares_without_new_task_or_todo() {
    let (_dir, _url, repo, a, _b) = setup().await;
    let original = todo(&repo, &a, "用户自己的原始邮件待办").await;
    configure(&repo, &a, true).await;
    let plan = generate(
        &repo,
        &a,
        vec![
            proposal("模型不能覆盖此标题", "communication", 5, Some(&original.id)),
            proposal("学习五个词", "learning", 4, None),
            proposal("走动一下", "exercise", 4, None),
            proposal("整理桌面", "general", 2, None),
            proposal("复习一句问路表达", "learning", 3, None),
        ],
    )
    .await;
    assert_eq!(plan.status, "ready");
    assert_eq!(plan.items.len(), 3);
    assert!(plan.items.iter().map(|i| i.estimated_minutes).sum::<i64>() <= 15);
    let referenced = plan
        .items
        .iter()
        .find(|i| i.todo_id.as_deref() == Some(&original.id))
        .unwrap();
    assert_eq!(referenced.title, original.title);
    assert_eq!(referenced.source_kind, "manual");
    assert!(referenced.focus);
    let candidate = plan
        .items
        .iter()
        .find(|i| i.todo_id.is_none() && i.kind == "learning")
        .unwrap();
    assert_eq!(candidate.source_kind, "ai_daily");
    assert!(candidate.can_replace);
    let replaced = repo
        .replace_daily_item(&a, &candidate.id, command(candidate, "replace-once"))
        .await
        .unwrap();
    assert_eq!(replaced.items.len(), 3);
    assert!(!replaced.items.iter().any(|i| i.id == candidate.id));
    assert!(
        replaced
            .items
            .iter()
            .map(|i| i.estimated_minutes)
            .sum::<i64>()
            <= 15
    );
    let replay = repo
        .replace_daily_item(&a, &candidate.id, command(candidate, "replace-once"))
        .await
        .unwrap();
    assert_eq!(
        replay.items.iter().map(|i| &i.id).collect::<Vec<_>>(),
        replaced.items.iter().map(|i| &i.id).collect::<Vec<_>>()
    );
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(tasks, 1);
    assert_eq!(
        repo.todos_page(&a, "all", "all", 0, 100)
            .await
            .unwrap()
            .0
            .len(),
        1
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn accept_is_owned_idempotent_returns_fresh_todo_and_expiry_or_deletion_cannot_resurrect() {
    let (_dir, url, repo, a, b) = setup().await;
    configure(&repo, &a, false).await;
    let plan = generate(
        &repo,
        &a,
        vec![
            proposal("练习五个词", "learning", 5, None),
            proposal("走一小段路", "exercise", 5, None),
        ],
    )
    .await;
    let item = plan.items[0].clone();
    let untouched = plan.items[1].clone();
    assert!(matches!(
        repo.accept_daily_item(&b, &item.id, command(&item, "foreign"))
            .await,
        Err(DomainError::NotFound)
    ));
    let peer = Repository::connect(&url).await.unwrap();
    let (one, two) = tokio::join!(
        repo.accept_daily_item(&a, &item.id, command(&item, "same-accept")),
        peer.accept_daily_item(&a, &item.id, command(&item, "same-accept"))
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_eq!(one.todo.id, two.todo.id);
    assert_eq!(one.todo.source_kind, "ai_daily");
    assert_eq!(one.todo.source_id.as_deref(), Some(item.id.as_str()));
    assert_eq!(one.todo.source_excerpt, None);
    assert_eq!(one.todo.status, "pending");
    assert_eq!(
        repo.todos_page(&a, "all", "all", 0, 100)
            .await
            .unwrap()
            .0
            .len(),
        1
    );
    let edited = repo
        .update_todo(
            &a,
            &one.todo.id,
            UpdateTodo {
                version: one.todo.version,
                title: Some("接纳后用户自己修改的标题".into()),
                status: Some("in_progress".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let replay = repo
        .accept_daily_item(&a, &item.id, command(&item, "same-accept"))
        .await
        .unwrap();
    assert_eq!(
        (replay.todo.id, replay.todo.title, replay.todo.version),
        (edited.id.clone(), edited.title.clone(), edited.version)
    );
    sqlx::query("UPDATE growth_daily_plans SET local_date='2001-01-01' WHERE user_id=$1 AND id=$2")
        .bind(&a)
        .bind(plan.id.as_deref().unwrap())
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(matches!(
        repo.accept_daily_item(&a, &untouched.id, command(&untouched, "expired-accept"))
            .await,
        Err(DomainError::Conflict(_))
    ));
    repo.delete_todo(&a, &edited.id).await.unwrap();
    assert!(repo
        .accept_daily_item(&a, &item.id, command(&item, "same-accept"))
        .await
        .is_err());
    assert!(repo
        .todos_page(&a, "all", "all", 0, 100)
        .await
        .unwrap()
        .0
        .is_empty());
}

#[tokio::test]
async fn skipping_pausing_or_disabling_never_deletes_existing_or_accepted_todos() {
    let (_dir, _url, repo, a, _b) = setup().await;
    let original = todo(&repo, &a, "不能被推荐系统删除的原事项").await;
    configure(&repo, &a, true).await;
    let plan = generate(
        &repo,
        &a,
        vec![
            proposal("原事项", "communication", 5, Some(&original.id)),
            proposal("练习英语", "learning", 5, None),
        ],
    )
    .await;
    let original_item = plan
        .items
        .iter()
        .find(|i| i.todo_id.is_some())
        .unwrap()
        .clone();
    let generated_item = plan
        .items
        .iter()
        .find(|i| i.todo_id.is_none())
        .unwrap()
        .clone();
    let accepted = repo
        .accept_daily_item(
            &a,
            &generated_item.id,
            command(&generated_item, "accept-before-rest"),
        )
        .await
        .unwrap();
    repo.skip_daily_item(
        &a,
        &original_item.id,
        command(&original_item, "skip-original"),
    )
    .await
    .unwrap();
    assert_eq!(
        repo.todo(&a, &original.id).await.unwrap().title,
        original.title
    );
    let old = repo.growth_preferences(&a).await.unwrap();
    repo.update_growth_preferences(
        &a,
        UpdateGrowthPreferences {
            version: old.version,
            enabled: None,
            daily_minutes: None,
            use_existing_todos: None,
            goals: None,
            paused_today: Some(true),
            halo: None,
        },
    )
    .await
    .unwrap();
    let paused = repo.daily_plan(&a).await.unwrap();
    assert_eq!(paused.status, "paused");
    assert!(paused
        .items
        .iter()
        .any(|i| i.todo_id.as_deref() == Some(&accepted.todo.id)));
    assert_eq!(
        repo.todos_page(&a, "active", "all", 0, 100)
            .await
            .unwrap()
            .0
            .len(),
        2
    );
    let old = repo.growth_preferences(&a).await.unwrap();
    repo.update_growth_preferences(
        &a,
        UpdateGrowthPreferences {
            version: old.version,
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
    let disabled = repo.daily_plan(&a).await.unwrap();
    assert_eq!(disabled.status, "disabled");
    assert!(disabled.items.is_empty());
    assert_eq!(
        repo.todos_page(&a, "active", "all", 0, 100)
            .await
            .unwrap()
            .0
            .len(),
        2
    );
    assert_eq!(repo.growth_summary(&a).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn settings_permission_and_account_fences_reject_late_model_results() {
    let (_dir, _url, repo, a, b) = setup().await;
    let original = todo(&repo, &a, "仅授权时可用于建议").await;
    configure(&repo, &a, true).await;
    let (claim, context) = begin(&repo, &a).await;
    assert!(context.existing_todos.iter().any(|t| t.id == original.id));
    assert!(context
        .existing_todos
        .iter()
        .all(|t| t.draft.is_none() && t.source_excerpt.is_none() && t.progress_notes.is_none()));
    let old = repo.growth_preferences(&a).await.unwrap();
    repo.update_growth_preferences(
        &a,
        UpdateGrowthPreferences {
            version: old.version,
            enabled: None,
            daily_minutes: None,
            use_existing_todos: Some(false),
            goals: None,
            paused_today: None,
            halo: None,
        },
    )
    .await
    .unwrap();
    let response =
        json!({"items":[proposal("旧来源结果","communication",5,Some(&original.id))]}).to_string();
    assert!(repo
        .complete_daily_generation(&claim, &context, &response)
        .await
        .is_err());
    let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(items, 0);
    repo.fail_daily_generation(&claim, "设置变化，测试明确失败")
        .await
        .unwrap();
    assert_eq!(repo.todo(&a, &original.id).await.unwrap().status, "pending");
    configure(&repo, &b, false).await;
    let (claim, context) = begin(&repo, &b).await;
    sqlx::query("INSERT INTO admin_user_controls(user_id,disabled,updated_at)VALUES($1,1,$2)")
        .bind(&b)
        .bind(now())
        .execute(&repo.pool())
        .await
        .unwrap();
    let result = repo
        .complete_daily_generation(
            &claim,
            &context,
            &json!({"items":[proposal("不应发布","learning",5,None)]}).to_string(),
        )
        .await;
    assert!(result.is_err() || matches!(result, Ok(false)));
    let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items WHERE user_id=$1")
        .bind(&b)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(items, 0);
}

#[tokio::test]
async fn expired_claims_and_uncertain_reclaims_do_not_silently_spend_a_third_model_start() {
    let (_dir, _url, repo, a, _b) = setup().await;
    configure(&repo, &a, false).await;
    repo.ensure_daily_plan(&a, EnsureDailyPlan::default())
        .await
        .unwrap();
    let first = repo.claim_task(90).await.unwrap().unwrap();
    sqlx::query("UPDATE tasks SET claimed_until=$1 WHERE id=$2")
        .bind(now() - 1)
        .bind(&first.task.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(repo.begin_daily_generation(&first).await.unwrap().is_none());
    let fresh = repo.claim_task(90).await.unwrap().unwrap();
    let _context = repo.begin_daily_generation(&fresh).await.unwrap().unwrap();
    sqlx::query("UPDATE tasks SET claimed_until=$1 WHERE id=$2")
        .bind(now() - 1)
        .bind(&fresh.task.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    let reclaimed = repo.claim_task(90).await.unwrap().unwrap();
    assert!(repo
        .begin_daily_generation(&reclaimed)
        .await
        .unwrap()
        .is_none());
    let failed = repo.daily_plan(&a).await.unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.can_retry);
    let row = sqlx::query("SELECT attempts,context FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("attempts"), 1);
    assert!(row.get::<String, _>("context").is_empty());
    let (retry, _context) = begin(&repo, &a).await;
    repo.fail_daily_generation(&retry, "第二次模型失败，停止自动尝试")
        .await
        .unwrap();
    let final_plan = repo.daily_plan(&a).await.unwrap();
    assert_eq!(final_plan.status, "failed");
    assert!(!final_plan.can_retry);
    repo.ensure_daily_plan(&a, EnsureDailyPlan::default())
        .await
        .unwrap();
    let row = sqlx::query("SELECT attempts,dispatches FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        (
            row.get::<i64, _>("attempts"),
            row.get::<i64, _>("dispatches")
        ),
        (2, 2)
    );
    assert!(repo.claim_task(90).await.unwrap().is_none());
}

#[tokio::test]
async fn scheduler_cursor_reaches_enabled_users_beyond_the_first_hundred_without_duplicate_dispatch(
) {
    let (_dir, _url, repo, _a, _b) = setup().await;
    let zone = if chrono::Utc::now().hour() >= 8 {
        "UTC"
    } else {
        "Pacific/Kiritimati"
    };
    let body=json!({"enabled":true,"daily_minutes":15,"use_existing_todos":false,"goals":[{"kind":"general","title":"整理生活"}],"paused_date":null,"halo":"classic"}).to_string();
    let mut tx = repo.pool().begin().await.unwrap();
    for n in 0..101 {
        let id = format!("scheduler-{n:03}");
        sqlx::query("INSERT INTO users(id,email,password_hash,name,timezone,created_at)VALUES($1,$2,'fixture','调度测试',$3,$4)")
            .bind(&id).bind(format!("{id}@example.test")).bind(zone).bind(now()).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO growth_preferences(user_id,body,version,guard,last_active_at)VALUES($1,$2,1,0,$3)")
            .bind(id).bind(&body).bind(now()).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    assert_eq!(repo.tick_daily_growth().await.unwrap(), 100);
    assert_eq!(repo.tick_daily_growth().await.unwrap(), 1);
    assert_eq!(repo.tick_daily_growth().await.unwrap(), 0);
    assert_eq!(repo.tick_daily_growth().await.unwrap(), 0);
    let plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_daily_plans")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE kind='daily_plan'")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!((plans, tasks), (101, 101));
}

#[tokio::test]
async fn exhausted_generic_task_leases_do_not_leave_the_daily_plan_generating_forever() {
    let (_dir, _url, repo, a, _b) = setup().await;
    configure(&repo, &a, false).await;
    repo.ensure_daily_plan(&a, EnsureDailyPlan::default())
        .await
        .unwrap();
    let mut claim = repo.claim_task(90).await.unwrap().unwrap();
    // Two crashes before model I/O should consume task leases, but no model budget.
    for _ in 0..2 {
        sqlx::query("UPDATE tasks SET claimed_until=$1 WHERE id=$2")
            .bind(now() - 1)
            .bind(&claim.task.id)
            .execute(&repo.pool())
            .await
            .unwrap();
        claim = repo.claim_task(90).await.unwrap().unwrap();
    }
    assert_eq!(claim.attempt, 3);
    let _context = repo.begin_daily_generation(&claim).await.unwrap().unwrap();
    sqlx::query("UPDATE tasks SET claimed_until=$1 WHERE id=$2")
        .bind(now() - 1)
        .bind(&claim.task.id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert!(repo.claim_task(90).await.unwrap().is_none());
    assert_eq!(
        repo.task(&a, &claim.task.id).await.unwrap().status,
        "failed"
    );
    let plan = repo.daily_plan(&a).await.unwrap();
    assert_eq!(
        plan.status, "failed",
        "an exhausted task must not strand its daily plan in generating"
    );
    assert!(
        plan.can_retry,
        "one uncertain model start leaves exactly one explicit retry"
    );
    let retry = repo
        .ensure_daily_plan(&a, EnsureDailyPlan::default())
        .await
        .unwrap();
    assert_eq!(retry.status, "queued");
}

#[tokio::test]
async fn ensure_request_replay_cannot_turn_failed_generation_into_implicit_paid_retry() {
    let (_dir, _url, repo, a, _b) = setup().await;
    configure(&repo, &a, false).await;
    let first_request = || EnsureDailyPlan {
        client_request_id: Some("ensure-original-intent".into()),
    };
    let first = repo.ensure_daily_plan(&a, first_request()).await.unwrap();
    assert_eq!(first.status, "queued");
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    assert!(repo.begin_daily_generation(&claim).await.unwrap().is_some());
    repo.fail_daily_generation(&claim, "本地合成模型失败")
        .await
        .unwrap();

    let replay = repo.ensure_daily_plan(&a, first_request()).await.unwrap();
    assert_eq!(replay.id, first.id);
    assert_eq!(replay.status, "failed");
    assert!(replay.can_retry);
    assert!(repo.claim_task(90).await.unwrap().is_none());
    let row = sqlx::query("SELECT attempts,dispatches FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        (
            row.get::<i64, _>("attempts"),
            row.get::<i64, _>("dispatches")
        ),
        (1, 1),
        "replaying an already consumed intent must not spend another dispatch"
    );

    let retry_request = || EnsureDailyPlan {
        client_request_id: Some("ensure-explicit-retry-intent".into()),
    };
    let retry = repo.ensure_daily_plan(&a, retry_request()).await.unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(retry.status, "queued");
    let replay_retry = repo.ensure_daily_plan(&a, retry_request()).await.unwrap();
    assert_eq!(replay_retry.id, first.id);
    assert_eq!(replay_retry.status, "queued");
    let row = sqlx::query("SELECT attempts,dispatches FROM growth_daily_plans WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        (
            row.get::<i64, _>("attempts"),
            row.get::<i64, _>("dispatches")
        ),
        (1, 2),
        "a fresh explicit retry may enqueue once; its own replay may not"
    );
    let retry_claim = repo.claim_task(90).await.unwrap().unwrap();
    assert_ne!(retry_claim.task.id, claim.task.id);
    assert!(repo.claim_task(90).await.unwrap().is_none());
    assert!(repo
        .begin_daily_generation(&retry_claim)
        .await
        .unwrap()
        .is_some());
    let tasks: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE user_id=$1 AND kind='daily_plan'")
            .bind(&a)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(tasks, 2);
}

#[tokio::test]
async fn deleting_a_todo_disclosed_to_generation_invalidates_even_unlinked_model_suggestions() {
    let (_dir, _url, repo, a, _b) = setup().await;
    let original = todo(&repo, &a, "模型开始时可见、随后由用户删除的待办").await;
    configure(&repo, &a, true).await;
    let (claim, context) = begin(&repo, &a).await;
    assert!(context.existing_todos.iter().any(|t| t.id == original.id));
    repo.delete_todo(&a, &original.id).await.unwrap();

    // The response is a valid selected-goal action with no direct source reference.
    // It still came from the revoked context and must not bypass the publication fence.
    let published = repo
        .complete_daily_generation(
            &claim,
            &context,
            &json!({"items":[proposal("复习一句旅行英语", "learning", 5, None)]}).to_string(),
        )
        .await
        .unwrap();
    assert!(!published, "deleted-context results must not be published");
    let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items WHERE user_id=$1")
        .bind(&a)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(items, 0);
    assert_ne!(
        repo.task(&a, &claim.task.id).await.unwrap().status,
        "succeeded"
    );
    assert!(repo.daily_plan(&a).await.unwrap().items.is_empty());
}
