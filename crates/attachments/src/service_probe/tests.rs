use super::*;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

async fn mock(service: Service, status: u16, body: String, extra: &str) -> ModelProbe {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository.create_user("media-probe@example.test", "hash", "admin", "Asia/Shanghai").await.unwrap();
    let pool = repository.pool();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let expected_input = serde_json::from_str::<Value>(&body).ok()
        .and_then(|body| body.pointer("/usage/prompt_tokens").and_then(Value::as_i64));
    let extra = extra.to_owned();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let end = loop {
            let mut chunk = [0; 8192];
            let read = stream.read(&mut chunk).await.unwrap(); assert!(read > 0);
            bytes.extend_from_slice(&chunk[..read]);
            assert!(bytes.len() < 16000);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                assert!(headers.contains("authorization: bearer fixture-private-key"));
                let size = headers.lines().find_map(|line| line.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap();
                if bytes.len() >= end + 4 + size { break end; }
            }
        };
        let body_request: Value = serde_json::from_slice(&bytes[end+4..]).unwrap();
        match service {
            Service::Vision => {
                assert!(String::from_utf8_lossy(&bytes).starts_with("POST /v1/chat/completions "));
                assert_eq!(body_request["max_tokens"], 128);
                let content = body_request["messages"][0]["content"].as_array().unwrap();
                assert_eq!(content[0]["image_url"]["url"], format!("data:image/png;base64,{}",STANDARD.encode(IMAGE)));
                assert!(!content[1]["text"].as_str().unwrap().contains("red"));
                assert!(body_request.get("tools").is_none());
            }
            Service::Embedding => {
                assert!(String::from_utf8_lossy(&bytes).starts_with("POST /v1/embeddings "));
                assert_eq!(body_request["input"], json!([TEXT]));
                assert_eq!(body_request["dimensions"], 1024);
                assert_eq!(body_request["encoding_format"], "float");
            }
        }
        let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
        // A redirect/retry must never produce a second request.
        assert!(tokio::time::timeout(Duration::from_millis(30), listener.accept()).await.is_err());
    });
    let get = |name: &str| match name {
        "PHOTO_VISION_ENABLED" | "PHOTO_EMBEDDING_ENABLED" => Some("false".into()),
        "PHOTO_VISION_BASE_URL" | "PHOTO_EMBEDDING_BASE_URL" => Some(base.clone()),
        "PHOTO_VISION_API_KEY" | "PHOTO_EMBEDDING_API_KEY" => Some("fixture-private-key".into()),
        _ => None,
    };
    let result = match service { Service::Vision => vision_with_usage(get, &repository, &user.id).await,
        Service::Embedding => embedding_with_usage(get, &repository, &user.id).await };
    task.await.unwrap();
    assert!(!serde_json::to_string(&result).unwrap().contains("fixture-private-key"));
    let rows: Vec<(String,String,String,String)> = sqlx::query_as("SELECT user_id,capability,purpose,outcome_json FROM usage_requests")
        .fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, user.id);
    assert_eq!(rows[0].1, match service { Service::Vision => "vision", Service::Embedding => "embedding" });
    assert_eq!(rows[0].2, "other");
    let measured: Value = serde_json::from_str(&rows[0].3).unwrap();
    assert_eq!(measured["measurements"]["image_count"], match service { Service::Vision => json!(1), Service::Embedding => Value::Null });
    if let Some(expected) = expected_input { assert_eq!(measured["measurements"]["input_tokens"], expected); }
    pool.close().await;
    result
}

#[tokio::test]
async fn image_probe_requires_actual_color_and_shape_and_does_not_echo_provider_text() {
    let image = imagesize::blob_size(IMAGE).unwrap();
    assert_eq!((image.width, image.height), (256, 256));
    for (text, expected) in [("Red circle", true), ("A blue square", false), ("fixture-private-key", false)] {
        let result = mock(Service::Vision, 200, json!({"choices":[{"message":{"content":text}}]}).to_string(), "").await;
        assert_eq!(result.ok, expected);
        assert_eq!(result.code, if expected { "image_verified" } else { "image_mismatch" });
    }
}

#[tokio::test]
async fn embedding_probe_validates_dimensions_and_usable_nonzero_vectors() {
    for (vector, code) in [(vec![0.25;1024],"embedding_verified"), (vec![0.25;768],"dimension_mismatch"),
        (vec![0.0;1024],"invalid_response"), (vec![1e9;1024],"invalid_response")] {
        let result = mock(Service::Embedding, 200, json!({"data":[{"index":0,"embedding":vector}],"usage":{"prompt_tokens":9}}).to_string(), "").await;
        assert_eq!(result.code, code);
        assert_eq!(result.ok, code == "embedding_verified");
        assert_eq!(result.input_tokens, Some(9));
    }
    let result = mock(Service::Embedding, 200, json!({"data":[{"index":1,"embedding":vec![0.25;1024]}]}).to_string(), "").await;
    assert!(!result.ok);
}

#[tokio::test]
async fn auxiliary_probes_reject_error_empty_html_oversized_and_redirect_responses_without_leaking_secrets() {
    for service in [Service::Vision, Service::Embedding] {
        for (status, body, extra, code) in [
            (401,"fixture-private-key".into(),"","authentication_failed"),
            (429,json!({"error":{"message":"fixture-private-key"},"usage":{"prompt_tokens":4}}).to_string(),"","upstream_rate_limited"),
            (302,String::new(),"Location: /credential-leak\r\n","redirect_blocked"),
            (200,"<html>fixture-private-key</html>".into(),"","invalid_response"),
            (200,"{}".into(),"","invalid_response"),
            (200,"x".repeat(132000),"","invalid_response"),
        ] {
            let result = mock(service,status,body,extra).await;
            assert!(!result.ok); assert_eq!(result.code,code);
        }
    }
}

#[tokio::test]
async fn missing_config_and_custom_endpoints_never_borrow_asr_credentials() {
    for service in [Service::Vision, Service::Embedding] {
        let get = |name: &str| match name {
            "PHOTO_VISION_BASE_URL" | "PHOTO_EMBEDDING_BASE_URL" => Some("http://127.0.0.1:9/v1".into()),
            "ASR_PROTOCOL" => Some("qwen_asr".into()), "ASR_API_KEY" => Some("fixture-private-key".into()),
            "ASR_BASE_URL" => Some("https://dashscope.aliyuncs.com/compatible-mode/v1".into()), _=>None,
        };
        let result = match service { Service::Vision => vision(get).await, Service::Embedding => embedding(get).await };
        assert_eq!(result.code,"not_configured");
    }
}
