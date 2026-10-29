//! Independent synthetic acceptance: no worker, network model, SMS or application DB.
//! PostgreSQL is an explicit opt-in against the single Root-authorized QA container.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use chrono::{Days, TimeZone, Utc};
use serde_json::{json, Value};
use sqlx::Row;
use tomorrow_api::{app, AppState};
use tomorrow_domain::*;
use tower::ServiceExt;

struct Fixture {
    _dir: Option<tempfile::TempDir>,
    url: String,
    repo: Repository,
    router: Router,
    owner: String,
    other: String,
    token: String,
    other_token: String,
}
async fn at(url: String, dir: Option<tempfile::TempDir>) -> Fixture {
    let repo = Repository::connect(&url).await.unwrap();
    let owner = repo
        .create_user(
            &format!("growth-independent-{}@fixture.invalid", new_id()),
            "synthetic",
            "甲",
            "Pacific/Kiritimati",
        )
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user(
            &format!("growth-independent-{}@fixture.invalid", new_id()),
            "synthetic",
            "乙",
            "America/Los_Angeles",
        )
        .await
        .unwrap()
        .id;
    let token = repo.create_session(&owner).await.unwrap();
    let other_token = repo.create_session(&other).await.unwrap();
    let router = app(AppState::new(repo.clone(), ModelProvider::local(), &url));
    Fixture {
        _dir: dir,
        url,
        repo,
        router,
        owner,
        other,
        token,
        other_token,
    }
}
async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        dir.path().join("growth-independent.db").to_string_lossy()
    );
    at(url, Some(dir)).await
}
async fn call(
    f: &Fixture,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = f
        .router
        .clone()
        .oneshot(
            request
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn create(f: &Fixture, kind: &str, title: &str) -> Todo {
    f.repo
        .create_todo(
            &f.owner,
            serde_json::from_value(json!({"title":title,"kind":kind})).unwrap(),
        )
        .await
        .unwrap()
}
async fn status(f: &Fixture, todo: &Todo, state: &str) -> Todo {
    f.repo
        .update_todo(
            &f.owner,
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
async fn prefs(f: &Fixture, extra: Value) -> GrowthPreferences {
    let old = f.repo.growth_preferences(&f.owner).await.unwrap();
    let mut body = json!({"version":old.version});
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    f.repo
        .update_growth_preferences(&f.owner, serde_json::from_value(body).unwrap())
        .await
        .unwrap()
}
async fn enable(f: &Fixture) {
    prefs(f, json!({"enabled":true,"daily_minutes":15,"goals":[{"kind":"learning","title":"练习英语"},{"kind":"exercise","title":"散步"},{"kind":"general","title":"生活整理"}]})).await;
}
fn action(todo: &Todo, kind: &str, key: &str) -> ConfirmTodoAction {
    serde_json::from_value(json!({"kind":kind,"version":todo.version,"client_request_id":key}))
        .unwrap()
}
fn command(item: &DailyPlanItem, key: &str) -> DailyItemCommand {
    DailyItemCommand {
        version: item.version,
        client_request_id: key.into(),
    }
}
fn proposal(id: Option<&str>, title: &str, kind: &str) -> Value {
    json!({"todo_id":id,"title":title,"description":"可执行的一小步","kind":kind,"reason":"符合所选目标与时间","estimated_minutes":5})
}
async fn begin(f: &Fixture) -> (ClaimedTask, DailyPlanContext) {
    let plan = f
        .repo
        .ensure_daily_plan(&f.owner, EnsureDailyPlan::default())
        .await
        .unwrap();
    let claim = if f._dir.is_some() {
        f.repo.claim_task(60).await.unwrap().unwrap()
    } else {
        // Do not claim another tester's task in the shared QA DB. This fixture only
        // transitions the exact task reserved by this account's public ensure.
        let id: String =
            sqlx::query_scalar("SELECT task_id FROM growth_daily_plans WHERE id=$1 AND user_id=$2")
                .bind(plan.id.as_ref().unwrap())
                .bind(&f.owner)
                .fetch_one(&f.repo.pool())
                .await
                .unwrap();
        sqlx::query("UPDATE tasks SET status='running',attempts=attempts+1,claimed_until=$1 WHERE id=$2 AND user_id=$3")
            .bind(now()+60).bind(&id).bind(&f.owner).execute(&f.repo.pool()).await.unwrap();
        let attempt: i64 =
            sqlx::query_scalar("SELECT attempts FROM tasks WHERE id=$1 AND user_id=$2")
                .bind(&id)
                .bind(&f.owner)
                .fetch_one(&f.repo.pool())
                .await
                .unwrap();
        ClaimedTask {
            task: f.repo.task(&f.owner, &id).await.unwrap(),
            user_id: f.owner.clone(),
            attempt,
        }
    };
    assert_eq!(claim.user_id, f.owner);
    let context = f
        .repo
        .begin_daily_generation(&claim)
        .await
        .unwrap()
        .unwrap();
    (claim, context)
}
async fn generate(f: &Fixture, proposals: Vec<Value>) -> DailyPlan {
    let (claim, context) = begin(f).await;
    assert!(
        f.repo
            .begin_daily_generation(&claim)
            .await
            .unwrap()
            .is_none(),
        "same attempt must not start model IO twice"
    );
    let raw = json!({"items":proposals}).to_string();
    assert!(f
        .repo
        .complete_daily_generation(&claim, &context, &raw)
        .await
        .unwrap());
    assert!(
        !f.repo
            .complete_daily_generation(&claim, &context, &raw)
            .await
            .unwrap(),
        "late completion of the same claim must not insert another plan batch"
    );
    f.repo.daily_plan(&f.owner).await.unwrap()
}

#[tokio::test]
async fn api_opt_in_auth_ownership_and_no_retroactive_or_client_awards() {
    let f = fixture().await;
    assert_eq!(
        call(&f, "", "GET", "/v1/growth/summary", Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (code, initial) = call(&f, &f.token, "GET", "/v1/growth/summary", Value::Null).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(initial["total_xp"], 0);
    assert_eq!(initial["level"], 1);
    assert_eq!(initial["week"]["records"], json!([]));
    assert!(!f.repo.growth_preferences(&f.owner).await.unwrap().enabled);
    let prior = create(&f, "general", "开启前已完成").await;
    let prior = status(&f, &prior, "completed").await;
    let pending = create(&f, "general", "开启前尚未完成").await;
    let (code, p) = call(
        &f,
        &f.token,
        "PATCH",
        "/v1/growth/preferences",
        json!({"version":0,"enabled":true,"use_existing_todos":true}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{p}");
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            "/v1/growth/preferences",
            json!({"version":0,"daily_minutes":30})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    let old = f
        .repo
        .update_todo(
            &f.owner,
            &prior.id,
            UpdateTodo {
                version: prior.version,
                progress_notes: Some(Some("只记笔记".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(f
        .repo
        .growth_reward_state(&f.owner, &old.id)
        .await
        .unwrap()
        .reward
        .is_none());
    let (code, forged) = call(
        &f,
        &f.token,
        "PATCH",
        &format!("/v1/todos/{}", pending.id),
        json!({"version":pending.version,"status":"completed","xp":10000}),
    )
    .await;
    assert!(
        code.is_client_error(),
        "client must not mint points: {forged}"
    );
    let done = status(&f, &pending, "completed").await;
    let receipt = f
        .repo
        .growth_reward_state(&f.owner, &done.id)
        .await
        .unwrap();
    assert_eq!(receipt.total_xp, 10);
    assert_eq!(receipt.reward.unwrap().xp, 10);
    assert_eq!(
        call(
            &f,
            &f.other_token,
            "GET",
            &format!("/v1/growth/todos/{}", done.id),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &f,
            &f.other_token,
            "POST",
            &format!("/v1/todos/{}/actions", done.id),
            json!({"kind":"replied","version":done.version,"client_request_id":"foreign"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(f.repo.growth_summary(&f.other).await.unwrap().total_xp, 0);
    prefs(&f, json!({"enabled":false})).await;
    enable(&f).await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 10);
}

#[tokio::test]
async fn typed_reply_is_distinct_from_generic_waiting_and_replay_reads_current_truth() {
    let f = fixture().await;
    enable(&f).await;
    let mail = create(&f, "communication", "用户实际回复").await;
    let waiting = status(&f, &mail, "waiting").await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    let request = action(&waiting, "replied", "reply-once");
    let replied = f
        .repo
        .confirm_todo_action(&f.owner, &mail.id, request.clone())
        .await
        .unwrap();
    assert_eq!(replied.todo.status, "waiting");
    assert!(replied.actions.replied);
    assert_eq!(replied.reward.as_ref().unwrap().xp, 10);
    let undone = f
        .repo
        .confirm_todo_action(
            &f.owner,
            &mail.id,
            action(&replied.todo, "undo_replied", "undo-once"),
        )
        .await
        .unwrap();
    assert!(!undone.reward.as_ref().unwrap().active);
    assert_eq!(undone.todo.status, "pending");
    let replay = f
        .repo
        .confirm_todo_action(&f.owner, &mail.id, request)
        .await
        .unwrap();
    assert_eq!(replay.todo.version, undone.todo.version);
    assert!(!replay.actions.replied);
    assert!(!replay.reward.unwrap().active);
    let replied = f
        .repo
        .confirm_todo_action(
            &f.owner,
            &mail.id,
            action(&undone.todo, "replied", "reply-again"),
        )
        .await
        .unwrap();
    let completed = status(&f, &replied.todo, "completed").await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 10);
    let reopened = status(&f, &completed, "pending").await;
    assert!(
        f.repo
            .growth_reward_state(&f.owner, &mail.id)
            .await
            .unwrap()
            .reward
            .unwrap()
            .active,
        "reversing completion must retain the independently confirmed reply"
    );
    assert_eq!(reopened.status, "pending");
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 10);
}

#[tokio::test]
async fn reply_fact_can_be_corrected_without_erasing_an_independent_completed_fact() {
    let f = fixture().await;
    enable(&f).await;
    let mail = create(&f, "communication", "两份独立确认事实").await;
    let replied = f
        .repo
        .confirm_todo_action(&f.owner, &mail.id, action(&mail, "replied", "reply"))
        .await
        .unwrap();
    let completed = status(&f, &replied.todo, "completed").await;
    let corrected = f
        .repo
        .confirm_todo_action(
            &f.owner,
            &mail.id,
            action(&completed, "undo_replied", "clear-reply-only"),
        )
        .await;
    assert!(
        corrected.is_ok(),
        "typed reply and completion must be separately correctable: {corrected:?}"
    );
    let corrected = corrected.unwrap();
    assert_eq!(corrected.todo.status, "completed");
    assert!(!corrected.actions.replied);
    assert!(corrected.reward.unwrap().active);
}

async fn receipt_cross_day(f: &Fixture) {
    enable(f).await;
    let original = create(f, "learning", "跨日重新确认").await;
    let done = status(f, &original, "completed").await;
    let receipt = f
        .repo
        .growth_reward_state(&f.owner, &done.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    let date = Utc::now()
        .date_naive()
        .checked_sub_days(Days::new(1))
        .unwrap();
    let earned = Utc
        .from_utc_datetime(&date.and_hms_opt(12, 0, 0).unwrap())
        .timestamp();
    // Explicit authorized clock fixture, not a production API time override.
    sqlx::query("UPDATE growth_rewards SET earned_at=$1,local_date=$2,timezone='UTC' WHERE user_id=$3 AND todo_id=$4")
        .bind(earned).bind(date.to_string()).bind(&f.owner).bind(&done.id).execute(&f.repo.pool()).await.unwrap();
    let pending = status(f, &done, "pending").await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    prefs(f, json!({"enabled":false})).await;
    let redone = status(f, &pending, "completed").await;
    let restored = f
        .repo
        .growth_reward_state(&f.owner, &redone.id)
        .await
        .unwrap()
        .reward
        .unwrap();
    assert_eq!(
        (
            restored.id,
            restored.xp,
            restored.local_date,
            restored.timezone
        ),
        (receipt.id, 10, date.to_string(), "UTC".into())
    );
    assert!(restored.active);
    assert_eq!(restored.earned_at, timestamp(earned));
    let summary = f.repo.growth_summary(&f.owner).await.unwrap();
    assert_eq!(summary.total_xp, 10);
    assert_eq!(summary.today.action_count, 0);
    assert_eq!(summary.today.xp, 0);
}
#[tokio::test]
async fn cross_day_undo_recomplete_and_opt_out_retain_the_original_receipt_day() {
    receipt_cross_day(&fixture().await).await;
}

#[tokio::test]
async fn exercise_requires_explicit_bounded_integer_duration_and_stale_actions_do_not_mint() {
    let f = fixture().await;
    enable(&f).await;
    let todo = create(&f, "exercise", "自行记录运动").await;
    let running = status(&f, &todo, "in_progress").await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    for minutes in [json!(0), json!(361), json!(1000), json!(2.5)] {
        let (code,body)=call(&f,&f.token,"POST",&format!("/v1/todos/{}/actions",todo.id),json!({"kind":"exercise_completed","version":running.version,"client_request_id":new_id(),"actual_minutes":minutes})).await;
        assert_eq!(
            code,
            if minutes.is_f64() {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::BAD_REQUEST
            },
            "{minutes} must be rejected by validation rather than a missing route: {body}"
        );
        assert_eq!(
            f.repo.todo(&f.owner, &todo.id).await.unwrap().status,
            "in_progress"
        );
    }
    let mut request = action(&running, "exercise_completed", "finish-exercise");
    request.actual_minutes = Some(23);
    request.progress_notes = Some(Some("用户自己的笔记".into()));
    let (code, body) = call(
        &f,
        &f.token,
        "POST",
        &format!("/v1/todos/{}/actions", todo.id),
        serde_json::to_value(&request).unwrap(),
    )
    .await;
    assert_eq!(
        code,
        StatusCode::OK,
        "successful owned HTTP action must be mounted: {body}"
    );
    let result: TodoActionResult = serde_json::from_value(body).unwrap();
    assert_eq!(result.todo.status, "completed");
    assert_eq!(result.reward.as_ref().unwrap().minutes, Some(23));
    assert_eq!(
        result.todo.progress_notes.as_deref(),
        Some("用户自己的笔记")
    );
    let duplicate = f
        .repo
        .confirm_todo_action(&f.owner, &todo.id, request)
        .await
        .unwrap();
    assert_eq!(duplicate.todo.version, result.todo.version);
    assert!(f
        .repo
        .confirm_todo_action(
            &f.owner,
            &todo.id,
            action(&running, "exercise_completed", "stale-new-key")
        )
        .await
        .is_err());
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 10);
}

#[tokio::test]
async fn daily_plan_is_unique_source_grounded_bounded_and_accept_is_an_unrewarded_commitment() {
    let f = fixture().await;
    enable(&f).await;
    let original = create(&f, "communication", "原始待办标题").await;
    let other = Repository::connect(&f.url).await.unwrap();
    let (a, b) = tokio::join!(
        f.repo
            .ensure_daily_plan(&f.owner, EnsureDailyPlan::default()),
        other.ensure_daily_plan(&f.owner, EnsureDailyPlan::default())
    );
    assert_eq!(a.unwrap().id, b.unwrap().id);
    let jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE user_id=$1 AND kind='daily_plan'")
            .bind(&f.owner)
            .fetch_one(&f.repo.pool())
            .await
            .unwrap();
    assert_eq!(jobs, 1);
    let plan = generate(
        &f,
        vec![
            proposal(Some(&original.id), "模型擅改标题", "communication"),
            proposal(None, "练习新知识", "learning"),
            proposal(None, "走一小段路", "exercise"),
            proposal(None, "整理抽屉", "general"),
        ],
    )
    .await;
    assert_eq!(plan.status, "ready");
    assert_eq!(plan.items.len(), 3);
    assert!(plan.items.iter().map(|i| i.estimated_minutes).sum::<i64>() <= 15);
    let sourced = plan
        .items
        .iter()
        .find(|i| i.todo_id.as_deref() == Some(&original.id))
        .unwrap();
    assert_eq!(sourced.title, original.title);
    assert_eq!(sourced.source_kind, "manual");
    assert!(sourced.focus);
    assert_eq!(
        f.repo.growth_summary(&f.owner).await.unwrap().total_xp,
        0,
        "AI execution and suggestion creation cannot reward"
    );
    let replacement = plan.items.iter().find(|i| i.todo_id.is_none()).unwrap();
    let (replace_a, replace_b) = tokio::join!(
        f.repo
            .replace_daily_item(&f.owner, &replacement.id, command(replacement, "replace-a")),
        other.replace_daily_item(&f.owner, &replacement.id, command(replacement, "replace-b"))
    );
    assert_eq!(
        usize::from(replace_a.is_ok()) + usize::from(replace_b.is_ok()),
        1,
        "one candidate version can replace only once: {replace_a:?} {replace_b:?}"
    );
    let after = replace_a.or(replace_b).unwrap();
    assert!(!after.items.iter().any(|i| i.id == replacement.id));
    assert_eq!(
        f.repo.todo(&f.owner, &original.id).await.unwrap().title,
        original.title
    );
    let start = after.items.iter().find(|i| i.todo_id.is_none()).unwrap();
    let (first, second) = tokio::join!(
        f.repo
            .accept_daily_item(&f.owner, &start.id, command(start, "accept-a")),
        other.accept_daily_item(&f.owner, &start.id, command(start, "accept-b"))
    );
    assert_eq!(
        usize::from(first.is_ok()) + usize::from(second.is_ok()),
        1,
        "concurrent CAS must admit exactly one: {first:?} {second:?}"
    );
    let accepted = first.or(second).unwrap();
    assert_eq!(accepted.todo.status, "pending");
    assert_eq!(accepted.todo.source_kind, "ai_daily");
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    assert!(f
        .repo
        .accept_daily_item(&f.other, &sourced.id, command(sourced, "foreign-accept"))
        .await
        .is_err());
    let focus = f
        .repo
        .accept_daily_item(&f.owner, &sourced.id, command(sourced, "focus-accept"))
        .await
        .unwrap();
    let reply = f
        .repo
        .confirm_todo_action(
            &f.owner,
            &original.id,
            action(&focus.todo, "replied", "focus-reply"),
        )
        .await
        .unwrap();
    assert_eq!(reply.reward.unwrap().xp, 20);
    let completed = status(&f, &reply.todo, "completed").await;
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 20);
    prefs(&f, json!({"paused_today":true})).await;
    let paused = f.repo.daily_plan(&f.owner).await.unwrap();
    assert_eq!(paused.status, "paused");
    assert!(paused.items.iter().all(|i| i.status == "accepted"));
    assert!(f.repo.todo(&f.owner, &accepted.todo.id).await.is_ok());
    let done = status(&f, &accepted.todo, "completed").await;
    assert_eq!(
        f.repo
            .growth_reward_state(&f.owner, &done.id)
            .await
            .unwrap()
            .reward
            .unwrap()
            .xp,
        10
    );
    prefs(&f, json!({"enabled":false})).await;
    assert!(f
        .repo
        .ensure_daily_plan(&f.owner, EnsureDailyPlan::default())
        .await
        .is_err());
    assert!(f.repo.todo(&f.owner, &completed.id).await.is_ok());
}

#[tokio::test]
async fn invalid_source_failed_retry_and_changed_preferences_cannot_apply_a_late_plan() {
    let f = fixture().await;
    enable(&f).await;
    let own = create(&f, "general", "原有事项必须保留").await;
    let foreign = f
        .repo
        .create_todo(
            &f.other,
            serde_json::from_value(json!({"title":"其他账号私有事项"})).unwrap(),
        )
        .await
        .unwrap();
    let (claim, context) = begin(&f).await;
    let invalid = f
        .repo
        .complete_daily_generation(
            &claim,
            &context,
            &json!({"items":[proposal(Some(&foreign.id),"伪造来源","general")]}).to_string(),
        )
        .await;
    assert!(matches!(invalid, Err(DomainError::Validation(_))));
    let mut fake_source = proposal(None, "模型伪造来源", "learning");
    fake_source["source_kind"] = json!("sms");
    assert!(matches!(
        f.repo
            .complete_daily_generation(
                &claim,
                &context,
                &json!({"items":[fake_source]}).to_string()
            )
            .await,
        Err(DomainError::Validation(_))
    ));
    f.repo
        .fail_daily_generation(&claim, "synthetic provider failure")
        .await
        .unwrap();
    let failed = f.repo.daily_plan(&f.owner).await.unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.can_retry);
    assert!(f.repo.todo(&f.owner, &own.id).await.is_ok());
    let (retry, stale) = begin(&f).await;
    prefs(&f, json!({"use_existing_todos":false})).await;
    assert!(matches!(
        f.repo
            .complete_daily_generation(
                &retry,
                &stale,
                &json!({"items":[proposal(None,"新学习建议","learning")]}).to_string()
            )
            .await,
        Err(DomainError::Conflict(_))
    ));
    f.repo
        .fail_daily_generation(&retry, "settings changed")
        .await
        .unwrap();
    assert!(f.repo.todo(&f.owner, &own.id).await.is_ok());
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
    assert!(!f.repo.daily_plan(&f.owner).await.unwrap().can_retry);
    let no_sources = fixture().await;
    enable(&no_sources).await;
    let existing = create(&no_sources, "general", "不允许交给模型的既有事项").await;
    prefs(&no_sources, json!({"use_existing_todos":false})).await;
    let (claim, context) = begin(&no_sources).await;
    assert!(context.existing_todos.is_empty());
    assert!(matches!(
        no_sources
            .repo
            .complete_daily_generation(
                &claim,
                &context,
                &json!({"items":[proposal(Some(&existing.id),"不能绕过设置","general")]})
                    .to_string()
            )
            .await,
        Err(DomainError::Validation(_))
    ));
}

#[tokio::test]
#[ignore = "requires explicit GROWTH_TEST_DATABASE_URL for Root-owned QA PostgreSQL 55444"]
async fn postgres_private_qa_migrations_receipts_owner_and_plan_parity() {
    let dsn = std::env::var("GROWTH_TEST_DATABASE_URL").expect("explicit QA opt-in required");
    let parsed = url::Url::parse(&dsn).unwrap();
    assert_eq!(parsed.scheme(), "postgres");
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert_eq!(parsed.port(), Some(55444));
    assert_eq!(parsed.username(), "growth_qa");
    assert_eq!(parsed.path(), "/growth_qa");
    let f = at(dsn, None).await;
    receipt_cross_day(&f).await;
    enable(&f).await;
    let own = create(&f, "learning", "PG 原有事项").await;
    let plan = generate(
        &f,
        vec![
            proposal(Some(&own.id), "忽略模型重命名", "learning"),
            proposal(None, "PG 学习建议", "learning"),
        ],
    )
    .await;
    let item = plan
        .items
        .iter()
        .find(|i| i.todo_id.as_deref() == Some(&own.id))
        .unwrap();
    assert_eq!(item.title, own.title);
    let accepted = f
        .repo
        .accept_daily_item(&f.owner, &item.id, command(item, "pg-accept"))
        .await
        .unwrap();
    assert_eq!(accepted.todo.id, own.id);
    assert!(matches!(
        f.repo.growth_reward_state(&f.other, &own.id).await,
        Err(DomainError::NotFound)
    ));
    assert!(f
        .repo
        .growth_reward_state(&f.owner, &own.id)
        .await
        .unwrap()
        .reward
        .is_none());
    let done = status(&f, &accepted.todo, "completed").await;
    assert_eq!(
        f.repo
            .growth_reward_state(&f.owner, &done.id)
            .await
            .unwrap()
            .reward
            .unwrap()
            .xp,
        20
    );
    let row = sqlx::query("SELECT COUNT(*) AS n FROM growth_daily_plans WHERE user_id=$1")
        .bind(&f.owner)
        .fetch_one(&f.repo.pool())
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("n"), 1);
}

#[tokio::test]
async fn typed_reply_null_clears_a_saved_draft_but_omission_preserves_it() {
    let f = fixture().await;
    enable(&f).await;
    for explicit_null in [true, false] {
        let todo = create(&f, "communication", "三态草稿确认").await;
        let todo = f
            .repo
            .update_todo(
                &f.owner,
                &todo.id,
                UpdateTodo {
                    version: todo.version,
                    draft: Some(Some("既有私有草稿".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let mut body =
            json!({"kind":"replied","version":todo.version,"client_request_id":new_id()});
        if explicit_null {
            body["draft"] = Value::Null;
        }
        let (code, result) = call(
            &f,
            &f.token,
            "POST",
            &format!("/v1/todos/{}/actions", todo.id),
            body,
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{result}");
        let saved = f.repo.todo(&f.owner, &todo.id).await.unwrap();
        assert_eq!(saved.status, "waiting");
        if explicit_null {
            assert!(
                saved.draft.is_none(),
                "explicit null must clear the old draft, not silently reuse it: {:?}",
                saved.draft
            );
            assert!(result["todo"]["draft"].is_null());
        } else {
            assert_eq!(saved.draft.as_deref(), Some("既有私有草稿"));
        }
    }
}

#[tokio::test]
async fn exercise_completion_null_clears_saved_notes_but_omission_preserves_them() {
    let f = fixture().await;
    enable(&f).await;
    for explicit_null in [true, false] {
        let todo = create(&f, "exercise", "活动笔记三态确认").await;
        let todo = f
            .repo
            .update_todo(
                &f.owner,
                &todo.id,
                UpdateTodo {
                    version: todo.version,
                    status: Some("in_progress".into()),
                    progress_notes: Some(Some("此前自行记录的活动笔记".into())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let mut body = json!({"kind":"exercise_completed","version":todo.version,"client_request_id":new_id(),"actual_minutes":23});
        if explicit_null {
            body["progress_notes"] = Value::Null;
        }
        let (code, result) = call(
            &f,
            &f.token,
            "POST",
            &format!("/v1/todos/{}/actions", todo.id),
            body,
        )
        .await;
        assert_eq!(code, StatusCode::OK, "{result}");
        let saved = f.repo.todo(&f.owner, &todo.id).await.unwrap();
        assert_eq!(saved.status, "completed");
        assert_eq!(result["reward"]["minutes"], 23);
        if explicit_null {
            assert!(
                saved.progress_notes.is_none(),
                "explicit null must clear prior activity notes: {:?}",
                saved.progress_notes
            );
            assert!(result["todo"]["progress_notes"].is_null());
        } else {
            assert_eq!(
                saved.progress_notes.as_deref(),
                Some("此前自行记录的活动笔记")
            );
        }
    }
}

#[tokio::test]
async fn deleting_a_context_source_fences_the_entire_late_generation_even_for_goal_only_output() {
    let f = fixture().await;
    enable(&f).await;
    let source = create(&f, "general", "删除后不可继续用于计划上下文").await;
    let (claim, context) = begin(&f).await;
    assert!(context
        .existing_todos
        .iter()
        .any(|todo| todo.id == source.id));
    f.repo.delete_todo(&f.owner, &source.id).await.unwrap();
    let stored_context: String =
        sqlx::query_scalar("SELECT context FROM growth_daily_plans WHERE user_id=$1 AND id=$2")
            .bind(&f.owner)
            .bind(&context.plan_id)
            .fetch_one(&f.repo.pool())
            .await
            .unwrap();
    assert!(
        stored_context.is_empty(),
        "source deletion fixture must invalidate stored context"
    );
    let late = f
        .repo
        .complete_daily_generation(
            &claim,
            &context,
            &json!({"items":[proposal(None,"纯目标新建议","learning")]}).to_string(),
        )
        .await;
    assert!(matches!(late,Err(DomainError::Conflict(_))|Ok(false)),"cleared DB context must fence old in-memory context even without a returned todo_id: {late:?}");
    assert!(f.repo.daily_plan(&f.owner).await.unwrap().items.is_empty());
    assert!(matches!(
        f.repo.todo(&f.owner, &source.id).await,
        Err(DomainError::NotFound)
    ));
    assert_eq!(f.repo.growth_summary(&f.owner).await.unwrap().total_xp, 0);
}

#[tokio::test]
async fn failed_plan_replayed_ensure_ack_is_read_only_and_only_a_new_retry_key_can_dispatch() {
    let f = fixture().await;
    enable(&f).await;
    let ensure = |key: &str| EnsureDailyPlan {
        client_request_id: Some(key.into()),
    };
    let first = f
        .repo
        .ensure_daily_plan(&f.owner, ensure("first-admission"))
        .await
        .unwrap();
    let claim = f.repo.claim_task(60).await.unwrap().unwrap();
    f.repo
        .begin_daily_generation(&claim)
        .await
        .unwrap()
        .unwrap();
    f.repo
        .fail_daily_generation(&claim, "synthetic first model failure; ACK lost")
        .await
        .unwrap();
    let replay = f
        .repo
        .ensure_daily_plan(&f.owner, ensure("first-admission"))
        .await
        .unwrap();
    assert_eq!(replay.id, first.id);
    assert_eq!(
        replay.status, "failed",
        "replay of the first admission must not spend a retry/model attempt"
    );
    let jobs = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM tasks WHERE user_id=$1 AND kind='daily_plan'",
        )
        .bind(&f.owner)
        .fetch_one(&f.repo.pool())
        .await
        .unwrap()
    };
    assert_eq!(jobs().await, 1);
    let retry = f
        .repo
        .ensure_daily_plan(&f.owner, ensure("explicit-new-retry"))
        .await
        .unwrap();
    assert_eq!(retry.id, first.id);
    assert_eq!(retry.status, "queued");
    assert_eq!(jobs().await, 2);
    let second = f.repo.claim_task(60).await.unwrap().unwrap();
    assert_ne!(second.task.id, claim.task.id);
    f.repo
        .begin_daily_generation(&second)
        .await
        .unwrap()
        .unwrap();
    f.repo
        .fail_daily_generation(&second, "synthetic second failure")
        .await
        .unwrap();
    let second_replay = f
        .repo
        .ensure_daily_plan(&f.owner, ensure("explicit-new-retry"))
        .await
        .unwrap();
    assert_eq!(second_replay.status, "failed");
    assert_eq!(jobs().await, 2);
    let exhausted = f
        .repo
        .ensure_daily_plan(&f.owner, ensure("third-new-key"))
        .await
        .unwrap();
    assert_eq!(exhausted.status, "failed");
    assert!(!exhausted.can_retry);
    assert_eq!(jobs().await, 2);
}
