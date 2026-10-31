use super::*;
use axum::{body::to_bytes, http::Request};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;

pub(super) struct Fixture {
    pub(super) state: AttachmentsState,
    pub(super) token: String,
    pub(super) other: String,
    pub(super) device: String,
    pub(super) asset: String,
    pub(super) user: String,
}
impl Fixture {
    pub(super) async fn new() -> Self {
        Self::at("sqlite::memory:").await
    }
    pub(super) async fn at(url: &str) -> Self {
        let repo = Repository::connect(url).await.unwrap();
        let mut users = Vec::new();
        let mut tokens = Vec::new();
        for email in ["one@photo.test", "two@photo.test"] {
            let user = repo
                .create_user(
                    &format!("{}-{email}", uuid::Uuid::new_v4()),
                    "test-hash",
                    "test",
                    "Asia/Shanghai",
                )
                .await
                .unwrap();
            tokens.push(repo.create_session(&user.id).await.unwrap());
            users.push(user.id);
        }
        let root = std::env::temp_dir().join(format!(
            "tomorrow-photo-semantic-test-{}",
            uuid::Uuid::new_v4()
        ));
        let state = AttachmentsState::initialize(repo, root, DEFAULT_MAX_BYTES, None)
            .await
            .unwrap();
        Self {
            state,
            token: tokens.remove(0),
            other: tokens.remove(0),
            device: uuid::Uuid::new_v4().to_string(),
            asset: uuid::Uuid::new_v4().to_string(),
            user: users.remove(0),
        }
    }
    pub(super) fn base(&self) -> String {
        format!("/v1/photo-index/devices/{}", self.device)
    }
    pub(super) async fn call(&self, method: &str, path: &str, body: serde_json::Value) -> Response {
        call(&self.state, &self.token, method, path, body).await
    }
    pub(super) async fn enable(&self) -> i64 {
        let result = body(
            self.call("PUT", &self.base(), json!({"enabled":true}))
                .await,
        )
        .await;
        result["epoch"].as_i64().unwrap()
    }
    pub(super) async fn enable_cloud(&self) -> i64 {
        let status = body(self.call("GET", &self.base(), json!(null)).await).await;
        let response = self.call("PUT", &self.base(), json!({"enabled":true,"cloud_processing":true,"consent_scope":status["consent_scope"]})).await;
        assert_eq!(response.status(), StatusCode::OK);
        body(response).await["epoch"].as_i64().unwrap()
    }
    pub(super) async fn sync(&self, asset: &str, text: &str, epoch: i64) -> Response {
        self.call("PUT",&format!("{}/assets/{asset}",self.base()),json!({"epoch":epoch,"revision":"v1","metadata":{"taken_at":null,"modified_at":1,"width":100,"height":100,"size":1000,"mime_type":"image/jpeg"},"results":[{"kind":"ocr","processor":"local-test-v1","content":text}]})).await
    }
    fn configure(&mut self, endpoint: String) {
        let postgres_vector = self.state.photo_index.postgres_vector;
        self.state.photo_index = Arc::new(Runtime {
            config: Some(semantic::Config {
                endpoint,
                key: "mock-key".into(),
                model: "test-multilingual".into(),
                dimension: 2,
            }),
            postgres_vector,
            active: Arc::new(Semaphore::new(2)),
        });
    }
    pub(super) async fn cleanup(self) {
        let root = self.state.config.root.clone();
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("tomorrow-photo-semantic-test-")
        );
        assert_eq!(
            root.parent().unwrap(),
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        );
        self.state.pool.close().await;
        drop(self);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
pub(super) async fn call(
    state: &AttachmentsState,
    token: &str,
    method: &str,
    path: &str,
    payload: serde_json::Value,
) -> Response {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    super::super::router(state.clone())
        .oneshot(request)
        .await
        .unwrap()
}
pub(super) async fn body(response: Response) -> serde_json::Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn count(state: &AttachmentsState, table: &str) -> i64 {
    assert!(
        [
            "photo_index_vectors",
            "photo_index_vector_spaces",
            "photo_index_facts",
            "photo_embedding_queries",
            "photo_embedding_attempts"
        ]
        .contains(&table)
    );
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn keyword_search_folds_unicode_and_preserves_literal_pagination_and_scope() {
    keyword_search_checks("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires the isolated local tada_qa_e05 PostgreSQL database"]
async fn postgres_keyword_search_folds_unicode_and_preserves_literal_scope() {
    let database = std::env::var("E05_ATTACHMENTS_TEST_DATABASE_URL")
        .expect("explicit isolated test database required");
    let url = reqwest::Url::parse(&database).unwrap();
    assert!(["postgres", "postgresql"].contains(&url.scheme()));
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_eq!(url.path(), "/tada_qa_e05");
    keyword_search_checks(&database).await;
}

async fn keyword_search_checks(database: &str) {
    let f = Fixture::at(database).await;
    let epoch = f.enable().await;
    for _ in 0..4 {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(f.sync(&id, "MÜNCHEN ΑΘΉΝΑ 100%_done! C:\\Photos", epoch).await.status(), StatusCode::OK);
    }
    assert_eq!(f.sync(&f.asset, "unrelated OCR", epoch).await.status(), StatusCode::OK);
    sqlx::query("UPDATE photo_index_results SET search_text=NULL WHERE user_id=$1")
        .bind(&f.user).execute(&f.state.pool).await.unwrap();
    initialize_keyword_search(&f.state.pool).await.unwrap();
    let all = literal_matches(&f.state, &f.user, &f.device, "münchen", 100, 0).await.unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "αθήνα", 100, 0).await.unwrap(), all);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "%_", 100, 0).await.unwrap(), all);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "done! c:\\photos", 100, 0).await.unwrap(), all);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 2, 0).await.unwrap(), all[..2]);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 2, 2).await.unwrap(), all[2..]);
    assert!(literal_matches(&f.state, &f.user, &uuid::Uuid::new_v4().to_string(), "münchen", 20, 0).await.unwrap().is_empty());
    let path = format!("{}/assets?mode=keyword&q=m%C3%BCnchen", f.base());
    let response = call(&f.state, &f.other, "GET", &path, json!(null)).await;
    assert!(body(response).await["items"].as_array().unwrap().is_empty());
    assert_eq!(body(f.call("GET", &path, json!(null)).await).await["items"].as_array().unwrap().len(), 4);
    f.cleanup().await;
}

#[tokio::test]
async fn legacy_keyword_search_backfills_multiple_batches_and_preserves_source() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let pool = repo.pool();
    sqlx::query("CREATE TABLE photo_index_results(user_id TEXT NOT NULL,device_id TEXT NOT NULL,asset_id TEXT NOT NULL,kind TEXT NOT NULL,processor TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(user_id,device_id,asset_id,kind))")
        .execute(&pool).await.unwrap();
    for i in 0..257 {
        sqlx::query("INSERT INTO photo_index_results(user_id,device_id,asset_id,kind,processor,content)VALUES('legacy-user','legacy-device',$1,'ocr','device','MÜNCHEN ΑΘΉΝΑ 100%_!')")
            .bind(i.to_string()).execute(&pool).await.unwrap();
    }
    initialize(&pool).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM photo_index_results WHERE content='MÜNCHEN ΑΘΉΝΑ 100%_!' AND search_text='münchen αθήνα 100%_!'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(count, 257);
    initialize_keyword_search(&pool).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM photo_index_results WHERE search_text IS NULL").fetch_one(&pool).await.unwrap(), 0);
    pool.close().await;
}

#[tokio::test]
async fn keyword_backfill_cannot_resurrect_deleted_or_overwrite_resynced_rows() {
    let f = Fixture::new().await;
    let epoch = f.enable().await;
    assert_eq!(f.sync(&f.asset, "OLD MÜNCHEN", epoch).await.status(), StatusCode::OK);
    sqlx::query("UPDATE photo_index_results SET search_text=NULL WHERE user_id=$1")
        .bind(&f.user).execute(&f.state.pool).await.unwrap();
    let pending = sqlx::query_as::<_, (String, String, String, String, String)>("SELECT user_id,device_id,asset_id,kind,content FROM photo_index_results WHERE user_id=$1")
        .bind(&f.user).fetch_all(&f.state.pool).await.unwrap();
    assert_eq!(f.sync(&f.asset, "NEW ΑΘΉΝΑ", epoch).await.status(), StatusCode::OK);
    backfill_keyword_batch(&f.state.pool, &pending).await.unwrap();
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "new αθήνα", 20, 0).await.unwrap(), vec![f.asset.clone()]);
    f.call("DELETE", &f.base(), json!(null)).await;
    backfill_keyword_batch(&f.state.pool, &pending).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM photo_index_results WHERE user_id=$1").bind(&f.user).fetch_one(&f.state.pool).await.unwrap(), 0);
    f.cleanup().await;
}

#[tokio::test]
async fn keyword_recent_window_preserves_global_order_and_older_matches() {
    let f = Fixture::new().await;
    let epoch = f.enable().await;
    for _ in 0..30 {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(f.sync(&id, "MÜNCHEN", epoch).await.status(), StatusCode::OK);
    }
    let all = literal_matches(&f.state, &f.user, &f.device, "münchen", 100, 0).await.unwrap();
    assert_eq!(all.len(), 30);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 20, 0).await.unwrap(), all[..20]);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 20, 20).await.unwrap(), all[20..]);
    for _ in 0..270 {
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(f.sync(&id, "unrelated recent photo", epoch).await.status(), StatusCode::OK);
    }
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 20, 0).await.unwrap(), all[..20]);
    assert_eq!(literal_matches(&f.state, &f.user, &f.device, "münchen", 20, 20).await.unwrap(), all[20..]);
    f.cleanup().await;
}

#[tokio::test]
async fn semantic_search_finds_nonliteral_matches_caches_calls_and_isolates_users() {
    semantic_search_checks("sqlite::memory:", false).await;
}

#[tokio::test]
#[ignore = "requires an isolated photo_index_test_* PostgreSQL database"]
async fn postgres_photo_semantic_round_trip() {
    let url =
        std::env::var("PHOTO_INDEX_TEST_DATABASE_URL").expect("set isolated test database URL");
    assert!(
        reqwest::Url::parse(&url)
            .unwrap()
            .path()
            .starts_with("/photo_index_test_")
    );
    semantic_search_checks(&url, true).await;
}

async fn semantic_search_checks(database: &str, require_vector: bool) {
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/embeddings",
        post(
            move |headers: HeaderMap, Json(input): Json<serde_json::Value>| {
                let received = received.clone();
                async move {
                    assert_eq!(headers[header::AUTHORIZATION], "Bearer mock-key");
                    assert_eq!(input.as_object().unwrap().len(), 4);
                    assert_eq!(input["dimensions"], 2);
                    let text = input["input"][0].as_str().unwrap();
                    received.fetch_add(1, Ordering::SeqCst);
                    let vector = if text.contains("发票") {
                        vec![0.0, 1.0]
                    } else {
                        vec![1.0, 0.0]
                    };
                    Json(json!({"data":[{"index":0,"embedding":vector}]}))
                }
            },
        ),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut f = Fixture::at(database).await;
    if require_vector {
        assert!(
            f.state.photo_index.postgres_vector,
            "pgvector must be exercised"
        );
    }
    f.configure(format!("http://{address}/embeddings"));
    assert_eq!(
        f.call("POST", &format!("{}/prepare", f.base()), json!(null))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let epoch = f.enable_cloud().await;
    assert_eq!(
        f.sync(&f.asset, "2026年10月28日 航班：MU5810\n目的地：昆明", epoch)
            .await
            .status(),
        StatusCode::OK
    );
    let invoice = uuid::Uuid::new_v4().to_string();
    f.sync(&invoice, "餐厅发票 金额：￥1280.50", epoch).await;
    for _ in 0..2 {
        let response = f
            .call("POST", &format!("{}/prepare", f.base()), json!(null))
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["processed"], true);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    f.sync(&f.asset, "2026年10月28日 航班：MU5810\n目的地：昆明", epoch)
        .await;
    assert_eq!(
        body(
            f.call("POST", &format!("{}/prepare", f.base()), json!(null))
                .await
        )
        .await["processed"],
        false
    );
    let path = format!("{}/assets?q={}", f.base(), percent_encode("出行凭证"));
    for _ in 0..2 {
        let result = body(f.call("GET", &path, json!(null)).await).await;
        assert_eq!(result["search_mode"], "hybrid");
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["asset_id"], f.asset);
        assert!(
            result["items"][0]["facts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|fact| fact["kind"] == "location"
                    && fact["value"] == "昆明"
                    && fact["needs_confirmation"] == true)
        );
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "repeat search must use cached query embedding"
    );
    let isolated = body(call(&f.state, &f.other, "GET", &path, json!(null)).await).await;
    assert!(isolated["items"].as_array().unwrap().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    f.call("PUT", &f.base(), json!({"enabled":false})).await;
    assert_eq!(
        body(f.call("GET", &path, json!(null)).await).await["search_mode"],
        "keyword"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    f.call("DELETE", &f.base(), json!(null)).await;
    for table in [
        "photo_index_vector_spaces",
        "photo_index_facts",
        "photo_embedding_queries",
    ] {
        assert_eq!(count(&f.state, table).await, 0);
    }
    assert_eq!(
        count(&f.state, "photo_embedding_attempts").await,
        3,
        "clearing cannot reset paid-call quota"
    );
    assert!(
        std::fs::read_dir(&f.state.config.root)
            .unwrap()
            .next()
            .is_none()
    );
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn clearing_while_embedding_is_in_flight_cannot_resurrect_derived_data() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let arrived = entered.clone();
    let gate = release.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/embeddings",
        post(move || {
            let arrived = arrived.clone();
            let gate = gate.clone();
            async move {
                arrived.notify_one();
                gate.notified().await;
                Json(json!({"data":[{"index":0,"embedding":[1.0,0.0]}]}))
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut f = Fixture::new().await;
    f.configure(format!("http://{address}/embeddings"));
    let epoch = f.enable_cloud().await;
    f.sync(&f.asset, "目的地：昆明", epoch).await;
    let state = f.state.clone();
    let token = f.token.clone();
    let path = format!("{}/prepare", f.base());
    let pending =
        tokio::spawn(async move { call(&state, &token, "POST", &path, json!(null)).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    assert_eq!(
        f.call("DELETE", &f.base(), json!(null)).await.status(),
        StatusCode::OK
    );
    release.notify_one();
    assert_eq!(pending.await.unwrap().status(), StatusCode::CONFLICT);
    assert_eq!(count(&f.state, "photo_index_vector_spaces").await, 0);
    assert_eq!(count(&f.state, "photo_index_facts").await, 0);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn embedding_failures_keep_quota_and_provider_errors_never_leak() {
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/embeddings",
        post(move || {
            let received = received.clone();
            async move {
                received.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "private-provider-payload",
                )
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut f = Fixture::new().await;
    f.configure(format!("http://{address}/embeddings"));
    let epoch = f.enable_cloud().await;
    f.sync(&f.asset, "地点：昆明", epoch).await;
    let response = f
        .call("POST", &format!("{}/prepare", f.base()), json!(null))
        .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(
        !body(response)
            .await
            .to_string()
            .contains("private-provider-payload")
    );
    let retry = body(
        f.call("POST", &format!("{}/prepare", f.base()), json!(null))
            .await,
    )
    .await;
    assert_eq!(retry["deferred"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(count(&f.state, "photo_embedding_attempts").await, 1);
    assert_eq!(count(&f.state, "photo_index_vector_spaces").await, 0);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn daily_admission_limit_survives_cache_deletion() {
    let mut f = Fixture::new().await;
    f.configure("http://127.0.0.1:1/embeddings".into());
    let epoch = f.enable_cloud().await;
    f.sync(&f.asset, "地点：昆明", epoch).await;
    for _ in 0..100 {
        sqlx::query(
            "INSERT INTO photo_embedding_attempts(id,user_id,requested_at,units)VALUES($1,$2,$3,1)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&f.user)
        .bind(chrono::Utc::now().timestamp())
        .execute(&f.state.pool)
        .await
        .unwrap();
    }
    let result = body(
        f.call("POST", &format!("{}/prepare", f.base()), json!(null))
            .await,
    )
    .await;
    assert_eq!(result["deferred"], true);
    assert_eq!(count(&f.state, "photo_embedding_attempts").await, 100);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires an explicitly configured backend embedding key; sends synthetic text only"]
async fn real_embedding_service_ranks_synthetic_travel_text() {
    let f = Fixture::new().await;
    let config = f
        .state
        .photo_index
        .config
        .as_ref()
        .expect("configure PHOTO_EMBEDDING_* privately");
    let travel = semantic::embed(
        &f.state,
        config,
        "航班行程单：上海飞往昆明，2026年10月28日，航班MU5810。",
    )
    .await
    .unwrap();
    let food = semantic::embed(&f.state, config, "餐厅发票：宫保鸡丁、米饭，合计58元。")
        .await
        .unwrap();
    let query = semantic::embed(&f.state, config, "去云南坐飞机的出行凭证")
        .await
        .unwrap();
    let score = |v: &Vec<f64>| v.iter().zip(&query).map(|(a, b)| a * b).sum::<f64>();
    assert!(score(&travel) > score(&food));
    f.cleanup().await;
}

#[tokio::test]
async fn changed_source_invalidates_vectors_even_when_the_client_reuses_a_revision() {
    let f = Fixture::new().await;
    let epoch = f.enable().await;
    f.sync(&f.asset, "金额：￥50", epoch).await;
    let fingerprint:String=sqlx::query_scalar("SELECT source_hash FROM photo_index_facts WHERE user_id=$1 AND device_id=$2 AND asset_id=$3").bind(&f.user).bind(&f.device).bind(&f.asset).fetch_one(&f.state.pool).await.unwrap();
    sqlx::query("INSERT INTO photo_index_vectors(user_id,device_id,asset_id,revision,input_hash,model,dimension,vector_data)VALUES($1,$2,$3,'v1',$4,'test',2,'[1,0]')")
        .bind(&f.user).bind(&f.device).bind(&f.asset).bind(fingerprint).execute(&f.state.pool).await.unwrap();
    assert_eq!(count(&f.state, "photo_index_vectors").await, 1);
    f.sync(&f.asset, "金额：￥100", epoch).await;
    assert_eq!(count(&f.state, "photo_index_vectors").await, 0);
    let result = body(
        f.call("GET", &format!("{}/assets", f.base()), json!(null))
            .await,
    )
    .await;
    assert_eq!(result["items"][0]["facts"][0]["value"], "￥100");
    f.cleanup().await;
}

#[tokio::test]
async fn malformed_or_zero_embeddings_are_never_persisted() {
    for vector in [vec![1.0], vec![0.0, 0.0]] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/embeddings",
            post(move || {
                let vector = vector.clone();
                async move { Json(json!({"data":[{"index":0,"embedding":vector}]})) }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut f = Fixture::new().await;
        f.configure(format!("http://{address}/embeddings"));
        let epoch = f.enable_cloud().await;
        f.sync(&f.asset, "地点：昆明", epoch).await;
        assert_eq!(
            f.call("POST", &format!("{}/prepare", f.base()), json!(null))
                .await
                .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(count(&f.state, "photo_index_vector_spaces").await, 0);
        server.abort();
        f.cleanup().await;
    }
}
