//! Independent acceptance uses isolated SQLite, an opt-in dedicated QA PostgreSQL,
//! and synthetic accounts. Never uses application/production database settings.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use chrono::{Days, TimeZone};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tomorrow_api::{app, AppState};
use tomorrow_domain::{new_id, now, timestamp, Message, ModelProvider, Repository};
use tower::ServiceExt;

struct ModelStub {
    content: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<Value>>>,
    handle: tokio::task::JoinHandle<()>,
    url: String,
}
impl Drop for ModelStub {
    fn drop(&mut self) {
        self.handle.abort();
    }
}
impl ModelStub {
    async fn new(content: Value) -> Self {
        let content = Arc::new(Mutex::new(content.to_string()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        async fn answer(
            State((content, requests)): State<(Arc<Mutex<String>>, Arc<Mutex<Vec<Value>>>)>,
            Json(request): Json<Value>,
        ) -> Json<Value> {
            requests.lock().unwrap().push(request);
            Json(
                json!({"choices":[{"message":{"role":"assistant","content":content.lock().unwrap().clone()}}]}),
            )
        }
        // Root authorized this ephemeral fixture only; never uses configured endpoints.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/v1/chat/completions", post(answer))
            .with_state((content.clone(), requests.clone()));
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            content,
            requests,
            handle,
            url,
        }
    }
    fn provider(&self) -> ModelProvider {
        ModelProvider::from_settings(
            self.url.clone(),
            Some("independent-fixture-no-real-key".into()),
            Some("fixture".into()),
        )
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    url: String,
    repo: Repository,
    router: Router,
    owner: String,
    token: String,
    other: String,
    foreign_token: String,
}
async fn fixture(provider: ModelProvider) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        dir.path().join("independent.db").to_string_lossy()
    );
    let repo = Repository::connect(&url).await.unwrap();
    let owner = repo
        .create_user(
            "independent-a@fixture.invalid",
            "unused",
            "A",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user(
            "independent-b@fixture.invalid",
            "unused",
            "B",
            "America/Los_Angeles",
        )
        .await
        .unwrap()
        .id;
    let token = repo.create_session(&owner).await.unwrap();
    let foreign_token = repo.create_session(&other).await.unwrap();
    let router = app(AppState::new(repo.clone(), provider, &url));
    Fixture {
        _dir: dir,
        url,
        repo,
        router,
        owner,
        token,
        other,
        foreign_token,
    }
}
async fn call(
    f: &Fixture,
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
        .body(if ["GET", "DELETE"].contains(&method) {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap();
    let response = f.router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn create(f: &Fixture, title: &str, extra: Value) -> Value {
    let mut body = json!({"title":title});
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    let (status, todo) = call(f, &f.token, "POST", "/v1/todos", body).await;
    assert_eq!(status, StatusCode::OK, "{todo}");
    todo
}
fn route(todo: &Value) -> String {
    format!("/v1/todos/{}", todo["id"].as_str().unwrap())
}
fn candidate(excerpt: &str) -> Value {
    json!({"items":[{"title":"回访客户","description":"依据来源处理","kind":"communication","due_at":null,"estimated_minutes":null,"source_excerpt":excerpt}]})
}
async fn import(f: &Fixture, text: &str) -> String {
    let id = new_id();
    sqlx::query("INSERT INTO integration_imports(id,user_id,source_app,title,body,source_url,external_key,created_at)VALUES($1,$2,'fixture','已确认资料',$3,'',$4,$5)")
        .bind(&id).bind(&f.owner).bind(text).bind(new_id()).bind(now()).execute(&f.repo.pool()).await.unwrap();
    id
}

#[tokio::test]
async fn api_edits_survive_reopen_and_foreign_accounts_cannot_mutate_or_prepare() {
    let f = fixture(ModelProvider::local()).await;
    let todo = create(
        &f,
        "自己的事项",
        json!({"kind":"reading","client_request_id":"create-one"}),
    )
    .await;
    let (_, retry) = call(
        &f,
        &f.token,
        "POST",
        "/v1/todos",
        json!({"title":"自己的事项","kind":"reading","client_request_id":"create-one"}),
    )
    .await;
    assert_eq!(todo["id"], retry["id"]);
    assert_eq!(
        call(
            &f,
            &f.token,
            "POST",
            "/v1/todos",
            json!({"title":"另一件事","client_request_id":"create-one"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let path = route(&todo);
    let (status,edited)=call(&f,&f.token,"PATCH",&path,json!({"version":1,"title":"真正修改后","draft":"本人的可编辑草稿","due_at":"2030-01-01T08:00:00+08:00"})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["status"], "pending");
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            &path,
            json!({"version":1,"title":"旧编辑"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for (method, url, body) in [
        ("GET", path.clone(), Value::Null),
        (
            "PATCH",
            path.clone(),
            json!({"version":2,"title":"跨账号覆盖"}),
        ),
        ("DELETE", path.clone(), Value::Null),
        ("POST", format!("{path}/prepare"), json!({})),
    ] {
        assert_eq!(
            call(&f, &f.foreign_token, method, &url, body).await.0,
            StatusCode::NOT_FOUND,
            "{method} {url}"
        );
    }
    assert!(f
        .repo
        .todos_page(&f.other, "all", "all", 0, 10)
        .await
        .unwrap()
        .0
        .is_empty());
    let reopened = Repository::connect(&f.url).await.unwrap();
    let saved = reopened
        .todo(&f.owner, todo["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(saved.title, "真正修改后");
    assert_eq!(saved.draft.as_deref(), Some("本人的可编辑草稿"));
    assert_eq!(saved.version, 2);
    let (status, cleared) = call(
        &f,
        &f.token,
        "PATCH",
        &path,
        json!({"version":2,"due_at":null,"draft":null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(cleared["due_at"].is_null());
    assert!(cleared["draft"].is_null());
}

#[tokio::test]
async fn today_boundary_and_pagination_do_not_mix_waiting_completed_or_tomorrow() {
    let f = fixture(ModelProvider::local()).await;
    let tz = chrono_tz::Asia::Shanghai;
    let tomorrow = chrono::Utc::now()
        .with_timezone(&tz)
        .date_naive()
        .checked_add_days(Days::new(1))
        .unwrap();
    let boundary = tz
        .from_local_datetime(&tomorrow.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .unwrap();
    let undated = create(&f, "无日期", json!({})).await;
    let before = create(
        &f,
        "今日最后一秒",
        json!({"due_at":(boundary-chrono::Duration::seconds(1)).to_rfc3339()}),
    )
    .await;
    let later = create(&f, "明日零点", json!({"due_at":boundary.to_rfc3339()})).await;
    let overdue = create(&f, "逾期仍需处理", json!({"due_at":"2020-01-01T00:00:00Z"})).await;
    let waiting = create(&f, "已实际回复", json!({"kind":"communication"})).await;
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            &route(&waiting),
            json!({"version":1,"status":"waiting"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let done = create(&f, "个人已确认", json!({})).await;
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            &route(&done),
            json!({"version":1,"status":"completed"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut ids = HashSet::new();
    let mut offset = 0;
    loop {
        let (status, page) = call(
            &f,
            &f.token,
            "GET",
            &format!("/v1/todos?filter=active&scope=today&limit=2&offset={offset}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        for t in page["items"].as_array().unwrap() {
            assert!(
                ids.insert(t["id"].as_str().unwrap().to_owned()),
                "duplicate continuation"
            );
        }
        match page["next_offset"].as_i64() {
            Some(next) => {
                assert!(next > offset);
                offset = next
            }
            None => break,
        }
    }
    assert_eq!(
        ids,
        HashSet::from([&undated, &before, &overdue].map(|v| v["id"].as_str().unwrap().to_owned()))
    );
    let (_, all) = call(
        &f,
        &f.token,
        "GET",
        "/v1/todos?filter=active&scope=all",
        Value::Null,
    )
    .await;
    assert!(all["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["id"] == later["id"]));
    for (filter, expected) in [
        ("waiting", waiting["id"].clone()),
        ("completed", done["id"].clone()),
    ] {
        let (_, page) = call(
            &f,
            &f.token,
            "GET",
            &format!("/v1/todos?filter={filter}&scope=today"),
            Value::Null,
        )
        .await;
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["id"], expected);
    }
}

#[tokio::test]
async fn owned_import_quote_is_required_and_dismissed_or_deleted_evidence_does_not_return() {
    let model = ModelStub::new(candidate("我会回访客户")).await;
    let f = fixture(model.provider()).await;
    let source = import(&f, "我会回访客户，确认合同范围。").await;
    let input = json!({"source_kind":"integration_import","source_id":source});
    assert_eq!(
        call(
            &f,
            &f.foreign_token,
            "POST",
            "/v1/todos/extract",
            input.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(model.requests.lock().unwrap().is_empty());
    let (status, extracted) = call(&f, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{extracted}");
    assert_eq!(extracted["created_count"], 1);
    let todo = &extracted["items"][0];
    assert_eq!(todo["status"], "suggested");
    assert_eq!(todo["source_excerpt"], "我会回访客户");
    assert_eq!(todo["source_id"], source);
    assert!(call(
        &f,
        &f.token,
        "PATCH",
        &route(todo),
        json!({"version":1,"status":"completed"})
    )
    .await
    .0
    .is_client_error());
    let (_, retry) = call(&f, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(retry["items"][0]["id"], todo["id"]);
    assert_eq!(retry["created_count"], 0);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            &route(todo),
            json!({"version":1,"status":"dismissed"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, hidden) = call(&f, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(hidden["items"], json!([]));
    assert_eq!(
        call(&f, &f.token, "DELETE", &route(todo), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE integration_imports SET body=$1 WHERE user_id=$2 AND id=$3")
        .bind("我会回访客户，确认合同范围。补充说明。")
        .bind(&f.owner)
        .bind(&source)
        .execute(&f.repo.pool())
        .await
        .unwrap();
    let (_, still_hidden) = call(&f, &f.token, "POST", "/v1/todos/extract", input).await;
    assert_eq!(still_hidden["created_count"], 0);
    assert_eq!(still_hidden["items"], json!([]));
    *model.content.lock().unwrap() = candidate("这是原文并没有的话").to_string();
    let different = import(&f, "我会核对发票").await;
    assert_eq!(
        call(
            &f,
            &f.token,
            "POST",
            "/v1/todos/extract",
            json!({"source_kind":"integration_import","source_id":different})
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
}

#[tokio::test]
async fn assistant_suggestions_cannot_supply_user_commitment_evidence() {
    let model = ModelStub::new(candidate("建议你回访客户")).await;
    let f = fixture(model.provider()).await;
    let conversation = f
        .repo
        .create_conversation(&f.owner, "仅助手建议")
        .await
        .unwrap();
    for (role, text) in [("user", "我还没有决定"), ("assistant", "建议你回访客户")] {
        f.repo
            .save_message(
                &f.owner,
                &Message {
                    id: new_id(),
                    conversation_id: conversation.id.clone(),
                    role: role.into(),
                    content: text.into(),
                    created_at: timestamp(now()),
                    model_mode: None,
                    attachments: vec![],
                },
            )
            .await
            .unwrap();
    }
    let body = json!({"source_kind":"conversation","source_id":conversation.id});
    assert_eq!(
        call(&f, &f.token, "POST", "/v1/todos/extract", body.clone())
            .await
            .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(
        call(&f, &f.foreign_token, "POST", "/v1/todos/extract", body)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(f
        .repo
        .todos_page(&f.owner, "all", "all", 0, 50)
        .await
        .unwrap()
        .0
        .is_empty());
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn completed_preparation_is_only_a_draft_and_late_results_cannot_overwrite_user_edits() {
    let model = ModelStub::new(json!({"items":[]})).await;
    let f = fixture(model.provider()).await;
    for manual_edit in [false, true] {
        let todo = create(&f, "学习真实目标", json!({"kind":"learning"})).await;
        let path = route(&todo);
        let (status, prepared) = call(
            &f,
            &f.token,
            "POST",
            &format!("{path}/prepare"),
            json!({"client_request_id":new_id()}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{prepared}");
        assert_eq!(prepared["status"], "pending");
        assert!(prepared["draft"].is_null());
        if manual_edit {
            assert_eq!(
                call(
                    &f,
                    &f.token,
                    "PATCH",
                    &path,
                    json!({"version":prepared["version"],"draft":"用户自己完成的草稿"})
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let claim = f.repo.claim_task(90).await.unwrap().unwrap();
        f.repo
            .complete_task(&claim, "模型准备出的练习", "llm")
            .await
            .unwrap();
        let (_, result) = call(&f, &f.token, "GET", &path, Value::Null).await;
        assert_eq!(result["status"], "pending");
        assert!(result["completed_at"].is_null());
        assert_eq!(
            result["draft"],
            if manual_edit {
                "用户自己完成的草稿"
            } else {
                "模型准备出的练习"
            }
        );
    }
    assert!(
        model.requests.lock().unwrap().is_empty(),
        "Preparation endpoint queues work; this test never runs a worker"
    );
}

#[tokio::test]
#[ignore = "Explicit QA container lease and TODOS_TEST_DATABASE_URL required; not a default pass"]
async fn qa_postgres_todos_migrations_and_personal_state_contract() {
    let database_url = std::env::var("TODOS_TEST_DATABASE_URL")
        .expect("TODOS_TEST_DATABASE_URL must explicitly name the dedicated QA database");
    let parsed = url::Url::parse(&database_url).expect("QA database URL must be valid");
    assert!(
        ["postgres", "postgresql"].contains(&parsed.scheme())
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.port() == Some(55443)
            && parsed.username() == "todos_qa"
            && parsed.path() == "/todos_qa",
        "Refusing a database outside Root's dedicated localhost:55443 QA lease"
    );
    let mut output = candidate("我会核对报销票据");
    output["items"][0]["title"] = json!("核对报销票据");
    let model = ModelStub::new(output).await;
    // A new connection applies Repository's real PostgreSQL migrations.
    let repo = Repository::connect(&database_url).await.unwrap();
    let suffix = new_id();
    let owner = repo
        .create_user(
            &format!("pg-owner-{suffix}@fixture.invalid"),
            "unused",
            "PG owner",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user(
            &format!("pg-other-{suffix}@fixture.invalid"),
            "unused",
            "PG other",
            "UTC",
        )
        .await
        .unwrap()
        .id;
    let token = repo.create_session(&owner).await.unwrap();
    let foreign_token = repo.create_session(&other).await.unwrap();
    let f = Fixture {
        _dir: tempfile::tempdir().unwrap(),
        url: database_url.clone(),
        router: app(AppState::new(repo.clone(), model.provider(), &database_url)),
        repo,
        owner,
        token,
        other,
        foreign_token,
    };
    let todo = create(
        &f,
        "PG 持久学习目标",
        json!({"kind":"learning","client_request_id":new_id()}),
    )
    .await;
    let path = route(&todo);
    let (status, edited) = call(
        &f,
        &f.token,
        "PATCH",
        &path,
        json!({"version":1,"title":"PG 修改后的学习目标","progress_notes":"用户自己的实际进展"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["version"], 2);
    assert_eq!(
        call(
            &f,
            &f.token,
            "PATCH",
            &path,
            json!({"version":1,"title":"过期覆盖"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for (method, endpoint, body) in [
        ("GET", path.clone(), Value::Null),
        (
            "PATCH",
            path.clone(),
            json!({"version":2,"title":"异账号覆盖"}),
        ),
        ("DELETE", path.clone(), Value::Null),
        ("POST", format!("{path}/prepare"), json!({})),
    ] {
        assert_eq!(
            call(&f, &f.foreign_token, method, &endpoint, body).await.0,
            StatusCode::NOT_FOUND
        );
    }
    let reopened = Repository::connect(&database_url).await.unwrap();
    let persisted = reopened
        .todo(&f.owner, todo["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(persisted.title, "PG 修改后的学习目标");
    assert_eq!(
        persisted.progress_notes.as_deref(),
        Some("用户自己的实际进展")
    );

    let source = import(&f, "我会核对报销票据，核对后自行提交。").await;
    let input =
        json!({"source_kind":"integration_import","source_id":source,"client_request_id":new_id()});
    assert_eq!(
        call(
            &f,
            &f.foreign_token,
            "POST",
            "/v1/todos/extract",
            input.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, extracted) = call(&f, &f.token, "POST", "/v1/todos/extract", input.clone()).await;
    assert_eq!(status, StatusCode::OK, "{extracted}");
    assert_eq!(extracted["created_count"], 1);
    assert_eq!(extracted["items"][0]["status"], "suggested");
    let (status, retry) = call(&f, &f.token, "POST", "/v1/todos/extract", input).await;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert_eq!(retry["created_count"], 0);
    assert_eq!(retry["items"][0]["id"], extracted["items"][0]["id"]);
    assert_eq!(
        model.requests.lock().unwrap().len(),
        1,
        "Same source retry must not call the model twice"
    );

    let (status, prepared) = call(
        &f,
        &f.token,
        "POST",
        &format!("{path}/prepare"),
        json!({"client_request_id":new_id()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prepared}");
    assert_eq!(prepared["status"], "pending");
    let task_id = prepared["linked_task_id"].as_str().unwrap();
    let task = reopened.task(&f.owner, task_id).await.unwrap();
    assert_eq!(task.status, "queued");
    assert_eq!(task.kind, "todo_prepare");
    // Synthetic completion of this exact owned task, without a shared worker/claim.
    assert_eq!(sqlx::query("UPDATE tasks SET status='succeeded',result=$1,progress=100,model_mode='fixture',updated_at=$2 WHERE id=$3 AND user_id=$4")
        .bind("准备出的真实目标练习").bind(now()).bind(task_id).bind(&f.owner)
        .execute(&f.repo.pool()).await.unwrap().rows_affected(), 1);
    let completed_task = reopened.task(&f.owner, task_id).await.unwrap();
    assert_eq!(completed_task.status, "succeeded");
    let refreshed = reopened
        .todo(&f.owner, todo["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(refreshed.status, "pending");
    assert_eq!(refreshed.draft.as_deref(), Some("准备出的真实目标练习"));
    assert_eq!(
        refreshed.progress_notes.as_deref(),
        Some("用户自己的实际进展")
    );
    assert!(refreshed.completed_at.is_none());
    let (status, personal_done) = call(
        &f,
        &f.token,
        "PATCH",
        &path,
        json!({"version":refreshed.version,"status":"completed"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{personal_done}");
    assert_eq!(personal_done["status"], "completed");
    assert!(personal_done["completed_at"].is_string());
    let disposable = create(&f, "PG 可删除记录", json!({})).await;
    assert_eq!(
        call(&f, &f.token, "DELETE", &route(&disposable), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&f, &f.token, "GET", &route(&disposable), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        model.requests.lock().unwrap().len(),
        1,
        "No worker or real model execution in this test"
    );
}
