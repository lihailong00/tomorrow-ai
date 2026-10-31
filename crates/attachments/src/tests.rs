use super::*;
use axum::{body::to_bytes, http::Request};
use tower::ServiceExt;

#[test]
fn asr_configuration_supports_explicit_private_http_services_and_rejects_public_http() {
    let configuration = |base: &str| super::asr_from_lookup(|key| match key {
        "ASR_BASE_URL" => Some(base.to_owned()),
        "ASR_MODEL" => Some("local-whisper".into()),
        _ => None,
    });
    for base in ["http://127.0.0.1:8081/v1","http://host.docker.internal:8081/v1","http://192.168.1.20:8081/v1","http://[::1]:8081/v1"] {
        let config = configuration(base).unwrap().unwrap();
        assert!(config.endpoint.ends_with("/audio/transcriptions"));
        assert!(config.api_key.is_none());
    }
    for base in ["http://asr.example.test/v1","http://169.254.169.254/latest","https://user:secret@example.test/v1"] {
        assert!(configuration(base).is_err());
    }
}

async fn fixture(
    max_bytes: u64,
    asr: Option<AsrConfig>,
) -> (AttachmentsState, String, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "one@example.test",
            "unused-test-hash",
            "one",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let other = repo
        .create_user(
            "two@example.test",
            "unused-test-hash",
            "two",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repo.create_session(&user.id).await.unwrap();
    let other_token = repo.create_session(&other.id).await.unwrap();
    let root = std::env::temp_dir().join(format!("tomorrow-uploads-test-{}", uuid::Uuid::new_v4()));
    let state = AttachmentsState::initialize(repo, root, max_bytes, asr)
        .await
        .unwrap();
    (state, user.id, token, other_token)
}

fn multipart_request(token: &str, name: &str, mime: &str, bytes: &[u8]) -> Request<Body> {
    let boundary = "tomorrow-test-boundary";
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Request::builder()
        .method("POST")
        .uri("/v1/uploads")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

async fn post_file(
    state: &AttachmentsState,
    token: &str,
    name: &str,
    mime: &str,
    content: &[u8],
) -> Response {
    router(state.clone())
        .oneshot(multipart_request(token, name, mime, content))
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

async fn remove_fixture(state: AttachmentsState) {
    let root = state.config.root.clone();
    assert!(root.is_absolute());
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("tomorrow-uploads-test-")
    );
    assert_eq!(
        root.parent().unwrap(),
        std::fs::canonicalize(std::env::temp_dir()).unwrap()
    );
    state.pool.close().await;
    drop(state);
    tokio::fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn upload_archive_pages_every_file_filters_before_paging_and_isolates_owners() {
    let (state, user, token, other) = fixture(DEFAULT_MAX_BYTES, None).await;
    let mut expected = std::collections::HashSet::new();
    for i in 0..205 {
        let response = post_file(&state, &token, &format!("archive-{i}.txt"), "text/plain", b"fixture").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        expected.insert(json_body(response).await["id"].as_str().unwrap().to_owned());
    }
    let audio = json_body(post_file(&state, &token, "voice.m4a", "audio/mp4", b"fixture").await).await;
    let audio_id = audio["id"].as_str().unwrap().to_owned();
    expected.insert(audio_id.clone());
    sqlx::query("UPDATE uploads SET created_at='2026-01-01T00:00:00Z' WHERE user_id=$1")
        .bind(&user).execute(&state.pool).await.unwrap();
    sqlx::query("UPDATE uploads SET created_at='1970-01-01T00:00:00Z' WHERE id=$1")
        .bind(&audio_id).execute(&state.pool).await.unwrap();
    let secret = json_body(post_file(&state, &other, "other-owner.txt", "text/plain", b"private").await).await;

    async fn get(state: &AttachmentsState, token: &str, path: &str) -> Response {
        router(state.clone()).oneshot(Request::builder().uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty()).unwrap()).await.unwrap()
    }
    let first = json_body(get(&state, &token, "/v1/uploads").await).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 200);
    assert_eq!(first["next_offset"], 200);
    let mut seen = std::collections::HashSet::new();
    let mut offset = 0;
    loop {
        let page = json_body(get(&state, &token, &format!("/v1/uploads?limit=37&offset={offset}")).await).await;
        for item in page["items"].as_array().unwrap() {
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
        }
        let Some(next) = page["next_offset"].as_i64() else { break };
        offset = next;
    }
    assert_eq!(seen, expected);
    assert!(!seen.contains(secret["id"].as_str().unwrap()));
    let filtered = json_body(get(&state, &token, "/v1/uploads?kind=audio&limit=1").await).await;
    assert_eq!(filtered["items"][0]["id"], audio_id);
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["has_more"], false);
    let last_files = json_body(get(&state, &token, "/v1/uploads?kind=file&limit=100&offset=200").await).await;
    assert_eq!(last_files["items"].as_array().unwrap().len(), 5);
    let other_page = json_body(get(&state, &other, "/v1/uploads").await).await;
    assert_eq!(other_page["items"].as_array().unwrap().len(), 1);
    assert_eq!(other_page["items"][0]["id"], secret["id"]);
    for query in ["limit=0", "limit=201", "offset=-1", "offset=1000001", "kind=unknown", "unrecognized=1"] {
        assert_eq!(get(&state, &token, &format!("/v1/uploads?{query}")).await.status(), StatusCode::BAD_REQUEST, "{query}");
    }
    let id = last_files["items"][0]["id"].as_str().unwrap();
    assert_eq!(get(&state, &token, &format!("/v1/uploads/{id}/download")).await.status(), StatusCode::OK);
    remove_fixture(state).await;
}

#[tokio::test]
async fn attachment_deletion_checks_owner_and_removes_bytes_and_context() {
    let (state, user_id, token, other_token) = fixture(DEFAULT_MAX_BYTES, None).await;
    let upload: Upload = serde_json::from_value(
        json_body(
            post_file(
                &state,
                &token,
                "private.txt",
                "text/plain",
                b"private-content",
            )
            .await,
        )
        .await,
    )
    .unwrap();
    let request = |token: &str| {
        Request::builder()
            .method("DELETE")
            .uri(format!("/v1/uploads/{}", upload.id))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let denied = router(state.clone())
        .oneshot(request(&other_token))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    assert!(state.path(&upload.id).unwrap().exists());
    let response = router(state.clone())
        .oneshot(request(&token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["ok"], true);
    assert!(!state.path(&upload.id).unwrap().exists());
    assert_eq!(
        state
            .read_text(&user_id, &upload.id)
            .await
            .unwrap_err()
            .code(),
        "not_found"
    );
    remove_fixture(state).await;
}

#[tokio::test]
async fn s3_record_without_client_never_falls_back_to_a_local_copy() {
    let (state, user_id, token, _) = fixture(DEFAULT_MAX_BYTES, None).await;
    let upload: Upload = serde_json::from_value(
        json_body(
            post_file(
                &state,
                &token,
                "notes.txt",
                "text/plain",
                b"local-old-content",
            )
            .await,
        )
        .await,
    )
    .unwrap();
    sqlx::query("INSERT INTO upload_objects(upload_id,bucket,object_key)VALUES($1,'private-bucket','remote-key')")
        .bind(&upload.id).execute(&state.pool).await.unwrap();
    assert_eq!(
        state
            .read_text(&user_id, &upload.id)
            .await
            .unwrap_err()
            .code(),
        "storage_not_configured"
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/v1/uploads/{}/download", upload.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    remove_fixture(state).await;
}

#[cfg(feature = "s3")]
#[tokio::test]
async fn sdk_s3_upload_download_context_and_delete_use_real_signed_http_and_same_auth() {
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    #[derive(Clone, Default)]
    struct MockS3 {
        objects: Arc<tokio::sync::Mutex<HashMap<String, Vec<u8>>>>,
        calls: Arc<AtomicUsize>,
    }
    async fn put_object(
        State(state): State<MockS3>,
        Path((bucket, key)): Path<(String, String)>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        assert!(
            headers
                .get(header::AUTHORIZATION)
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("AWS4-HMAC-SHA256 ")
        );
        state.calls.fetch_add(1, Ordering::SeqCst);
        state
            .objects
            .lock()
            .await
            .insert(format!("{bucket}/{key}"), body.to_vec());
        (StatusCode::OK, [("etag", "\"test-etag\"")], "").into_response()
    }
    async fn get_object(
        State(state): State<MockS3>,
        Path((bucket, key)): Path<(String, String)>,
        headers: HeaderMap,
    ) -> Response {
        assert!(headers.get(header::AUTHORIZATION).is_some());
        state.calls.fetch_add(1, Ordering::SeqCst);
        match state
            .objects
            .lock()
            .await
            .get(&format!("{bucket}/{key}"))
            .cloned()
        {
            Some(bytes) => (StatusCode::OK, bytes).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "<Error><Code>NoSuchKey</Code></Error>",
            )
                .into_response(),
        }
    }
    async fn delete_object(
        State(state): State<MockS3>,
        Path((bucket, key)): Path<(String, String)>,
        headers: HeaderMap,
    ) -> Response {
        assert!(headers.get(header::AUTHORIZATION).is_some());
        state.calls.fetch_add(1, Ordering::SeqCst);
        state
            .objects
            .lock()
            .await
            .remove(&format!("{bucket}/{key}"));
        StatusCode::NO_CONTENT.into_response()
    }
    let mock = MockS3::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route(
            "/{bucket}/{*key}",
            axum::routing::put(put_object)
                .get(get_object)
                .delete(delete_object),
        )
        .with_state(mock.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (mut state, user_id, token, other_token) = fixture(DEFAULT_MAX_BYTES, None).await;
    state.s3 = Some(
        super::s3::S3Storage::configured(
            &format!("http://{address}"),
            "test-bucket".into(),
            "us-east-1".into(),
            "test-access".into(),
            "test-secret".into(),
            None,
            "private".into(),
            true,
        )
        .unwrap(),
    );
    let response = post_file(
        &state,
        &token,
        "notes.txt",
        "text/plain",
        b"actual-s3-object",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let upload: Upload = serde_json::from_value(json_body(response).await).unwrap();
    assert_eq!(state.storage_mode(), "s3");
    assert_eq!(
        mock.objects
            .lock()
            .await
            .get(&format!("test-bucket/private/{}", upload.id))
            .unwrap()
            .as_slice(),
        b"actual-s3-object"
    );
    assert!(!state.path(&upload.id).unwrap().exists());
    assert_eq!(std::fs::read_dir(&state.config.root).unwrap().count(), 0);
    assert_eq!(
        state.read_text(&user_id, &upload.id).await.unwrap().text,
        "actual-s3-object"
    );
    let request = |token: &str, method: &str, path: &str| {
        Request::builder()
            .method(method)
            .uri(format!("/v1/uploads/{}{path}", upload.id))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let calls = mock.calls.load(Ordering::SeqCst);
    for (method, path) in [("GET", "/download"), ("DELETE", "")] {
        let response = router(state.clone())
            .oneshot(request(&other_token, method, path))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
    assert_eq!(
        mock.calls.load(Ordering::SeqCst),
        calls,
        "cross-user requests must not reach S3"
    );
    let response = router(state.clone())
        .oneshot(request(&token, "GET", "/download"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"actual-s3-object"
    );
    let response = router(state.clone())
        .oneshot(request(&token, "DELETE", ""))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(mock.objects.lock().await.is_empty());
    assert_eq!(
        state
            .read_text(&user_id, &upload.id)
            .await
            .unwrap_err()
            .code(),
        "not_found"
    );
    server.abort();
    remove_fixture(state).await;
}

/// Explicit opt-in integration gate: requires a real S3 endpoint and credentials.
/// Creates the configured bucket only when absent, then removes its test object.
#[cfg(feature = "s3")]
#[tokio::test]
#[ignore = "requires a running S3-compatible server and S3_* environment"]
async fn real_s3_server_round_trip() {
    let storage = super::s3::S3Storage::from_env().expect("S3 configuration is required");
    assert!(
        storage.ensure_test_bucket().await.is_ok(),
        "could not initialize configured test bucket"
    );
    let (mut state, user_id, token, other_token) = fixture(DEFAULT_MAX_BYTES, None).await;
    state.s3 = Some(storage);
    let content = format!("Tomorrow real S3 round trip {}", uuid::Uuid::new_v4());
    let response = post_file(
        &state,
        &token,
        "integration.txt",
        "text/plain",
        content.as_bytes(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let upload: Upload = serde_json::from_value(json_body(response).await).unwrap();
    assert_eq!(
        state.read_text(&user_id, &upload.id).await.unwrap().text,
        content
    );
    let request = |token: &str, method: &str, suffix: &str| {
        Request::builder()
            .method(method)
            .uri(format!("/v1/uploads/{}{suffix}", upload.id))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let denied = router(state.clone())
        .oneshot(request(&other_token, "GET", "/download"))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    let downloaded = router(state.clone())
        .oneshot(request(&token, "GET", "/download"))
        .await
        .unwrap();
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(downloaded.into_body(), 4096)
            .await
            .unwrap()
            .as_ref(),
        content.as_bytes()
    );
    let deleted = router(state.clone())
        .oneshot(request(&token, "DELETE", ""))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let missing = router(state.clone())
        .oneshot(request(&token, "GET", "/download"))
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    remove_fixture(state).await;
}

#[test]
fn original_filenames_never_become_paths_or_header_injections() {
    for name in [
        "../secret.txt",
        "..\\secret.txt",
        "C:secret.txt",
        "a\r\nInjected: x",
        ".",
        "..",
        "bad\0.txt",
        "name.",
        "<script>.txt",
        "",
    ] {
        assert!(validate_filename(name).is_err(), "accepted {name:?}");
    }
    assert_eq!(
        validate_filename("  日程 notes.txt  ").unwrap(),
        "日程 notes.txt"
    );
    assert_eq!(
        percent_encode("日程 notes.txt"),
        "%E6%97%A5%E7%A8%8B%20notes.txt"
    );
    assert!(validate_mime("text/plain\r\nx-injected:1").is_err());
}

#[tokio::test]
async fn upload_persists_bytes_and_metadata_and_isolates_users() {
    let (state, user_id, token, other_token) = fixture(DEFAULT_MAX_BYTES, None).await;
    let bytes = "会议明天下午三点。".as_bytes();
    let response = post_file(&state, &token, "meeting.txt", "text/plain", bytes).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let upload: Upload = serde_json::from_value(json_body(response).await).unwrap();
    assert_eq!(upload.size, bytes.len() as i64);
    assert_eq!(
        tokio::fs::read(state.path(&upload.id).unwrap())
            .await
            .unwrap(),
        bytes
    );
    assert_eq!(
        state.read_text(&user_id, &upload.id).await.unwrap().text,
        "会议明天下午三点。"
    );
    assert!(uuid::Uuid::parse_str(&upload.id).is_ok());
    let uri = format!("/v1/uploads/{}/download", upload.id);
    for auth in [None, Some(other_token)] {
        let mut request = Request::builder().uri(&uri);
        if let Some(token) = auth {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = router(state.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!([StatusCode::UNAUTHORIZED, StatusCode::NOT_FOUND].contains(&response.status()));
    }
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .uri(&uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "private, no-store"
    );
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        bytes
    );
    let list = router(state.clone())
        .oneshot(
            Request::builder()
                .uri("/v1/uploads")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(json_body(list).await["items"].as_array().unwrap().len(), 1);
    // A fresh module instance against the same repository still finds the record.
    let restarted = AttachmentsState::initialize(
        state.repo.clone(),
        state.config.root.clone(),
        DEFAULT_MAX_BYTES,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        restarted.metadata(&user_id, &upload.id).await.unwrap().name,
        "meeting.txt"
    );
    drop(restarted);
    remove_fixture(state).await;
}

#[tokio::test]
async fn oversize_empty_invalid_and_multi_file_uploads_leave_no_files() {
    let (state, _user_id, token, _other) = fixture(1024, None).await;
    let response = post_file(&state, &token, "large.txt", "text/plain", &vec![b'x'; 1025]).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(json_body(response).await["error"]["code"], "file_too_large");
    let response = post_file(&state, &token, "empty.txt", "text/plain", b"").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let response = post_file(&state, &token, "../secret.txt", "text/plain", b"secret").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let boundary = "multi-file-test";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"one.txt\"\r\n\r\none\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"two.txt\"\r\n\r\ntwo\r\n--{boundary}--\r\n"
    );
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/uploads")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let files = std::fs::read_dir(&state.config.root).unwrap().count();
    assert_eq!(files, 0);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    remove_fixture(state).await;
}

#[tokio::test]
async fn unsupported_and_binary_text_are_not_fabricated_as_readable_content() {
    let (state, user_id, token, _other) = fixture(DEFAULT_MAX_BYTES, None).await;
    for (name, content, code) in [
        (
            "report.pdf",
            b"%PDF-sample".as_slice(),
            "unsupported_file_type",
        ),
        ("fake.txt", b"text\0binary".as_slice(), "invalid_text"),
        ("encoding.txt", &[0xff, 0xfe], "invalid_text"),
    ] {
        let upload: Upload = serde_json::from_value(
            json_body(post_file(&state, &token, name, "application/octet-stream", content).await)
                .await,
        )
        .unwrap();
        assert_eq!(
            state
                .read_text(&user_id, &upload.id)
                .await
                .unwrap_err()
                .code(),
            code
        );
    }
    remove_fixture(state).await;
}

#[tokio::test]
async fn asr_without_configuration_is_explicit_and_never_fakes_transcription() {
    let (state, user_id, token, _other) = fixture(DEFAULT_MAX_BYTES, None).await;
    let upload: Upload = serde_json::from_value(
        json_body(post_file(&state, &token, "voice.wav", "audio/wav", b"RIFFsample").await).await,
    )
    .unwrap();
    let response = router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/v1/uploads/{}/transcribe", upload.id))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(response).await["error"]["code"], "not_configured");
    assert_eq!(
        state
            .read_text(&user_id, &upload.id)
            .await
            .unwrap_err()
            .code(),
        "unsupported_file_type"
    );
    remove_fixture(state).await;
}

#[tokio::test]
async fn configured_asr_makes_real_multipart_request_and_persists_transcript() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mock = Router::new().route(
        "/v1/audio/transcriptions",
        post(|headers: HeaderMap, mut multipart: Multipart| async move {
            assert_eq!(
                headers.get(header::AUTHORIZATION).unwrap(),
                "Bearer test-secret"
            );
            let mut file_seen = false;
            let mut model_seen = false;
            while let Some(field) = multipart.next_field().await.unwrap() {
                match field.name().unwrap() {
                    "file" => {
                        assert_eq!(field.file_name(), Some("voice.wav"));
                        assert_eq!(field.bytes().await.unwrap().as_ref(), b"RIFF-real-test");
                        file_seen = true;
                    }
                    "model" => {
                        assert_eq!(field.text().await.unwrap(), "test-whisper");
                        model_seen = true;
                    }
                    _ => {}
                }
            }
            assert!(file_seen && model_seen);
            Json(serde_json::json!({"text":"明早八点生成简报。"}))
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let config = AsrConfig {
        protocol: asr::Protocol::Multipart,
        endpoint: format!("http://{address}/v1/audio/transcriptions"),
        api_key: Some("test-secret".into()),
        model: "test-whisper".into(),
    };
    let (state, user_id, token, _other) = fixture(DEFAULT_MAX_BYTES, Some(config)).await;
    let upload: Upload = serde_json::from_value(
        json_body(post_file(&state, &token, "voice.wav", "audio/wav", b"RIFF-real-test").await)
            .await,
    )
    .unwrap();
    let request = || {
        Request::builder()
            .method("POST")
            .uri(format!("/v1/uploads/{}/transcribe", upload.id))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    let response = router(state.clone()).oneshot(request()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["text"], "明早八点生成简报。");
    assert_eq!(
        state.read_text(&user_id, &upload.id).await.unwrap().text,
        "明早八点生成简报。"
    );
    server.abort();
    let response = router(state.clone()).oneshot(request()).await.unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "persisted transcription must work without repeating provider call"
    );
    remove_fixture(state).await;
}

#[tokio::test]
async fn qwen_adapter_preserves_audio_and_caches_without_cross_user_calls() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mock=Router::new().route("/chat/completions", post(move |headers:HeaderMap,Json(body):Json<serde_json::Value>| {
        let counted=counted.clone();
        async move {
            assert_eq!(headers.get(header::AUTHORIZATION).unwrap(),"Bearer mock-asr-key");
            assert_eq!(body["model"],"qwen3-asr-flash");
            assert_eq!(body["stream"],false);
            assert_eq!(body["asr_options"]["enable_itn"],true);
            assert_eq!(body["messages"][0]["content"][0]["input_audio"]["data"],"data:audio/mp4;base64,YXVkaW8=");
            counted.fetch_add(1,Ordering::SeqCst);
            Json(serde_json::json!({"choices":[{"message":{"content":"  明天下午3点开会。  "}}]}))
        }
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let (state, _, token, other) = fixture(
        DEFAULT_MAX_BYTES,
        Some(AsrConfig {
            protocol: asr::Protocol::Qwen,
            endpoint: format!("http://{address}/chat/completions"),
            api_key: Some("mock-asr-key".into()),
            model: "qwen3-asr-flash".into(),
        }),
    )
    .await;
    let upload: Upload = serde_json::from_value(
        json_body(post_file(&state, &token, "voice.m4a", "audio/mp4", b"audio").await).await,
    )
    .unwrap();
    let request = |bearer: &str| {
        Request::builder()
            .method("POST")
            .uri(format!("/v1/uploads/{}/transcribe", upload.id))
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .body(Body::empty())
            .unwrap()
    };
    let denied = router(state.clone())
        .oneshot(request(&other))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    for _ in 0..2 {
        let response = router(state.clone())
            .oneshot(request(&token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["text"], "明天下午3点开会。");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM asr_attempts")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    server.abort();
    remove_fixture(state).await;
}

#[tokio::test]
async fn asr_admission_rejects_duplicate_running_jobs_and_retains_failed_attempts() {
    let (state, user, _, _) = fixture(DEFAULT_MAX_BYTES, None).await;
    assert!(
        asr::reserve(&state, &user, "first")
            .await
            .unwrap()
            .is_none()
    );
    let error = asr::reserve(&state, &user, "first").await.unwrap_err();
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(error.retry_after.unwrap() > 0);
    sqlx::query("UPDATE asr_jobs SET status='failed'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(
        asr::reserve(&state, &user, "first")
            .await
            .unwrap()
            .is_none()
    );
    for n in 2..20 {
        asr::reserve(&state, &user, &format!("upload-{n}"))
            .await
            .unwrap();
    }
    let error = asr::reserve(&state, &user, "over-user-limit")
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(error.retry_after.unwrap() > 86000);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM asr_attempts")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 20);
    // Global quota still applies when callers use different accounts.
    for n in 20..50 {
        asr::reserve(&state, &format!("other-{n}"), &format!("upload-{n}"))
            .await
            .unwrap();
    }
    assert_eq!(
        asr::reserve(&state, "new-user", "over-global-limit")
            .await
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    remove_fixture(state).await;
}

#[tokio::test]
async fn photo_index_is_opt_in_scoped_idempotent_and_revocable() {
    let (state, _, token, other) = fixture(DEFAULT_MAX_BYTES, None).await;
    let device = uuid::Uuid::new_v4().to_string();
    let asset = uuid::Uuid::new_v4().to_string();
    let path = format!("/v1/photo-index/devices/{device}");
    let asset_path = format!("{path}/assets/{asset}");
    let call = |method: &str, url: &str, bearer: &str, body: serde_json::Value| {
        Request::builder()
            .method(method)
            .uri(url)
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let body = serde_json::json!({"epoch":1,"revision":"v1","metadata":{"taken_at":null,"modified_at":100,"width":800,"height":600,"size":10000,"mime_type":"image/jpeg"},"results":[{"kind":"ocr","processor":"local-test-v1","content":"云南旅行攻略 100%"},{"kind":"description","processor":"local-summary-v1","content":"一张旅行攻略截图"}]});
    let response = router(state.clone())
        .oneshot(call("GET", &path, &token, serde_json::Value::Null))
        .await
        .unwrap();
    let status = json_body(response).await;
    assert_eq!(status["enabled"], false);
    assert_eq!(status["indexed"], 0);
    let denied = router(state.clone())
        .oneshot(call("PUT", &asset_path, &token, body.clone()))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::CONFLICT);
    let enabled = json_body(
        router(state.clone())
            .oneshot(call(
                "PUT",
                &path,
                &token,
                serde_json::json!({"enabled":true}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(enabled["epoch"], 1);
    for _ in 0..2 {
        assert_eq!(
            router(state.clone())
                .oneshot(call("PUT", &asset_path, &token, body.clone()))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let result = json_body(
        router(state.clone())
            .oneshot(call(
                "GET",
                &format!("{path}/assets?q=%25"),
                &token,
                serde_json::Value::Null,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["results"].as_array().unwrap().len(), 2);
    let isolated = json_body(
        router(state.clone())
            .oneshot(call(
                "GET",
                &format!("{path}/assets"),
                &other,
                serde_json::Value::Null,
            ))
            .await
            .unwrap(),
    )
    .await;
    assert!(isolated["items"].as_array().unwrap().is_empty());
    assert_eq!(
        router(state.clone())
            .oneshot(call("PUT", &asset_path, &other, body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    // A client cannot smuggle image bytes, file paths or arbitrary metadata into this API.
    let mut bytes = body.clone();
    bytes["image_base64"] = serde_json::json!("data:image/jpeg;base64,secret");
    assert_eq!(
        router(state.clone())
            .oneshot(call("PUT", &asset_path, &token, bytes))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut metadata = body.clone();
    metadata["metadata"]["local_uri"] = serde_json::json!("content://private");
    assert_eq!(
        router(state.clone())
            .oneshot(call("PUT", &asset_path, &token, metadata))
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let off = json_body(
        router(state.clone())
            .oneshot(call(
                "PUT",
                &path,
                &token,
                serde_json::json!({"enabled":false}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(off["epoch"], 2);
    assert_eq!(
        router(state.clone())
            .oneshot(call("PUT", &asset_path, &token, body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    // Re-enabling never restores an old in-flight writer's authority.
    let on = json_body(
        router(state.clone())
            .oneshot(call(
                "PUT",
                &path,
                &token,
                serde_json::json!({"enabled":true}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(on["epoch"], 3);
    assert_eq!(
        router(state.clone())
            .oneshot(call("PUT", &asset_path, &token, body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        router(state.clone())
            .oneshot(call("DELETE", &path, &token, serde_json::Value::Null))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let cleared = json_body(
        router(state.clone())
            .oneshot(call("GET", &path, &token, serde_json::Value::Null))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(cleared["enabled"], false);
    assert_eq!(cleared["indexed"], 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM photo_index_results")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(
        std::fs::read_dir(&state.config.root)
            .unwrap()
            .next()
            .is_none(),
        "index API must not store files"
    );
    remove_fixture(state).await;
}

#[tokio::test]
async fn text_read_missing_local_bytes_is_not_found_and_other_io_and_limits_stay_strict() {
    let (state, owner, token, other) = fixture(DEFAULT_MAX_BYTES, None).await;
    let upload: Upload = serde_json::from_value(json_body(
        post_file(&state, &token, "race.txt", "text/plain", b"race-source").await,
    ).await).unwrap();
    let path = state.path(&upload.id).unwrap();
    let request = |token: &str| Request::builder()
        .uri(format!("/v1/uploads/{}/text", upload.id))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty()).unwrap();
    assert_eq!(router(state.clone()).oneshot(request(&token)).await.unwrap().status(), StatusCode::OK);
    // Keep metadata present to model deletion between its lookup and local open.
    tokio::fs::remove_file(&path).await.unwrap();
    let response = router(state.clone()).oneshot(request(&token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(response).await["error"]["code"], "not_found");
    assert_eq!(state.chat_context(&owner, &[upload.id.clone()]).await.unwrap_err().status(), StatusCode::NOT_FOUND);
    assert_eq!(router(state.clone()).oneshot(request(&other)).await.unwrap().status(), StatusCode::NOT_FOUND);
    tokio::fs::write(&path, b"12345").await.unwrap();
    assert_eq!(state.read_bytes(&owner, &upload.id, 4).await.unwrap_err().status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(router(state.clone()).oneshot(request(&other)).await.unwrap().status(), StatusCode::NOT_FOUND);
    tokio::fs::remove_file(&path).await.unwrap();
    tokio::fs::create_dir(&path).await.unwrap();
    let response = router(state.clone()).oneshot(request(&token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(json_body(response).await["error"]["code"], "storage_error");
    remove_fixture(state).await;
}

#[cfg(windows)]
#[tokio::test]
async fn windows_access_denied_is_not_found_only_after_owned_metadata_disappears() {
    let (state, owner, token, _) = fixture(DEFAULT_MAX_BYTES, None).await;
    let upload: Upload = serde_json::from_value(json_body(
        post_file(&state, &token, "delete-pending.txt", "text/plain", b"source").await,
    ).await).unwrap();
    let path = state.path(&upload.id).unwrap();
    // Opening a directory as a file forces real Windows access-denied (error 5).
    // Delete-pending can produce the same kind, but its timing is not stable
    // enough to require in a deterministic fixture on every Windows filesystem.
    tokio::fs::remove_file(&path).await.unwrap();
    tokio::fs::create_dir(&path).await.unwrap();
    assert_eq!(std::fs::File::open(&path).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
    // A permission error alone cannot justify hiding a surviving upload row.
    assert_eq!(state.read_bytes(&owner, &upload.id, 100).await.unwrap_err().status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(state.download_body(&owner, &upload.id).await.unwrap_err().status(), StatusCode::INTERNAL_SERVER_ERROR);
    // Model the API delete committing metadata shortly after unlinking the file.
    let delete = async {
        tokio::time::sleep(Duration::from_millis(10)).await;
        sqlx::query("DELETE FROM uploads WHERE user_id=$1 AND id=$2")
            .bind(&owner).bind(&upload.id).execute(&state.pool).await.unwrap();
    };
    let ((), download) = tokio::join!(delete, state.download_body(&owner, &upload.id));
    assert_eq!(download.unwrap_err().status(), StatusCode::NOT_FOUND);
    assert_eq!(state.read_bytes(&owner, &upload.id, 100).await.unwrap_err().status(), StatusCode::NOT_FOUND);
    remove_fixture(state).await;
}
