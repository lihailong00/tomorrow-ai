use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    routing::post,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Fixture {
    mode: u8,
    received: Arc<Mutex<Vec<Value>>>,
}

async fn handle(
    State(fixture): State<Fixture>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> Response {
    fixture.received.lock().unwrap().push(json!({"body":input,"authorization":headers.get("authorization").and_then(|value|value.to_str().ok()),"session":headers.get("mcp-session-id").and_then(|value|value.to_str().ok()),"protocol":headers.get("mcp-protocol-version").and_then(|value|value.to_str().ok())}));
    let method = input["method"].as_str().unwrap_or("");
    let id = input["id"].as_u64().unwrap_or(0);
    if method == "notifications/initialized" {
        return StatusCode::ACCEPTED.into_response();
    }
    if fixture.mode == 3 {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "http://127.0.0.1:1/secret")],
            "redirect",
        )
            .into_response();
    }
    if fixture.mode == 6 {
        return (
            StatusCode::FORBIDDEN,
            "private credential may be present upstream",
        )
            .into_response();
    }
    let result = if method == "initialize" {
        json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}})
    } else if fixture.mode == 5 {
        json!({"tools":[{"name":if input["params"]["cursor"].is_null(){"first"}else{"second"},"inputSchema":{"type":"object"}}],"nextCursor":"repeat"})
    } else {
        json!({"tools":[{"name":"lookup","description":"fixture","inputSchema":{"type":"object"}}]})
    };
    if fixture.mode == 2 {
        return (
            [("content-type", "application/json")],
            "x".repeat(MAX_BYTES + 1),
        )
            .into_response();
    }
    let response = json!({"jsonrpc":"2.0","id":if fixture.mode==4{id+1}else{id},"result":result});
    let mut response = if fixture.mode == 1 && method != "initialize" {
        ([("content-type","text/event-stream")],format!("data: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{{}}}}\r\n\r\ndata: {response}\r\n\r\n")).into_response()
    } else {
        Json(response).into_response()
    };
    response.headers_mut().insert(
        "mcp-session-id",
        HeaderValue::from_static("fixture-session"),
    );
    response
}

async fn server(
    mode: u8,
) -> (
    HttpConnection,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let fixture = Fixture {
        mode,
        received: Arc::new(Mutex::new(Vec::new())),
    };
    let router = Router::new()
        .route(
            "/",
            post(handle).delete(|| async { StatusCode::NO_CONTENT }),
        )
        .with_state(fixture.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer personal-fixture-token"),
    );
    (
        HttpConnection::new(Url::parse(&format!("http://{address}/")).unwrap(), headers).unwrap(),
        fixture.received,
        handle,
    )
}

fn credentials() -> Credentials {
    Credentials {
        token: "fixture-token".into(),
        environment: "production".into(),
        server_url: None,
    }
}

#[test]
fn only_registered_provider_endpoints_and_credential_modes_are_accepted() {
    let token = credentials();
    for provider in [
        "mcdonalds",
        "didi",
        "tencent_docs",
        "yuque",
        "tencent_meeting",
    ] {
        assert!(token.validate(provider).is_ok());
    }
    for provider in ["amap", "unknown", "feishu"] {
        assert!(token.validate(provider).is_err());
    }
    let didi = HttpConnection::official(
        "didi",
        &Credentials {
            environment: "sandbox".into(),
            ..token.clone()
        },
    )
    .unwrap();
    assert_eq!(didi.url.host_str(), Some("mcp.didichuxing.com"));
    assert_eq!(didi.url.path(), "/mcp-servers-sandbox");
    assert!(
        HttpConnection::official("tencent_docs", &token)
            .unwrap()
            .headers[AUTHORIZATION]
            == "fixture-token"
    );
    let meeting = HttpConnection::official("tencent_meeting", &token).unwrap();
    assert_eq!(
        meeting.url.as_str(),
        "https://mcp.meeting.tencent.com/mcp/wemeet-open/v1"
    );
    assert_eq!(meeting.headers["X-Tencent-Meeting-Token"], "fixture-token");
    assert_eq!(meeting.headers["X-Skill-Version"], "v1.0.15");
    assert!(!meeting.headers.contains_key(AUTHORIZATION));
    assert!(
        HttpConnection::official("mcdonalds", &token)
            .unwrap()
            .headers[AUTHORIZATION]
            == "Bearer fixture-token"
    );
    for invalid_token in [
        "",
        " leading",
        "token\r\ninjected: yes",
        "trailing ",
        "a\0b",
    ] {
        assert!(
            Credentials {
                token: invalid_token.into(),
                ..token.clone()
            }
            .validate("didi")
            .is_err()
        );
    }
    assert!(
        Credentials {
            server_url: Some("https://attacker.test".into()),
            ..token.clone()
        }
        .validate("didi")
        .is_err()
    );
    assert!(
        Credentials {
            environment: "sandbox".into(),
            ..token
        }
        .validate("mcdonalds")
        .is_err()
    );
}

#[test]
fn read_policy_does_not_trust_names_or_upstream_annotations() {
    assert!(super::super::catalog::is_read_only("didi", "taxi_estimate"));
    assert!(!super::super::catalog::is_read_only(
        "didi",
        "taxi_create_order"
    ));
    assert!(!super::super::catalog::is_read_only(
        "mcdonalds",
        "auto-bind-coupons"
    ));
    assert!(super::super::catalog::is_read_only(
        "mcdonalds",
        "query-order"
    ));
    assert!(!super::super::catalog::is_read_only(
        "tencent_docs",
        "read_and_delete"
    ));
    assert!(!super::super::catalog::is_read_only(
        "yuque",
        "yuque_update_doc"
    ));
}

#[test]
fn meeting_metadata_keeps_actual_run_model_and_reports_manual_calls_truthfully() {
    let input = json!({"meeting_id":"fixture","_client_info":{"model":"actual-frozen-model","agent":"override","os":"override"}});
    let output = call_arguments("tencent_meeting", input);
    assert_eq!(
        output["_client_info"],
        json!({"os":std::env::consts::OS,"agent":"Tada","model":"actual-frozen-model"})
    );
    assert_eq!(
        call_arguments("tencent_meeting", json!({}))["_client_info"]["model"],
        "not_provided"
    );
    assert_eq!(
        call_arguments("tencent_meeting", json!({"_client_info":{"model":""}}))["_client_info"]["model"],
        "not_provided"
    );
    assert_eq!(
        call_arguments("didi", json!({"name":"unchanged"})),
        json!({"name":"unchanged"})
    );
}

#[tokio::test]
async fn json_and_sse_preserve_session_and_auth_without_fake_streaming() {
    for mode in [0, 1] {
        let (mut http, received, handle) = server(mode).await;
        let initialized = http
            .rpc("initialize", json!({"protocolVersion":PROTOCOL}))
            .await
            .unwrap();
        assert_eq!(initialized["protocolVersion"], PROTOCOL);
        http.notify("notifications/initialized").await.unwrap();
        let mut connection = Connection::Http(http);
        let tools = discover_on(&mut connection).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "lookup");
        connection.close().await;
        let requests = received.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[1]["body"]["id"], Value::Null);
        assert_eq!(
            requests[2]["authorization"],
            "Bearer personal-fixture-token"
        );
        assert_eq!(requests[2]["session"], "fixture-session");
        handle.abort();
    }
}

#[tokio::test]
async fn oversized_redirect_wrong_id_and_repeated_cursor_fail_closed() {
    for mode in [2, 3, 4, 5, 6] {
        let (http, _, handle) = server(mode).await;
        let error = discover_on(&mut Connection::Http(http)).await.unwrap_err();
        assert!(!error.to_string().contains("private credential"));
        assert!(!error.to_string().contains("personal-fixture-token"));
        handle.abort();
    }
}

#[test]
fn sse_uses_only_matching_complete_json_rpc_frames() {
    assert!(sse_frame(b": ping", 1).unwrap().is_none());
    assert!(
        sse_frame(
            b"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}",
            1
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        sse_frame(b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\n data: bad}", 1).is_err(),
        true
    );
    assert!(sse_frame(b"data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}", 1).is_err());
    assert!(
        sse_frame(
            b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"secret\"}}",
            1
        )
        .unwrap_err()
        .to_string()
        .find("secret")
        .is_none()
    );
    assert_eq!(
        sse_frame(
            b"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}",
            1
        )
        .unwrap(),
        Some(json!({"ok":true}))
    );
}

/// Explicitly run by the integration acceptance command. This touches the real,
/// pinned official stdio package but makes NO network/account request: MCP
/// initialize and tools/list are handled locally by the package.
#[tokio::test]
#[ignore = "requires the installed Node and pinned official yuque-mcp runtime"]
async fn official_yuque_stdio_catalog_smoke_without_network_or_credentials() {
    let mut connection = timeout(DEADLINE, Connection::open("yuque", &credentials()))
        .await
        .unwrap()
        .unwrap();
    let tools = timeout(DEADLINE, discover_on(&mut connection))
        .await
        .unwrap()
        .unwrap();
    connection.close().await;
    assert!(tools.iter().any(|tool| tool["name"] == "yuque_get_user"));
    assert!(tools.iter().any(|tool| tool["name"] == "yuque_update_doc"));
}

#[test]
fn yuque_identity_requires_positive_account_data_not_just_a_text_response() {
    assert!(validate_yuque_identity(&json!({"content":[{"type":"text","text":"{\"id\":123,\"login\":\"test-owner\"}"}]})).is_ok());
    for value in [
        json!({"content":[]}),
        json!({"content":[{"type":"text","text":"authentication failed"}]}),
        json!({"content":[{"type":"text","text":"{\"status\":401}"}]}),
        json!({"content":[{"type":"text","text":"{\"id\":0,\"login\":\"test-owner\"}"}]}),
        json!({"isError":true,"content":[{"type":"text","text":"{\"id\":123,\"login\":\"test-owner\"}"}]}),
    ] { assert!(validate_yuque_identity(&value).is_err()); }
}

#[tokio::test]
async fn stdio_bounds_output_and_does_not_pass_parent_secrets_to_child() {
    let temporary = tempfile::tempdir().unwrap();
    let script = temporary.path().join("fixture.js");
    std::fs::write(&script,r#"process.stdin.on('data', chunk => { for (const line of chunk.toString().split('\n').filter(Boolean)) { const q=JSON.parse(line); if(q.id) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tokenAlias:process.env.YUQUE_TOKEN===process.env.YUQUE_PERSONAL_TOKEN,hasRustKey:!!process.env.AGENT_SERVICE_TOKEN,hasNodeOptions:!!process.env.NODE_OPTIONS}})+'\n'); }});"#).unwrap();
    let mut stdio = StdioConnection::spawn("node".into(), script, "child-only-fixture").unwrap();
    let result = timeout(Duration::from_secs(5), stdio.rpc("fixture", json!({})))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        result,
        json!({"tokenAlias":true,"hasRustKey":false,"hasNodeOptions":false})
    );
    stdio.child.kill().await.unwrap();
    stdio.child.wait().await.unwrap();

    let script = temporary.path().join("oversized.js");
    std::fs::write(
        &script,
        "process.stdin.on('data',()=>process.stdout.write('x'.repeat(300000))); ",
    )
    .unwrap();
    let mut stdio = StdioConnection::spawn("node".into(), script, "fixture").unwrap();
    assert_eq!(
        timeout(Duration::from_secs(5), stdio.rpc("fixture", json!({})))
            .await
            .unwrap()
            .unwrap_err()
            .code,
        "mcp_response_limit"
    );
    stdio.child.kill().await.unwrap();
    stdio.child.wait().await.unwrap();
}
