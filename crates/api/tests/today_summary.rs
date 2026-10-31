use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{new_id, ModelProvider, Repository};
use tower::ServiceExt;

async fn today(router: axum::Router, token: &str) -> Value {
    let response = router
        .oneshot(
            Request::builder()
                .uri("/v1/today")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}

async fn seed(repository: &Repository, owner: &str, start: i64, end: i64) {
    let pool = repository.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in start..end {
        let id = format!("{owner}-{index:04}");
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,result,created_at,updated_at) VALUES($1,$2,'fixture','fixture',$3,'succeeded',$4,$5,$5)")
            .bind(&id).bind(owner).bind(if index == 0 { "briefing" } else { "general" })
            .bind(format!("saved-briefing-{owner}")).bind(index).execute(&mut *tx).await.unwrap();
        for kind in ["memory", "notification"] {
            let id = format!("{id}-{kind}");
            let body = if kind == "memory" {
                json!({"id":id,"title":"fixture","content":"fixture","kind":"fact","source":"test","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","version":1})
            } else {
                json!({"id":id,"title":"fixture","body":"fixture","read":index != 0,"created_at":"2026-01-01T00:00:00Z"})
            };
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)")
                .bind(id).bind(owner).bind(kind).bind(body.to_string()).bind(index).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
}

async fn verify(database_url: &str) {
    let repository = Repository::connect(database_url).await.unwrap();
    let owner = repository
        .create_user(&format!("{}@today.test", new_id()), "test", "Home", "UTC")
        .await
        .unwrap();
    let foreign = repository
        .create_user(
            &format!("{}@today.test", new_id()),
            "test",
            "Foreign",
            "UTC",
        )
        .await
        .unwrap();
    let token = repository.create_session(&owner.id).await.unwrap();
    let foreign_token = repository.create_session(&foreign.id).await.unwrap();
    let router = app(AppState::new(
        repository.clone(),
        ModelProvider::local(),
        database_url,
    ));
    let empty = today(router.clone(), &token).await;
    assert_eq!(
        empty["stats"],
        json!({"tasks_completed":0,"active_routines":0,"memory_count":0,"active_tasks":0,"unread_notifications":0})
    );
    for (start, end) in [(0, 499), (499, 500), (500, 501)] {
        seed(&repository, &owner.id, start, end).await;
        let body = today(router.clone(), &token).await;
        assert_eq!(body["stats"]["tasks_completed"], end);
        assert_eq!(body["stats"]["memory_count"], end);
        assert_eq!(body["stats"]["unread_notifications"], 1);
        assert_eq!(body["briefing"], format!("saved-briefing-{}", owner.id));
        for key in ["tasks", "memories", "notifications"] {
            assert_eq!(body[key].as_array().unwrap().len(), end.min(500) as usize);
        }
        if end == 501 {
            assert!(body["notifications"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["read"] == true));
            assert!(body["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["kind"] != "briefing"));
        }
    }
    let before_foreign = today(router.clone(), &token).await;
    seed(&repository, &foreign.id, 0, 503).await;
    assert_eq!(today(router.clone(), &token).await, before_foreign);
    let foreign_body = today(router.clone(), &foreign_token).await;
    assert_eq!(foreign_body["stats"]["tasks_completed"], 503);
    assert_eq!(foreign_body["stats"]["memory_count"], 503);
    assert_eq!(
        foreign_body["briefing"],
        format!("saved-briefing-{}", foreign.id)
    );
    for (index, status) in ["queued", "running", "waiting_approval", "uncertain"]
        .iter()
        .enumerate()
    {
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at) VALUES($1,$2,'old active','fixture','general',$3,-1,-1)")
            .bind(new_id()).bind(&owner.id).bind(status).execute(&repository.pool()).await.unwrap();
        sqlx::query("INSERT INTO schedules(id,user_id,title,prompt,frequency,time_of_day,timezone,enabled,next_run_at,created_at,updated_at) VALUES($1,$2,'routine','fixture','daily','09:00','UTC',$3,1,1,1)")
            .bind(new_id()).bind(&owner.id).bind(if index == 0 { 0_i64 } else { 1_i64 }).execute(&repository.pool()).await.unwrap();
    }
    // A newer unsuccessful briefing cannot replace the latest successful result.
    sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,result,created_at,updated_at) VALUES($1,$2,'failed briefing','fixture','briefing','failed','wrong',1000,1000)")
        .bind(new_id()).bind(&owner.id).execute(&repository.pool()).await.unwrap();
    let active = today(router.clone(), &token).await;
    assert_eq!(active["stats"]["active_tasks"], 4);
    assert_eq!(active["stats"]["active_routines"], 3);
    assert!(active["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["status"] != "queued"));
    assert_eq!(active["briefing"], format!("saved-briefing-{}", owner.id));
    sqlx::query("UPDATE tasks SET kind='general' WHERE user_id=$1 AND kind='briefing' AND status='succeeded'")
        .bind(&owner.id).execute(&repository.pool()).await.unwrap();
    let fallback = today(router, &token).await;
    assert!(fallback["briefing"]
        .as_str()
        .unwrap()
        .starts_with("你有 4 个进行中的任务、501 条记忆。"));
    for id in [&owner.id, &foreign.id] {
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(id)
            .execute(&repository.pool())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn home_summary_is_owner_wide_while_previews_remain_bounded_sqlite() {
    verify("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "Requires an isolated PostgreSQL TEST_E07_DATABASE_URL; no model or SMS requests"]
async fn home_summary_is_owner_wide_while_previews_remain_bounded_postgres() {
    verify(&std::env::var("TEST_E07_DATABASE_URL").unwrap()).await;
}
