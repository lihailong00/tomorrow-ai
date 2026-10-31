use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, Response},
};
use std::sync::{Arc, Mutex};

const FIXTURE_TOKEN: &str = "S=s:synthetic-private-auth-token-not-real";
#[derive(Clone)]
struct Fixture {
    requests: Arc<Mutex<Vec<Value>>>,
    response: Value,
    status: StatusCode,
    redirect: bool,
}
struct Server {
    api: Api,
    fixture: Fixture,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handler(State(fixture): State<Fixture>, request: Request<Body>) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let token = request
        .headers()
        .get("auth")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = to_bytes(request.into_body(), 64 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    fixture
        .requests
        .lock()
        .unwrap()
        .push(json!({"path":path,"auth":token,"content_type":content_type,"body":body}));
    let mut response = Response::builder()
        .status(fixture.status)
        .header("content-type", "application/json");
    if fixture.redirect {
        response = response.header("location", "https://other-host.invalid/steal");
    }
    response
        .body(Body::from(fixture.response.to_string()))
        .unwrap()
}

async fn server(response: Value, status: StatusCode) -> Server {
    let fixture = Fixture {
        requests: Arc::new(Mutex::new(Vec::new())),
        response,
        status,
        redirect: status.is_redirection(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().fallback(handler).with_state(fixture.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Server {
        api: Api::new(Url::parse(&format!("http://{address}/")).unwrap()).unwrap(),
        fixture,
        task,
    }
}
fn credentials() -> Credentials {
    Credentials {
        token: FIXTURE_TOKEN.into(),
        environment: "production".into(),
        server_url: None,
    }
}

#[tokio::test]
async fn discover_validates_the_real_authorized_notebook_api_and_exposes_only_declared_skill_tools()
{
    let s = server(
        json!({"status":{"code":0},"data":{"noteBookList":[]}}),
        StatusCode::OK,
    )
    .await;
    let tools = s.api.discover(&credentials()).await.unwrap();
    assert_eq!(tools.len(), 9);
    assert!(tools.iter().any(|tool| tool["name"] == "yinxiang_get_note"));
    assert!(tools.iter().all(|tool| tool["adapter"] == "official_skill"));
    assert!(
        !serde_json::to_string(&tools)
            .unwrap()
            .contains(FIXTURE_TOKEN)
    );
    let requests = s.fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["path"], format!("/{NOTEBOOKS}"));
    assert_eq!(requests[0]["auth"], FIXTURE_TOKEN);
    assert_eq!(requests[0]["body"], json!({"source":"skill"}));
    assert!(
        requests[0]["content_type"]
            .as_str()
            .unwrap()
            .starts_with("application/json")
    );
    assert_eq!(
        tools
            .iter()
            .filter(|t| is_read_only(t["name"].as_str().unwrap()))
            .count(),
        5
    );
    assert!(!is_read_only("yinxiang_create_note"));
    assert!(!is_read_only("yinxiang_read_and_delete_everything"));
}

#[tokio::test]
async fn failed_or_malformed_authorization_never_becomes_connected() {
    for response in [
        json!({"code":401,"message":FIXTURE_TOKEN}),
        json!({"code":100,"message":"membership required"}),
        json!({"code":0,"data":{}}),
        json!({"data":{"noteBookList":[]}}),
        json!({"status":{"code":"0"},"data":{"noteBookList":[]}}),
    ] {
        let s = server(response, StatusCode::OK).await;
        let error = s.api.discover(&credentials()).await.unwrap_err();
        assert!(!error.to_string().contains(FIXTURE_TOKEN));
    }
    for status in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
        let s = server(json!({"message":FIXTURE_TOKEN}), status).await;
        let error = s.api.discover(&credentials()).await.unwrap_err();
        assert_eq!(error.code, "connection_required");
        assert!(!error.to_string().contains(FIXTURE_TOKEN));
    }
}

#[tokio::test]
async fn search_uses_only_documented_filters_and_fixed_summary_result_spec() {
    let s=server(json!({"status":{"code":0},"data":{"total":150,"noteDetailList":[{"noteGuid":"known-guid","noteTitle":"项目记录"}]}}),StatusCode::OK).await;
    let result=s.api.call(&credentials(),"yinxiang_search_notes",json!({"keyword":"复盘","notebookGuid":"book-guid","tagNames":["工作"],"startTime":0,"endTime":1000})).await.unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["data"]["total"], 150);
    assert_eq!(
        result["structuredContent"]["data"]["noteDetailList"][0]["noteGuid"],
        "known-guid"
    );
    let requests = s.fixture.requests.lock().unwrap();
    assert_eq!(requests[0]["path"], format!("/{SEARCH}"));
    assert_eq!(
        requests[0]["body"]["resultSpec"],
        json!({"includeContent":false,"includeResources":false,"includeTags":true,"includeResourceContent":false})
    );
    assert_eq!(requests[0]["body"]["source"], "skill");
    drop(requests);
    for args in [
        json!({"url":"https://evil.invalid"}),
        json!({"source":"override"}),
        json!({"resultSpec":{"includeContent":true}}),
        json!({"startTime":100,"endTime":0}),
        json!({"notebookGuid":"id","notebookName":"name"}),
        json!({"updatedTime":100}),
        json!({"guids":[]}),
    ] {
        assert!(
            s.api
                .call(&credentials(), "yinxiang_search_notes", args)
                .await
                .is_err()
        );
    }
    assert_eq!(s.fixture.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn no_search_results_are_distinct_from_auth_and_business_failure() {
    let s = server(
        json!({"status":{"code":1107,"msg":"not found"}}),
        StatusCode::OK,
    )
    .await;
    let result = s
        .api
        .call(
            &credentials(),
            "yinxiang_search_notes",
            json!({"keyword":"absent"}),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(result["structuredContent"]["data"]["total"], 0);
    let s = server(
        json!({"code":700,"message":"failure with private detail"}),
        StatusCode::OK,
    )
    .await;
    let result = s
        .api
        .call(
            &credentials(),
            "yinxiang_create_note",
            json!({"title":"title","content":"content"}),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], true);
    assert!(!result.to_string().contains("private detail"));
    assert_eq!(s.fixture.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn successful_status_without_the_expected_read_payload_is_not_a_successful_read() {
    for (tool, args) in [
        ("yinxiang_list_notebooks", json!({})),
        ("yinxiang_list_tags", json!({})),
        ("yinxiang_get_note", json!({"guid":"id"})),
    ] {
        for body in [
            json!({"code":0}),
            json!({"code":0,"data":null}),
            json!({"code":0,"data":{"dataDetail":{}}}),
            json!({"code":0,"data":{"noteBookList":null,"tagList":{},"dataDetail":[]}}),
        ] {
            let s = server(body, StatusCode::OK).await;
            assert_eq!(
                s.api
                    .call(&credentials(), tool, args.clone())
                    .await
                    .unwrap_err()
                    .code,
                "yinxiang_protocol_error"
            );
        }
    }
    let s = server(json!({"code":0,"data":{"tagList":[]}}), StatusCode::OK).await;
    assert_eq!(
        s.api
            .call(&credentials(), "yinxiang_list_tags", json!({}))
            .await
            .unwrap()["isError"],
        false
    );
    let s = server(json!({"code":0,"data":{"noteBookList":[]}}), StatusCode::OK).await;
    assert_eq!(
        s.api
            .call(&credentials(), "yinxiang_list_notebooks", json!({}))
            .await
            .unwrap()["isError"],
        false
    );
}

#[tokio::test]
async fn writes_use_exact_endpoints_and_never_retry_or_accept_arbitrary_fields() {
    let s = server(
        json!({"code":0,"data":{"noteGuid":"new-guid"}}),
        StatusCode::OK,
    )
    .await;
    let result = s
        .api
        .call(
            &credentials(),
            "yinxiang_update_note",
            json!({"noteGuid":"known-guid","content":"新正文","clearTags":true}),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false);
    assert_eq!(
        s.fixture.requests.lock().unwrap()[0]["path"],
        "/third/third-party-note-service/restful/v1/updateNoteFromMCP"
    );
    assert_eq!(
        s.fixture.requests.lock().unwrap()[0]["body"],
        json!({"noteGuid":"known-guid","content":"新正文","clearTags":true,"source":"skill"})
    );
    for args in [
        json!({"noteGuid":"id"}),
        json!({"noteGuid":"id","tagNames":[]}),
        json!({"noteGuid":"id","tagNames":["tag"],"clearTags":true}),
        json!({"noteGuid":"id","clearTags":false}),
        json!({"noteGuid":"id","content":""}),
        json!({"noteGuid":"id","auth":"fake"}),
    ] {
        assert!(
            s.api
                .call(&credentials(), "yinxiang_update_note", args)
                .await
                .is_err()
        );
    }
    assert!(
        s.api
            .call(&credentials(), "yinxiang_delete_note", json!({"guid":"id"}))
            .await
            .is_err()
    );
    assert!(
        s.api
            .call(
                &credentials(),
                "yinxiang_clip_url",
                json!({"url":"http://127.0.0.1"})
            )
            .await
            .is_err()
    );
    assert_eq!(s.fixture.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn body_and_header_never_change_the_fixed_official_route() {
    let s = server(
        json!({"code":0,"data":{"dataDetail":{"content":"trusted response"}}}),
        StatusCode::OK,
    )
    .await;
    let result = s
        .api
        .call(
            &credentials(),
            "yinxiang_get_note",
            json!({"guid":"https://127.0.0.1/never-request"}),
        )
        .await
        .unwrap();
    assert_eq!(result["isError"], false);
    let requests = s.fixture.requests.lock().unwrap();
    assert_eq!(requests[0]["path"], format!("/{DETAIL}"));
    assert_eq!(
        requests[0]["body"]["guid"],
        "https://127.0.0.1/never-request"
    );
    assert_eq!(requests[0]["body"]["resultSpec"]["includeContent"], true);
}

#[tokio::test]
async fn redirects_oversized_responses_and_secret_echoes_fail_closed() {
    let s = server(json!({"code":0}), StatusCode::FOUND).await;
    assert!(s.api.discover(&credentials()).await.is_err());
    assert_eq!(s.fixture.requests.lock().unwrap().len(), 1);
    let s = server(
        json!({"code":0,"data":{"content":"x".repeat(MAX_RESPONSE)}}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        s.api
            .call(&credentials(), "yinxiang_get_note", json!({"guid":"id"}))
            .await
            .unwrap_err()
            .code,
        "yinxiang_response_limit"
    );
    let s = server(
        json!({"code":0,"data":{"content":FIXTURE_TOKEN}}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        s.api
            .call(&credentials(), "yinxiang_get_note", json!({"guid":"id"}))
            .await
            .unwrap_err()
            .code,
        "yinxiang_protocol_error"
    );
    assert!(contains_secret(
        &json!({"nested":[{"a":"private\"\\token"}]}),
        "private\"\\token"
    ));
}

#[test]
fn credential_and_argument_bounds_reject_unsupported_modes_without_network() {
    let mut c = credentials();
    c.server_url = Some("http://127.0.0.1".into());
    assert!(validate(&c).is_err());
    let mut c = credentials();
    c.environment = "sandbox".into();
    assert!(validate(&c).is_err());
    let mut c = credentials();
    c.token = "x\r\nauth: bad".into();
    assert!(validate(&c).is_err());
    let mut c = credentials();
    c.token = "".into();
    assert!(validate(&c).is_err());
    assert!(
        request_for(
            "yinxiang_create_note",
            json!({"title":"x","content":"a".repeat(MAX_ARGUMENTS)})
        )
        .is_err()
    );
    assert!(request_for("yinxiang_create_note", json!({"title":"x"})).is_err());
}
