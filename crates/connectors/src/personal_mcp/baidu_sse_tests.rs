use super::*;
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

#[derive(Clone)]
struct Fixture {
    mode: u8,
    sender: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    posts: Arc<Mutex<Vec<Value>>>,
    versions: Arc<Mutex<Vec<Option<String>>>>,
}

async fn open(
    State(state): State<Fixture>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if state.mode == 2
        || query.get("access_token").map(String::as_str) != Some("fixture-access-token")
    {
        return (StatusCode::UNAUTHORIZED, "upstream body must not escape").into_response();
    }
    if state.mode == 3 {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "http://127.0.0.1:1/leak")],
            "",
        )
            .into_response();
    }
    let (sender, receiver) = mpsc::channel::<String>(16);
    let endpoint = if state.mode == 1 {
        "https://attacker.invalid/messages"
    } else {
        "/messages/?session_id=fixture-session"
    };
    sender
        .send(format!("event: endpoint\r\ndata: {endpoint}\r\n\r\n"))
        .await
        .unwrap();
    *state.sender.lock().unwrap() = Some(sender);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|value| (Ok::<Bytes, std::io::Error>(Bytes::from(value)), receiver))
    });
    (
        [("content-type", "text/event-stream")],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn message(
    State(state): State<Fixture>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    if query.get("session_id").map(String::as_str) != Some("fixture-session") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.posts.lock().unwrap().push(input.clone());
    state.versions.lock().unwrap().push(
        headers
            .get("mcp-protocol-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    );
    if state.mode == 4 {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "http://127.0.0.1:1/leak")],
            "",
        )
            .into_response();
    }
    let Some(id) = input["id"].as_u64() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = match input["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":if state.mode==9{"2024-11-05"}else{PROTOCOL},"capabilities":{"tools":{}},"serverInfo":{"name":"Baidu-fixture","version":"1"}})
        }
        "tools/list" => {
            if input["params"]["cursor"].is_null() {
                json!({"tools":[{"name":"user_info","inputSchema":{"type":"object"}}],"nextCursor":"page2"})
            } else {
                json!({"tools":[{"name":"get_quota","inputSchema":{"type":"object"}}]})
            }
        }
        "tools/call" => {
            if state.mode == 6 {
                json!({"content":[{"type":"text","text":"{\"errno\":110,\"errmsg\":\"invalid token\"}"}]})
            } else if state.mode == 7 {
                json!({"content":[{"type":"text","text":"{\"errno\":0,\"baidu_name\":\"no-id\"}"}]})
            } else {
                json!({"content":[{"type":"text","text":"{\"errno\":0,\"uk\":12345,\"baidu_name\":\"fixture\"}"}]})
            }
        }
        _ => json!({}),
    };
    let frame = if state.mode == 8 {
        format!("event: message\ndata: {}\n\n", "x".repeat(MAX_BYTES + 1))
    } else {
        format!(
            "event: message\r\ndata: {}\r\n\r\n",
            json!({"jsonrpc":"2.0","id":if state.mode==5{id+1}else{id},"result":result})
        )
    };
    let sender = state.sender.lock().unwrap().clone().unwrap();
    let _ = sender.send(frame).await;
    StatusCode::ACCEPTED.into_response()
}

async fn server(mode: u8) -> (Url, Fixture, tokio::task::JoinHandle<()>) {
    let state = Fixture {
        mode,
        sender: Arc::new(Mutex::new(None)),
        posts: Arc::new(Mutex::new(Vec::new())),
        versions: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/sse", get(open))
        .route("/messages/", post(message))
        .with_state(state.clone());
    let handle = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (
        Url::parse(&format!(
            "http://{address}/sse?access_token=fixture-access-token"
        ))
        .unwrap(),
        state,
        handle,
    )
}

#[tokio::test]
async fn official_legacy_flow_uses_endpoint_post_and_original_response_stream() {
    let (url, state, handle) = server(0).await;
    let sse = LegacySse::connect_at(url).await.unwrap();
    let mut connection = super::super::Connection::Baidu(sse);
    let initialized = connection
        .rpc(
            "initialize",
            json!({"protocolVersion":PROTOCOL,"capabilities":{}}),
        )
        .await
        .unwrap();
    assert_eq!(initialized["protocolVersion"], PROTOCOL);
    connection
        .notify("notifications/initialized")
        .await
        .unwrap();
    let tools = super::super::discover_on(&mut connection).await.unwrap();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], "user_info");
    let identity = connection
        .rpc("tools/call", json!({"name":"user_info","arguments":{}}))
        .await
        .unwrap();
    validate_identity(&identity).unwrap();
    connection.close().await;
    let posts = state.posts.lock().unwrap();
    assert_eq!(posts.len(), 5);
    assert_eq!(posts[3]["params"]["cursor"], "page2");
    assert!(
        !serde_json::to_string(&*posts)
            .unwrap()
            .contains("fixture-access-token")
    );
    if let super::super::Connection::Baidu(sse) = connection {
        assert!(sse.stream.is_none());
    }
    handle.abort();
}

#[tokio::test]
async fn negotiated_legacy_protocol_is_used_for_every_subsequent_post() {
    let (url, state, handle) = server(9).await;
    let sse = LegacySse::connect_at(url).await.unwrap();
    let mut connection = super::super::Connection::Baidu(sse);
    connection.initialize().await.unwrap();
    connection.rpc("tools/list", json!({})).await.unwrap();
    connection.close().await;
    let versions = state.versions.lock().unwrap();
    assert_eq!(versions.len(), 3);
    assert_eq!(versions[0].as_deref(), Some(PROTOCOL));
    assert_eq!(versions[1].as_deref(), Some("2024-11-05"));
    assert_eq!(versions[2].as_deref(), Some("2024-11-05"));
    handle.abort();
}

#[test]
fn discovered_post_endpoint_cannot_change_origin_downgrade_or_embed_userinfo() {
    let origin = Url::parse("https://mcp-pan.baidu.com/sse?access_token=secret").unwrap();
    assert_eq!(
        validate_endpoint(&origin, "/messages/?session_id=1")
            .unwrap()
            .host_str(),
        Some("mcp-pan.baidu.com")
    );
    for endpoint in [
        "https://attacker.invalid/messages",
        "http://mcp-pan.baidu.com/messages",
        "//127.0.0.1/messages",
        "https://mcp-pan.baidu.com:444/messages",
        "https://user@mcp-pan.baidu.com/messages",
        "/messages#fragment",
        "\n/messages",
        "",
    ] {
        assert!(
            validate_endpoint(&origin, endpoint).is_err(),
            "unsafe endpoint accepted"
        );
    }
}

#[tokio::test]
async fn credential_rejection_redirects_and_cross_origin_endpoint_are_safe_errors() {
    for mode in [1, 2, 3] {
        let (url, _, handle) = server(mode).await;
        let error = match LegacySse::connect_at(url).await {
            Ok(_) => panic!("invalid server accepted"),
            Err(error) => error,
        };
        assert!(!error.to_string().contains("fixture-access-token"));
        assert!(!error.to_string().contains("upstream body"));
        handle.abort();
    }
}

#[tokio::test]
async fn wrong_rpc_id_post_redirect_and_oversized_event_are_rejected_without_retry() {
    for mode in [4, 5, 8] {
        let (url, state, handle) = server(mode).await;
        let mut sse = LegacySse::connect_at(url).await.unwrap();
        assert!(sse.rpc("initialize", json!({})).await.is_err());
        assert_eq!(state.posts.lock().unwrap().len(), 1);
        sse.close();
        handle.abort();
    }
}

#[tokio::test]
async fn static_catalog_does_not_make_invalid_or_missing_account_identity_connected() {
    for mode in [6, 7] {
        let (url, _, handle) = server(mode).await;
        let mut sse = LegacySse::connect_at(url).await.unwrap();
        let tools = sse.rpc("tools/list", json!({})).await.unwrap();
        assert!(!tools["tools"].as_array().unwrap().is_empty());
        let identity = sse
            .rpc("tools/call", json!({"name":"user_info","arguments":{}}))
            .await
            .unwrap();
        assert!(validate_identity(&identity).is_err());
        sse.close();
        handle.abort();
    }
}

#[test]
fn identity_requires_positive_baidu_uk_and_no_business_error() {
    for payload in [
        json!({"errno":0,"uk":123}),
        json!({"data":{"errno":0,"uk":"123"}}),
    ] {
        assert!(validate_identity(&json!({"structuredContent":payload})).is_ok());
    }
    for payload in [
        json!({"errno":110,"uk":123}),
        json!({"uk":0}),
        json!({"uk":"000"}),
        json!({"uk":"arbitrary"}),
        json!({"name":"account"}),
    ] {
        assert!(validate_identity(&json!({"structuredContent":payload})).is_err());
    }
    assert!(validate_identity(&json!({"isError":true,"structuredContent":{"uk":123}})).is_err());
}

#[test]
fn baidu_is_explicit_experience_and_exact_read_ids_exclude_file_changes() {
    let credentials = Credentials {
        token: "fixture".into(),
        environment: "experience".into(),
        server_url: None, account: None, client_id: None,
    };
    assert!(credentials.validate("baidu_netdisk").is_ok());
    assert!(
        Credentials {
            environment: "production".into(),
            ..credentials.clone()
        }
        .validate("baidu_netdisk")
        .is_err()
    );
    assert!(
        Credentials {
            server_url: Some("https://attacker.invalid".into()),
            ..credentials
        }
        .validate("baidu_netdisk")
        .is_err()
    );
    assert!(super::super::super::catalog::is_read_only(
        "baidu_netdisk",
        "user_info"
    ));
    assert!(super::super::super::catalog::is_read_only(
        "baidu_netdisk",
        "file_semantics_search"
    ));
    for name in [
        "file_del",
        "make_dir",
        "file_move",
        "file_copy",
        "file_rename",
        "file_sharelink_set",
        "file_upload_by_url",
    ] {
        assert!(!super::super::super::catalog::is_read_only(
            "baidu_netdisk",
            name
        ));
    }
}
