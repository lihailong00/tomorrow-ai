use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderMap, Request, StatusCode},
    response::IntoResponse,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tomorrow_api::{app, ApiError, AppState};
use tomorrow_domain::{
    phone::PhoneAuth,
    sms::{SmsMessage, SmsSender},
    DomainError, ModelProvider, Repository,
};
use tower::ServiceExt;

const PASSWORD: &str = " 安全密码 example 2026 ";
const NEW_PASSWORD: &str = "新的安全密码 example 2026";
static PASSWORD_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct CountingSms(AtomicUsize);
impl SmsSender for CountingSms {
    fn send<'a>(
        &'a self,
        _message: SmsMessage<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), DomainError>> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

async fn call(
    router: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let (status, _, reply) = call_with_headers(router, method, path, token, body).await;
    (status, reply)
}

async fn call_with_headers(
    router: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, headers, serde_json::from_slice(&bytes).unwrap())
}
async fn code(router: &axum::Router, repo: &Repository, phone: &str, purpose: &str) -> String {
    // Only session/ownership fixtures clear attempts; dedicated tests exercise the actual quota.
    sqlx::query("DELETE FROM phone_sms_attempts")
        .execute(&repo.pool())
        .await
        .unwrap();
    let (status, reply) = call(
        router,
        "POST",
        "/v1/auth/phone/code",
        None,
        json!({"phone":phone,"purpose":purpose}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["test_mode"], true);
    assert!(reply.get("code").is_none());
    reply["challenge_id"].as_str().unwrap().into()
}
async fn register(router: &axum::Router, repo: &Repository, phone: &str) -> Value {
    let challenge = code(router, repo, phone, "register").await;
    let (status, reply) = call(
        router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":phone,"code":"123456","challenge_id":challenge,"password":PASSWORD,"name":"测试用户"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    reply
}

#[tokio::test]
async fn unconfigured_sms_disables_code_registration_and_reset_but_allows_password_login() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let configured = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let session = register(&configured, &repo, "13800138000").await;
    let router = app(AppState::new(
        repo.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    for path in [
        "/v1/auth/phone/code",
        "/v1/auth/phone/register",
        "/v1/auth/phone/password/reset",
    ] {
        let (status, reply) = call(&router, "POST", path, None, json!({"phone":"13900139000","purpose":"register","code":"123456","challenge_id":"a".repeat(64),"password":PASSWORD,"new_password":NEW_PASSWORD})).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {reply}");
        assert_eq!(reply["error"]["code"], "service_unavailable");
        assert!(!reply.to_string().contains("123456"));
    }
    assert!(repo.phone_user("13900139000").await.unwrap().is_none());
    let (status, logged) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{logged}");
    assert_eq!(logged["user"]["id"], session["user"]["id"]);
}

#[tokio::test]
async fn phone_registration_login_and_logout_use_persistent_real_sessions() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let challenge = code(&router, &repo, "13800138000", "register").await;
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":"13800138000","code":"000000","challenge_id":challenge,"password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(repo.phone_user("13800138000").await.unwrap().is_none());
    let (status, first) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":"+86 13800138000","code":"123456","challenge_id":challenge,"password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["user"]["phone"], "+8613800138000");
    assert_eq!(first["user"]["name"], "用户8000");
    assert!(first["user"].get("password_hash").is_none());
    let token = first["token"].as_str().unwrap();
    let (status, logged) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"008613800138000","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{logged}");
    assert_eq!(logged["user"]["id"], first["user"]["id"]);
    assert_ne!(logged["token"], first["token"]);
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":PASSWORD.trim()}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    call(&router, "POST", "/v1/auth/logout", Some(token), json!({})).await;
    assert_eq!(
        call(&router, "GET", "/v1/me", Some(token), json!({}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &router,
            "GET",
            "/v1/me",
            Some(logged["token"].as_str().unwrap()),
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":"13800138000","code":"123456","challenge_id":"a".repeat(64),"password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn phone_accounts_cannot_read_or_mutate_each_others_records() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let first = register(&router, &repo, "13800138000").await;
    let second = register(&router, &repo, "13900139000").await;
    let a = first["token"].as_str().unwrap();
    let b = second["token"].as_str().unwrap();
    assert_ne!(first["user"]["id"], second["user"]["id"]);
    let (_, memory) = call(
        &router,
        "POST",
        "/v1/memories",
        Some(a),
        json!({"content":"A专属偏好","kind":"preference"}),
    )
    .await;
    let (_, task) = call(
        &router,
        "POST",
        "/v1/tasks",
        Some(a),
        json!({"instruction":"A专属任务","approval_required":true}),
    )
    .await;
    let(_,schedule)=call(&router,"POST","/v1/schedules",Some(a),json!({"title":"A专属计划","instruction":"A提醒","frequency":"daily","time":"08:30","timezone":"Asia/Shanghai","enabled":false})).await;
    let (_, chat) = call(
        &router,
        "POST",
        "/v1/chat",
        Some(a),
        json!({"message":"A独有的对话","client_request_id":"same-user-action"}),
    )
    .await;
    for path in [
        "/v1/memories",
        "/v1/tasks",
        "/v1/schedules",
        "/v1/conversations",
        "/v1/artifacts",
        "/v1/notifications",
        "/v1/agent-runs",
    ] {
        let (status, reply) = call(&router, "GET", path, Some(b), json!({})).await;
        assert_eq!(status, StatusCode::OK, "{path}: {reply}");
        assert!(
            reply["items"].as_array().unwrap().is_empty(),
            "{path}: {reply}"
        );
    }
    let memory_id = memory["id"].as_str().unwrap();
    let task_id = task["id"].as_str().unwrap();
    let schedule_id = schedule["id"].as_str().unwrap();
    for (method, path, body) in [
        (
            "PATCH",
            format!("/v1/memories/{memory_id}"),
            json!({"content":"B越权改写"}),
        ),
        ("DELETE", format!("/v1/memories/{memory_id}"), json!({})),
        ("GET", format!("/v1/tasks/{task_id}"), json!({})),
        ("POST", format!("/v1/tasks/{task_id}/cancel"), json!({})),
        ("POST", format!("/v1/tasks/{task_id}/approve"), json!({})),
        (
            "PATCH",
            format!("/v1/schedules/{schedule_id}"),
            json!({"enabled":true}),
        ),
        ("DELETE", format!("/v1/schedules/{schedule_id}"), json!({})),
        (
            "GET",
            format!(
                "/v1/conversations/{}/messages",
                chat["conversation_id"].as_str().unwrap()
            ),
            json!({}),
        ),
    ] {
        assert_eq!(
            call(&router, method, &path, Some(b), body).await.0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    let (_, own) = call(
        &router,
        "POST",
        "/v1/memories",
        Some(b),
        json!({"content":"B专属记忆","kind":"fact","user_id":first["user"]["id"]}),
    )
    .await;
    assert_ne!(own["id"], memory["id"]);
    let (_, a_list) = call(&router, "GET", "/v1/memories", Some(a), json!({})).await;
    assert_eq!(a_list["items"].as_array().unwrap().len(), 1);
    assert_eq!(a_list["items"][0]["content"], "A专属偏好");
    let (_, again) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":PASSWORD}),
    )
    .await;
    let (_, home) = call(
        &router,
        "GET",
        "/v1/today",
        Some(again["token"].as_str().unwrap()),
        json!({}),
    )
    .await;
    assert_eq!(home["memories"][0]["content"], "A专属偏好");
    assert_eq!(home["tasks"][0]["id"], task["id"]);
    assert_eq!(home["schedules"][0]["id"], schedule["id"]);
}

#[tokio::test]
async fn resend_returns_429_with_retry_header_and_the_existing_error_envelope() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let input = json!({"phone":"13800138000","purpose":"register"});
    assert_eq!(
        call(&router, "POST", "/v1/auth/phone/code", None, input.clone())
            .await
            .0,
        StatusCode::OK
    );
    let (status, headers, reply) =
        call_with_headers(&router, "POST", "/v1/auth/phone/code", None, input).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let retry_after: i64 = headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=60).contains(&retry_after));
    assert_eq!(reply.as_object().unwrap().len(), 1);
    assert_eq!(reply["error"].as_object().unwrap().len(), 2);
    assert_eq!(reply["error"]["code"], "rate_limited");
    assert!(reply["error"]["message"].is_string());
    assert!(reply.get("retry_after").is_none());
    let attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM phone_sms_attempts")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(attempts, 1);
}

#[tokio::test]
async fn rate_limit_headers_clamp_nonpositive_values_without_changing_other_errors() {
    for (seconds, expected) in [(0, "1"), (-100, "1"), (73, "73")] {
        for error in [
            DomainError::RateLimited {
                retry_after: seconds,
            },
            DomainError::LoginRateLimited {
                retry_after: seconds,
            },
        ] {
            let response = ApiError(error).into_response();
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response.headers()[header::RETRY_AFTER], expected);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let reply: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(reply["error"]["code"], "rate_limited");
            assert_eq!(reply["error"].as_object().unwrap().len(), 2);
        }
    }
    let response = ApiError(DomainError::Conflict("unchanged".into())).into_response();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(response.headers().get(header::RETRY_AFTER).is_none());
}

#[tokio::test]
async fn only_phone_auth_routes_limit_json_bodies_to_two_kibibytes() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    for path in [
        "/v1/auth/phone/code",
        "/v1/auth/phone/register",
        "/v1/auth/phone/login",
        "/v1/auth/phone/password/reset",
    ] {
        let (status, reply) = call(
            &router,
            "POST",
            path,
            None,
            json!({"phone":"13800138000","purpose":"register","code":"123456","challenge_id":"a".repeat(64),"password":PASSWORD,"new_password":NEW_PASSWORD,"padding":"x".repeat(4096)}),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{path}: {reply}");
        assert_eq!(reply["error"]["code"], "invalid_request");
    }
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/login",
        None,
        json!({"email":"missing@example.test","password":"not-a-real-password","padding":"x".repeat(4096)}),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for table in [
        "phone_sms_attempts",
        "phone_codes",
        "phone_identities",
        "users",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&repo.pool())
            .await
            .unwrap();
        assert_eq!(count, 0, "oversized phone request changed {table}");
    }
}

#[tokio::test]
async fn malformed_challenges_and_codes_do_not_mutate_the_database() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let id = code(&router, &repo, "13800138000", "register").await;
    for path in ["/v1/auth/phone/register", "/v1/auth/phone/password/reset"] {
        for (challenge_id, submitted_code) in [
            ("a".repeat(1024), "123456".to_owned()),
            ("g".repeat(64), "123456".to_owned()),
            (id.clone(), "1234567".to_owned()),
            (id.clone(), "１２３４５６".to_owned()),
        ] {
            let (status, reply) = call(
                &router,
                "POST",
                path,
                None,
                json!({"phone":"13800138000","code":submitted_code,"challenge_id":challenge_id,"password":PASSWORD,"new_password":NEW_PASSWORD}),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {reply}");
            assert_eq!(reply["error"]["code"], "validation");
            assert!(!reply.to_string().contains("1234567"));
        }
    }
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM phone_codes WHERE id=$1")
        .bind(&id)
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(attempts, 0);
    let sms_attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM phone_sms_attempts")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(sms_attempts, 1);
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(users, 0);
}

#[tokio::test]
async fn code_consuming_routes_reject_malformed_code_before_any_database_access() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    repo.pool().close().await;
    for path in ["/v1/auth/phone/register", "/v1/auth/phone/password/reset"] {
        for (challenge_id, submitted_code) in
            [("a".repeat(1024), "123456"), ("a".repeat(64), "1234567")]
        {
            let (status, reply) = call(
        &router,
        "POST",
        path,
        None,
        json!({"phone":"13800138000","code":submitted_code,"challenge_id":challenge_id,"password":PASSWORD,"new_password":NEW_PASSWORD}),
    )
    .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(reply["error"]["code"], "validation");
        }
    }
}

#[tokio::test]
async fn disallowed_phones_return_generic_forbidden_without_consuming_sms_quota() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:").with_phone_auth(
            PhoneAuth::local_test()
                .with_allowed_phones("13800138000")
                .unwrap(),
        ),
    );
    let (status, reply) = call(
        &router,
        "POST",
        "/v1/auth/phone/code",
        None,
        json!({"phone":"13900139000","purpose":"register"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(reply["error"]["code"], "forbidden");
    assert!(!reply.to_string().contains("13900139000"));
    assert!(!reply.to_string().contains("13800138000"));
    for table in ["phone_sms_attempts", "phone_codes"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&repo.pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn wrong_unknown_and_uninitialized_credentials_have_the_same_safe_response() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    register(&router, &repo, "13800138000").await;
    repo.create_phone_user("13700137000", "旧账号", "Asia/Shanghai")
        .await
        .unwrap();
    let mut expected = None;
    for (phone, password) in [
        ("13800138000", "another wrong password"),
        ("13900139000", PASSWORD),
        ("13700137000", PASSWORD),
        ("invalid", PASSWORD),
        ("13800138000", "short"),
    ] {
        let (status, reply) = call(
            &router,
            "POST",
            "/v1/auth/phone/login",
            None,
            json!({"phone":phone,"password":password}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{reply}");
        assert_eq!(reply["error"]["code"], "invalid_credentials");
        assert_eq!(
            reply["error"]["message"],
            "手机号或密码错误；如未设置密码，请先重置密码"
        );
        if phone.starts_with('1') {
            assert!(!reply.to_string().contains(phone));
        }
        if let Some(expected) = &expected {
            assert_eq!(&reply, expected);
        } else {
            expected = Some(reply);
        }
    }
}

#[tokio::test]
async fn invalid_registration_passwords_and_profile_fields_do_not_consume_the_code() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let id = code(&router, &repo, "13800138000", "register").await;
    for overrides in [
        json!({"password":"1234567"}),
        json!({"password":"字".repeat(129)}),
        json!({"name":"字".repeat(81)}),
        json!({"timezone":"not/an/iana/timezone"}),
    ] {
        let mut input =
            json!({"phone":"13800138000","code":"123456","challenge_id":id,"password":PASSWORD});
        input
            .as_object_mut()
            .unwrap()
            .extend(overrides.as_object().unwrap().clone());
        let (status, reply) = call(&router, "POST", "/v1/auth/phone/register", None, input).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
        assert_eq!(reply["error"]["code"], "validation");
    }
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":"13800138000","code":"123456","challenge_id":id}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let attempts: i64 =
        sqlx::query_scalar("SELECT CAST(attempts AS BIGINT) FROM phone_codes WHERE id=$1")
            .bind(&id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(attempts, 0);
    assert!(repo.phone_user("13800138000").await.unwrap().is_none());
    let (status, reply) = call(&router, "POST", "/v1/auth/phone/register", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":id,"password":"八个汉字密码测试"})).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
}

#[tokio::test]
async fn password_reset_revokes_only_its_users_sessions_and_never_logs_in_automatically() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let first = register(&router, &repo, "13800138000").await;
    let (_, logged) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":PASSWORD}),
    )
    .await;
    let other = register(&router, &repo, "13900139000").await;
    let id = code(&router, &repo, "13800138000", "reset_password").await;
    let input = json!({"phone":"+86 138-0013-8000","code":"123456","challenge_id":id,"new_password":NEW_PASSWORD});
    let mut invalid = input.clone();
    invalid["new_password"] = json!("short");
    assert_eq!(
        call(
            &router,
            "POST",
            "/v1/auth/phone/password/reset",
            None,
            invalid
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let attempts: i64 =
        sqlx::query_scalar("SELECT CAST(attempts AS BIGINT) FROM phone_codes WHERE id=$1")
            .bind(&id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(attempts, 0);
    let (status, headers, reply) = call_with_headers(
        &router,
        "POST",
        "/v1/auth/phone/password/reset",
        None,
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply, json!({"ok":true}));
    assert!(headers.get(header::SET_COOKIE).is_none());
    let sessions: i64 =
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions WHERE user_id=$1")
            .bind(first["user"]["id"].as_str().unwrap())
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(sessions, 0, "reset must not create a replacement session");
    for session in [&first, &logged] {
        assert_eq!(
            call(
                &router,
                "GET",
                "/v1/me",
                session["token"].as_str(),
                json!({})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(&router, "GET", "/v1/me", other["token"].as_str(), json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "POST",
            "/v1/auth/phone/login",
            None,
            json!({"phone":"13800138000","password":PASSWORD})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, new_session) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":NEW_PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{new_session}");
    assert_eq!(new_session["user"]["id"], first["user"]["id"]);
    assert_eq!(
        call(
            &router,
            "POST",
            "/v1/auth/phone/password/reset",
            None,
            input
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "the reset code must not be reusable"
    );
}

#[tokio::test]
async fn existing_phone_accounts_can_set_a_password_only_after_reset_verification() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let existing = repo
        .create_phone_user("13800138000", "旧账号", "Asia/Shanghai")
        .await
        .unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let id = code(&router, &repo, "13800138000", "reset_password").await;
    let (status, reply) = call(&router, "POST", "/v1/auth/phone/password/reset", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":id,"new_password":NEW_PASSWORD})).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply, json!({"ok":true}));
    let (status, logged) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":NEW_PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{logged}");
    assert_eq!(logged["user"]["id"], existing.id);
}

#[tokio::test]
async fn codes_are_scoped_to_register_or_reset_and_cannot_register_by_resetting() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    let reset_id = code(&router, &repo, "13800138000", "reset_password").await;
    let register_id = code(&router, &repo, "13800138000", "register").await;
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        json!({"phone":"13800138000","code":"123456","challenge_id":reset_id,"password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&router, "POST", "/v1/auth/phone/password/reset", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":register_id,"new_password":NEW_PASSWORD})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&router, "POST", "/v1/auth/phone/password/reset", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":reset_id,"new_password":NEW_PASSWORD})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(repo.phone_user("13800138000").await.unwrap().is_none());
    let (status, registered) = call(&router, "POST", "/v1/auth/phone/register", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":register_id,"password":PASSWORD})).await;
    assert_eq!(status, StatusCode::OK, "{registered}");
    let (status, _) = call(&router, "POST", "/v1/auth/phone/register", None,
        json!({"phone":"13800138000","code":"123456","challenge_id":register_id,"password":PASSWORD})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let sessions: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

#[tokio::test]
async fn registered_phone_conflicts_require_fresh_verified_proof_and_consume_it_once() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:")
            .with_phone_auth(PhoneAuth::local_test()),
    );
    register(&router, &repo, "13800138000").await;
    let mut expected = None;
    for phone in ["13800138000", "13900139000"] {
        let (status, reply) = call(
            &router, "POST", "/v1/auth/phone/register", None,
            json!({"phone":phone,"code":"123456","challenge_id":"a".repeat(64),"password":PASSWORD}),
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
        if let Some(expected) = &expected {
            assert_eq!(
                &reply, expected,
                "unverified requests must not reveal registration status"
            );
        } else {
            expected = Some(reply);
        }
    }
    let id = code(&router, &repo, "13800138000", "register").await;
    let input =
        json!({"phone":"13800138000","code":"123456","challenge_id":id,"password":PASSWORD});
    let (status, reply) = call(
        &router,
        "POST",
        "/v1/auth/phone/register",
        None,
        input.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{reply}");
    assert_eq!(reply["error"]["code"], "conflict");
    let (status, reply) = call(&router, "POST", "/v1/auth/phone/register", None, input).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "verified conflicting proof must be consumed: {reply}"
    );
    assert_eq!(reply["error"]["code"], "validation");
    let sessions: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM sessions")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        sessions, 1,
        "neither duplicate registration nor replay may add sessions"
    );
}

#[tokio::test]
async fn old_login_codes_and_otp_only_login_requests_never_send_sms_or_change_state() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let sender = Arc::new(CountingSms::default());
    let router = app(
        AppState::new(repo.clone(), ModelProvider::local(), "sqlite::memory:").with_phone_auth(
            PhoneAuth::with_sender(
                sender.clone(),
                "test-only-secret-at-least-32-bytes-long".into(),
            )
            .unwrap(),
        ),
    );
    for purpose in ["login", "", "unknown", "ResetPassword"] {
        let (status, reply) = call(
            &router,
            "POST",
            "/v1/auth/phone/code",
            None,
            json!({"phone":"13800138000","purpose":purpose}),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{reply}");
        assert_eq!(reply["error"]["code"], "invalid_request");
    }
    let (status, _) = call(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","code":"123456","challenge_id":"a".repeat(64)}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(sender.0.load(Ordering::SeqCst), 0);
    for table in [
        "phone_sms_attempts",
        "phone_codes",
        "phone_login_attempts",
        "sessions",
        "users",
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT CAST(COUNT(*) AS BIGINT) FROM {table}"))
                .fetch_one(&repo.pool())
                .await
                .unwrap();
        assert_eq!(count, 0, "invalid legacy request changed {table}");
    }
}

#[tokio::test]
async fn password_login_throttling_returns_429_and_a_positive_retry_after() {
    let _password_guard = PASSWORD_TEST_LOCK.lock().await;
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let router = app(AppState::new(
        repo.clone(),
        ModelProvider::local(),
        "sqlite::memory:",
    ));
    for i in 0..10 {
        sqlx::query("INSERT INTO phone_login_attempts(id,phone,requested_at) VALUES($1,$2,$3)")
            .bind(format!("test-attempt-{i}"))
            .bind("+8613800138000")
            .bind(tomorrow_domain::now())
            .execute(&repo.pool())
            .await
            .unwrap();
    }
    let (status, headers, reply) = call_with_headers(
        &router,
        "POST",
        "/v1/auth/phone/login",
        None,
        json!({"phone":"13800138000","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{reply}");
    assert_eq!(reply["error"]["code"], "rate_limited");
    let seconds: i64 = headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=900).contains(&seconds));
    assert!(!reply.to_string().contains("13800138000"));
    let count: i64 =
        sqlx::query_scalar("SELECT CAST(COUNT(*) AS BIGINT) FROM phone_login_attempts")
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(count, 10);
}

#[test]
fn phone_auth_contract_is_public_and_documents_phone_user() {
    let api = serde_json::to_value(tomorrow_api::openapi_document()).unwrap();
    for path in [
        "/v1/auth/phone/code",
        "/v1/auth/phone/register",
        "/v1/auth/phone/login",
        "/v1/auth/phone/password/reset",
    ] {
        assert!(api["paths"][path]["post"].is_object());
        assert!(api["paths"][path]["post"].get("security").is_none());
    }
    assert!(api["components"]["schemas"]["User"]["properties"]["phone"].is_object());
    let schemas = &api["components"]["schemas"];
    assert_eq!(
        schemas["PhonePurpose"]["enum"],
        json!(["register", "reset_password"])
    );
    for (schema, required) in [
        ("PhoneRegisterInput", "password"),
        ("PhoneLoginInput", "password"),
        ("PhonePasswordResetInput", "new_password"),
    ] {
        assert!(schemas[schema]["required"]
            .as_array()
            .unwrap()
            .contains(&json!(required)));
        assert_eq!(schemas[schema]["properties"][required]["minLength"], 8);
        assert_eq!(schemas[schema]["properties"][required]["maxLength"], 128);
        assert_eq!(schemas[schema]["properties"][required]["writeOnly"], true);
    }
    let login = &schemas["PhoneLoginInput"]["properties"];
    assert!(login.get("code").is_none());
    assert!(login.get("challenge_id").is_none());
}
