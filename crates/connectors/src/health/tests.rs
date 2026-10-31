use super::*;
use axum::{
    extract::{Query as AxumQuery, State as AxumState},
    routing::{get, post},
};
use base64::Engine;
use std::sync::atomic::{AtomicUsize, Ordering};

fn settings() -> HashMap<String, String> {
    HashMap::from([
        ("CONNECTOR_ENCRYPTION_KEY".into(), "41".repeat(32)),
        ("XIAOMI_HEALTH_CLIENT_ID".into(), "12345".into()),
        (
            "XIAOMI_HEALTH_CLIENT_SECRET".into(),
            "test-client-secret".into(),
        ),
        ("HUAWEI_HEALTH_CLIENT_ID".into(), "54321".into()),
        (
            "HUAWEI_HEALTH_CLIENT_SECRET".into(),
            "test-huawei-secret".into(),
        ),
        (
            "INSTANCE_PUBLIC_URL".into(),
            "https://health.example.test".into(),
        ),
    ])
}

async fn fixture() -> (HealthState, String, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("health-a@example.test", "unused", "A", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("health-b@example.test", "unused", "B", "Asia/Shanghai")
        .await
        .unwrap();
    let sa = repo.create_session(&a.id).await.unwrap();
    let sb = repo.create_session(&b.id).await.unwrap();
    (
        HealthState::with_config(repo, Config::from_lookup(|k| settings().get(k).cloned()))
            .await
            .unwrap(),
        a.id,
        b.id,
        sa,
        sb,
    )
}

fn state_from(url: &str) -> String {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}

#[test]
fn redirects_are_fixed_and_only_https_or_loopback() {
    for bad in [
        "https://u:p@health.example.test/v1/health/oauth/xiaomi/callback",
        "http://health.example.test/v1/health/oauth/xiaomi/callback",
        "https://health.example.test/v1/health/oauth/huawei/callback",
        "https://health.example.test/v1/health/oauth/xiaomi/callback?redirect=evil",
        "https://health.example.test/v1/health/oauth/xiaomi/callback#token",
    ] {
        assert!(!config::valid_redirect(bad, Provider::Xiaomi));
    }
    assert!(config::valid_redirect(
        "http://127.0.0.1:18091/v1/health/oauth/xiaomi/callback",
        Provider::Xiaomi
    ));
    let values = settings();
    let config = Config::from_lookup(|k| values.get(k).cloned());
    assert_eq!(
        config.provider(Provider::Xiaomi).unwrap().redirect,
        "https://health.example.test/v1/health/oauth/xiaomi/callback"
    );
    let mut invalid = values.clone();
    invalid.insert(
        "INSTANCE_PUBLIC_URL".into(),
        "https://example.test/evil".into(),
    );
    assert!(
        Config::from_lookup(|k| invalid.get(k).cloned())
            .providers
            .is_empty()
    );
    invalid.insert("INSTANCE_PUBLIC_URL".into(), "http://example.test".into());
    assert!(
        Config::from_lookup(|k| invalid.get(k).cloned())
            .providers
            .is_empty()
    );
}

#[test]
fn only_confirmed_read_metrics_are_exposed() {
    assert!(validate_metrics(Provider::Huawei, vec!["heart_rate".into()]).is_err());
    assert!(validate_metrics(Provider::Xiaomi, vec!["payment".into()]).is_err());
    assert!(validate_metrics(Provider::Xiaomi, vec![]).is_err());
    assert_eq!(Provider::Huawei.metrics(), ["steps"]);
    for provider in Provider::all() {
        for metric in provider.metrics() {
            assert!(!provider.scope(metric).unwrap().contains("write"))
        }
    }
}

#[tokio::test]
async fn authorize_uses_exact_scopes_and_encrypts_the_session() {
    let (state, a, _, session, _) = fixture().await;
    let url = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let parsed = reqwest::Url::parse(&url).unwrap();
    let pairs: HashMap<_, _> = parsed.query_pairs().collect();
    assert_eq!(parsed.host_str(), Some("account.xiaomi.com"));
    assert_eq!(pairs.get("scope").unwrap(), "200016 200013");
    assert_eq!(pairs.get("skip_confirm").unwrap(), "false");
    let cipher: String = sqlx::query_scalar("SELECT encrypted_pending FROM health_oauth_states")
        .fetch_one(&state.inner.pool)
        .await
        .unwrap();
    assert!(!cipher.contains(&session));
    assert!(!cipher.contains("steps"));
    let consumed = state
        .consume(Provider::Xiaomi, &state_from(&url))
        .await
        .unwrap();
    assert_eq!(consumed.user, a);
    assert_eq!(consumed.pending.session, session);
    assert!(
        state
            .consume(Provider::Xiaomi, &state_from(&url))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn logout_invalidates_pending_authorization() {
    let (state, a, _, session, _) = fixture().await;
    let url = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    state.inner.repo.logout(&session).await.unwrap();
    assert!(
        state
            .consume(Provider::Xiaomi, &state_from(&url))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn state_is_bound_to_provider_configuration_and_generation() {
    let (state, a, _, session, _) = fixture().await;
    let old = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let current = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    assert!(
        state
            .consume(Provider::Xiaomi, &state_from(&old))
            .await
            .is_err()
    );
    assert!(
        state
            .consume(Provider::Huawei, &state_from(&current))
            .await
            .is_err()
    );
    let mut changed = settings();
    changed.insert("XIAOMI_HEALTH_CLIENT_SECRET".into(), "rotated".into());
    assert!(
        state
            .reconfigured(&changed)
            .consume(Provider::Xiaomi, &state_from(&current))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn disconnect_cancels_pending_and_removes_only_owners_credentials() {
    let (state, a, b, session, sb) = fixture().await;
    let ua = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let ub = state
        .authorize(&b, &sb, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let result = state.disconnect(&a, "xiaomi").await.unwrap();
    assert_eq!(result["remote_revoked"], false);
    assert!(
        state
            .consume(Provider::Xiaomi, &state_from(&ua))
            .await
            .is_err()
    );
    assert_eq!(
        state
            .consume(Provider::Xiaomi, &state_from(&ub))
            .await
            .unwrap()
            .user,
        b
    );
}

#[tokio::test]
async fn denied_callback_is_consumed_without_network_or_credentials() {
    let (state, a, _, session, _) = fixture().await;
    let url = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let result = state
        .complete(
            Provider::Xiaomi,
            Callback {
                state: Some(state_from(&url)),
                code: None,
                error: Some("denied-private-provider-message".into()),
            },
        )
        .await;
    let error = result.err().unwrap();
    assert_eq!(error.code, "health_authorization_denied");
    assert!(!error.message.contains("private"));
    assert!(
        state
            .account(&a, Provider::Xiaomi)
            .await
            .unwrap()
            .unwrap()
            .ciphertext
            .is_empty()
    );
    assert!(
        state
            .consume(Provider::Xiaomi, &state_from(&url))
            .await
            .is_err()
    );
}

#[derive(Clone)]
struct Mock {
    scopes: String,
    calls: Arc<AtomicUsize>,
    mode: Arc<AtomicUsize>,
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
async fn mock_token(AxumState(mock): AxumState<Mock>) -> Json<Value> {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    if mock.mode.load(Ordering::SeqCst) == 7 {
        mock.reached.notify_one();
        mock.release.notified().await;
    }
    let token_type = if mock.mode.load(Ordering::SeqCst) == 5 {
        "unknown"
    } else if mock.scopes.starts_with("https:") {
        "Bearer"
    } else {
        "mac"
    };
    Json(
        json!({"access_token":"synthetic-health-access","refresh_token":"synthetic-health-refresh","expires_in":3600,"scope":mock.scopes,"token_type":token_type,"mac_key":"synthetic-mac-key","mac_algorithm":"HmacSHA1"}),
    )
}
async fn mock_data(
    AxumState(mock): AxumState<Mock>,
    AxumQuery(query): AxumQuery<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    mock.calls.fetch_add(1, Ordering::SeqCst);
    if mock.mode.load(Ordering::SeqCst) == 6 {
        mock.reached.notify_one();
        mock.release.notified().await;
    }
    assert_eq!(headers["authorization"], "Bearer synthetic-health-access");
    assert_eq!(headers["x-client-id"], "12345");
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(headers["x-client-nonce"].to_str().unwrap())
        .unwrap();
    assert_eq!(nonce.len(), 12);
    assert_eq!(
        u32::from_be_bytes(nonce[8..].try_into().unwrap()),
        (now() / 60) as u32
    );
    if mock.mode.load(Ordering::SeqCst) == 1 {
        return Json(json!({"group":[]}));
    }
    if mock.mode.load(Ordering::SeqCst) == 2 {
        return Json(json!({"unexpected":"not healthy"}));
    }
    let data_type = query.get("dataTypeName").unwrap();
    let (field, amount) = match data_type.as_str() {
        "com.xiaomi.steps.delta" => ("steps_delta", 15.0),
        "com.xiaomi.heart_rate.delta" => ("bpm", 72.0),
        "com.xiaomi.weight.instantaneous" => ("weight", 68.2),
        "com.xiaomi.calories.delta" => ("calories", 14.5),
        "com.xiaomi.sleep.health" => ("all_sleep_duration", 480.0),
        _ => panic!("unexpected data type"),
    };
    let mut start = query["startTime"].parse::<i64>().unwrap();
    start += 100;
    let point = json!({"dataTypeName":data_type,"startTime":start,"endTime":start,"value":[{"fieldName":field,"floatValue":amount}]});
    if data_type == "com.xiaomi.sleep.health" {
        Json(json!({"healthRecords":[point],"hasMore":false}))
    } else if mock.mode.load(Ordering::SeqCst) == 3 {
        Json(
            json!({"group":[{"dataSet":[{"dataPoints":[point]}]}],"hasMore":true,"cursor":"same-cursor"}),
        )
    } else if mock.mode.load(Ordering::SeqCst) == 4 {
        let mut other = point.clone();
        other["originDataSourceId"] = json!("collector-b");
        Json(
            json!({"group":[{"dataSet":[{"sourceId":"collector-a","dataPoints":[point,other]}]}],"hasMore":false}),
        )
    } else {
        Json(json!({"group":[{"dataSet":[{"dataPoints":[point.clone(),point]}]}],"hasMore":false}))
    }
}
async fn mock_huawei(Json(body): Json<Value>) -> Json<Value> {
    let start = body["startTime"].as_i64().unwrap();
    let end = body["endTime"].as_i64().unwrap();
    Json(
        json!({"group":[{"sampleSet":[{"samplePoints":[{"dataTypeName":"com.huawei.continuous.steps.total","startTime":(start*1_000_000).to_string(),"endTime":(end*1_000_000).to_string(),"value":[{"fieldName":"steps","integerValue":100}]}]}]}]}),
    )
}

async fn with_mock(
    state: HealthState,
    scopes: &str,
) -> (HealthState, Mock, tokio::task::JoinHandle<()>) {
    let mock = Mock {
        scopes: scopes.into(),
        calls: Arc::new(AtomicUsize::new(0)),
        mode: Arc::new(AtomicUsize::new(0)),
        reached: Arc::new(tokio::sync::Notify::new()),
        release: Arc::new(tokio::sync::Notify::new()),
    };
    let app = Router::new()
        .route("/token", post(mock_token))
        .route("/healthkit/dataSources/dataPoints", get(mock_data))
        .route("/healthkit/healthRecords", get(mock_data))
        .route("/healthkit/v2/sampleSet:polymerize", post(mock_huawei))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut config = state.inner.config.clone();
    config.endpoints.xiaomi_token = format!("{base}/token");
    config.endpoints.xiaomi_refresh = format!("{base}/token");
    config.endpoints.xiaomi_data = base.clone();
    config.endpoints.huawei_token = format!("{base}/token");
    config.endpoints.huawei_data = base;
    (
        HealthState {
            inner: Arc::new(Inner {
                repo: state.inner.repo.clone(),
                pool: state.inner.pool.clone(),
                config,
                client: state.inner.client.clone(),
                refresh: state.inner.refresh.clone(),
            }),
        },
        mock,
        handle,
    )
}

async fn connect(
    state: &HealthState,
    user: &str,
    session: &str,
    provider: Provider,
    metrics: Vec<String>,
) -> Result<()> {
    let url = state.authorize(user, session, provider, metrics).await?;
    let receipt = state
        .complete(
            provider,
            Callback {
                state: Some(state_from(&url)),
                code: Some("synthetic-code".into()),
                error: None,
            },
        )
        .await?;
    state.finalize(user, session, provider, &receipt).await?;
    Ok(())
}

#[tokio::test]
async fn xiaomi_real_http_fixture_validates_probe_and_normalizes_all_supported_metrics() {
    let (state, a, b, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200007 200009 200010 200001 200013").await;
    connect(
        &state,
        &a,
        &session,
        Provider::Xiaomi,
        Provider::Xiaomi
            .metrics()
            .iter()
            .map(|s| s.to_string())
            .collect(),
    )
    .await
    .unwrap();
    assert_eq!(
        state.statuses(&a).await.unwrap()["items"][1]["status"],
        "connected"
    );
    assert_eq!(
        state.statuses(&b).await.unwrap()["items"][1]["status"],
        "available"
    );
    let cipher = state
        .account(&a, Provider::Xiaomi)
        .await
        .unwrap()
        .unwrap()
        .ciphertext;
    assert!(!cipher.contains("synthetic-health-access"));
    assert!(state.decode(&b, Provider::Xiaomi, &cipher).is_err());
    let data = state.sync(&a, Provider::Xiaomi, 7, None).await.unwrap();
    assert_eq!(data["records"].as_array().unwrap().len(), 5);
    assert_eq!(data["truncated"], false);
    let records = data["records"].as_array().unwrap();
    let sleep = records.iter().find(|r| r["metric"] == "sleep").unwrap();
    assert_eq!(sleep["unit"], "min");
    assert_eq!(
        sleep["value"], 480.0,
        "cloud schema stores eight hours as 480 minutes"
    );
    assert!(!data.to_string().contains("synthetic-health"));
    assert!(state.sync(&a, Provider::Xiaomi, 7, None).await.is_err());
    assert!(mock.calls.load(Ordering::SeqCst) >= 7);
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'health%'",
    )
    .fetch_all(&state.inner.pool)
    .await
    .unwrap();
    assert_eq!(
        tables.len(),
        3,
        "health records must not be persisted by the server"
    );
    handle.abort();
}

#[tokio::test]
async fn empty_and_malformed_provider_responses_are_distinct() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    mock.mode.store(1, Ordering::SeqCst);
    connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let value = state.sync(&a, Provider::Xiaomi, 7, None).await.unwrap();
    assert!(value["records"].as_array().unwrap().is_empty());
    mock.mode.store(2, Ordering::SeqCst);
    let tokens = state
        .decode(
            &a,
            Provider::Xiaomi,
            &state
                .account(&a, Provider::Xiaomi)
                .await
                .unwrap()
                .unwrap()
                .ciphertext,
        )
        .unwrap();
    assert!(
        state
            .read_records(Provider::Xiaomi, &tokens, 7)
            .await
            .is_err()
    );
    handle.abort();
}

#[tokio::test]
async fn finalization_requires_real_health_probe_and_rejects_excess_scopes() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    mock.mode.store(2, Ordering::SeqCst);
    assert!(
        connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
            .await
            .is_err()
    );
    assert!(
        state
            .account(&a, Provider::Xiaomi)
            .await
            .unwrap()
            .unwrap()
            .ciphertext
            .is_empty()
    );
    handle.abort();
    let (state, a, _, session, _) = fixture().await;
    let (state, _, handle) = with_mock(state, "200016 200007 200013").await;
    assert!(
        connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
            .await
            .is_err()
    );
    handle.abort();
}

#[tokio::test]
async fn huawei_uses_confirmed_aggregate_and_nanosecond_sample_timestamps() {
    let (state, a, _, session, _) = fixture().await;
    let (state, _, handle) = with_mock(state, "https://www.huawei.com/healthkit/step.read").await;
    connect(&state, &a, &session, Provider::Huawei, vec!["steps".into()])
        .await
        .unwrap();
    let data = state.sync(&a, Provider::Huawei, 7, None).await.unwrap();
    assert_eq!(data["records"][0]["value"], 100.0);
    assert_eq!(data["records"][0]["unit"], "count");
    handle.abort();
}

#[tokio::test]
async fn repeated_pagination_cursor_fails_instead_of_looping() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    mock.mode.store(3, Ordering::SeqCst);
    assert!(
        connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
            .await
            .is_err()
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 3);
    handle.abort();
}

#[tokio::test]
async fn rotating_server_key_makes_existing_credentials_unusable_but_deletable() {
    let (state, a, _, session, _) = fixture().await;
    let (state, _, handle) = with_mock(state, "200016 200013").await;
    connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let mut values = settings();
    values.insert("CONNECTOR_ENCRYPTION_KEY".into(), "42".repeat(32));
    let changed = state.reconfigured(&values);
    let status = changed.statuses(&a).await.unwrap();
    assert_eq!(status["items"][1]["status"], "reconnect_required");
    assert_eq!(status["items"][1]["has_credentials"], true);
    changed.disconnect(&a, "xiaomi").await.unwrap();
    assert_eq!(
        changed.statuses(&a).await.unwrap()["items"][1]["has_credentials"],
        false
    );
    handle.abort();
}

#[tokio::test]
async fn xiaomi_mac_token_response_uses_documented_health_bearer_and_preserves_collectors() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    mock.mode.store(4, Ordering::SeqCst);
    connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    let value = state.sync(&a, Provider::Xiaomi, 7, None).await.unwrap();
    let records = value["records"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert_ne!(records[0]["id"], records[1]["id"]);
    let sources: HashSet<_> = records
        .iter()
        .map(|r| r["source_id"].as_str().unwrap())
        .collect();
    assert!(sources.contains("collector-a") && sources.contains("collector-b"));
    handle.abort();
}

#[tokio::test]
async fn unknown_token_type_is_rejected_without_saving_credentials() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    mock.mode.store(5, Ordering::SeqCst);
    assert!(
        connect(&state, &a, &session, Provider::Xiaomi, vec!["steps".into()])
            .await
            .is_err()
    );
    assert!(
        state
            .account(&a, Provider::Xiaomi)
            .await
            .unwrap()
            .unwrap()
            .ciphertext
            .is_empty()
    );
    handle.abort();
}

#[tokio::test]
async fn partial_grants_are_honored_and_sync_cannot_expand_them() {
    let (state, a, _, session, _) = fixture().await;
    let (state, _, handle) = with_mock(state, "200016 200013").await;
    connect(
        &state,
        &a,
        &session,
        Provider::Xiaomi,
        vec!["steps".into(), "heart_rate".into()],
    )
    .await
    .unwrap();
    assert_eq!(
        state.statuses(&a).await.unwrap()["items"][1]["granted_metrics"],
        json!(["steps"])
    );
    assert!(
        state
            .sync(&a, Provider::Xiaomi, 7, Some(vec!["heart_rate".into()]))
            .await
            .is_err()
    );
    handle.abort();
}

async fn receipt(state: &HealthState, user: &str, session: &str) -> String {
    let url = state
        .authorize(user, session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    state
        .complete(
            Provider::Xiaomi,
            Callback {
                state: Some(state_from(&url)),
                code: Some("fixture-code".into()),
                error: None,
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn browser_callback_does_not_read_health_or_bind_without_app_session_receipt_confirmation() {
    let (state, a, b, session, sb) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    let receipt = receipt(&state, &a, &session).await;
    assert_eq!(receipt.len(), 43);
    assert_eq!(
        mock.calls.load(Ordering::SeqCst),
        1,
        "only token exchange before app finalize"
    );
    assert!(
        state
            .account(&a, Provider::Xiaomi)
            .await
            .unwrap()
            .unwrap()
            .ciphertext
            .is_empty()
    );
    let status = state.statuses(&a).await.unwrap();
    assert_eq!(status["items"][1]["status"], "available");
    assert!(!status.to_string().contains(&receipt));
    let cipher: String = sqlx::query_scalar("SELECT encrypted_pending FROM health_pending_tokens")
        .fetch_one(&state.inner.pool)
        .await
        .unwrap();
    assert!(!cipher.contains("synthetic-health-access") && !cipher.contains(&session));
    assert!(
        state
            .finalize(&b, &sb, Provider::Xiaomi, &receipt)
            .await
            .is_err()
    );
    assert!(
        state
            .finalize(&a, &session, Provider::Huawei, &receipt)
            .await
            .is_err()
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    state
        .finalize(&a, &session, Provider::Xiaomi, &receipt)
        .await
        .unwrap();
    assert_eq!(
        state.statuses(&a).await.unwrap()["items"][1]["status"],
        "connected"
    );
    assert!(
        state
            .finalize(&a, &session, Provider::Xiaomi, &receipt)
            .await
            .is_err()
    );
    handle.abort();
}

#[tokio::test]
async fn different_session_cannot_finalize_even_for_same_user() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    let receipt = receipt(&state, &a, &session).await;
    let another = state.inner.repo.create_session(&a).await.unwrap();
    assert!(
        state
            .finalize(&a, &another, Provider::Xiaomi, &receipt)
            .await
            .is_err()
    );
    assert!(
        state
            .finalize(&a, &session, Provider::Xiaomi, &receipt)
            .await
            .is_err()
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    handle.abort();
}

#[tokio::test]
async fn receipt_expiration_new_authorization_and_disconnect_prevent_binding() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    let expired = receipt(&state, &a, &session).await;
    sqlx::query("UPDATE health_pending_tokens SET expires_at=$1")
        .bind(now() - 1)
        .execute(&state.inner.pool)
        .await
        .unwrap();
    assert!(
        state
            .finalize(&a, &session, Provider::Xiaomi, &expired)
            .await
            .is_err()
    );
    let superseded = receipt(&state, &a, &session).await;
    state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    assert!(
        state
            .finalize(&a, &session, Provider::Xiaomi, &superseded)
            .await
            .is_err()
    );
    let revoked = receipt(&state, &a, &session).await;
    state.disconnect(&a, "xiaomi").await.unwrap();
    assert!(
        state
            .finalize(&a, &session, Provider::Xiaomi, &revoked)
            .await
            .is_err()
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 3);
    handle.abort();
}

#[tokio::test]
async fn finalization_cannot_restore_credentials_after_concurrent_disconnect_or_logout() {
    for logout in [false, true] {
        let (state, a, _, session, _) = fixture().await;
        let (state, mock, handle) = with_mock(state, "200016 200013").await;
        let receipt = receipt(&state, &a, &session).await;
        mock.mode.store(6, Ordering::SeqCst);
        let worker_state = state.clone();
        let user = a.clone();
        let worker_session = session.clone();
        let worker = tokio::spawn(async move {
            worker_state
                .finalize(&user, &worker_session, Provider::Xiaomi, &receipt)
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), mock.reached.notified())
            .await
            .unwrap();
        if logout {
            state.inner.repo.logout(&session).await.unwrap()
        } else {
            state.disconnect(&a, "xiaomi").await.unwrap();
        }
        mock.release.notify_one();
        assert!(worker.await.unwrap().is_err());
        assert!(
            state
                .account(&a, Provider::Xiaomi)
                .await
                .unwrap()
                .unwrap()
                .ciphertext
                .is_empty()
        );
        handle.abort();
    }
}

#[tokio::test]
async fn callback_token_exchange_cannot_recreate_pending_binding_after_disconnect() {
    let (state, a, _, session, _) = fixture().await;
    let (state, mock, handle) = with_mock(state, "200016 200013").await;
    let url = state
        .authorize(&a, &session, Provider::Xiaomi, vec!["steps".into()])
        .await
        .unwrap();
    mock.mode.store(7, Ordering::SeqCst);
    let worker_state = state.clone();
    let worker = tokio::spawn(async move {
        worker_state
            .complete(
                Provider::Xiaomi,
                Callback {
                    state: Some(state_from(&url)),
                    code: Some("fixture-code".into()),
                    error: None,
                },
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), mock.reached.notified())
        .await
        .unwrap();
    state.disconnect(&a, "xiaomi").await.unwrap();
    mock.release.notify_one();
    assert!(worker.await.unwrap().is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_pending_tokens")
        .fetch_one(&state.inner.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    handle.abort();
}
