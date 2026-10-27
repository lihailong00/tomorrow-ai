use super::super::tests::{Fixture, body};
use super::*;
use axum::http::Request;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;
use tower::ServiceExt;
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfElEQVR4nNXOQREAIADDsFL/nocIHlyjIGcbZRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncRIncf4OvLpyqgN9ZSiDcwAAAABJRU5ErkJggg==";
async fn mock(
    f: &mut Fixture,
    barrier: Option<(Arc<Notify>, Arc<Notify>)>,
    valid: bool,
) -> (Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    f.state.photo_vision = Arc::new(Runtime {
        config: Some(semantic::Config {
            endpoint: format!("http://{}/chat/completions", listener.local_addr().unwrap()),
            key: "mock-key".into(),
            model: "test-vision".into(),
            dimension: 0,
        }),
        active: Arc::new(Semaphore::new(2)),
        client: reqwest::Client::new(),
    });
    let app=Router::new().route("/chat/completions",post(move |headers:HeaderMap,Json(value):Json<serde_json::Value>|{
        let observed=observed.clone();let barrier=barrier.clone();
        async move {
            assert_eq!(headers[header::AUTHORIZATION],"Bearer mock-key");
            assert_eq!(value["enable_thinking"],false);
            let data=value.pointer("/messages/0/content/0/image_url/url").unwrap().as_str().unwrap();
            assert_eq!(data,format!("data:image/png;base64,{PNG}"));
            observed.fetch_add(1,Ordering::SeqCst);
            if let Some((entered,release))=barrier {entered.notify_one();release.notified().await;}
            Json(json!({"choices":[{"finish_reason":if valid{"stop"}else{"length"},"message":{"content":json!({"description":"一张飞往昆明的机票截图","ocr":"2026年10月28日\n航班：MU5810\n目的地：昆明","labels":["机票","出行"]}).to_string()}}]}))
        }
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (calls, server)
}
fn input(epoch: i64) -> serde_json::Value {
    json!({"epoch":epoch,"revision":"source-v1","metadata":{"taken_at":null,"modified_at":1,"width":4000,"height":3000,"size":5000000,"mime_type":"image/jpeg"}})
}
async fn upload(
    state: &AttachmentsState,
    token: &str,
    path: &str,
    input: serde_json::Value,
    image: &[u8],
) -> Response {
    let mut bytes=format!("--photo-test\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n{input}\r\n--photo-test\r\nContent-Disposition: form-data; name=\"image\"; filename=\"analysis.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
    bytes.extend_from_slice(image);
    bytes.extend_from_slice(b"\r\n--photo-test--\r\n");
    super::super::super::router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    "multipart/form-data; boundary=photo-test",
                )
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap()
}
fn png() -> Vec<u8> {
    STANDARD.decode(PNG).unwrap()
}
async fn cloud_enable(f: &Fixture) -> i64 {
    body(
        f.call(
            "PUT",
            &f.base(),
            json!({"enabled":true,"cloud_processing":true}),
        )
        .await,
    )
    .await["epoch"]
        .as_i64()
        .unwrap()
}
async fn status(f: &Fixture, epoch: i64) -> serde_json::Value {
    body(
        f.call(
            "GET",
            &format!(
                "{}/assets/{}/analyze?epoch={epoch}&revision=source-v1",
                f.base(),
                f.asset
            ),
            json!(null),
        )
        .await,
    )
    .await
}
async fn wait_status(f: &Fixture, epoch: i64, expected: &str) {
    for _ in 0..200 {
        if status(f, epoch).await["status"] == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("analysis did not reach {expected}");
}
async fn wait_idle(f: &Fixture) {
    for _ in 0..200 {
        if f.state.photo_vision.active.available_permits() == 2 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("detached task did not finish");
}
async fn count(f: &Fixture, table: &str) -> i64 {
    assert!(
        [
            "photo_index_assets",
            "photo_vision_attempts",
            "photo_vision_results",
            "uploads"
        ]
        .contains(&table)
    );
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn cloud_analysis_requires_new_consent_caches_derivatives_and_never_stores_images() {
    cloud_round_trip("sqlite::memory:").await;
}
#[tokio::test]
#[ignore = "requires isolated photo_index_test_* PostgreSQL database"]
async fn postgres_cloud_vision_round_trip() {
    let url = std::env::var("PHOTO_INDEX_TEST_DATABASE_URL").unwrap();
    assert!(
        reqwest::Url::parse(&url)
            .unwrap()
            .path()
            .starts_with("/photo_index_test_")
    );
    cloud_round_trip(&url).await;
}
async fn cloud_round_trip(database: &str) {
    let mut f = Fixture::at(database).await;
    let (calls, server) = mock(&mut f, None, true).await;
    let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
    assert_eq!(
        upload(&f.state, &f.token, &path, input(1), &png())
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let legacy = f.enable().await;
    let denied = upload(&f.state, &f.token, &path, input(legacy), &png()).await;
    assert_eq!(denied.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(denied).await["error"]["code"],
        "photo_cloud_consent_required"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let epoch = cloud_enable(&f).await;
    assert_eq!(
        upload(&f.state, &f.other, &path, input(epoch), &png())
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let response = upload(&f.state, &f.token, &path, input(epoch), &png()).await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(body(response).await["cached"], false);
    wait_status(&f, epoch, "complete").await;
    let response = upload(&f.state, &f.token, &path, input(epoch), &png()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["cached"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let listed = body(
        f.call(
            "GET",
            &format!("{}/assets?q=昆明&mode=keyword", f.base()),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert!(
        listed["items"][0]["facts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["value"] == "昆明")
    );
    assert_eq!(count(&f, "uploads").await, 0);
    assert_eq!(std::fs::read_dir(&f.state.config.root).unwrap().count(), 0);
    assert_eq!(
        f.call("DELETE", &f.base(), json!(null)).await.status(),
        StatusCode::OK
    );
    assert_eq!(count(&f, "photo_index_assets").await, 0);
    assert_eq!(count(&f, "photo_vision_results").await, 0);
    assert_eq!(count(&f, "photo_vision_attempts").await, 1);
    server.abort();
    f.cleanup().await;
}
#[tokio::test]
async fn cloud_analysis_rejects_invalid_images_and_metadata_without_paid_calls() {
    let mut f = Fixture::new().await;
    let (calls, server) = mock(&mut f, None, true).await;
    let epoch = cloud_enable(&f).await;
    let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
    for (mut value, bytes) in [
        (input(epoch), b"not-an-image".to_vec()),
        (input(epoch), png()),
    ] {
        if bytes == png() {
            value["metadata"]["size"] = json!(-1);
        }
        assert_eq!(
            upload(&f.state, &f.token, &path, value, &bytes)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&f, "photo_vision_attempts").await, 0);
    server.abort();
    f.cleanup().await;
}
#[tokio::test]
async fn cloud_analysis_daily_quota_is_persistent_and_failed_calls_count() {
    let mut f = Fixture::new().await;
    let (calls, server) = mock(&mut f, None, false).await;
    let epoch = cloud_enable(&f).await;
    let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
    assert_eq!(
        upload(&f.state, &f.token, &path, input(epoch), &png())
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    wait_status(&f, epoch, "failed").await;
    assert_eq!(count(&f, "photo_vision_attempts").await, 1);
    assert_eq!(count(&f, "photo_index_assets").await, 0);
    assert_eq!(
        upload(&f.state, &f.token, &path, input(epoch), &png())
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    for _ in 0..49 {
        sqlx::query("INSERT INTO photo_vision_attempts(id,user_id,requested_at,pixels,bytes,model)VALUES($1,$2,$3,4096,100,'test')")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&f.user).bind(chrono::Utc::now().timestamp()).execute(&f.state.pool).await.unwrap();
    }
    let another = format!("{}/assets/{}/analyze", f.base(), uuid::Uuid::new_v4());
    assert_eq!(
        upload(&f.state, &f.token, &another, input(epoch), &png())
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    f.call("DELETE", &f.base(), json!(null)).await;
    assert_eq!(count(&f, "photo_vision_attempts").await, 50);
    server.abort();
    f.cleanup().await;
}
#[tokio::test]
async fn clearing_or_removing_during_cloud_call_cannot_resurrect_index() {
    for clear_all in [true, false] {
        let mut f = Fixture::new().await;
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (_, server) = mock(&mut f, Some((entered.clone(), release.clone())), true).await;
        let epoch = cloud_enable(&f).await;
        let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
        let pending = upload(&f.state, &f.token, &path, input(epoch), &png()).await;
        assert_eq!(pending.status(), StatusCode::ACCEPTED);
        entered.notified().await;
        let cancel = if clear_all {
            f.base()
        } else {
            format!("{}/assets/{}", f.base(), f.asset)
        };
        assert_eq!(
            f.call("DELETE", &cancel, json!({"epoch":epoch}))
                .await
                .status(),
            StatusCode::OK
        );
        release.notify_one();
        wait_idle(&f).await;
        assert_eq!(count(&f, "photo_index_assets").await, 0);
        assert_eq!(count(&f, "photo_vision_attempts").await, 1);
        server.abort();
        f.cleanup().await;
    }
}
#[tokio::test]
async fn slow_inference_survives_upload_disconnect_and_retries_do_not_pay_twice() {
    let mut f = Fixture::new().await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (calls, server) = mock(&mut f, Some((entered.clone(), release.clone())), true).await;
    let epoch = cloud_enable(&f).await;
    let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
    let response = tokio::time::timeout(
        Duration::from_secs(1),
        upload(&f.state, &f.token, &path, input(epoch), &png()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    drop(response); // no client response body or connection is retained
    entered.notified().await;
    assert_eq!(status(&f, epoch).await["status"], "processing");
    assert_eq!(
        upload(&f.state, &f.token, &path, input(epoch), &png())
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(count(&f, "photo_vision_attempts").await, 1);
    let foreign = super::super::super::router(f.state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("{path}?epoch={epoch}&revision=source-v1"))
                .header(header::AUTHORIZATION, format!("Bearer {}", f.other))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::CONFLICT);
    release.notify_one();
    wait_status(&f, epoch, "complete").await;
    wait_idle(&f).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
    f.cleanup().await;
}
#[tokio::test]
async fn abandoned_processing_record_expires_without_storing_or_reusing_an_image() {
    let mut f = Fixture::new().await;
    let (_, server) = mock(&mut f, None, true).await;
    let epoch = cloud_enable(&f).await;
    let now = chrono::Utc::now().timestamp();
    let job = uuid::Uuid::new_v4().to_string();
    // Represents a process restart: durable metadata exists, image RAM is gone.
    sqlx::query("INSERT INTO photo_vision_jobs(user_id,device_id,asset_id,requested_at,job_id)VALUES($1,$2,$3,$4,$5)").bind(&f.user).bind(&f.device).bind(&f.asset).bind(now-151).bind(&job).execute(&f.state.pool).await.unwrap();
    sqlx::query("INSERT INTO photo_vision_task_state(user_id,device_id,asset_id,job_id,epoch,revision,input_hash,model,status,requested_at)VALUES($1,$2,$3,$4,$5,'source-v1','lost','test-vision','processing',$6)").bind(&f.user).bind(&f.device).bind(&f.asset).bind(&job).bind(epoch).bind(now-151).execute(&f.state.pool).await.unwrap();
    assert_eq!(status(&f, epoch).await["status"], "failed");
    assert_eq!(count(&f, "photo_index_assets").await, 0);
    let path = format!("{}/assets/{}/analyze", f.base(), f.asset);
    assert_eq!(
        upload(&f.state, &f.token, &path, input(epoch), &png())
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    wait_status(&f, epoch, "complete").await;
    wait_idle(&f).await;
    server.abort();
    f.cleanup().await;
}
#[test]
fn vision_configuration_requires_private_credentials_and_reuses_only_official_origins() {
    let get = |base: &str, name: &str| match name {
        "ASR_PROTOCOL" => Some("qwen_asr".into()),
        "ASR_BASE_URL" => Some(base.into()),
        "ASR_API_KEY" => Some("private-test".into()),
        _ => None,
    };
    let config = config_from(|name| get("https://dashscope.aliyuncs.com/compatible-mode/v1", name))
        .unwrap()
        .unwrap();
    assert!(config.endpoint.ends_with("/chat/completions"));
    assert_eq!(config.model, "qwen3.7-flash");
    assert!(
        config_from(|name| get("https://attacker.test/compatible-mode/v1", name))
            .unwrap()
            .is_none()
    );
    assert!(
        config_from(|name| if name == "PHOTO_VISION_ENABLED" {
            Some("false".into())
        } else {
            get("https://dashscope.aliyuncs.com/compatible-mode/v1", name)
        })
        .unwrap()
        .is_none()
    );
}
