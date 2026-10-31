use super::*;
use std::{
    future::ready,
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
};

fn user_message() -> Message {
    Message {
        id: "stream-user".into(),
        conversation_id: "stream-conversation".into(),
        role: "user".into(),
        content: "你好".into(),
        created_at: "2026-10-28T00:00:00Z".into(),
        model_mode: None,
        attachments: Vec::new(),
    }
}

fn read_request(socket: &mut std::net::TcpStream) -> serde_json::Value {
    let mut request = Vec::new();
    let header_end = loop {
        let mut buffer = [0u8; 4096];
        let count = socket.read(&mut buffer).unwrap();
        assert_ne!(count, 0);
        request.extend_from_slice(&buffer[..count]);
        if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while request.len() - header_end < length {
        let mut buffer = [0u8; 4096];
        let count = socket.read(&mut buffer).unwrap();
        assert_ne!(count, 0);
        request.extend_from_slice(&buffer[..count]);
    }
    serde_json::from_slice(&request[header_end..header_end + length]).unwrap()
}

#[test]
fn sse_decoding_preserves_utf8_and_crlf_at_every_network_split() {
    let wire = ": keepalive\r\nevent: message\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"你好🌱\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    for split in 0..=wire.len() {
        let mut decoder = CompletionStreamDecoder::default();
        let mut events = decoder.push(&wire.as_bytes()[..split]).unwrap();
        events.extend(decoder.push(&wire.as_bytes()[split..]).unwrap());
        assert_eq!(events.len(), 2, "split {split}");
        let delta = completion_stream_update(&events[0]).unwrap();
        assert_eq!(delta.delta.as_deref(), Some("你好🌱"));
        assert!(!delta.finished);
        assert!(completion_stream_update(&events[1]).unwrap().finished);
    }
}

#[test]
fn sse_only_exposes_content_and_bounds_unfinished_events() {
    let private = r#"{"choices":[{"delta":{"reasoning_content":"private reasoning","tool_calls":[{"arguments":"private arguments"}]}}]}"#;
    let update = completion_stream_update(private).unwrap();
    assert!(update.delta.is_none());
    assert!(!update.finished);
    assert!(
        completion_stream_update(r#"{"error":{"message":"private upstream secret"}}"#).is_err()
    );
    let mut decoder = CompletionStreamDecoder::default();
    assert!(decoder.push(&vec![b'x'; 128 * 1024 + 1]).is_err());
}

#[tokio::test]
async fn real_http_stream_delivers_visible_text_before_final_is_available() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (payload_sender, payload_receiver) = mpsc::channel();
    let (allow_final, wait_for_delta) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        payload_sender.send(read_request(&mut socket)).unwrap();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        socket.write_all("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"第一段\"}}]}\n\n".as_bytes()).unwrap();
        socket.flush().unwrap();
        // Final data cannot exist until the consumer receives the first delta.
        wait_for_delta.recv_timeout(Duration::from_secs(5)).unwrap();
        socket.write_all("data: {\"choices\":[{\"delta\":{\"content\":\"，结束\"},\"finish_reason\":\"stop\"}]}\n\n".as_bytes()).unwrap();
        socket.flush().unwrap();
    });
    let provider = LlmProvider::from_settings(
        format!("http://{address}/v1"),
        Some("fixture-key".into()),
        Some("fixture-model".into()),
    );
    let mut observed = Vec::new();
    let reply = provider
        .complete_stream(&[user_message()], |delta| {
            observed.push(delta);
            if observed.len() == 1 {
                allow_final.send(()).unwrap();
            }
            ready(Ok(()))
        })
        .await
        .unwrap();
    assert_eq!(observed, ["第一段", "，结束"]);
    assert_eq!(reply.content, "第一段，结束");
    assert_eq!(reply.mode, "llm");
    let payload = payload_receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(payload["stream"], true);
    assert_eq!(payload["model"], "fixture-model");
    server.join().unwrap();
}

#[tokio::test]
async fn truncated_http_stream_keeps_delivered_partial_and_returns_an_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        read_request(&mut socket);
        socket.write_all("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"已收到的部分\"}}]}\n\n".as_bytes()).unwrap();
        socket.flush().unwrap();
    });
    let provider = LlmProvider::from_settings(
        format!("http://{address}"),
        Some("fixture-key".into()),
        Some("fixture-model".into()),
    );
    let mut observed = String::new();
    let result = provider
        .complete_stream(&[user_message()], |delta| {
            observed.push_str(&delta);
            ready(Ok(()))
        })
        .await;
    assert!(result.is_err());
    assert_eq!(observed, "已收到的部分");
    server.join().unwrap();
}

#[tokio::test]
async fn explicit_local_demo_does_not_invent_upstream_deltas() {
    let mut count = 0;
    let reply = LlmProvider::local()
        .complete_stream(&[user_message()], |_| {
            count += 1;
            ready(Ok(()))
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(reply.mode, "local");
    assert!(reply.content.contains("未调用 AI 模型"));
}
