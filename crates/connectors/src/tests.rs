use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use config::Endpoints;
use crypto::Crypto;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};
use tower::ServiceExt;

fn config() -> Config {
    Config {
        client_id: "test-client-id".into(),
        client_secret: "test-only-client-secret".into(),
        redirect_uri: "http://localhost:8080/v1/connectors/google/callback".into(),
        crypto: Crypto::from_hex(&"01".repeat(32)).unwrap(),
        endpoints: Endpoints::default(),
    }
}

async fn fixture(config: Option<Config>) -> (ConnectorState, String, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user_a = repo
        .create_user(
            "connector-a@example.test",
            "not-used-in-test",
            "A",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let user_b = repo
        .create_user(
            "connector-b@example.test",
            "not-used-in-test",
            "B",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token_a = repo.create_session(&user_a.id).await.unwrap();
    let token_b = repo.create_session(&user_b.id).await.unwrap();
    let state = ConnectorState::with_config(repo, config).await.unwrap();
    (state, user_a.id, user_b.id, token_a, token_b)
}

async fn store_tokens(state: &ConnectorState, user: &str, service: Service, expires_at: i64) {
    let config = state.config().unwrap();
    let tokens = Tokens {
        access_token: "test-only-access-secret".into(),
        refresh_token: Some("test-only-refresh-secret".into()),
        expires_at,
        scope: service.scope().into(),
    };
    let ciphertext = config
        .crypto
        .encrypt(
            user,
            service.id(),
            "tokens",
            &serde_json::to_vec(&tokens).unwrap(),
        )
        .unwrap();
    sqlx::query("INSERT INTO google_connector_accounts(user_id,service,generation,encrypted_tokens,updated_at) VALUES($1,$2,1,$3,$4) ON CONFLICT(user_id,service) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,updated_at=excluded.updated_at").bind(user).bind(service.id()).bind(ciphertext).bind(now()).execute(&state.inner.pool).await.unwrap();
}

async fn request(
    state: &ConnectorState,
    method: &str,
    uri: &str,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = router(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn oauth_state(url: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned()
}

fn mock_http(status: &str, body: &str) -> (String, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let status = status.to_owned();
    let body = body.to_owned();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let (header_end, content_length) = loop {
            let count = socket.read(&mut buffer).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                break (end + 4, length);
            }
        };
        while bytes.len() < header_end + content_length {
            let count = socket.read(&mut buffer).unwrap();
            assert_ne!(count, 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        sender
            .send(
                String::from_utf8(bytes[header_end..header_end + content_length].to_vec()).unwrap(),
            )
            .unwrap();
        write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    });
    (format!("http://{address}"), receiver)
}

#[test]
fn encryption_is_random_authenticated_and_bound_to_user_service_and_purpose() {
    let crypto = Crypto::from_hex(&"01".repeat(32)).unwrap();
    let first = crypto
        .encrypt("user-a", "gmail", "tokens", b"very secret tokens")
        .unwrap();
    let second = crypto
        .encrypt("user-a", "gmail", "tokens", b"very secret tokens")
        .unwrap();
    assert_ne!(first, second);
    assert!(!first.contains("secret"));
    assert_eq!(
        crypto.decrypt("user-a", "gmail", "tokens", &first).unwrap(),
        b"very secret tokens"
    );
    assert!(crypto.decrypt("user-b", "gmail", "tokens", &first).is_err());
    assert!(
        crypto
            .decrypt("user-a", "google_drive", "tokens", &first)
            .is_err()
    );
    assert!(crypto.decrypt("user-a", "gmail", "pkce", &first).is_err());
    let other = Crypto::from_hex(&"02".repeat(32)).unwrap();
    assert!(other.decrypt("user-a", "gmail", "tokens", &first).is_err());
    assert!(Crypto::from_hex("short").is_err());
    assert!(Crypto::from_hex(&"zz".repeat(32)).is_err());
}

#[tokio::test]
async fn oauth_state_is_hashed_once_only_short_lived_and_pkce_bound() {
    let (state, user, _, _, _) = fixture(Some(config())).await;
    let url = state
        .begin_authorization(&user, Service::Gmail)
        .await
        .unwrap();
    let parsed = Url::parse(&url).unwrap();
    let params = parsed
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(params["scope"], Service::Gmail.scope());
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["redirect_uri"],
        "http://localhost:8080/v1/connectors/google/callback"
    );
    let raw = oauth_state(&url);
    assert_eq!(raw.len(), 43);
    let row =
        sqlx::query("SELECT state_hash,encrypted_verifier,expires_at FROM google_oauth_states")
            .fetch_one(&state.inner.pool)
            .await
            .unwrap();
    assert_ne!(row.get::<String, _>("state_hash"), raw);
    assert!(row.get::<i64, _>("expires_at") <= now() + 600);
    let pending = state.consume_state(&raw).await.unwrap();
    assert_eq!(pending.user_id, user);
    assert_eq!(digest(&pending.verifier), params["code_challenge"]);
    assert_ne!(row.get::<String, _>("encrypted_verifier"), pending.verifier);
    assert!(state.consume_state(&raw).await.is_err());
    let second = oauth_state(
        &state
            .begin_authorization(&user, Service::Calendar)
            .await
            .unwrap(),
    );
    sqlx::query("UPDATE google_oauth_states SET expires_at=$1")
        .bind(now() - 1)
        .execute(&state.inner.pool)
        .await
        .unwrap();
    assert!(state.consume_state(&second).await.is_err());
}

#[tokio::test]
async fn authorization_requires_login_and_connection_data_is_user_isolated() {
    let (state, user_a, user_b, token_a, token_b) = fixture(Some(config())).await;
    store_tokens(&state, &user_a, Service::Gmail, now() + 3600).await;
    assert_eq!(
        request(&state, "GET", "/v1/connectors", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&state, "POST", "/v1/connectors/gmail/authorize", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, a) = request(&state, "GET", "/v1/connectors", Some(&token_a)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(a["items"][1]["status"], "connected");
    assert!(!a.to_string().contains("test-only-access-secret"));
    assert!(!a.to_string().contains("refresh"));
    let (_, b) = request(&state, "GET", "/v1/connectors", Some(&token_b)).await;
    assert_eq!(b["items"][1]["status"], "not_connected");
    assert_eq!(
        request(
            &state,
            "GET",
            "/v1/connectors/gmail/messages",
            Some(&token_b)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    request(&state, "DELETE", "/v1/connectors/gmail", Some(&token_b)).await;
    assert_eq!(
        state.statuses(&user_a).await.unwrap()[1].status,
        "connected"
    );
    assert_eq!(
        state.statuses(&user_b).await.unwrap()[1].status,
        "not_connected"
    );
}

#[tokio::test]
async fn missing_configuration_is_explicit_and_never_returns_mock_google_data() {
    let (state, _, _, token, _) = fixture(None).await;
    let (_, body) = request(&state, "GET", "/v1/connectors", Some(&token)).await;
    assert!(
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["status"] == "not_configured")
    );
    let (status, error) = request(
        &state,
        "POST",
        "/v1/connectors/gmail/authorize",
        Some(&token),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["error"]["code"], "not_configured");
    assert_eq!(
        request(
            &state,
            "GET",
            "/v1/connectors/google_drive/files",
            Some(&token)
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(
            &state,
            "GET",
            "/v1/connectors/gmail/messages?page_size=101",
            Some(&token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn refresh_is_real_http_and_new_tokens_remain_encrypted() {
    let (endpoint, receiver) = mock_http(
        "200 OK",
        r#"{"access_token":"new-test-access","expires_in":3600,"token_type":"Bearer"}"#,
    );
    let mut config = config();
    config.endpoints.token = format!("{endpoint}/token");
    let (state, user, _, _, _) = fixture(Some(config)).await;
    store_tokens(&state, &user, Service::Gmail, now() - 1).await;
    assert_eq!(
        state
            .access_token(&user, Service::Gmail, false)
            .await
            .unwrap(),
        "new-test-access"
    );
    let request = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    let parsed = Url::parse(&format!("http://local/?{request}")).unwrap();
    let params = parsed
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(params["grant_type"], "refresh_token");
    assert_eq!(params["refresh_token"], "test-only-refresh-secret");
    let account = state.account(&user, Service::Gmail).await.unwrap().unwrap();
    assert!(!account.ciphertext.contains("new-test-access"));
    assert!(!account.ciphertext.contains("refresh-secret"));
    let tokens = state
        .decode_tokens(
            state.config().unwrap(),
            &user,
            Service::Gmail,
            &account.ciphertext,
        )
        .unwrap();
    assert_eq!(
        tokens.refresh_token.as_deref(),
        Some("test-only-refresh-secret")
    );
    // The still-valid access token is reused, not refreshed for every read.
    assert_eq!(
        state
            .access_token(&user, Service::Gmail, false)
            .await
            .unwrap(),
        "new-test-access"
    );
}

#[tokio::test]
async fn disconnect_is_local_first_even_when_remote_revocation_fails() {
    let (endpoint, receiver) = mock_http(
        "500 Internal Server Error",
        r#"{"error":"do not expose private token"}"#,
    );
    let mut config = config();
    config.endpoints.revoke = format!("{endpoint}/revoke");
    let (state, user, _, _, _) = fixture(Some(config)).await;
    store_tokens(&state, &user, Service::Gmail, now() + 3600).await;
    store_tokens(&state, &user, Service::Calendar, now() + 3600).await;
    let raw = oauth_state(
        &state
            .begin_authorization(&user, Service::Gmail)
            .await
            .unwrap(),
    );
    let result = state.disconnect(&user, Service::Gmail).await.unwrap();
    receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["revoked"], false);
    assert!(!result.to_string().contains("private token"));
    assert_eq!(
        state.statuses(&user).await.unwrap()[1].status,
        "not_connected"
    );
    assert_eq!(state.statuses(&user).await.unwrap()[0].status, "connected");
    assert!(state.consume_state(&raw).await.is_err());
    assert!(
        state
            .access_token(&user, Service::Gmail, false)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn successful_project_revocation_invalidates_related_local_google_connections() {
    let (endpoint, receiver) = mock_http("200 OK", "{}");
    let mut config = config();
    config.endpoints.revoke = format!("{endpoint}/revoke");
    let (state, user, _, _, _) = fixture(Some(config)).await;
    store_tokens(&state, &user, Service::Gmail, now() + 3600).await;
    store_tokens(&state, &user, Service::Drive, now() + 3600).await;
    let result = state.disconnect(&user, Service::Gmail).await.unwrap();
    receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result["revoked"], true);
    assert_eq!(result["disconnected_ids"].as_array().unwrap().len(), 3);
    assert!(
        state
            .statuses(&user)
            .await
            .unwrap()
            .iter()
            .all(|connector| connector.status == "not_connected")
    );
}

#[tokio::test]
async fn a_late_callback_cannot_restore_a_disconnected_account() {
    let (endpoint, receiver) = mock_http(
        "200 OK",
        r#"{"access_token":"new-test-access","refresh_token":"new-test-refresh","expires_in":3600,"token_type":"Bearer"}"#,
    );
    let mut config = config();
    config.endpoints.token = format!("{endpoint}/token");
    let (state, user, _, _, _) = fixture(Some(config)).await;
    let raw = oauth_state(
        &state
            .begin_authorization(&user, Service::Gmail)
            .await
            .unwrap(),
    );
    let pending = state.consume_state(&raw).await.unwrap();
    let expected_verifier = pending.verifier.clone();
    state
        .clear_local(&user, Some(Service::Gmail))
        .await
        .unwrap();
    assert!(
        state
            .exchange_code(pending, "test-only-authorization-code")
            .await
            .is_err()
    );
    let request = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    let parsed = Url::parse(&format!("http://local/?{request}")).unwrap();
    let params = parsed
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(params["code_verifier"], expected_verifier);
    assert_eq!(
        state.statuses(&user).await.unwrap()[1].status,
        "not_connected"
    );
    assert!(
        state
            .account(&user, Service::Gmail)
            .await
            .unwrap()
            .unwrap()
            .ciphertext
            .is_empty()
    );
}
