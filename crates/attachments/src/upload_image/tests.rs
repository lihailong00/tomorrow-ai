use super::*;
use axum::{body::to_bytes, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        RwLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use tower::ServiceExt;

const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAIADDsFL/nocIHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLpyqgN9ZSiDcwAAAABJRU5ErkJggg==";
struct Fixture {
    state: AttachmentsState,
    user: String,
    token: String,
    other: String,
}
impl Fixture {
    async fn new() -> Self {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo
            .create_user(
                "image@example.test",
                "unused-test-hash",
                "image",
                "Asia/Shanghai",
            )
            .await
            .unwrap();
        let other = repo
            .create_user(
                "other@example.test",
                "unused-test-hash",
                "other",
                "Asia/Shanghai",
            )
            .await
            .unwrap();
        let token = repo.create_session(&user.id).await.unwrap();
        let other = repo.create_session(&other.id).await.unwrap();
        let root =
            std::env::temp_dir().join(format!("tada-chat-image-test-{}", uuid::Uuid::new_v4()));
        let state = AttachmentsState::initialize(repo, root, 10 * 1024 * 1024, None)
            .await
            .unwrap()
            .reconfigured(&HashMap::from([(
                "PHOTO_VISION_ENABLED".into(),
                "false".into(),
            )]))
            .unwrap();
        Self {
            state,
            user: user.id,
            token,
            other,
        }
    }
    async fn call(&self, method: &str, path: &str) -> Response {
        call(&self.state, &self.token, method, path).await
    }
    async fn upload(&self, mime: &str, bytes: &[u8]) -> Upload {
        let mut body=format!("--image-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"schedule.png\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n--image-test--\r\n");
        let response = crate::router(self.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/uploads")
                    .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                    .header(
                        header::CONTENT_TYPE,
                        "multipart/form-data; boundary=image-test",
                    )
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        serde_json::from_value(json_body(response).await).unwrap()
    }
    async fn cleanup(self) {
        let root = self.state.config.root.clone();
        let temp = tokio::fs::canonicalize(std::env::temp_dir()).await.unwrap();
        assert!(root.starts_with(temp));
        assert!(
            root.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("tada-chat-image-test-")
        );
        self.state.pool.close().await;
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
fn configuration(endpoint: &str, model: &str) -> HashMap<String, String> {
    HashMap::from([
        ("PHOTO_VISION_ENABLED".into(), "true".into()),
        ("PHOTO_VISION_BASE_URL".into(), endpoint.into()),
        ("PHOTO_VISION_API_KEY".into(), "fixture-image-key".into()),
        ("PHOTO_VISION_MODEL".into(), model.into()),
    ])
}
async fn mock(
    f: &mut Fixture,
    barrier: Option<(Arc<Notify>, Arc<Notify>)>,
    valid: bool,
) -> (Arc<AtomicUsize>, tokio::task::JoinHandle<()>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    f.state = f
        .state
        .reconfigured(&configuration(&base, "fixture-vision"))
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let pool = f.state.pool.clone();
    let user = f.user.clone();
    let app=Router::new().route("/v1/chat/completions",post(move |headers:HeaderMap,Json(value):Json<serde_json::Value>|{
        let count=count.clone();let barrier=barrier.clone();let pool=pool.clone();let user=user.clone();async move {
            let dispatched: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_requests WHERE user_id=$1 AND capability='vision' AND purpose='image' AND outcome_json=''")
                .bind(&user).fetch_one(&pool).await.unwrap();
            assert!(dispatched > 0, "usage dispatch is durable before provider receives the image");
            assert_eq!(headers[header::AUTHORIZATION],"Bearer fixture-image-key");
            assert_eq!(value["enable_thinking"],false);assert_eq!(value["stream"],false);
            assert_eq!(value.pointer("/messages/0/content/0/image_url/url").unwrap(),&format!("data:image/png;base64,{PNG}"));
            count.fetch_add(1,Ordering::SeqCst);
            if let Some((entered,release))=barrier{entered.notify_one();release.notified().await;}
            Json(json!({"choices":[{"finish_reason":if valid{"stop"}else{"length"},"message":{"content":json!({"description":"一张日程截图","ocr":"09:00 阅读\n17:00 散步","labels":["日程","阅读"]}).to_string()}}],"usage":{"prompt_tokens":120,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}))
        }
    }));
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (calls, task, base)
}
async fn call(state: &AttachmentsState, token: &str, method: &str, path: &str) -> Response {
    crate::router(state.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn json_body(response: Response) -> serde_json::Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap()
}
async fn wait_failed(f: &Fixture, id: &str) {
    for _ in 0..80 {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM upload_image_jobs WHERE upload_id=$1")
                .bind(id)
                .fetch_optional(&f.state.pool)
                .await
                .unwrap();
        if status.as_deref() == Some("failed") || status.is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("job did not terminate");
}

#[tokio::test]
async fn explicit_image_analysis_is_cached_owner_scoped_and_chat_readable_without_audio_transcript()
{
    let mut f = Fixture::new().await;
    let (calls, server, _) = mock(&mut f, None, true).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let path = format!("/v1/uploads/{}/analyze", image.id);
    let textpath = format!("/v1/uploads/{}/text", image.id);
    let before = f.call("GET", &textpath).await;
    assert_eq!(before.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(before).await["error"]["code"],
        "image_not_analyzed"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        call(&f.state, &f.other, "POST", &path).await.status(),
        StatusCode::NOT_FOUND
    );
    let response = f.call("POST", &path).await;
    assert_eq!(response.status(), StatusCode::OK);
    let result = json_body(response).await;
    assert_eq!(result["upload_id"], image.id);
    assert_eq!(result["name"], "schedule.png");
    assert_eq!(result["model"], "fixture-vision");
    assert!(result["text"].as_str().unwrap().contains("17:00 散步"));
    let cached = f.call("POST", &path).await;
    assert_eq!(cached.status(), StatusCode::OK);
    assert_eq!(json_body(cached).await, result);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let ledger: Vec<(String,String,String,String)> = sqlx::query_as("SELECT user_id,capability,purpose,outcome_json FROM usage_requests")
        .fetch_all(&f.state.pool).await.unwrap();
    assert_eq!(ledger.len(), 1, "cached image results do not generate usage");
    assert_eq!((&ledger[0].0, ledger[0].1.as_str(), ledger[0].2.as_str()), (&f.user, "vision", "image"));
    let outcome: serde_json::Value = serde_json::from_str(&ledger[0].3).unwrap();
    assert_eq!(outcome["measurements"]["image_count"], 1);
    assert_eq!(outcome["measurements"]["input_tokens"], 120);
    assert_eq!(outcome["measurements"]["cache_read_tokens"], 80);
    assert_eq!(
        json_body(f.call("GET", &textpath).await).await["text"],
        result["text"]
    );
    let context = f
        .state
        .chat_context(&f.user, &[image.id.clone()])
        .await
        .unwrap();
    assert!(context.contains("日程截图"));
    assert!(context.contains("17:00 散步"));
    let transcript: Option<String> =
        sqlx::query_scalar("SELECT transcript FROM uploads WHERE id=$1")
            .bind(&image.id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert!(transcript.is_none());
    f.state = f
        .state
        .reconfigured(&HashMap::from([(
            "PHOTO_VISION_ENABLED".into(),
            "false".into(),
        )]))
        .unwrap();
    assert_eq!(f.call("GET", &textpath).await.status(), StatusCode::OK);
    assert_eq!(
        f.call("POST", &path).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.call("DELETE", &format!("/v1/uploads/{}", image.id))
            .await
            .status(),
        StatusCode::OK
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM upload_image_results")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let outcomes: Vec<String> = sqlx::query_scalar("SELECT outcome_json FROM usage_requests WHERE user_id=$1 AND purpose='image'")
        .bind(&f.user).fetch_all(&f.state.pool).await.unwrap();
    assert_eq!(outcomes.len(), 1, "deleting the attachment preserves its paid request");
    let measured: serde_json::Value = serde_json::from_str(&outcomes[0]).unwrap();
    assert_eq!(measured["measurements"]["input_tokens"], 120);
    assert_eq!(measured["measurements"]["image_count"], 1);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn concurrent_retry_and_disconnected_http_share_one_durable_inference() {
    let mut f = Fixture::new().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (calls, server, _) = mock(&mut f, Some((entered.clone(), release.clone())), true).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let path = format!("/v1/uploads/{}/analyze", image.id);
    let state = f.state.clone();
    let token = f.token.clone();
    let firstpath = path.clone();
    let first = tokio::spawn(async move { call(&state, &token, "POST", &firstpath).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    first.abort();
    let state = f.state.clone();
    let token = f.token.clone();
    let secondpath = path.clone();
    let second = tokio::spawn(async move { call(&state, &token, "POST", &secondpath).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    release.notify_one();
    let response = second.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM photo_vision_attempts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(attempts, 1);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn missing_provider_and_invalid_or_unsupported_images_never_call_model() {
    let mut f = Fixture::new().await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let missing = f
        .call("POST", &format!("/v1/uploads/{}/analyze", image.id))
        .await;
    assert_eq!(missing.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(missing).await["error"]["code"],
        "image_vision_not_configured"
    );
    let (calls, server, _) = mock(&mut f, None, true).await;
    let invalid = f.upload("image/png", b"not a PNG").await;
    assert_eq!(
        f.call("POST", &format!("/v1/uploads/{}/analyze", invalid.id))
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let other = f.upload("image/webp", b"RIFFxxxxWEBP").await;
    assert_eq!(
        f.call("POST", &format!("/v1/uploads/{}/analyze", other.id))
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let large = f.upload("image/png", &vec![0; vision::MAX_BYTES + 1]).await;
    assert_eq!(
        f.call("POST", &format!("/v1/uploads/{}/analyze", large.id))
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut huge = STANDARD.decode(PNG).unwrap();
    huge[16..20].copy_from_slice(&8192u32.to_be_bytes());
    huge[20..24].copy_from_slice(&8192u32.to_be_bytes());
    let huge = f.upload("image/png", &huge).await;
    assert_eq!(
        f.call("POST", &format!("/v1/uploads/{}/analyze", huge.id))
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let dispatched: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_requests").fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(dispatched, 0, "local image validation never calls a model");
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn deletion_during_inference_discards_result_and_jobs_without_resurrecting_attachment() {
    let mut f = Fixture::new().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (calls, server, _) = mock(&mut f, Some((entered.clone(), release.clone())), true).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let state = f.state.clone();
    let token = f.token.clone();
    let path = format!("/v1/uploads/{}/analyze", image.id);
    let work = tokio::spawn(async move { call(&state, &token, "POST", &path).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    assert_eq!(
        f.call("DELETE", &format!("/v1/uploads/{}", image.id))
            .await
            .status(),
        StatusCode::OK
    );
    release.notify_one();
    assert_eq!(work.await.unwrap().status(), StatusCode::NOT_FOUND);
    wait_failed(&f, &image.id).await;
    let count:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM upload_image_results)+(SELECT count(*) FROM upload_image_jobs)+(SELECT count(*) FROM uploads)").fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(count, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn live_provider_change_discards_old_result_then_retries_against_current_configuration() {
    let mut f = Fixture::new().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (a_calls, a, a_base) = mock(&mut f, Some((entered.clone(), release.clone())), true).await;
    let (b_calls, b, b_base) = mock(&mut f, None, true).await;
    let shared = Arc::new(RwLock::new(configuration(&a_base, "fixture-vision")));
    let loader = shared.clone();
    f.state = f
        .state
        .reconfigured(&shared.read().unwrap())
        .unwrap()
        .with_photo_configuration(move || {
            let values = loader.read().unwrap().clone();
            async move { Some((1, values)) }
        });
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let path = format!("/v1/uploads/{}/analyze", image.id);
    let state = f.state.clone();
    let token = f.token.clone();
    let firstpath = path.clone();
    let first = tokio::spawn(async move { call(&state, &token, "POST", &firstpath).await });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    *shared.write().unwrap() = configuration(&b_base, "fixture-vision");
    release.notify_one();
    let old = first.await.unwrap();
    assert_eq!(old.status(), StatusCode::CONFLICT);
    assert_eq!(
        json_body(old).await["error"]["code"],
        "image_vision_configuration_changed"
    );
    wait_failed(&f, &image.id).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM upload_image_results")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(f.call("POST", &path).await.status(), StatusCode::OK);
    assert_eq!(a_calls.load(Ordering::SeqCst), 1);
    assert_eq!(b_calls.load(Ordering::SeqCst), 1);
    a.abort();
    b.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn incomplete_model_output_is_not_cached_and_retry_remains_explicit() {
    let mut f = Fixture::new().await;
    let (calls, server, _) = mock(&mut f, None, false).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let path = format!("/v1/uploads/{}/analyze", image.id);
    let response = f.call("POST", &path).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "image_vision_unavailable"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.call("GET", &format!("/v1/uploads/{}/text", image.id))
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM upload_image_results")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let outcomes: Vec<String> = sqlx::query_scalar("SELECT outcome_json FROM usage_requests WHERE user_id=$1 AND purpose='image'")
        .bind(&f.user).fetch_all(&f.state.pool).await.unwrap();
    assert_eq!(outcomes.len(), 1, "rejected model output still has one paid request");
    let measured: serde_json::Value = serde_json::from_str(&outcomes[0]).unwrap();
    assert_eq!(measured["measurements"]["input_tokens"], 120);
    assert_eq!(measured["measurements"]["image_count"], 1);
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn upload_analysis_shares_daily_admission_with_album_calls() {
    let mut f = Fixture::new().await;
    let (calls, server, _) = mock(&mut f, None, true).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    for _ in 0..50 {
        sqlx::query("INSERT INTO photo_vision_attempts(id,user_id,requested_at,pixels,bytes,model)VALUES($1,$2,$3,4096,100,'album-fixture')")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&f.user).bind(chrono::Utc::now().timestamp()).execute(&f.state.pool).await.unwrap();
    }
    let response = f
        .call("POST", &format!("/v1/uploads/{}/analyze", image.id))
        .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let dispatched: i64 = sqlx::query_scalar("SELECT count(*) FROM usage_requests").fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(dispatched, 0, "local quota rejection never calls a model");
    server.abort();
    f.cleanup().await;
}

#[tokio::test]
async fn busy_image_service_does_not_spend_daily_admission_or_create_phantom_job() {
    let mut f = Fixture::new().await;
    let (calls, server, _) = mock(&mut f, None, true).await;
    let image = f.upload("image/png", &STANDARD.decode(PNG).unwrap()).await;
    let permit = f
        .state
        .photo_vision
        .active
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let path = format!("/v1/uploads/{}/analyze", image.id);
    assert_eq!(
        f.call("POST", &path).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let count: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM photo_vision_attempts)+(SELECT count(*) FROM upload_image_jobs)")
        .fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(count, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    drop(permit);
    assert_eq!(f.call("POST", &path).await.status(), StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
    f.cleanup().await;
}
