use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use tower::ServiceExt;

#[tokio::test]
async fn managed_encryption_key_does_not_provision_a_wallet_runtime() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let values = HashMap::from([
        ("CONNECTOR_ENCRYPTION_KEY".into(), "42".repeat(32)),
        ("ALIPAY_WALLET_RUNTIME".into(), "official_cli_single_user".into()),
        ("ALIPAY_WALLET_OWNER_ID".into(), "ordinary-setting".into()),
    ]);
    let state = PersonalWalletState::with_configuration(repository, &values).await.unwrap();
    assert!(state.inner.crypto.is_some());
    assert!(state.inner.runtime.is_none());
    assert_eq!(state.status("ordinary-setting").await.unwrap()["binding_available"], false);
}

async fn fixture() -> (Router, Repository, String, String) {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repository
        .create_user("wallet-a@example.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repository
        .create_user("wallet-b@example.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let session_a = repository.create_session(&a.id).await.unwrap();
    let session_b = repository.create_session(&b.id).await.unwrap();
    let state = PersonalWalletState::new(repository.clone()).await.unwrap();
    (router(state), repository, session_a, session_b)
}

async fn request(
    app: Router,
    method: &str,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value, bool) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let no_store = response
        .headers()
        .get("cache-control")
        .is_some_and(|value| value == "no-store");
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap(), no_store)
}

#[tokio::test]
async fn all_wallet_routes_require_a_real_user_session() {
    let (app, _, _, _) = fixture().await;
    for (method, path) in [
        ("GET", "/v1/personal-wallet/alipay"),
        ("DELETE", "/v1/personal-wallet/alipay"),
        ("POST", "/v1/personal-wallet/alipay/authorize"),
        ("POST", "/v1/personal-wallet/alipay/bind"),
        ("POST", "/v1/personal-wallet/alipay/test"),
    ] {
        for token in ["", "not-a-session"] {
            let (status, _, no_store) =
                request(app.clone(), method, path, token, json!({"code":"654321"})).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
            assert!(no_store);
        }
    }
}

#[tokio::test]
async fn availability_is_honest_and_does_not_fabricate_a_binding() {
    let (app, repository, a, b) = fixture().await;
    for token in [&a, &b] {
        let (status, value, no_store) = request(
            app.clone(),
            "GET",
            "/v1/personal-wallet/alipay",
            token,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(no_store);
        assert_eq!(value["status"], "not_configured");
        assert_eq!(value["binding_available"], false);
        assert_eq!(value["payment_available"], false);
        assert!(value.get("authorization").is_none());
        assert!(value.get("account").is_none());
        assert!(value["reason"].as_str().unwrap().contains("个人钱包"));
        assert_eq!(value["requires_merchant_keys"], false);
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'personal_wallet%'")
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert_eq!(
        count, 0,
        "disabled provider must not persist wallet identities or codes"
    );
}

#[tokio::test]
async fn bind_and_authorize_fail_closed_without_echoing_or_retaining_codes() {
    let (app, _, session, _) = fixture().await;
    for path in ["authorize", "bind", "test"] {
        let (status, value, no_store) = request(app.clone(), "POST", &format!("/v1/personal-wallet/alipay/{path}"), &session,
            json!({"code":"654321","authorization_id":"private-authorization","token":"never-return-this","user_id":"another-user","configured":true})).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(no_store);
        assert_eq!(value["error"]["code"], "wallet_not_configured");
        let text = value.to_string();
        for secret in [
            "654321",
            "private-authorization",
            "never-return-this",
            "another-user",
        ] {
            assert!(!text.contains(secret));
        }
    }
}

#[tokio::test]
async fn disconnect_does_not_claim_to_revoke_an_unprovisioned_remote_wallet() {
    let (app, _, session, _) = fixture().await;
    for _ in 0..2 {
        let (status, value, _) = request(
            app.clone(),
            "DELETE",
            "/v1/personal-wallet/alipay",
            &session,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["status"], "not_configured");
        assert_eq!(value["remote_revoked"], false);
        assert_eq!(value["local_credentials_removed"], false);
    }
}

#[tokio::test]
async fn arbitrary_settings_cannot_turn_on_unverified_wallet_or_merchant_credentials() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let state = PersonalWalletState::new(repository)
        .await
        .unwrap()
        .reconfigured(&HashMap::from([
            ("ALIPAY_APP_ID".into(), "merchant-app".into()),
            ("ALIPAY_WALLET_ENABLED".into(), "true".into()),
            ("CONNECTOR_ENCRYPTION_KEY".into(), "42".repeat(32)),
        ]));
    let value = state.status("arbitrary-owner").await.unwrap();
    assert_eq!(value["status"], "not_configured");
    assert_eq!(value["binding_available"], false);
}
