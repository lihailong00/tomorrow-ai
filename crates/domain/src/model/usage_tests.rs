use super::*;
use std::{io::{Read, Write}, net::TcpListener, thread};
use sqlx::Row;

#[test]
fn compatible_usage_keeps_cached_input_in_total_and_unknown_distinct_from_zero() {
    let value = serde_json::json!({"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":30,"cache_write_tokens":10}});
    let usage = compatible_usage(Some(&value));
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(7));
    assert_eq!(usage.cache_read_tokens, Some(30));
    assert_eq!(usage.cache_write_tokens, Some(10));
    assert_eq!(compatible_usage(None), UsageMeasurements::default());
    let zero = compatible_usage(Some(&serde_json::json!({"prompt_tokens":0,"completion_tokens":0})));
    assert_eq!(zero.input_tokens, Some(0));
    assert_eq!(zero.cache_read_tokens, Some(0));
    assert_eq!(zero.cache_write_tokens, Some(0));
    assert_eq!(compatible_usage(Some(&serde_json::json!({"prompt_tokens":-1,"completion_tokens":1.5}))).input_tokens, None);
}

#[test]
fn missing_cache_fields_remain_unknown_for_positive_input() {
    let usage = compatible_usage(Some(&serde_json::json!({"prompt_tokens":100,"completion_tokens":10})));
    assert_eq!(usage.input_tokens, Some(100));
    assert_eq!(usage.output_tokens, Some(10));
    assert_eq!(usage.cache_read_tokens, None);
    assert_eq!(usage.cache_write_tokens, None);
    let explicit = compatible_usage(Some(&serde_json::json!({"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}})));
    assert_eq!(explicit.cache_read_tokens, Some(0));
    assert_eq!(explicit.cache_write_tokens, Some(0));
    let read_only = compatible_usage(Some(&serde_json::json!({"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":30})));
    assert_eq!(read_only.cache_read_tokens, Some(30));
    assert_eq!(read_only.cache_write_tokens, None);
}

#[test]
fn final_usage_only_chunk_is_consumed_after_text_finished() {
    let finish = completion_stream_update(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
    assert!(finish.finished);
    assert!(!finish.done);
    assert!(completion_stream_update(r#"{"choices":[{"delta":{}}],"usage":{"prompt_tokens":80,"completion_tokens":0}}"#).unwrap().usage.is_none());
    let usage = completion_stream_update(r#"{"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":9,"prompt_cache_hit_tokens":20}}"#).unwrap();
    assert_eq!(usage.usage.unwrap().input_tokens, Some(80));
    assert!(!usage.done);
    assert!(completion_stream_update("[DONE]").unwrap().done);
}

async fn fixture(body: &str, stream: bool) -> (LlmProvider, Repository, String, thread::JoinHandle<()>) {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repository.create_user("usage-model@test.local", "unused", "fixture", "Asia/Shanghai").await.unwrap().id;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_owned();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let header_end = loop {
            let mut buffer = [0; 4096];
            let read = socket.read(&mut buffer).unwrap(); assert_ne!(read, 0);
            request.extend_from_slice(&buffer[..read]);
            if let Some(index) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") { break index + 4; }
        };
        let length: usize = String::from_utf8_lossy(&request[..header_end]).lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
        }).unwrap();
        while request.len() - header_end < length {
            let mut buffer = [0; 4096]; let read = socket.read(&mut buffer).unwrap(); assert_ne!(read, 0);
            request.extend_from_slice(&buffer[..read]);
        }
        let payload: serde_json::Value = serde_json::from_slice(&request[header_end..header_end + length]).unwrap();
        if stream { assert_eq!(payload["stream_options"]["include_usage"], true); }
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", if stream { "text/event-stream" } else { "application/json" }, body.len(), body).unwrap();
    });
    let provider = LlmProvider::from_settings(format!("http://{address}/v1"), Some("fixture-key".into()), Some("fixture-model".into()))
        .with_usage(UsageContext::new(repository.clone(), &user, "memory", "fixture"));
    (provider, repository, user, server)
}

fn message() -> Message {
    Message { id: "fixture".into(), conversation_id: "fixture".into(), role: "user".into(), content: "fixture content".into(), created_at: String::new(), model_mode: None, attachments: vec![] }
}

async fn recorded(repository: &Repository, user: &str) -> UsageOutcome {
    let row = sqlx::query("SELECT outcome_json,purpose FROM usage_requests WHERE user_id=$1").bind(user).fetch_one(&repository.pool()).await.unwrap();
    assert_eq!(row.get::<String, _>("purpose"), "memory");
    serde_json::from_str(&row.get::<String, _>("outcome_json")).unwrap()
}

#[tokio::test]
async fn rejected_content_still_records_actual_nonstream_usage() {
    let (provider, repository, user, server) = fixture(r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_cache_hit_tokens":30}}"#, false).await;
    assert!(provider.complete(&[message()]).await.is_err());
    let outcome = recorded(&repository, &user).await;
    assert_eq!(outcome.measurements.input_tokens, Some(100));
    assert_eq!(outcome.measurements.cache_read_tokens, Some(30));
    assert_eq!(outcome.measurements.output_tokens, Some(7));
    server.join().unwrap();
}

#[tokio::test]
async fn direct_http_stream_records_usage_after_finish_reason() {
    let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":9}}\n\ndata: [DONE]\n\n";
    let (provider, repository, user, server) = fixture(wire, true).await;
    assert_eq!(provider.complete_stream(&[message()], |_| std::future::ready(Ok(()))).await.unwrap().content, "answer");
    let outcome = recorded(&repository, &user).await;
    assert_eq!(outcome.measurements.input_tokens, Some(42));
    assert_eq!(outcome.measurements.output_tokens, Some(9));
    server.join().unwrap();
}
