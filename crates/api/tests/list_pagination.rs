use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tomorrow_api::{AppState, app};
use tomorrow_domain::{ModelProvider, Repository, new_id};
use tower::ServiceExt;

async fn get(router: axum::Router, token: &str, path: &str) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn lists_expose_older_filtered_records_and_validate_bounds_over_http() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository
        .create_user("pagination@api.test", "test", "分页", "UTC")
        .await
        .unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let pool = repository.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in 0..505_i64 {
        let id = format!("{index:04}-{}", new_id());
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at) VALUES($1,$2,'fixture','fixture','general',$3,$4,$4)")
            .bind(&id).bind(&user.id).bind(if index == 0 { "waiting_approval" } else { "succeeded" }).bind(index)
            .execute(&mut *tx).await.unwrap();
        let body = json!({"id":id,"title":"fixture","content":"fixture","kind":if index == 0 {"person"} else {"fact"},"source":"test","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","version":1}).to_string();
        sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,'memory',$3,$4,$4)")
            .bind(id).bind(&user.id).bind(body).bind(index).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let router = app(AppState::new(
        repository,
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    let (status, first) = get(router.clone(), &token, "/v1/tasks").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["items"].as_array().unwrap().len(), 500);
    assert_eq!(first["next_offset"], 500);
    let (_, tail) = get(router.clone(), &token, "/v1/tasks?offset=500&limit=50").await;
    assert_eq!(tail["items"].as_array().unwrap().len(), 5);
    assert_eq!(tail["items"][4]["status"], "waiting_approval");
    assert!(tail["next_offset"].is_null());
    let (_, active) = get(router.clone(), &token, "/v1/tasks?status=active&limit=50").await;
    assert_eq!(active["items"].as_array().unwrap().len(), 1);
    let (_, persons) = get(router.clone(), &token, "/v1/memories?kind=person&limit=50").await;
    assert_eq!(persons["items"].as_array().unwrap().len(), 1);
    assert_eq!(persons["items"][0]["kind"], "person");
    for path in [
        "/v1/tasks?offset=-1",
        "/v1/tasks?limit=0",
        "/v1/tasks?limit=501",
        "/v1/tasks?status=invalid",
        "/v1/tasks?offset=9223372036854775807",
        "/v1/tasks?offset=oops",
        "/v1/memories?offset=-1",
        "/v1/memories?limit=501",
        "/v1/memories?kind=invalid",
    ] {
        assert_eq!(
            get(router.clone(), &token, path).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}
