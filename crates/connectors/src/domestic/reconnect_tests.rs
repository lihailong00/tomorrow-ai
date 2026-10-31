use super::*;
use tests::{fixture, request};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

fn credentials(token: &str) -> Value {
    json!({"access_token":token,"refresh_token":"synthetic-refresh","expires_at":now()+7200,"open_id":"synthetic-user"})
}

async fn seed(state: &IntegrationState, user: &str, id: &str, value: Value) -> (i64, String) {
    let generation = state.reserve(user, id).await.unwrap();
    state.save(user, id, generation, &value).await.unwrap();
    state.account(user, id).await.unwrap().unwrap()
}

async fn assert_status(state: &IntegrationState, user: &str, id: &str, expected: &str) {
    let items = state.statuses(user).await.unwrap();
    assert_eq!(
        items.iter().find(|item| item["id"] == id).unwrap()["status"],
        expected
    );
    assert!(
        !serde_json::to_string(&items)
            .unwrap()
            .contains("synthetic-")
    );
}

fn callback(state: &str, denied: bool) -> CallbackQuery {
    CallbackQuery {
        state: Some(state.into()),
        code: (!denied).then(|| "synthetic-code".into()),
        error: denied.then(|| "access_denied".into()),
    }
}

async fn authorize(state: &IntegrationState, user: &str) -> String {
    reqwest::Url::parse(&state.authorize(user, "tencent_docs").await.unwrap())
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned()
}

// The provider origin override exists only in test builds. No real provider
// credential or request is used by these lifecycle tests.
async fn recording_provider(
    state: IntegrationState,
    status: u16,
    response: Value,
) -> (
    IntegrationState,
    oneshot::Receiver<String>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let values = std::collections::HashMap::from([
        ("TENCENT_DOCS_CLIENT_ID", "synthetic-client"),
        ("TENCENT_DOCS_CLIENT_SECRET", "synthetic-app-secret"),
        (
            "TENCENT_DOCS_REDIRECT_URI",
            "https://app.example/v1/integrations/tencent_docs/callback",
        ),
        ("TENCENT_DOCS_SCOPES", "scope.drive.readonly"),
    ]);
    let provider = oauth::OAuthProvider::from_lookup("tencent_docs", |key| {
        values.get(key).map(|value| (*value).into())
    })
    .unwrap()
    .with_test_origin(format!("http://{}", listener.local_addr().unwrap()));
    let mut inner = (*state.0).clone();
    inner
        .oauth_test_providers
        .insert("tencent_docs".into(), provider);
    let (received_tx, received_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 2048];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                break;
            }
            assert!(bytes.len() < 16_384);
        }
        received_tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        release_rx.await.unwrap();
        let body = serde_json::to_vec(&response).unwrap();
        socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
    });
    (
        IntegrationState(Arc::new(inner)),
        received_rx,
        release_tx,
        server,
    )
}

fn grant() -> Value {
    json!({"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","expires_in":7200,"user_id":"synthetic-new-user","scope":"scope.drive.readonly"})
}

#[tokio::test]
async fn malformed_token_and_mail_reconnect_preserve_the_working_connection() {
    let (state, a, b, ta, _) = fixture().await;
    let (_, old) = seed(&state, &a, "yuque", json!({"token":"synthetic-old-token"})).await;
    let other = seed(
        &state,
        &b,
        "yuque",
        json!({"token":"synthetic-other-token"}),
    )
    .await;
    let (_, mail) = seed(
        &state,
        &a,
        "qq_mail",
        json!({"email":"synthetic@qq.com","authorization_code":"synthetic1234"}),
    )
    .await;
    for value in [
        json!({}),
        json!({"token":""}),
        json!({"token":"invalid\nheader"}),
    ] {
        let (status, body) = request(
            &state,
            "POST",
            "/v1/integrations/yuque/connect",
            Some(&ta),
            value,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.to_string().contains("synthetic-"));
        assert_eq!(state.account(&a, "yuque").await.unwrap().unwrap().1, old);
        assert_eq!(state.account(&b, "yuque").await.unwrap().unwrap(), other);
        assert_status(&state, &a, "yuque", "connected").await;
    }
    let (status, _) = request(
        &state,
        "POST",
        "/v1/integrations/qq_mail/connect",
        Some(&ta),
        json!({"email":"synthetic@wrong.example","authorization_code":"synthetic1234"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(state.account(&a, "qq_mail").await.unwrap().unwrap().1, mail);
    assert_status(&state, &a, "qq_mail", "connected").await;
    state.disconnect(&a, "yuque").await.unwrap();
    assert!(
        state
            .account(&a, "yuque")
            .await
            .unwrap()
            .unwrap()
            .1
            .is_empty()
    );
    assert_status(&state, &a, "yuque", "not_connected").await;
    assert_eq!(state.account(&b, "yuque").await.unwrap().unwrap(), other);
    assert!(state.connect(&a, "zhihu", json!({})).await.is_err());
    assert_status(&state, &a, "zhihu", "not_connected").await;
}

#[tokio::test]
async fn oauth_begin_cancel_and_provider_rejection_retain_old_credentials() {
    let (state, a, b, ta, _) = fixture().await;
    let (state, received, release, server) =
        recording_provider(state, 403, json!({"error":"synthetic-provider-secret"})).await;
    let (_, old) = seed(
        &state,
        &a,
        "tencent_docs",
        credentials("synthetic-old-access"),
    )
    .await;
    let other = seed(
        &state,
        &b,
        "tencent_docs",
        credentials("synthetic-other-access"),
    )
    .await;
    let (status, response) = request(
        &state,
        "POST",
        "/v1/integrations/tencent_docs/authorize",
        Some(&ta),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let secret = reqwest::Url::parse(response["authorization_url"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(
        state.account(&a, "tencent_docs").await.unwrap().unwrap().1,
        old
    );
    assert_status(&state, &a, "tencent_docs", "connected").await;
    let path = format!("/v1/integrations/tencent_docs/callback?state={secret}&error=access_denied");
    assert_eq!(
        request(&state, "GET", &path, None, json!({})).await.0,
        StatusCode::OK
    );
    assert_eq!(
        state.account(&a, "tencent_docs").await.unwrap().unwrap().1,
        old
    );
    assert!(
        state
            .finish_authorize("tencent_docs", callback(&secret, true))
            .await
            .is_err()
    );
    let secret = authorize(&state, &a).await;
    let worker = state.clone();
    let task = tokio::spawn(async move {
        worker
            .finish_authorize("tencent_docs", callback(&secret, false))
            .await
    });
    assert!(received.await.unwrap().starts_with("GET /oauth/v2/token?"));
    assert_eq!(
        state.account(&a, "tencent_docs").await.unwrap().unwrap().1,
        old
    );
    release.send(()).unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert!(!error.to_string().contains("synthetic"));
    assert_eq!(
        state.account(&a, "tencent_docs").await.unwrap().unwrap().1,
        old
    );
    assert_status(&state, &a, "tencent_docs", "connected").await;
    assert_eq!(
        state.account(&b, "tencent_docs").await.unwrap().unwrap(),
        other
    );
    server.await.unwrap();
    state.disconnect(&a, "tencent_docs").await.unwrap();
    let secret = authorize(&state, &a).await;
    assert_status(&state, &a, "tencent_docs", "not_connected").await;
    assert!(
        !state
            .finish_authorize("tencent_docs", callback(&secret, true))
            .await
            .unwrap()
    );
    assert_status(&state, &a, "tencent_docs", "not_connected").await;
}

async fn replacement_fences_pending_reads(
    state: IntegrationState,
    replica: IntegrationState,
    user: String,
) {
    let (_, old) = seed(
        &state,
        &user,
        "yuque",
        json!({"token":"synthetic-old-token"}),
    )
    .await;
    let attempt = state.reserve(&user, "yuque").await.unwrap();
    assert_eq!(
        replica.account(&user, "yuque").await.unwrap().unwrap().1,
        old
    );
    for refresh in [false, true] {
        if refresh {
            state.reserve(&user, "yuque").await.unwrap();
        }
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let reader = replica.clone();
        let read_user = user.clone();
        let read = tokio::spawn(async move {
            let saver = reader.clone();
            let save_user = read_user.clone();
            reader
                .with_account_read(
                    &read_user,
                    "yuque",
                    Duration::from_secs(5),
                    |generation, credentials, lease| async move {
                        assert!(!credentials["token"].as_str().unwrap().is_empty());
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        if refresh {
                            saver
                                .save_under_read_lease(
                                    &save_user,
                                    "yuque",
                                    generation,
                                    &lease,
                                    &json!({"token":"synthetic-stale-refresh"}),
                                )
                                .await?;
                        }
                        Ok(json!({"items":[{"text":"private-prior-account-content"}]}))
                    },
                )
                .await
        });
        started_rx.await.unwrap();
        let generation = state.account(&user, "yuque").await.unwrap().unwrap().0;
        state
            .save(
                &user,
                "yuque",
                generation,
                &json!({"token":"synthetic-new-token"}),
            )
            .await
            .unwrap();
        assert!(
            state
                .save(
                    &user,
                    "yuque",
                    generation,
                    &json!({"token":"synthetic-replayed-save"})
                )
                .await
                .is_err()
        );
        release_tx.send(()).unwrap();
        assert_eq!(
            read.await.unwrap().unwrap_err().status,
            StatusCode::CONFLICT
        );
        let (_, encrypted) = state.account(&user, "yuque").await.unwrap().unwrap();
        assert_eq!(
            state.decode(&user, "yuque", &encrypted).unwrap()["token"],
            "synthetic-new-token"
        );
    }
    assert!(
        state
            .save(
                &user,
                "yuque",
                attempt,
                &json!({"token":"synthetic-old-attempt"})
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn reconnect_commit_fences_reads_and_refreshes_started_during_pending_verification() {
    let (state, a, _, _, _) = fixture().await;
    replacement_fences_pending_reads(state.clone(), state, a).await;
}

#[tokio::test]
async fn successful_oauth_reconnect_replaces_only_verified_credentials() {
    let (state, a, _, _, _) = fixture().await;
    let (state, received, release, server) = recording_provider(state, 200, grant()).await;
    let (_, old) = seed(
        &state,
        &a,
        "tencent_docs",
        credentials("synthetic-old-access"),
    )
    .await;
    let secret = authorize(&state, &a).await;
    let worker = state.clone();
    let replay = secret.clone();
    let task = tokio::spawn(async move {
        worker
            .finish_authorize("tencent_docs", callback(&secret, false))
            .await
    });
    let captured = received.await.unwrap();
    assert!(captured.contains("code=synthetic-code"));
    assert_eq!(
        state.account(&a, "tencent_docs").await.unwrap().unwrap().1,
        old
    );
    assert_status(&state, &a, "tencent_docs", "connected").await;
    release.send(()).unwrap();
    assert!(task.await.unwrap().unwrap());
    let (_, encrypted) = state.account(&a, "tencent_docs").await.unwrap().unwrap();
    assert_ne!(encrypted, old);
    assert!(!encrypted.contains("synthetic"));
    assert_eq!(
        state.decode(&a, "tencent_docs", &encrypted).unwrap()["access_token"],
        "synthetic-new-access"
    );
    assert!(
        state
            .finish_authorize("tencent_docs", callback(&replay, false))
            .await
            .is_err()
    );
    assert_status(&state, &a, "tencent_docs", "connected").await;
    server.await.unwrap();
}

#[tokio::test]
async fn retry_and_disconnect_fence_oauth_exchanges_already_in_flight() {
    for disconnect in [false, true] {
        let (state, a, _, _, _) = fixture().await;
        let (state, received, release, server) = recording_provider(state, 200, grant()).await;
        let (_, old) = seed(
            &state,
            &a,
            "tencent_docs",
            credentials("synthetic-old-access"),
        )
        .await;
        let secret = authorize(&state, &a).await;
        let worker = state.clone();
        let task = tokio::spawn(async move {
            worker
                .finish_authorize("tencent_docs", callback(&secret, false))
                .await
        });
        received.await.unwrap();
        let new_state = if disconnect {
            state.disconnect(&a, "tencent_docs").await.unwrap();
            None
        } else {
            Some(authorize(&state, &a).await)
        };
        release.send(()).unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().status,
            StatusCode::CONFLICT
        );
        let (_, encrypted) = state.account(&a, "tencent_docs").await.unwrap().unwrap();
        if let Some(secret) = new_state {
            assert_eq!(encrypted, old);
            assert!(
                !state
                    .finish_authorize("tencent_docs", callback(&secret, true))
                    .await
                    .unwrap()
            );
            assert_status(&state, &a, "tencent_docs", "connected").await;
        } else {
            assert!(encrypted.is_empty());
            assert_status(&state, &a, "tencent_docs", "not_connected").await;
        }
        server.await.unwrap();
    }
}

async fn concurrent_authorizations(
    state: &IntegrationState,
    replica: &IntegrationState,
    user: &str,
) {
    let (first, second) = tokio::join!(authorize(state, user), authorize(replica, user));
    let rows = sqlx::query("SELECT state_hash,generation FROM integration_oauth_states WHERE user_id=$1 AND provider='tencent_docs'").bind(user).fetch_all(&state.0.pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    let hash: String = rows[0].get("state_hash");
    assert_eq!(
        rows[0].get::<i64, _>("generation"),
        state
            .account(user, "tencent_docs")
            .await
            .unwrap()
            .unwrap()
            .0
    );
    let (current, stale) = if hash == digest(&first) {
        (first, second)
    } else {
        (second, first)
    };
    assert_eq!(hash, digest(&current));
    assert!(
        state
            .finish_authorize("tencent_docs", callback(&stale, true))
            .await
            .is_err()
    );
    assert!(
        !state
            .finish_authorize("tencent_docs", callback(&current, true))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn concurrent_authorization_start_keeps_only_the_latest_fenced_state() {
    let (state, a, _, _, _) = fixture().await;
    let (state, _, _, server) = recording_provider(state, 200, grant()).await;
    concurrent_authorizations(&state, &state, &a).await;
    assert_status(&state, &a, "tencent_docs", "not_connected").await;
    server.abort();
}

#[tokio::test]
#[ignore = "Requires an isolated PostgreSQL database via TEST_CONNECTORS_DATABASE_URL"]
async fn postgres_reconnect_fences_across_independent_pools() {
    let url = std::env::var("TEST_CONNECTORS_DATABASE_URL")
        .expect("set a disposable TEST_CONNECTORS_DATABASE_URL");
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user(
            &format!("reconnect-{}@example.test", tomorrow_domain::new_id()),
            "not-used",
            "Test",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let state =
        IntegrationState::with_crypto(repo, Some(Crypto::from_hex(&"01".repeat(32)).unwrap()))
            .await
            .unwrap();
    let replica = IntegrationState::with_crypto(
        Repository::connect(&url).await.unwrap(),
        Some(Crypto::from_hex(&"01".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    replacement_fences_pending_reads(state.clone(), replica.clone(), user.id.clone()).await;
    let (state, _, _, server) = recording_provider(state, 200, grant()).await;
    let mut inner = (*replica.0).clone();
    inner.oauth_test_providers = state.0.oauth_test_providers.clone();
    let replica = IntegrationState(Arc::new(inner));
    seed(
        &state,
        &user.id,
        "tencent_docs",
        credentials("synthetic-old-access"),
    )
    .await;
    concurrent_authorizations(&state, &replica, &user.id).await;
    assert_status(&state, &user.id, "tencent_docs", "connected").await;
    server.abort();
}
