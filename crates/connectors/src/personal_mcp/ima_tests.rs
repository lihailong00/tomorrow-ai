use super::*;
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Request},
    routing::any,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

fn credentials() -> Credentials {
    serde_json::from_value(json!({"token":"ima-synthetic-api-key","client_id":"ima-synthetic-client","environment":"production"})).unwrap()
}

#[derive(Clone, Default)]
struct Fixture {
    replies: Arc<Mutex<VecDeque<(StatusCode, String)>>>,
    requests: Arc<Mutex<Vec<(String, String, HeaderMap, Value)>>>,
}
async fn server(
    State(f): State<Fixture>,
    request: Request<Body>,
) -> (StatusCode, HeaderMap, String) {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, MAX_ARGUMENTS + 1024)
        .await
        .unwrap();
    f.requests.lock().unwrap().push((
        parts.method.to_string(),
        parts.uri.to_string(),
        parts.headers,
        serde_json::from_slice(&body).unwrap(),
    ));
    let (status, body) = f
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected extra upstream request");
    let mut headers = HeaderMap::new();
    if status.is_redirection() {
        headers.insert(
            "location",
            HeaderValue::from_static("/redirect-must-not-be-followed"),
        );
    }
    (status, headers, body)
}
async fn fixture(
    replies: Vec<(StatusCode, String)>,
) -> (Api, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture::default();
    f.replies.lock().unwrap().extend(replies);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().fallback(any(server)).with_state(f.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (Api::new(base).unwrap(), f, task)
}

#[tokio::test]
async fn discovery_uses_real_authenticated_read_probe_and_sensitive_headers() {
    let (api, f, task) = fixture(vec![(
        StatusCode::OK,
        json!({"code":0,"data":{"list":[]}}).to_string(),
    )])
    .await;
    let tools = discover_with(&api, &credentials()).await.unwrap();
    assert_eq!(tools.len(), 10);
    assert!(
        tools
            .iter()
            .all(|t| is_read_only(t["name"].as_str().unwrap())
                && t["annotations"]["readOnlyHint"] == true)
    );
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "POST");
    assert_eq!(calls[0].1, "/openapi/wiki/v1/search_knowledge_base");
    assert_eq!(calls[0].3, json!({"query":"","cursor":"","limit":1}));
    assert_eq!(calls[0].2["ima-openapi-clientid"], "ima-synthetic-client");
    assert_eq!(calls[0].2["ima-openapi-apikey"], "ima-synthetic-api-key");
    assert_eq!(calls[0].2["ima-openapi-ctx"], "skill_version=1.1.10");
    assert!(!calls[0].2.contains_key("authorization"));
    assert!(!calls[0].3.to_string().contains("ima-synthetic"));
    task.abort();
}

#[tokio::test]
async fn discovery_rejects_http_failures_redirects_false_success_and_secret_diagnostics() {
    let replies = vec![
        (
            StatusCode::UNAUTHORIZED,
            json!({"code":0,"message":"ima-synthetic-api-key"}).to_string(),
        ),
        (StatusCode::FOUND, json!({"code":0}).to_string()),
        (
            StatusCode::OK,
            json!({"code":1,"message":"ima-synthetic-api-key"}).to_string(),
        ),
        (StatusCode::OK, json!({"data":[]}).to_string()),
        (StatusCode::OK, "<html>ima-synthetic-api-key</html>".into()),
        (StatusCode::OK, json!({"code":true}).to_string()),
    ];
    let (api, f, task) = fixture(replies).await;
    for _ in 0..6 {
        let error = discover_with(&api, &credentials()).await.unwrap_err();
        assert!(!format!("{error:?}").contains("ima-synthetic"));
        assert!(!error.to_string().contains("<html>"));
    }
    assert_eq!(f.requests.lock().unwrap().len(), 6);
    task.abort();
}

#[tokio::test]
async fn call_sends_official_search_payload_and_returns_actual_response() {
    let response = json!({"code":"0","data":{"items":[{"note_id":"note-1","title":"实际笔记"}]}});
    let (api, f, task) = fixture(vec![(StatusCode::OK, response.to_string())]).await;
    let result = call_with(
        &api,
        &credentials(),
        "ima_search_notes",
        json!({"query":"日记","search_type":1,"start":20,"end":40}),
    )
    .await
    .unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"], response);
    let calls = f.requests.lock().unwrap();
    assert_eq!(calls[0].1, "/openapi/note/v1/search_note");
    assert_eq!(
        calls[0].3,
        json!({"search_type":1,"query_info":{"content":"日记"},"start":20,"end":40})
    );
    task.abort();
}

#[test]
fn all_advertised_tools_have_only_verified_fixed_paths_and_bounded_schemas() {
    let cases = [
        (
            "ima_list_notebooks",
            json!({}),
            "openapi/note/v1/list_notebook",
        ),
        (
            "ima_list_notes",
            json!({"folder_id":"folder-1"}),
            "openapi/note/v1/list_note",
        ),
        (
            "ima_get_note",
            json!({"note_id":"note-1"}),
            "openapi/note/v1/get_doc_content",
        ),
        (
            "ima_search_notes",
            json!({"query":"test"}),
            "openapi/note/v1/search_note",
        ),
        (
            "ima_list_knowledge_bases",
            json!({}),
            "openapi/wiki/v1/search_knowledge_base",
        ),
        (
            "ima_list_addable_knowledge_bases",
            json!({}),
            "openapi/wiki/v1/get_addable_knowledge_base_list",
        ),
        (
            "ima_get_knowledge_base",
            json!({"ids":["kb-1"]}),
            "openapi/wiki/v1/get_knowledge_base",
        ),
        (
            "ima_list_knowledge",
            json!({"knowledge_base_id":"kb-1"}),
            "openapi/wiki/v1/get_knowledge_list",
        ),
        (
            "ima_search_knowledge",
            json!({"knowledge_base_id":"kb-1","query":"test"}),
            "openapi/wiki/v1/search_knowledge",
        ),
        (
            "ima_get_media",
            json!({"media_id":"media-1"}),
            "openapi/wiki/v1/get_media_info",
        ),
    ];
    for (name, args, path) in cases {
        let (actual, body) = request_for(name, &args).unwrap();
        assert_eq!(actual, path);
        assert!(!body.to_string().contains("apikey"));
        let mut extra = args.clone();
        extra["url"] = json!("http://127.0.0.1/private");
        assert!(validate_arguments(name, &extra).is_err());
        assert!(
            tools()
                .iter()
                .any(|t| t["name"] == name && t["inputSchema"]["additionalProperties"] == false)
        );
    }
    assert!(!is_read_only("ima_create_note"));
    assert!(request_for("ima_create_note", &json!({"content":"forbidden"})).is_err());
    for args in [
        json!({"limit":0}),
        json!({"limit":21}),
        json!({"limit":"1"}),
        json!({"client_id":"in-body"}),
    ] {
        assert!(request_for("ima_list_knowledge_bases", &args).is_err());
    }
    assert!(request_for("ima_get_knowledge_base", &json!({"ids":[]})).is_err());
    assert!(request_for("ima_get_knowledge_base", &json!({"ids":["kb-1","kb-1"]})).is_err());
    assert!(request_for("ima_get_note", &json!({"note_id":""})).is_err());
    assert!(
        request_for(
            "ima_search_notes",
            &json!({"query":"q","start":20,"end":10})
        )
        .is_err()
    );
    assert!(request_for("ima_search_notes", &json!({"query":"q","search_type":2})).is_err());
}

#[tokio::test]
async fn oversized_response_and_invalid_credentials_fail_without_extra_requests() {
    let (api, f, task) = fixture(vec![(
        StatusCode::OK,
        json!({"code":0,"data":"x".repeat(MAX_RESPONSE)}).to_string(),
    )])
    .await;
    assert_eq!(
        discover_with(&api, &credentials()).await.unwrap_err().code,
        "ima_response_limit"
    );
    for (client, token, url) in [
        (None, "key", None),
        (Some("client\r\ninjected"), "key", None),
        (Some("client"), "key\n", None),
        (Some("client"), "key", Some("https://evil.invalid")),
    ] {
        let bad: Credentials = serde_json::from_value(
            json!({"client_id":client,"token":token,"server_url":url,"environment":"production"}),
        )
        .unwrap();
        assert!(discover_with(&api, &bad).await.is_err());
    }
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    task.abort();
}
