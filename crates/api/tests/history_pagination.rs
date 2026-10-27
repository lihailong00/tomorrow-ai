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
async fn personal_history_continues_beyond_500_over_http() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository
        .create_user("history@api.test", "test", "历史", "UTC")
        .await
        .unwrap();
    let token = repository.create_session(&user.id).await.unwrap();
    let pool = repository.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in 0..505_i64 {
        for kind in ["conversation", "notification", "artifact"] {
            let id = format!("{kind}-{:04}-{}", 504 - index, new_id());
            let activity = format!("2026-10-28T00:00:00.{index:09}Z");
            let body = match kind {
                "conversation" => {
                    json!({"id":id,"title":format!("conversation{index}"),"updated_at":activity})
                }
                "notification" => {
                    json!({"id":id,"title":format!("notification{index}"),"body":"fixture","task_id":null,"read":index != 504,"created_at":activity})
                }
                _ => {
                    json!({"id":id,"title":format!("artifact{index}"),"task_id":"fixture","content":"fixture","mime_type":"text/markdown","created_at":activity})
                }
            };
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,$3,$4,1000,1000)")
                .bind(id).bind(&user.id).bind(kind).bind(body.to_string()).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let router = app(AppState::new(
        repository,
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    for endpoint in ["conversations", "notifications", "artifacts"] {
        let (status, first) = get(router.clone(), &token, &format!("/v1/{endpoint}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["items"].as_array().unwrap().len(), 500);
        assert_eq!(first["next_offset"], 500);
        let (status, tail) = get(
            router.clone(),
            &token,
            &format!("/v1/{endpoint}?offset=500&limit=50"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(tail["items"].as_array().unwrap().len(), 5);
        assert!(tail["next_offset"].is_null());
        assert!(first["items"].as_array().unwrap().iter().all(|item| {
            !tail["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|other| item["id"] == other["id"])
        }));
        for query in [
            "offset=-1",
            "limit=0",
            "limit=501",
            "offset=nope",
            "offset=9223372036854775807",
        ] {
            assert_eq!(
                get(router.clone(), &token, &format!("/v1/{endpoint}?{query}"))
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
    }
    let (_, first) = get(router.clone(), &token, "/v1/conversations?limit=1").await;
    assert_eq!(first["items"][0]["title"], "conversation504");
    let (_, unread) = get(
        router.clone(),
        &token,
        "/v1/notifications?read=false&limit=50",
    )
    .await;
    assert_eq!(unread["items"].as_array().unwrap().len(), 1);
    assert_eq!(unread["items"][0]["title"], "notification504");
    assert_eq!(
        get(router, &token, "/v1/notifications?read=maybe").await.0,
        StatusCode::BAD_REQUEST
    );
}
