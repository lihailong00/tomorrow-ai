use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
};
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

async fn call(router: &Router, token: &str, method: &str, body: Value) -> (u16, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri("/v1/private-vault/backup")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    assert_eq!(response.headers()["cache-control"], "no-store, private");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn envelope() -> Value {
    json!({"schema":1,"algorithm":"A256GCM","kid":"0123456789abcdef0123456789abcdef","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA=="})
}

#[tokio::test]
async fn vault_is_owner_scoped_ciphertext_only_and_deleted_backups_cannot_be_resurrected() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user("vault@fixture.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let other = repo
        .create_user("other-vault@fixture.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&owner.id).await.unwrap();
    let foreign = repo.create_session(&other.id).await.unwrap();
    let router = app(AppState::new(
        repo.clone(),
        ModelProvider::from_lookup(|_| None),
        "sqlite::memory:",
    ));
    assert_eq!(call(&router, "", "GET", json!({})).await.0, 401);
    assert_eq!(
        call(&router, &token, "GET", json!({})).await.1["version"],
        0
    );
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope()})
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(&router, &foreign, "GET", json!({})).await.1["envelope"],
        Value::Null
    );
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope()})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(&router, &token, "DELETE", json!({"expected_version":1}))
            .await
            .1["version"],
        2
    );
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":1,"envelope":envelope()})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope()})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(&router, &token, "GET", json!({})).await.1["envelope"],
        Value::Null
    );
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":2,"envelope":envelope()})
        )
        .await
        .0,
        200
    );
    assert!(repo.memories(&owner.id).await.unwrap().is_empty());
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":3,"envelope":envelope(),"user_id":other.id})
        )
        .await
        .0,
        422
    );
    let mut plaintext = envelope();
    plaintext["number"] = json!("0000000000001234");
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":3,"envelope":plaintext})
        )
        .await
        .0,
        422
    );
    let mut malformed = envelope();
    malformed["ciphertext"] = json!("plaintext!");
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":3,"envelope":malformed})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        call(&router, &foreign, "DELETE", json!({"expected_version":3}))
            .await
            .0,
        409
    );
    assert!(call(&router, &token, "GET", json!({})).await.1["envelope"].is_object());
}

#[tokio::test]
async fn deleting_an_absent_backup_leaves_a_tombstone_and_rejects_old_uploads() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("empty-vault@fixture.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let router = app(AppState::new(
        repo,
        ModelProvider::from_lookup(|_| None),
        "sqlite::memory:",
    ));
    let (status, deleted) = call(&router, &token, "DELETE", json!({"expected_version":0})).await;
    assert_eq!(status, 200);
    assert_eq!(deleted["version"], 1);
    assert_eq!(deleted["envelope"], Value::Null);
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":envelope()})
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(&router, &token, "GET", json!({})).await.1["version"],
        1
    );
}

#[tokio::test]
async fn ciphertext_encoding_decoded_size_and_body_limits_are_enforced_privately() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("format-vault@fixture.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let router = app(AppState::new(
        repo,
        ModelProvider::from_lookup(|_| None),
        "sqlite::memory:",
    ));
    for ciphertext in ["AAAAAAAAAAAAAAAAAAAAAB==".to_owned(), "A".repeat(262168)] {
        let mut value = envelope();
        value["ciphertext"] = json!(ciphertext);
        assert_eq!(
            call(
                &router,
                &token,
                "PUT",
                json!({"expected_version":0,"envelope":value})
            )
            .await
            .0,
            400
        );
    }
    let mut too_large = envelope();
    too_large["ciphertext"] = json!("A".repeat(300000));
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":too_large})
        )
        .await
        .0,
        413
    );
    let mut maximum = envelope();
    maximum["ciphertext"] = json!("A".repeat(262166) + "==");
    assert_eq!(
        call(
            &router,
            &token,
            "PUT",
            json!({"expected_version":0,"envelope":maximum})
        )
        .await
        .0,
        200
    );
}
