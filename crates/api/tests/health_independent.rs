//! Independent health route acceptance. All credentials are inert fixtures;
//! provider calls are deliberately avoided by testing refusal/denial paths.
use axum::{Router, body::{Body, to_bytes}, http::{Request, StatusCode}};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use tomorrow_api::{AppState, app};
use tomorrow_connectors::health::HealthState;
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

struct Fixture { repo: Repository, token: String, other_token: String, state: HealthState }

impl Fixture {
    async fn new(configured: bool) -> Self {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo.create_user("health-independent-a@example.test", "unused", "A", "Asia/Shanghai").await.unwrap();
        let other = repo.create_user("health-independent-b@example.test", "unused", "B", "Asia/Shanghai").await.unwrap();
        let token = repo.create_session(&user.id).await.unwrap();
        let other_token = repo.create_session(&other.id).await.unwrap();
        let mut values = HashMap::new();
        if configured {
            values.insert("CONNECTOR_ENCRYPTION_KEY".into(), "19".repeat(32));
            values.insert("INSTANCE_PUBLIC_URL".into(), "https://health-fixture.example.test".into());
            for prefix in ["HUAWEI_HEALTH", "XIAOMI_HEALTH"] {
                values.insert(format!("{prefix}_CLIENT_ID"), "123456789".into());
                values.insert(format!("{prefix}_CLIENT_SECRET"), "fixture-never-use-provider-secret".into());
            }
        }
        let state = HealthState::new(repo.clone()).await.unwrap().reconfigured(&values);
        Self { repo, token, other_token, state }
    }
    fn router(&self) -> Router {
        let mut state = AppState::new(self.repo.clone(), ModelProvider::local(), "sqlite::memory:");
        state.health = Some(self.state.clone());
        app(state)
    }
    async fn request(&self, method: &str, path: &str, token: &str, body: Option<Value>) -> (StatusCode, String) {
        let mut builder = Request::builder().method(method).uri(path);
        if !token.is_empty() { builder = builder.header("authorization", format!("Bearer {token}")); }
        let request = if let Some(body) = body {
            builder.header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
        } else { builder.body(Body::empty()).unwrap() };
        let response = self.router().oneshot(request).await.unwrap();
        assert_eq!(response.headers().get("cache-control").and_then(|value| value.to_str().ok()), Some("no-store"), "health response lost no-store: {method} {path} HTTP {}", response.status());
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }
    async fn begin(&self, provider: &str) -> reqwest::Url {
        let (status, body) = self.request("POST", &format!("/v1/health/connections/{provider}/authorize"), &self.token, Some(json!({"metrics":["steps"]}))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let json: Value = serde_json::from_str(&body).unwrap();
        reqwest::Url::parse(json["authorization_url"].as_str().unwrap()).unwrap()
    }
}

#[tokio::test]
async fn health_mount_requires_real_session_and_has_no_automatic_sync() {
    let f = Fixture::new(false).await;
    for provider in ["huawei", "xiaomi"] {
        for (method, suffix, body) in [
            ("POST", "/authorize", Some(json!({"metrics":["steps"]}))),
            ("POST", "/sync", None),
            ("DELETE", "", None),
        ] {
            assert_eq!(f.request(method, &format!("/v1/health/connections/{provider}{suffix}"), "", body).await.0, StatusCode::UNAUTHORIZED);
        }
    }
    assert_eq!(f.request("GET", "/v1/health/connections", "bad-session", None).await.0, StatusCode::UNAUTHORIZED);
    let (status, body) = f.request("GET", "/v1/health/connections", &f.token, None).await;
    assert_eq!(status, StatusCode::OK);
    let data: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(data["items"].as_array().unwrap().len(), 2);
    for item in data["items"].as_array().unwrap() {
        assert_eq!(item["status"], "not_configured");
        assert_eq!(item["has_credentials"], false);
        assert!(item["last_sync_at"].is_null());
    }
    assert!(!body.contains("access_token"));
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_connector_accounts").fetch_one(&f.repo.pool()).await.unwrap();
    assert_eq!(accounts, 0);
    for provider in ["huawei", "xiaomi"] {
        assert_eq!(f.request("POST", &format!("/v1/health/connections/{provider}/authorize"), &f.token, Some(json!({"metrics":["steps"]}))).await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(f.request("POST", &format!("/v1/health/connections/{provider}/sync"), &f.token, None).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }
}

#[tokio::test]
async fn health_oauth_is_exact_read_scope_and_user_data_stays_private() {
    let f = Fixture::new(true).await;
    for provider in ["huawei", "xiaomi"] {
        let url = f.begin(provider).await;
        let pairs: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["redirect_uri"], format!("https://health-fixture.example.test/v1/health/oauth/{provider}/callback"));
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(pairs["scope"], if provider == "huawei" { "https://www.huawei.com/healthkit/step.read" } else { "200016 200013" });
        assert!(!url.as_str().contains("fixture-never-use-provider-secret"));
        assert!(!url.as_str().contains(&f.token));
        let row = sqlx::query("SELECT state_hash,encrypted_pending FROM health_oauth_states WHERE provider=$1").bind(provider).fetch_one(&f.repo.pool()).await.unwrap();
        let hash: String = row.get("state_hash");
        let ciphertext: String = row.get("encrypted_pending");
        assert_ne!(hash, pairs["state"]);
        assert!(!ciphertext.contains(&f.token));
        let (_, other_body) = f.request("GET", "/v1/health/connections", &f.other_token, None).await;
        let other: Value = serde_json::from_str(&other_body).unwrap();
        assert!(other["items"].as_array().unwrap().iter().all(|item| item["has_credentials"] == false));
        assert_eq!(f.request("POST", &format!("/v1/health/connections/{provider}/sync"), &f.other_token, None).await.0, StatusCode::CONFLICT);
        // Denial consumes state without issuing a token exchange.
        let path = format!("/v1/health/oauth/{provider}/callback?error=access_denied&state={}", pairs["state"]);
        let first = f.request("GET", &path, "", None).await;
        assert_eq!(first.0, StatusCode::BAD_REQUEST);
        assert!(first.1.contains("取消健康数据授权"));
        let replay = f.request("GET", &path, "", None).await;
        assert_eq!(replay.0, StatusCode::BAD_REQUEST);
        assert!(replay.1.contains("已失效或已使用"));
    }
}

#[tokio::test]
async fn health_disconnect_invalidates_pending_authorization_without_false_remote_revocation() {
    let f = Fixture::new(true).await;
    let url = f.begin("xiaomi").await;
    let state = url.query_pairs().find(|(key, _)| key == "state").unwrap().1.into_owned();
    let (status, body) = f.request("DELETE", "/v1/health/connections/xiaomi", &f.token, None).await;
    assert_eq!(status, StatusCode::OK);
    let data: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(data["local_credentials_removed"], true);
    assert_eq!(data["remote_revoked"], false);
    assert_eq!(f.request("GET", &format!("/v1/health/oauth/xiaomi/callback?error=access_denied&state={state}"), "", None).await.0, StatusCode::BAD_REQUEST);
    let states: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_oauth_states").fetch_one(&f.repo.pool()).await.unwrap();
    assert_eq!(states, 0);
}

#[tokio::test]
async fn health_invalid_scopes_windows_and_foreign_callback_do_not_reach_provider() {
    let f = Fixture::new(true).await;
    for input in [json!({"metrics":[]}), json!({"metrics":["steps","sleep"]}), json!({"metrics":["steps"],"redirect_uri":"https://evil.test"})] {
        let status = f.request("POST", "/v1/health/connections/huawei/authorize", &f.token, Some(input)).await.0;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY);
    }
    for days in [0, 31, 999] {
        assert_eq!(f.request("POST", "/v1/health/connections/xiaomi/sync", &f.token, Some(json!({"days":days}))).await.0, StatusCode::BAD_REQUEST);
    }
    let url = f.begin("xiaomi").await;
    let state = url.query_pairs().find(|(key, _)| key == "state").unwrap().1.into_owned();
    assert_eq!(f.request("GET", &format!("/v1/health/oauth/huawei/callback?error=access_denied&state={state}"), "", None).await.0, StatusCode::BAD_REQUEST);
    let (_, body) = f.request("GET", &format!("/v1/health/oauth/xiaomi/callback?error=access_denied&state={state}"), "", None).await;
    assert!(body.contains("取消健康数据授权"));
}

#[tokio::test]
async fn health_logout_invalidates_an_outstanding_browser_authorization() {
    let f = Fixture::new(true).await;
    let url = f.begin("xiaomi").await;
    let state = url.query_pairs().find(|(key, _)| key == "state").unwrap().1.into_owned();
    f.repo.logout(&f.token).await.unwrap();
    let (_, body) = f.request("GET", &format!("/v1/health/oauth/xiaomi/callback?error=access_denied&state={state}"), "", None).await;
    assert!(body.contains("已失效或已使用"));
    assert!(!body.contains("取消健康数据授权"));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_connector_accounts WHERE encrypted_tokens<>''").fetch_one(&f.repo.pool()).await.unwrap();
    assert_eq!(count, 0);
    assert_eq!(f.request("GET", "/v1/health/connections", &f.token, None).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn health_malformed_sync_json_is_not_treated_as_an_unscoped_default_sync() {
    let f = Fixture::new(true).await;
    for (content_type, body) in [(Some("application/json"), "{broken-json"), (None, "{\"metrics\":[\"sleep\"]}"), (Some("text/plain"), "{\"metrics\":[\"sleep\"]}")] {
        let mut request = Request::builder().method("POST").uri("/v1/health/connections/xiaomi/sync")
            .header("authorization", format!("Bearer {}", f.token));
        if let Some(content_type) = content_type { request = request.header("content-type", content_type); }
        let response = f.router().oneshot(request.body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "malformed/missing Content-Type must not expand selected metrics");
    }
}

#[tokio::test]
async fn health_finalize_requires_auth_configuration_and_a_real_single_use_receipt() {
    let f = Fixture::new(true).await;
    let path = "/v1/health/connections/xiaomi/finalize";
    assert_eq!(f.request("POST", path, "", Some(json!({"receipt":"x".repeat(43)}))).await.0, StatusCode::UNAUTHORIZED);
    for receipt in [String::new(), "short".into(), "x x".into(), "x".repeat(44)] {
        assert_eq!(f.request("POST", path, &f.token, Some(json!({"receipt":receipt}))).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(f.request("POST", path, &f.token, Some(json!({"receipt":"x".repeat(43)}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.request("POST", path, &f.other_token, Some(json!({"receipt":"x".repeat(43)}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(f.request("POST", path, &f.token, Some(json!({}))).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_connector_accounts WHERE encrypted_tokens<>''").fetch_one(&f.repo.pool()).await.unwrap();
    assert_eq!(active, 0);
    let missing = Fixture::new(false).await;
    assert_eq!(missing.request("POST", path, &missing.token, Some(json!({"receipt":"x".repeat(43)}))).await.0, StatusCode::SERVICE_UNAVAILABLE);
}
