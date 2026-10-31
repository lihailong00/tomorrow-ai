use super::*;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

async fn mock(status: &str, body: &str, headers: &str) -> (String, tokio::task::JoinHandle<String>) {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = server.local_addr().unwrap();
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let task = tokio::spawn(async move {
        let (mut stream, _) = server.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut part = [0; 4096];
            let read = stream.read(&mut part).await.unwrap();
            if read == 0 { break; }
            bytes.extend_from_slice(&part[..read]);
            assert!(bytes.len() < 32768);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let text = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let size = text.lines().find_map(|line| line.strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap_or(0);
                if bytes.len() >= end + 4 + size { break; }
            }
        }
        let _ = stream.write_all(response.as_bytes()).await;
        String::from_utf8(bytes).unwrap()
    });
    (format!("http://{address}/v1"), task)
}
fn provider(base: String) -> LlmProvider {
    LlmProvider::from_settings(base, Some("fixture-private-key".into()), Some("fixture-model".into()))
}
#[tokio::test]
async fn connection_probe_sends_one_bounded_message_and_returns_only_safe_metadata() {
    let (base, task) = mock("200 OK", r#"{"choices":[{"message":{"role":"assistant","content":"OK"}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}"#, "").await;
    let result = provider(base).probe_connection().await;
    assert!(result.ok);
    assert_eq!(result.code, "connected");
    assert_eq!(result.input_tokens, Some(7));
    assert_eq!(result.output_tokens, Some(2));
    let request = task.await.unwrap();
    let (_, body) = request.split_once("\r\n\r\n").unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(body["max_tokens"], 128);
    assert_eq!(body["messages"].as_array().unwrap().len(), 1);
    assert_eq!(body["messages"][0]["content"], "Reply OK.");
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("fixture-private-key") && !serialized.contains("http://") && !serialized.contains("choices"));
}
#[tokio::test]
async fn connection_probe_classifies_authentication_without_reflecting_provider_body() {
    let (base, task) = mock("401 Unauthorized", r#"{"error":{"message":"fixture-private-key and internal-host must not escape"}}"#, "").await;
    let result = provider(base).probe_connection().await;
    task.await.unwrap();
    assert!(!result.ok);
    assert_eq!(result.code, "authentication_failed");
    assert_eq!(result.upstream_status, Some(401));
    let response = serde_json::to_string(&result).unwrap();
    assert!(!response.contains("fixture-private-key") && !response.contains("internal-host"));
}
#[tokio::test]
async fn connection_probe_never_follows_redirects_with_credentials() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect = format!("Location: http://{}/stolen\r\n", target.local_addr().unwrap());
    let (base, task) = mock("307 Temporary Redirect", "{}", &redirect).await;
    let result = provider(base).probe_connection().await;
    task.await.unwrap();
    assert_eq!(result.code, "redirect_blocked");
    assert!(tokio::time::timeout(Duration::from_millis(60), target.accept()).await.is_err());
}
#[tokio::test]
async fn connection_probe_rejects_html_empty_objects_and_oversized_success_bodies() {
    for body in ["<html>login</html>".to_owned(), r#"{"choices":[{"message":{}}]}"#.to_owned(), "x".repeat(65537)] {
        let (base, task) = mock("200 OK", &body, "").await;
        let result = provider(base).probe_connection().await;
        task.await.unwrap();
        assert!(!result.ok);
        assert_eq!(result.code, "invalid_response");
    }
}
#[tokio::test]
async fn connection_probe_incomplete_configuration_does_not_use_offline_demo() {
    let result = LlmProvider::local().probe_connection().await;
    assert!(!result.ok);
    assert_eq!(result.code, "not_configured");
    assert_eq!(result.upstream_status, None);
}
