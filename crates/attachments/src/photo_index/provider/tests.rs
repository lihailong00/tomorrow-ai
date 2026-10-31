use super::super::tests::{Fixture, body};
use super::*;
use std::collections::HashMap;
use std::sync::{
    RwLock,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::Notify;

struct Mock {
    base: String,
    calls: Arc<AtomicUsize>,
    hold: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}
async fn mock(reverse: bool) -> Mock {
    let calls = Arc::new(AtomicUsize::new(0));
    let hold = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (seen, wait, arrived, go) = (
        calls.clone(),
        hold.clone(),
        entered.clone(),
        release.clone(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/v1/embeddings",
        post(move |Json(value): Json<serde_json::Value>| {
            let (seen, wait, arrived, go) =
                (seen.clone(), wait.clone(), arrived.clone(), go.clone());
            async move {
                seen.fetch_add(1, Ordering::SeqCst);
                if wait.load(Ordering::SeqCst) {
                    arrived.notify_one();
                    go.notified().await;
                }
                assert_eq!(value["dimensions"], 1024);
                let text = value["input"][0].as_str().unwrap().to_lowercase();
                let blue = text.contains("blue") || text.contains("azure");
                let mut vector = vec![0.0; 1024];
                vector[usize::from(blue ^ reverse)] = 1.0;
                Json(json!({"data":[{"index":0,"embedding":vector}]}))
            }
        }),
    );
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Mock {
        base,
        calls,
        hold,
        entered,
        release,
        task,
    }
}
fn values(base: &str) -> HashMap<String, String> {
    HashMap::from([
        ("PHOTO_EMBEDDING_ENABLED".into(), "true".into()),
        ("PHOTO_EMBEDDING_BASE_URL".into(), base.into()),
        (
            "PHOTO_EMBEDDING_API_KEY".into(),
            "synthetic-secret-one".into(),
        ),
        ("PHOTO_EMBEDDING_MODEL".into(), "same-model-alias".into()),
        ("PHOTO_VISION_ENABLED".into(), "false".into()),
    ])
}
fn live(f: &mut Fixture, values: HashMap<String, String>) -> Arc<RwLock<HashMap<String, String>>> {
    let shared = Arc::new(RwLock::new(values));
    let observed = shared.clone();
    f.state = f
        .state
        .clone()
        .with_photo_configuration(move || {
            let values = observed.read().unwrap().clone();
            async move { Some((1, values)) }
        })
        .reconfigured(&shared.read().unwrap())
        .unwrap();
    shared
}
fn change(
    f: &mut Fixture,
    shared: &Arc<RwLock<HashMap<String, String>>>,
    next: HashMap<String, String>,
) {
    *shared.write().unwrap() = next;
    f.state = f.state.reconfigured(&shared.read().unwrap()).unwrap();
}
async fn status(f: &Fixture) -> serde_json::Value {
    body(f.call("GET", &f.base(), json!(null)).await).await
}
async fn prepare(f: &Fixture) -> Response {
    f.call("POST", &format!("{}/prepare", f.base()), json!(null))
        .await
}
async fn query(f: &Fixture, text: &str) -> serde_json::Value {
    body(
        f.call("GET", &format!("{}/assets?q={text}", f.base()), json!(null))
            .await,
    )
    .await
}
async fn count(f: &Fixture, table: &str) -> i64 {
    assert!(
        [
            "photo_index_vector_spaces",
            "photo_embedding_queries",
            "photo_embedding_attempts"
        ]
        .contains(&table)
    );
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE user_id=$1"))
        .bind(&f.user)
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn provider_spaces_consent_and_cached_queries_do_not_cross_same_alias_destinations() {
    let a = mock(false).await;
    let b = mock(true).await;
    let mut f = Fixture::new().await;
    let shared = live(&mut f, values(&a.base));
    let epoch = f.enable().await;
    let blue = uuid::Uuid::new_v4().to_string();
    f.sync(&f.asset, "RED photo", epoch).await;
    f.sync(&blue, "BLUE photo", epoch).await;
    assert_eq!(prepare(&f).await.status(), StatusCode::OK);
    query(&f, "crimson").await;
    assert_eq!(
        a.calls.load(Ordering::SeqCst),
        0,
        "local OCR consent must never submit text"
    );
    let scope_a = status(&f).await["consent_scope"].clone();
    assert_eq!(
        f.call(
            "PUT",
            &f.base(),
            json!({"enabled":true,"cloud_processing":true})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    f.enable_cloud().await;
    for _ in 0..2 {
        assert_eq!(prepare(&f).await.status(), StatusCode::OK);
    }
    assert_eq!(query(&f, "crimson").await["items"][0]["asset_id"], f.asset);
    assert_eq!(a.calls.load(Ordering::SeqCst), 3);
    assert_eq!(query(&f, "crimson").await["items"][0]["asset_id"], f.asset);
    assert_eq!(a.calls.load(Ordering::SeqCst), 3);
    change(&mut f, &shared, values(&b.base));
    let paused = status(&f).await;
    assert_eq!(paused["cloud_processing"], false);
    assert_eq!(paused["consent_required"], true);
    assert_eq!(paused["semantic_ready"], 0);
    assert_eq!(count(&f, "photo_index_vector_spaces").await, 2);
    assert_eq!(
        f.call(
            "PUT",
            &f.base(),
            json!({"enabled":true,"cloud_processing":true,"consent_scope":scope_a})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    f.enable_cloud().await;
    for _ in 0..2 {
        assert_eq!(prepare(&f).await.status(), StatusCode::OK);
    }
    assert_eq!(query(&f, "crimson").await["items"][0]["asset_id"], f.asset);
    assert_eq!(
        b.calls.load(Ordering::SeqCst),
        3,
        "A cache must not skip B's query call"
    );
    assert_eq!(
        query(&f, "crimson-new").await["items"][0]["asset_id"],
        f.asset
    );
    assert_eq!(
        count(&f, "photo_index_vector_spaces").await,
        4,
        "keep both authorized spaces until user clear"
    );
    let accepted = status(&f).await;
    let mut rotated = values(&b.base);
    rotated.insert(
        "PHOTO_EMBEDDING_API_KEY".into(),
        "synthetic-secret-two".into(),
    );
    change(&mut f, &shared, rotated);
    let changed = status(&f).await;
    assert_eq!(changed["consent_scope"], accepted["consent_scope"]);
    assert_eq!(changed["cloud_processing"], true);
    assert_eq!(
        changed["semantic_ready"], 0,
        "key may route a different tenant's vector space"
    );
    assert!(!changed.to_string().contains("synthetic-secret"));
    f.call("DELETE", &f.base(), json!(null)).await;
    assert_eq!(count(&f, "photo_index_vector_spaces").await, 0);
    assert_eq!(count(&f, "photo_embedding_queries").await, 0);
    assert!(count(&f, "photo_embedding_attempts").await > 0);
    a.task.abort();
    b.task.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn live_provider_change_and_consent_revocation_discard_inflight_vectors_and_queries() {
    let a = mock(false).await;
    let b = mock(true).await;
    let mut f = Fixture::new().await;
    let shared = live(&mut f, values(&a.base));
    let epoch = f.enable_cloud().await;
    f.sync(&f.asset, "RED photo", epoch).await;
    a.hold.store(true, Ordering::SeqCst);
    let old = f.state.clone();
    let token = f.token.clone();
    let path = format!("{}/prepare", f.base());
    let pending = tokio::spawn(async move {
        super::super::tests::call(&old, &token, "POST", &path, json!(null)).await
    });
    tokio::time::timeout(Duration::from_secs(5), a.entered.notified())
        .await
        .unwrap();
    change(&mut f, &shared, values(&b.base));
    a.release.notify_one();
    assert_eq!(pending.await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(count(&f, "photo_index_vector_spaces").await, 0);
    assert_eq!(status(&f).await["consent_required"], true);
    assert_eq!(b.calls.load(Ordering::SeqCst), 0);
    let epoch = f.enable_cloud().await;
    assert_eq!(prepare(&f).await.status(), StatusCode::OK);
    b.hold.store(true, Ordering::SeqCst);
    let old = f.state.clone();
    let token = f.token.clone();
    let path = format!("{}/assets?q=crimson-pending", f.base());
    let pending = tokio::spawn(async move {
        super::super::tests::call(&old, &token, "GET", &path, json!(null)).await
    });
    tokio::time::timeout(Duration::from_secs(5), b.entered.notified())
        .await
        .unwrap();
    let local = body(
        f.call(
            "PUT",
            &f.base(),
            json!({"enabled":true,"cloud_processing":false}),
        )
        .await,
    )
    .await;
    b.release.notify_one();
    assert_eq!(pending.await.unwrap().status(), StatusCode::OK);
    assert_eq!(count(&f, "photo_embedding_queries").await, 0);
    assert_eq!(
        count(&f, "photo_index_vector_spaces").await,
        1,
        "revoking future use is not silently deleting authorized stored data"
    );
    let before = b.calls.load(Ordering::SeqCst);
    query(&f, "crimson").await;
    assert_eq!(b.calls.load(Ordering::SeqCst), before);
    assert!(local["epoch"].as_i64().unwrap() > epoch);
    assert_eq!(
        f.sync(
            &f.asset,
            "LOCAL OCR remains usable",
            local["epoch"].as_i64().unwrap()
        )
        .await
        .status(),
        StatusCode::OK
    );
    f.call("DELETE", &f.base(), json!(null)).await;
    assert_eq!(count(&f, "photo_index_vector_spaces").await, 0);
    a.task.abort();
    b.task.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn legacy_consent_is_never_inferred_and_is_fenced_once() {
    let f = Fixture::new().await;
    let epoch = f.enable().await;
    sqlx::query("INSERT INTO photo_cloud_consents(user_id,device_id,epoch)VALUES($1,$2,$3)")
        .bind(&f.user)
        .bind(&f.device)
        .bind(epoch)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let paused = status(&f).await;
    assert_eq!(paused["consent_required"], true);
    assert_eq!(paused["consent_reason"], "legacy_consent");
    assert_eq!(paused["epoch"], epoch + 1);
    assert_eq!(status(&f).await["epoch"], epoch + 1);
    f.enable_cloud().await;
    assert_eq!(status(&f).await["cloud_processing"], true);
    f.cleanup().await;
}

#[test]
fn disclosure_redacts_secret_paths_but_scope_still_binds_the_full_endpoint() {
    let config = semantic::Config {
        endpoint: "https://SERVICE.example:443/private/sk_path_secret/embeddings".into(),
        key: "raw-secret".into(),
        model: "same".into(),
        dimension: 1024,
    };
    let first = Snapshot::new(Some(1), None, Some(config.clone()));
    let displayed = first.disclosure().to_string();
    assert!(!displayed.contains("sk_path_secret"));
    assert!(!displayed.contains("raw-secret"));
    assert_eq!(
        first.disclosure()["embeddings"]["destination"],
        "https://service.example"
    );
    let mut other = config;
    other.endpoint = "https://service.example/other/embeddings".into();
    assert_ne!(first.scope, Snapshot::new(Some(2), None, Some(other)).scope);
}
