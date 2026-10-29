use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{new_id, now, timestamp, Message, ModelProvider, Repository};
use tower::ServiceExt;

struct Fixture {
    repo: Repository,
    app: Router,
    user: String,
    token: String,
    other_token: String,
    requests: Arc<Mutex<Vec<Value>>>,
    response: Arc<Mutex<(StatusCode, String)>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn fixture(output: Value) -> Fixture {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let response = Arc::new(Mutex::new((StatusCode::OK, output.to_string())));
    async fn model(
        State((requests, response)): State<(
            Arc<Mutex<Vec<Value>>>,
            Arc<Mutex<(StatusCode, String)>>,
        )>,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        requests.lock().unwrap().push(body);
        let (status, content) = response.lock().unwrap().clone();
        (
            status,
            Json(json!({"choices":[{"message":{"role":"assistant","content":content}}]})),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let model_app = Router::new()
        .route("/v1/chat/completions", post(model))
        .with_state((requests.clone(), response.clone()));
    let server = tokio::spawn(async move {
        axum::serve(listener, model_app).await.unwrap();
    });
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("api-todo-owner@test.invalid", "test", "Owner", "UTC")
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user("api-todo-other@test.invalid", "test", "Other", "UTC")
        .await
        .unwrap()
        .id;
    let token = repo.create_session(&user).await.unwrap();
    let other_token = repo.create_session(&other).await.unwrap();
    let provider = ModelProvider::from_settings(
        format!("http://{addr}/v1"),
        Some("test-local-only".into()),
        Some("mock-model".into()),
    );
    Fixture {
        app: app(AppState::new(repo.clone(), provider, "sqlite::memory:")),
        repo,
        user,
        token,
        other_token,
        requests,
        response,
        server,
    }
}
async fn call(
    app: &Router,
    token: &str,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(if method == "GET" || method == "DELETE" {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn conversation(f: &Fixture, user_text: &str, assistant_text: &str) -> String {
    let conv = f
        .repo
        .create_conversation(&f.user, "真实目标")
        .await
        .unwrap();
    for (role, content) in [("user", user_text), ("assistant", assistant_text)] {
        f.repo
            .save_message(
                &f.user,
                &Message {
                    id: new_id(),
                    conversation_id: conv.id.clone(),
                    role: role.into(),
                    content: content.into(),
                    created_at: timestamp(now()),
                    model_mode: None,
                    attachments: vec![],
                },
            )
            .await
            .unwrap();
    }
    conv.id
}
fn candidate(excerpt: &str) -> Value {
    json!({"items":[{"title":"回复客户","description":"确认方案","kind":"communication","due_at":null,"estimated_minutes":null,"source_excerpt":excerpt}]})
}

#[tokio::test]
async fn http_todo_contract_versions_owner_nulls_and_no_source_forgery() {
    let f = fixture(json!({"items":[]})).await;
    let create = json!({"title":"回复客户","kind":"communication","client_request_id":"manual-1"});
    let (status, todo) = call(&f.app, &f.token, "POST", "/v1/todos", create.clone()).await;
    assert_eq!(status, StatusCode::OK, "{todo}");
    assert_eq!(todo["source_kind"], "manual");
    assert_eq!(todo["status"], "pending");
    assert!(todo["due_at"].is_null());
    let path = format!("/v1/todos/{}", todo["id"].as_str().unwrap());
    assert_eq!(
        call(&f.app, &f.token, "POST", "/v1/todos", create).await.1["id"],
        todo["id"]
    );
    assert_eq!(
        call(&f.app, &f.other_token, "GET", &path, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&f.app, &f.other_token, "DELETE", &path, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &f.app,
            &f.token,
            "PATCH",
            &path,
            json!({"version":99,"title":"changed"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert!(
        call(&f.app, &f.token, "PATCH", &path, json!({"title":"changed"}))
            .await
            .0
            .is_client_error()
    );
    let (status, changed) = call(&f.app, &f.token, "PATCH", &path, json!({"version":1,"draft":"用户草稿","due_at":"2026-01-01T00:00:00Z","estimated_minutes":20})).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    let (status, cleared) = call(
        &f.app,
        &f.token,
        "PATCH",
        &path,
        json!({"version":2,"draft":null,"due_at":null,"estimated_minutes":null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    for field in ["draft", "due_at", "estimated_minutes"] {
        assert!(cleared[field].is_null());
    }
    assert!(call(
        &f.app,
        &f.token,
        "POST",
        "/v1/todos",
        json!({"title":"forged","source_kind":"conversation","source_id":"fake"})
    )
    .await
    .0
    .is_client_error());
    assert_eq!(f.requests.lock().unwrap().len(), 0);
    let openapi = tomorrow_api::openapi_document();
    for path in [
        "/v1/todos",
        "/v1/todos/{id}",
        "/v1/todos/{id}/prepare",
        "/v1/todos/extract",
    ] {
        assert!(openapi.paths.paths.contains_key(path));
    }
}

#[tokio::test]
async fn extraction_reads_owned_real_conversation_and_deduplicates_dismissals() {
    let mut output = candidate("我要回复客户确认方案");
    let duplicate = output["items"][0].clone();
    output["items"].as_array_mut().unwrap().push(duplicate);
    let f = fixture(output).await;
    let id = conversation(&f, "我要回复客户确认方案", "建议你同时安排跑步").await;
    let input =
        json!({"source_kind":"conversation","source_id":id,"client_request_id":"extract-1"});
    assert_eq!(
        call(
            &f.app,
            &f.other_token,
            "POST",
            "/v1/todos/extract",
            input.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(f.requests.lock().unwrap().is_empty());
    let (status, result) = call(&f.app, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["created_count"], 1);
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    let todo = &result["items"][0];
    assert_eq!(todo["source_id"], id);
    assert_eq!(todo["status"], "suggested");
    assert!(todo["due_at"].is_null());
    let request = f.requests.lock().unwrap()[0].to_string();
    assert!(request.contains("我要回复客户确认方案"));
    assert!(request.contains("建议你同时安排跑步"));
    let (status, retry) = call(&f.app, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["created_count"], 0);
    assert_eq!(retry["items"][0]["id"], todo["id"]);
    assert_eq!(f.requests.lock().unwrap().len(), 1);
    let path = format!("/v1/todos/{}", todo["id"].as_str().unwrap());
    assert_eq!(
        call(
            &f.app,
            &f.token,
            "PATCH",
            &path,
            json!({"version":1,"status":"dismissed"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, after) = call(&f.app, &f.token, "POST", "/v1/todos/extract", input).await;
    assert_eq!(after["created_count"], 0);
    assert!(after["items"].as_array().unwrap().is_empty());
    // Source additions and paraphrased model titles cannot revive the same evidence.
    f.repo
        .save_message(
            &f.user,
            &Message {
                id: new_id(),
                conversation_id: id.clone(),
                role: "user".into(),
                content: "补充说明".into(),
                created_at: timestamp(now() + 1),
                model_mode: None,
                attachments: vec![],
            },
        )
        .await
        .unwrap();
    let (_, after_edit) = call(
        &f.app,
        &f.token,
        "POST",
        "/v1/todos/extract",
        json!({"source_kind":"conversation","source_id":id,"client_request_id":"extract-2"}),
    )
    .await;
    assert_eq!(after_edit["created_count"], 0);
    assert!(after_edit["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn extraction_rejects_assistant_only_evidence_invalid_json_and_upstream_failure() {
    let f = fixture(candidate("建议你回复客户")).await;
    let id = conversation(&f, "我还没决定", "建议你回复客户").await;
    let input = json!({"source_kind":"conversation","source_id":id});
    assert_eq!(
        call(&f.app, &f.token, "POST", "/v1/todos/extract", input.clone())
            .await
            .0,
        StatusCode::BAD_GATEWAY
    );
    *f.response.lock().unwrap() = (StatusCode::OK, "not json".into());
    assert_eq!(
        call(&f.app, &f.token, "POST", "/v1/todos/extract", input.clone())
            .await
            .0,
        StatusCode::BAD_GATEWAY
    );
    *f.response.lock().unwrap() = (
        StatusCode::SERVICE_UNAVAILABLE,
        "upstream unavailable".into(),
    );
    assert_eq!(
        call(&f.app, &f.token, "POST", "/v1/todos/extract", input.clone())
            .await
            .0,
        StatusCode::BAD_GATEWAY
    );
    *f.response.lock().unwrap() = (StatusCode::OK, json!({"items":[]}).to_string());
    let (status, empty) = call(&f.app, &f.token, "POST", "/v1/todos/extract", input).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["created_count"], 0);
    assert!(empty["items"].as_array().unwrap().is_empty());
    assert!(f.repo.conversation(&f.user, &id).await.is_ok());
    assert!(f
        .repo
        .todos_page(&f.user, "all", "all", 0, 10)
        .await
        .unwrap()
        .0
        .is_empty());
}

#[tokio::test]
async fn integration_source_is_owned_and_extraction_does_not_accept_client_text() {
    let f = fixture(candidate("回复客户确认方案")).await;
    let id = new_id();
    sqlx::query("INSERT INTO integration_imports(id,user_id,source_app,title,body,source_url,external_key,created_at)VALUES($1,$2,'shared','客户资料','回复客户确认方案','',$3,$4)")
        .bind(&id).bind(&f.user).bind(new_id()).bind(now()).execute(&f.repo.pool()).await.unwrap();
    let input = json!({"source_kind":"integration_import","source_id":id});
    assert_eq!(
        call(
            &f.app,
            &f.other_token,
            "POST",
            "/v1/todos/extract",
            input.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, result) = call(&f.app, &f.token, "POST", "/v1/todos/extract", input).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["created_count"], 1);
    assert_eq!(result["items"][0]["source_kind"], "integration_import");
    assert!(call(
        &f.app,
        &f.token,
        "POST",
        "/v1/todos/extract",
        json!({"source_kind":"integration_import","source_id":id,"text":"伪造资料"})
    )
    .await
    .0
    .is_client_error());
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM integration_imports WHERE user_id=$1")
            .bind(&f.user)
            .fetch_one(&f.repo.pool())
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn prepare_http_returns_queued_owned_task_immediately_and_preserves_personal_state() {
    let f = fixture(json!({"items":[]})).await;
    let (_, todo) = call(
        &f.app,
        &f.token,
        "POST",
        "/v1/todos",
        json!({"title":"学习Rust","kind":"learning"}),
    )
    .await;
    let id = todo["id"].as_str().unwrap();
    let path = format!("/v1/todos/{id}/prepare");
    let (status, prepared) = call(
        &f.app,
        &f.token,
        "POST",
        &path,
        json!({"client_request_id":"prepare-1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["status"], "pending");
    assert!(prepared["draft"].is_null());
    assert!(f.requests.lock().unwrap().is_empty());
    let task = f
        .repo
        .task(&f.user, prepared["linked_task_id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(task.kind, "todo_prepare");
    assert_eq!(task.status, "queued");
    let (_, retry) = call(
        &f.app,
        &f.token,
        "POST",
        &path,
        json!({"client_request_id":"prepare-1"}),
    )
    .await;
    assert_eq!(retry["linked_task_id"], prepared["linked_task_id"]);
    assert_eq!(f.repo.tasks(&f.user).await.unwrap().len(), 1);
    let claim = f.repo.claim_task(90).await.unwrap().unwrap();
    f.repo
        .complete_task(&claim, "学习解释和练习草稿", "llm")
        .await
        .unwrap();
    let (_, result) = call(
        &f.app,
        &f.token,
        "GET",
        &format!("/v1/todos/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(result["draft"], "学习解释和练习草稿");
    assert_eq!(result["status"], "pending");
    assert!(result["completed_at"].is_null());
}
