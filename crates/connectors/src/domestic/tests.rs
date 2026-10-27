use super::*;
use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use tower::ServiceExt;

async fn fixture() -> (IntegrationState, String, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user(
            "integration-a@example.test",
            "not-used-in-test",
            "A",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let b = repo
        .create_user(
            "integration-b@example.test",
            "not-used-in-test",
            "B",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let ta = repo.create_session(&a.id).await.unwrap();
    let tb = repo.create_session(&b.id).await.unwrap();
    let state =
        IntegrationState::with_crypto(repo, Some(Crypto::from_hex(&"01".repeat(32)).unwrap()))
            .await
            .unwrap();
    (state, a.id, b.id, ta, tb)
}
async fn request(
    state: &IntegrationState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = router(state.clone())
        .oneshot(
            builder
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let bytes = to_bytes(response.into_body(), 200_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn input(external: &str) -> ImportInput {
    ImportInput {
        source_app: "wechat".into(),
        title: "项目会议".into(),
        text: "明天下午讨论项目资料".into(),
        url: None,
        external_id: Some(external.into()),
    }
}

#[tokio::test]
async fn every_data_route_requires_authentication() {
    let (state, _, _, _, _) = fixture().await;
    for (method, path) in [
        ("GET", "/v1/integrations"),
        ("GET", "/v1/integrations/imports"),
        ("POST", "/v1/integrations/imports"),
        ("POST", "/v1/integrations/qq_mail/connect"),
        ("POST", "/v1/integrations/amap/read"),
        ("DELETE", "/v1/integrations/yuque"),
    ] {
        assert_eq!(
            request(&state, method, path, None, json!({})).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}
#[tokio::test]
async fn imports_dedupe_search_and_delete_are_user_scoped() {
    let (state, a, b, ta, tb) = fixture().await;
    let first = state
        .import(&a, input("local-notification-1"))
        .await
        .unwrap();
    let repeat = state
        .import(&a, input("local-notification-1"))
        .await
        .unwrap();
    assert_eq!(first["id"], repeat["id"]);
    assert_eq!(repeat["duplicate"], true);
    assert_eq!(
        state.imports(&b, ImportQuery::default()).await.unwrap()["items"],
        json!([])
    );
    let other = state
        .import(&b, input("local-notification-1"))
        .await
        .unwrap();
    assert_ne!(first["id"], other["id"]);
    assert_eq!(
        state
            .imports(
                &a,
                ImportQuery {
                    q: Some("项目".into()),
                    source_app: Some("wechat".into())
                }
            )
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let path = format!("/v1/integrations/imports/{}", first["id"].as_str().unwrap());
    assert_eq!(
        request(&state, "DELETE", &path, Some(&tb), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        state.imports(&a, ImportQuery::default()).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    request(&state, "DELETE", &path, Some(&ta), json!({})).await;
    assert!(
        state.imports(&a, ImportQuery::default()).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn server_never_fetches_imported_links_and_rejects_credential_urls() {
    let (state, a, _, _, _) = fixture().await;
    let mut value = input("link");
    value.url = Some("https://example.test/资料".into());
    assert!(state.import(&a, value).await.is_ok());
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://secret@example.test/",
    ] {
        let mut value = input(url);
        value.url = Some(url.into());
        assert!(state.import(&a, value).await.is_err());
    }
    let mut value = input("unknown");
    value.source_app = "made_up".into();
    assert!(state.import(&a, value).await.is_err());
    let mut value = input("shared");
    value.source_app = "shared".into();
    assert!(state.import(&a, value).await.is_ok());
}
#[tokio::test]
async fn encrypted_vault_binding_disconnect_and_stale_callbacks() {
    let (state, a, b, _, _) = fixture().await;
    let generation = state.reserve(&a, "yuque").await.unwrap();
    let credentials = json!({"token":"test-only-personal-token"});
    state
        .save(&a, "yuque", generation, &credentials)
        .await
        .unwrap();
    let (_, ciphertext) = state.account(&a, "yuque").await.unwrap().unwrap();
    assert!(!ciphertext.contains("test-only-personal-token"));
    assert!(state.decode(&b, "yuque", &ciphertext).is_err());
    assert!(state.decode(&a, "zhihu", &ciphertext).is_err());
    assert_eq!(state.decode(&a, "yuque", &ciphertext).unwrap(), credentials);
    state.disconnect(&a, "yuque").await.unwrap();
    assert!(
        state
            .save(&a, "yuque", generation, &credentials)
            .await
            .is_err()
    );
    let items = state.statuses(&a).await.unwrap();
    assert!(
        !serde_json::to_string(&items)
            .unwrap()
            .contains("test-only-personal-token")
    );
    assert_eq!(
        items.iter().find(|item| item["id"] == "yuque").unwrap()["status"],
        "not_connected"
    );
}
#[tokio::test]
async fn budgets_count_attempts_and_do_not_cross_users() {
    let (state, a, b, _, _) = fixture().await;
    for _ in 0..30 {
        state.admit(&a).await.unwrap();
    }
    assert_eq!(
        state.admit(&a).await.unwrap_err().status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(state.admit(&b).await.is_ok());
}
#[tokio::test]
async fn phone_imports_work_without_server_credentials() {
    let (state, a, _, _, _) = fixture().await;
    let no_keys = IntegrationState::with_crypto(state.0.repo.clone(), None)
        .await
        .unwrap();
    let statuses = no_keys.statuses(&a).await.unwrap();
    assert_eq!(
        statuses.iter().find(|item| item["id"] == "wechat").unwrap()["status"],
        "available"
    );
    assert_eq!(
        statuses
            .iter()
            .find(|item| item["id"] == "qq_mail")
            .unwrap()["status"],
        "not_configured"
    );
    assert!(no_keys.import(&a, input("no-keys")).await.is_ok());
    assert!(
        no_keys
            .connect(
                &a,
                "qq_mail",
                json!({"email":"a@qq.com","authorization_code":"test-only"})
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn oauth_state_is_bound_to_provider_and_consumed_once() {
    let (state, a, _, _, _) = fixture().await;
    let value = random_secret();
    let generation = state.reserve(&a, "feishu").await.unwrap();
    sqlx::query("INSERT INTO integration_oauth_states(state_hash,user_id,provider,generation,expires_at)VALUES($1,$2,'feishu',$3,$4)").bind(digest(&value)).bind(a).bind(generation).bind(now()+600).execute(&state.0.pool).await.unwrap();
    let callback = |state: &str| CallbackQuery {
        state: Some(state.into()),
        code: None,
        error: Some("access_denied".into()),
    };
    assert!(
        state
            .finish_authorize("dingtalk", callback(&value))
            .await
            .is_err()
    );
    assert!(
        !state
            .finish_authorize("feishu", callback(&value))
            .await
            .unwrap()
    );
    assert!(
        state
            .finish_authorize("feishu", callback(&value))
            .await
            .is_err()
    );
}

async fn saved_token(state: &IntegrationState, user: &str) -> i64 {
    let generation = state.reserve(user, "yuque").await.unwrap();
    state
        .save(
            user,
            "yuque",
            generation,
            &json!({"token":"initial-test-token","login":"test-user"}),
        )
        .await
        .unwrap();
    generation
}

#[tokio::test]
async fn status_rejects_corrupt_cross_user_and_invalid_vault_values() {
    let (state, a, b, _, _) = fixture().await;
    let generation = saved_token(&state, &a).await;
    let status = |items: Vec<Value>| {
        items
            .into_iter()
            .find(|item| item["id"] == "yuque")
            .unwrap()["status"]
            .clone()
    };
    assert_eq!(status(state.statuses(&a).await.unwrap()), "connected");
    let (_, ciphertext) = state.account(&a, "yuque").await.unwrap().unwrap();
    state.reserve(&b, "yuque").await.unwrap();
    sqlx::query("UPDATE integration_accounts SET encrypted_credentials=$1 WHERE user_id=$2 AND provider='yuque'").bind(&ciphertext).bind(&b).execute(&state.0.pool).await.unwrap();
    assert_eq!(status(state.statuses(&b).await.unwrap()), "not_connected");
    sqlx::query("UPDATE integration_accounts SET encrypted_credentials='not-a-vault' WHERE user_id=$1 AND provider='yuque'").bind(&a).execute(&state.0.pool).await.unwrap();
    assert_eq!(status(state.statuses(&a).await.unwrap()), "not_connected");
    state
        .save(&a, "yuque", generation, &json!({"token":""}))
        .await
        .unwrap();
    assert_eq!(status(state.statuses(&a).await.unwrap()), "not_connected");
}

#[tokio::test]
async fn independent_replicas_serialize_refresh_and_read_the_rotated_credentials() {
    let (state, a, _, _, _) = fixture().await;
    saved_token(&state, &a).await;
    let replica = IntegrationState::with_crypto(
        state.0.repo.clone(),
        Some(Crypto::from_hex(&"01".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let worker = state.clone();
    let user = a.clone();
    let first = tokio::spawn(async move {
        let saver = worker.clone();
        let save_user = user.clone();
        worker
            .with_account_read(
                &user,
                "yuque",
                Duration::from_secs(2),
                |generation, credentials, lease| async move {
                    assert_eq!(credentials["token"], "initial-test-token");
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    saver
                        .save_under_read_lease(
                            &save_user,
                            "yuque",
                            generation,
                            &lease,
                            &json!({"token":"rotated-test-token"}),
                        )
                        .await?;
                    Ok(json!({"items":[]}))
                },
            )
            .await
    });
    started_rx.await.unwrap();
    let second = replica
        .with_account_read(&a, "yuque", Duration::from_secs(1), |_, _, _| async {
            panic!("a second refresh must not run");
        })
        .await;
    assert_eq!(second.unwrap_err().status, StatusCode::TOO_MANY_REQUESTS);
    release_tx.send(()).unwrap();
    first.await.unwrap().unwrap();
    replica
        .with_account_read(
            &a,
            "yuque",
            Duration::from_secs(1),
            |_, credentials, _| async move {
                assert_eq!(credentials["token"], "rotated-test-token");
                Ok(json!({"items":[]}))
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn disconnect_and_reconnect_suppress_in_flight_sensitive_results() {
    for reconnect in [false, true] {
        let (state, a, _, _, _) = fixture().await;
        saved_token(&state, &a).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker = state.clone();
        let user = a.clone();
        let read = tokio::spawn(async move {
            worker
                .with_account_read(
                    &user,
                    "yuque",
                    Duration::from_secs(2),
                    |_, _, _| async move {
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        Ok(json!({"items":[{"text":"private-old-account-data"}]}))
                    },
                )
                .await
        });
        started_rx.await.unwrap();
        if reconnect {
            let generation = state.reserve(&a, "yuque").await.unwrap();
            let (_, encrypted) = state.account(&a, "yuque").await.unwrap().unwrap();
            assert!(encrypted.is_empty());
            state
                .save(
                    &a,
                    "yuque",
                    generation,
                    &json!({"token":"new-account-token"}),
                )
                .await
                .unwrap();
        } else {
            state.disconnect(&a, "yuque").await.unwrap();
        }
        release_tx.send(()).unwrap();
        assert_eq!(
            read.await.unwrap().unwrap_err().status,
            StatusCode::CONFLICT
        );
    }
}

#[tokio::test]
async fn timeouts_and_provider_errors_release_the_account_lease() {
    let (state, a, _, _, _) = fixture().await;
    saved_token(&state, &a).await;
    let started = std::time::Instant::now();
    let error = state
        .with_account_read(&a, "yuque", Duration::from_millis(10), |_, _, _| {
            std::future::pending::<Result<Value>>()
        })
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::GATEWAY_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(1));
    let error = state
        .with_account_read(&a, "yuque", Duration::from_secs(1), |_, _, _| async {
            Err(ConnectorError::invalid())
        })
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    state
        .with_account_read(&a, "yuque", Duration::from_secs(1), |_, _, _| async {
            Ok(json!({"items":[]}))
        })
        .await
        .unwrap();
    let count: i64 =
        sqlx::query("SELECT COUNT(*) AS n FROM integration_account_read_leases WHERE user_id=$1")
            .bind(&a)
            .fetch_one(&state.0.pool)
            .await
            .unwrap()
            .get("n");
    assert_eq!(count, 0);
}

#[tokio::test]
async fn an_expired_worker_cannot_save_or_remove_a_new_workers_lease() {
    let (state, a, _, _, _) = fixture().await;
    let generation = saved_token(&state, &a).await;
    state
        .acquire_read_lease(&a, "yuque", generation, "old-worker")
        .await
        .unwrap();
    sqlx::query("UPDATE integration_account_read_leases SET expires_at=$1 WHERE user_id=$2")
        .bind(now() - 1)
        .bind(&a)
        .execute(&state.0.pool)
        .await
        .unwrap();
    state
        .acquire_read_lease(&a, "yuque", generation, "new-worker")
        .await
        .unwrap();
    assert!(
        state
            .save_under_read_lease(
                &a,
                "yuque",
                generation,
                "old-worker",
                &json!({"token":"stale-refresh"})
            )
            .await
            .is_err()
    );
    assert!(
        !state
            .finish_read_lease(&a, "yuque", "old-worker")
            .await
            .unwrap()
    );
    assert!(
        state
            .finish_read_lease(&a, "yuque", "new-worker")
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn duplicate_import_returns_the_original_persisted_content() {
    let (state, a, _, _, _) = fixture().await;
    let original = state.import(&a, input("immutable-import")).await.unwrap();
    let mut changed = input("immutable-import");
    changed.title = "重传时修改了标题".into();
    changed.text = "这段内容没有写入数据库".into();
    changed.url = Some("https://example.test/changed".into());
    let repeat = state.import(&a, changed).await.unwrap();
    assert_eq!(repeat["duplicate"], true);
    for key in ["id", "title", "text", "url", "created_at"] {
        assert_eq!(repeat[key], original[key]);
    }
    for source in ["manual", "shared"] {
        let mut imported = input(source);
        imported.source_app = source.into();
        state.import(&a, imported).await.unwrap();
        let listed = state
            .imports(
                &a,
                ImportQuery {
                    q: None,
                    source_app: Some(source.into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        assert_eq!(listed["items"][0]["source_app"], source);
    }
}

#[tokio::test]
async fn imports_support_exact_id_lookup_without_cross_user_access() {
    let (state, a, b, _, _) = fixture().await;
    let imported = state
        .import(&a, input("agent-import-reference"))
        .await
        .unwrap();
    let id = imported["id"].as_str().unwrap();
    let query = || ImportQuery {
        q: Some(id.into()),
        source_app: None,
    };
    let own = state.imports(&a, query()).await.unwrap();
    assert_eq!(own["items"].as_array().unwrap().len(), 1);
    assert_eq!(own["items"][0]["id"], id);
    assert!(
        state.imports(&b, query()).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let partial = ImportQuery {
        q: Some(id[..id.len() - 1].into()),
        source_app: None,
    };
    assert!(
        state.imports(&a, partial).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

async fn prefill_imports(state: &IntegrationState, user: &str, count: usize) {
    let mut tx = state.0.pool.begin().await.unwrap();
    for index in 0..count {
        sqlx::query("INSERT INTO integration_imports(id,user_id,source_app,title,body,source_url,external_key,created_at)VALUES($1,$2,'wechat','existing','stored','',$3,$4)")
            .bind(tomorrow_domain::new_id()).bind(user).bind(digest(&format!("prefilled-{index}"))).bind(now()).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}
async fn last_slot_race(state: IntegrationState, user: String) {
    prefill_imports(&state, &user, 499).await;
    let replica = IntegrationState::with_crypto(
        state.0.repo.clone(),
        Some(Crypto::from_hex(&"01".repeat(32)).unwrap()),
    )
    .await
    .unwrap();
    let (left, right) = tokio::join!(
        state.import(&user, input("last-slot-left")),
        replica.import(&user, input("last-slot-right"))
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert_eq!(
        left.as_ref().err().or(right.as_ref().err()).unwrap().code,
        "import_limit"
    );
    let row = sqlx::query("SELECT COUNT(*) AS n FROM integration_imports WHERE user_id=$1")
        .bind(&user)
        .fetch_one(&state.0.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("n"), 500);
    let counter =
        sqlx::query("SELECT item_count FROM integration_import_counters WHERE user_id=$1")
            .bind(&user)
            .fetch_one(&state.0.pool)
            .await
            .unwrap();
    assert_eq!(counter.get::<i64, _>("item_count"), 500);
    let winner = left.as_ref().ok().or(right.as_ref().ok()).unwrap();
    let duplicate_id = if left.is_ok() {
        "last-slot-left"
    } else {
        "last-slot-right"
    };
    assert_eq!(
        state.import(&user, input(duplicate_id)).await.unwrap()["id"],
        winner["id"]
    );
    state
        .delete_import(&user, winner["id"].as_str().unwrap())
        .await
        .unwrap();
    state
        .import(&user, input("reuses-deleted-slot"))
        .await
        .unwrap();
    assert_eq!(
        state
            .import(&user, input("over-cap-after-delete"))
            .await
            .unwrap_err()
            .code,
        "import_limit"
    );
}

#[tokio::test]
async fn concurrent_imports_share_a_durable_cap_and_delete_restores_one_slot() {
    let (state, a, _, _, _) = fixture().await;
    last_slot_race(state, a).await;
}

#[tokio::test]
#[ignore = "Requires an isolated PostgreSQL database via TEST_CONNECTORS_DATABASE_URL"]
async fn postgres_replicas_cannot_claim_the_same_last_import_slot() {
    let url = std::env::var("TEST_CONNECTORS_DATABASE_URL")
        .expect("set a disposable TEST_CONNECTORS_DATABASE_URL");
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user(
            &format!(
                "integration-race-{}@example.test",
                tomorrow_domain::new_id()
            ),
            "not-used-in-test",
            "Test",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let state =
        IntegrationState::with_crypto(repo, Some(Crypto::from_hex(&"01".repeat(32)).unwrap()))
            .await
            .unwrap();
    last_slot_race(state.clone(), user.id.clone()).await;
    sqlx::query("DELETE FROM integration_imports WHERE user_id=$1")
        .bind(&user.id)
        .execute(&state.0.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM integration_import_counters WHERE user_id=$1")
        .bind(&user.id)
        .execute(&state.0.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM integration_rate_limits WHERE user_id=$1")
        .bind(&user.id)
        .execute(&state.0.pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "Requires an isolated PostgreSQL database via TEST_CONNECTORS_DATABASE_URL"]
async fn postgres_independent_pools_enforce_lease_rotation_and_revocation() {
    let url = std::env::var("TEST_CONNECTORS_DATABASE_URL")
        .expect("set a disposable TEST_CONNECTORS_DATABASE_URL");
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user(
            &format!(
                "integration-lease-{}@example.test",
                tomorrow_domain::new_id()
            ),
            "not-used-in-test",
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
    let generation = saved_token(&state, &user.id).await;
    state
        .acquire_read_lease(&user.id, "yuque", generation, "postgres-owner")
        .await
        .unwrap();
    assert_eq!(
        replica
            .acquire_read_lease(&user.id, "yuque", generation, "postgres-competitor")
            .await
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    state
        .save_under_read_lease(
            &user.id,
            "yuque",
            generation,
            "postgres-owner",
            &json!({"token":"postgres-rotated-test-token"}),
        )
        .await
        .unwrap();
    assert!(
        state
            .finish_read_lease(&user.id, "yuque", "postgres-owner")
            .await
            .unwrap()
    );
    assert!(
        !state
            .finish_read_lease(&user.id, "yuque", "postgres-owner")
            .await
            .unwrap()
    );
    let revoker = state.clone();
    let revoke_user = user.id.clone();
    let result = replica
        .with_account_read(
            &user.id,
            "yuque",
            Duration::from_secs(3),
            |_, credentials, _| async move {
                assert_eq!(credentials["token"], "postgres-rotated-test-token");
                revoker.disconnect(&revoke_user, "yuque").await?;
                Ok(json!({"items":[{"text":"revoked-private-content"}]}))
            },
        )
        .await;
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    for table in ["integration_accounts", "integration_rate_limits"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE user_id=$1"))
            .bind(&user.id)
            .execute(&state.0.pool)
            .await
            .unwrap();
    }
}
