//! Independent acceptance fixtures: no model, network, SMS, or real provider calls.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use chrono::DateTime;
use serde_json::{json, Value};
use tomorrow_api::{app, AppState};
use tomorrow_domain::usage::{
    UpdateUsageReminder, UsageDispatch, UsageIdentity, UsageMeasurements, UsageOutcome, UsagePrice,
    UsageQuery, UsageRates, MAX_SAFE_INTEGER,
};
use tomorrow_domain::{ModelProvider, Repository};
use tower::ServiceExt;

fn at(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value).unwrap().timestamp()
}
fn query(period: &str) -> UsageQuery {
    UsageQuery {
        period: Some(period.into()),
        ..Default::default()
    }
}
fn custom(start: &str, end: &str) -> UsageQuery {
    UsageQuery {
        period: Some("custom".into()),
        start: Some(start.into()),
        end: Some(end.into()),
    }
}
fn identity(deployment: &str) -> UsageIdentity {
    UsageIdentity::new(
        deployment,
        "same-model",
        "Fixture Model",
        "Fixture Provider",
    )
}
fn measured() -> UsageMeasurements {
    UsageMeasurements {
        input_tokens: Some(1000),
        output_tokens: Some(100),
        cache_read_tokens: Some(400),
        cache_write_tokens: Some(100),
        ..Default::default()
    }
}
fn request_price(micros: i64) -> UsagePrice {
    UsagePrice {
        version: "independent-v1".into(),
        rates: UsageRates {
            request_cny_micros_each: Some(micros),
            ..Default::default()
        },
    }
}

struct Fixture {
    repo: Repository,
    user: String,
    other: String,
    token: String,
    other_token: String,
}
impl Fixture {
    async fn new() -> Self {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo
            .create_user(
                "usage-independent-a@example.test",
                "unused",
                "A",
                "America/Los_Angeles",
            )
            .await
            .unwrap();
        let other = repo
            .create_user("usage-independent-b@example.test", "unused", "B", "UTC")
            .await
            .unwrap();
        let token = repo.create_session(&user.id).await.unwrap();
        let other_token = repo.create_session(&other.id).await.unwrap();
        sqlx::query("UPDATE usage_recording SET recording_start=$1 WHERE id=1")
            .bind(at("2026-10-01T02:00:00Z"))
            .execute(&repo.pool())
            .await
            .unwrap();
        Self {
            repo,
            user: user.id,
            other: other.id,
            token,
            other_token,
        }
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value, String) {
        let mut request = Request::builder().method(method).uri(path);
        if !token.is_empty() {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = app(AppState::new(
            self.repo.clone(),
            ModelProvider::local(),
            "sqlite::memory:",
        ))
        .oneshot(request)
        .await
        .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        let raw = String::from_utf8(
            to_bytes(response.into_body(), 1_000_000)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let body = serde_json::from_str(&raw).unwrap_or(Value::Null);
        (status, body, raw)
    }
    async fn dispatch(&self, owner: &str, id: &str, time: &str, price: Option<UsagePrice>) {
        let mut dispatch = UsageDispatch::new(
            id,
            identity("https://fixture-a.example.test/v1"),
            "llm",
            "chat",
        );
        dispatch.dispatched_at = Some(at(time));
        dispatch.price = price;
        self.repo.usage_dispatch(owner, dispatch).await.unwrap();
    }
    async fn finish(&self, owner: &str, id: &str, status: &str) {
        self.repo
            .usage_finish(owner, id, UsageOutcome::new(status, measured()))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn routes_require_sessions_and_never_accept_a_requested_owner() {
    let f = Fixture::new().await;
    for token in ["", "invalid-session"] {
        for (method, path, body) in [
            ("GET", "/v1/usage", None),
            ("GET", "/v1/usage/reminder", None),
            (
                "PATCH",
                "/v1/usage/reminder",
                Some(json!({"enabled":false,"threshold_cny_micros":5_000_000})),
            ),
        ] {
            assert_eq!(
                f.call(method, path, token, body).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
    }
    f.dispatch(
        &f.user,
        "private-a",
        "2026-10-05T00:00:00Z",
        Some(request_price(321)),
    )
    .await;
    f.finish(&f.user, "private-a", "succeeded").await;
    f.dispatch(
        &f.other,
        "private-b",
        "2026-10-05T00:00:00Z",
        Some(request_price(654)),
    )
    .await;
    f.finish(&f.other, "private-b", "succeeded").await;
    let a = f.call("GET", "/v1/usage?period=all", &f.token, None).await;
    let b = f
        .call("GET", "/v1/usage?period=all", &f.other_token, None)
        .await;
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["totals"]["known_cost_cny_micros"], 321);
    assert_eq!(b.1["totals"]["known_cost_cny_micros"], 654);
    let injection = f
        .call(
            "GET",
            &format!("/v1/usage?period=all&user_id={}", f.other),
            &f.token,
            None,
        )
        .await;
    assert_eq!(injection.0, StatusCode::BAD_REQUEST);
    for raw in [a.2, b.2] {
        for secret in [
            &f.token,
            &f.other_token,
            &f.user,
            &f.other,
            "private-a",
            "private-b",
            "fixture-a.example.test",
        ] {
            assert!(
                !raw.contains(secret),
                "private ledger data appeared in report"
            );
        }
    }
}

#[tokio::test]
async fn http_rejects_invalid_dates_overrides_and_reminder_amounts() {
    let f = Fixture::new().await;
    for path in [
        "/v1/usage?period=custom",
        "/v1/usage?period=custom&start=2026-10-02",
        "/v1/usage?period=custom&start=2026-10-03&end=2026-10-02",
        "/v1/usage?period=custom&start=2026-02-30&end=2026-10-02",
        "/v1/usage?period=custom&start=2026-10-2&end=2026-10-03",
        "/v1/usage?period=custom&start=2026-09-30&end=2026-10-02",
        "/v1/usage?period=custom&start=2026-10-01&end=9999-12-31",
        "/v1/usage?period=week&start=2026-10-01&end=2026-10-02",
        "/v1/usage?period=invalid",
    ] {
        assert_eq!(
            f.call("GET", path, &f.token, None).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    for amount in [0, -1, 7_000_000, MAX_SAFE_INTEGER + 1] {
        assert_eq!(
            f.call(
                "PATCH",
                "/v1/usage/reminder",
                &f.token,
                Some(json!({"enabled":true,"threshold_cny_micros":amount}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn shanghai_custom_dates_include_both_midnights_and_exclude_next_day() {
    let f = Fixture::new().await;
    for (id, timestamp) in [
        ("before", "2026-11-01T15:59:59Z"),
        ("start", "2026-11-01T16:00:00Z"),
        ("end", "2026-11-02T15:59:59Z"),
        ("after", "2026-11-02T16:00:00Z"),
    ] {
        f.dispatch(&f.user, id, timestamp, Some(request_price(1)))
            .await;
        f.finish(&f.user, id, "succeeded").await;
    }
    let report = f
        .repo
        .usage_report_at(
            &f.user,
            custom("2026-11-02", "2026-11-02"),
            at("2026-11-03T02:00:00Z"),
        )
        .await
        .unwrap();
    assert_eq!(report.timezone, "Asia/Shanghai");
    assert_eq!(report.totals.call_count, 2);
    assert_eq!(report.totals.known_cost_cny_micros, 2);
    assert_eq!(report.start_date, "2026-11-02");
    assert_eq!(report.end_date, "2026-11-02");
}

#[tokio::test]
async fn week_is_rolling_seven_dates_across_year_and_coverage_is_not_first_call() {
    let f = Fixture::new().await;
    f.dispatch(&f.user, "week-before", "2026-12-26T15:59:59Z", None)
        .await;
    f.dispatch(&f.user, "week-start", "2026-12-26T16:00:00Z", None)
        .await;
    let report = f
        .repo
        .usage_report_at(&f.user, query("week"), at("2027-01-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(
        (report.start_date.as_str(), report.end_date.as_str()),
        ("2026-12-27", "2027-01-02")
    );
    assert_eq!(report.totals.call_count, 1);
    let all = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2027-01-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(all.start_date, "2026-10-01");
    assert_eq!(all.recording_start, "2026-10-01T02:00:00+00:00");
    assert_eq!(all.history_status, "partial");
    let empty = f
        .repo
        .usage_report_at(&f.other, query("month"), at("2026-10-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(empty.history_status, "partial");
    assert_eq!(empty.totals.call_count, 0);
    assert_eq!(empty.totals.input_tokens, Some(0));
    assert_eq!(empty.totals.estimated_cost_cny_micros, Some(0));
    assert!(empty.cells.is_empty());
}

#[tokio::test]
async fn prices_snapshot_at_dispatch_and_cached_input_is_only_billed_once() {
    let f = Fixture::new().await;
    let model = identity("https://fixture-a.example.test/v1");
    let book = |version: &str, rate: i64| {
        json!({"version":version,"models":{(model.model_key.clone()):{
        "input_cny_micros_per_million":rate,"output_cny_micros_per_million":2_000_000,
        "cache_read_cny_micros_per_million":500_000,"cache_write_cny_micros_per_million":750_000}}})
        .to_string()
    };
    f.repo
        .set_usage_pricebook(&book("before", 1_000_000))
        .await
        .unwrap();
    f.dispatch(&f.user, "snapshot", "2026-11-02T00:00:00Z", None)
        .await;
    f.repo
        .set_usage_pricebook(&book("after", 9_000_000))
        .await
        .unwrap();
    f.finish(&f.user, "snapshot", "failed").await;
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    // (1000 - 400 - 100) + 100*2 + 400*.5 + 100*.75 = 975 micros.
    assert_eq!(report.totals.input_tokens, Some(1000));
    assert_eq!(report.totals.cache_read_tokens, Some(400));
    assert_eq!(report.totals.estimated_cost_cny_micros, Some(975));
}

#[tokio::test]
async fn unknown_price_explicit_free_and_submicro_rounding_stay_distinct() {
    let f = Fixture::new().await;
    f.dispatch(&f.user, "missing-price", "2026-11-02T00:00:00Z", None)
        .await;
    f.finish(&f.user, "missing-price", "succeeded").await;
    f.dispatch(
        &f.user,
        "explicit-free",
        "2026-11-02T00:00:00Z",
        Some(request_price(0)),
    )
    .await;
    f.finish(&f.user, "explicit-free", "succeeded").await;
    let mut dispatch = UsageDispatch::new(
        "round-once",
        identity("https://rounding.example.test/v1"),
        "llm",
        "brief",
    );
    dispatch.dispatched_at = Some(at("2026-11-02T00:00:00Z"));
    dispatch.price = Some(UsagePrice {
        version: "round".into(),
        rates: UsageRates {
            input_cny_micros_per_million: Some(500_000),
            output_cny_micros_per_million: Some(500_000),
            ..Default::default()
        },
    });
    f.repo.usage_dispatch(&f.user, dispatch).await.unwrap();
    f.repo
        .usage_finish(
            &f.user,
            "round-once",
            UsageOutcome::new(
                "succeeded",
                UsageMeasurements {
                    input_tokens: Some(1),
                    output_tokens: Some(1),
                    cache_read_tokens: Some(0),
                    cache_write_tokens: Some(0),
                    ..Default::default()
                },
            ),
        )
        .await
        .unwrap();
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.known_cost_cny_micros, 1);
    assert_eq!(report.totals.unknown_cost_call_count, 1);
    assert_eq!(report.totals.cost_status, "partial");
    assert_eq!(report.totals.estimated_cost_cny_micros, None);
    assert_eq!(report.totals.usage_status, "complete");
}

#[tokio::test]
async fn dispatch_replay_is_idempotent_retry_is_distinct_and_cancel_keeps_measurements() {
    let f = Fixture::new().await;
    for id in [
        "physical-attempt-1",
        "physical-attempt-1",
        "physical-attempt-2",
        "dispatch-then-crash",
    ] {
        f.dispatch(&f.user, id, "2026-11-02T00:00:00Z", Some(request_price(10)))
            .await;
    }
    f.finish(&f.user, "physical-attempt-1", "failed").await;
    f.finish(&f.user, "physical-attempt-1", "failed").await;
    f.finish(&f.user, "physical-attempt-2", "cancelled").await;
    assert!(f
        .repo
        .usage_finish(
            &f.other,
            "physical-attempt-1",
            UsageOutcome::new("succeeded", measured())
        )
        .await
        .is_err());
    let mut conflicting = measured();
    conflicting.input_tokens = Some(2000);
    assert!(f
        .repo
        .usage_finish(
            &f.user,
            "physical-attempt-1",
            UsageOutcome::new("failed", conflicting)
        )
        .await
        .is_err());
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.call_count, 3);
    assert_eq!(report.totals.input_tokens, Some(2000));
    assert_eq!(report.totals.usage_status, "partial");
    // A configured per-request rate remains known even if that attempt's token use is unknown.
    assert_eq!(report.totals.estimated_cost_cny_micros, Some(30));
}

#[tokio::test]
async fn reminder_is_per_owner_and_current_month_even_for_an_old_report() {
    let f = Fixture::new().await;
    f.repo
        .update_usage_reminder(
            &f.user,
            UpdateUsageReminder {
                enabled: true,
                threshold_cny_micros: 5_000_000,
            },
        )
        .await
        .unwrap();
    f.dispatch(
        &f.user,
        "month-known",
        "2026-11-01T16:00:00Z",
        Some(request_price(5_000_000)),
    )
    .await;
    f.finish(&f.user, "month-known", "succeeded").await;
    f.dispatch(&f.user, "month-unknown", "2026-11-01T16:00:01Z", None)
        .await;
    let report = f
        .repo
        .usage_report_at(
            &f.user,
            custom("2026-10-01", "2026-10-02"),
            at("2026-11-02T02:00:00Z"),
        )
        .await
        .unwrap();
    assert_eq!(report.totals.call_count, 0);
    let notice = report.monthly_reminder.notice_key.unwrap();
    assert_eq!(report.monthly_reminder.known_cost_cny_micros, 5_000_000);
    assert_eq!(report.monthly_reminder.cost_status, "partial");
    assert!(report.monthly_reminder.reached);
    assert!(!notice.contains(&f.user));
    assert_eq!(
        f.repo
            .usage_reminder_at(&f.user, at("2026-11-02T12:00:00Z"))
            .await
            .unwrap()
            .notice_key
            .as_deref(),
        Some(notice.as_str())
    );
    let other = f
        .repo
        .usage_reminder_at(&f.other, at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(other.threshold_cny_micros, 20_000_000);
    assert!(!other.reached);
    f.repo
        .update_usage_reminder(
            &f.user,
            UpdateUsageReminder {
                enabled: false,
                threshold_cny_micros: 5_000_000,
            },
        )
        .await
        .unwrap();
    let off = f
        .repo
        .usage_reminder_at(&f.user, at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert!(!off.reached);
    assert!(off.notice_key.is_none());
    assert_eq!(off.threshold_cny_micros, 5_000_000);
    let next = f
        .repo
        .usage_reminder_at(&f.user, at("2026-11-30T16:00:00Z"))
        .await
        .unwrap();
    assert_eq!(next.month, "2026-12");
    assert_eq!(next.known_cost_cny_micros, 0);
    let patch = f
        .call(
            "PATCH",
            "/v1/usage/reminder",
            &f.token,
            Some(json!({"enabled":false,"threshold_cny_micros":10_000_000})),
        )
        .await;
    assert_eq!(patch.0, StatusCode::OK);
    assert_eq!(
        f.call("GET", "/v1/usage/reminder", &f.token, None).await.1["threshold_cny_micros"],
        10_000_000
    );
    assert_eq!(
        f.call("GET", "/v1/usage/reminder", &f.other_token, None)
            .await
            .1["threshold_cny_micros"],
        20_000_000
    );
}

#[tokio::test]
async fn deployment_identity_sanitizes_credentials_and_rejects_conflicting_replay() {
    let f = Fixture::new().await;
    let clean = identity("https://fixture-a.example.test/v1");
    let secret = identity("https://name:never-leak-password@fixture-a.example.test/v1/chat/completions?api_key=never-leak-key#secret");
    assert_eq!(clean.model_key, secret.model_key);
    let other = identity("https://fixture-b.example.test/v1");
    assert_ne!(clean.model_key, other.model_key);
    for (id, model) in [
        ("deployment-a", clean.clone()),
        ("deployment-b", other.clone()),
    ] {
        let mut dispatch = UsageDispatch::new(id, model, "llm", "memory");
        dispatch.dispatched_at = Some(at("2026-11-02T00:00:00Z"));
        f.repo.usage_dispatch(&f.user, dispatch).await.unwrap();
    }
    assert!(f
        .repo
        .usage_dispatch(
            &f.user,
            UsageDispatch::new("deployment-a", other, "llm", "memory")
        )
        .await
        .is_err());
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.cells.len(), 2);
    assert_eq!(report.totals.usage_status, "unknown");
    assert_eq!(report.totals.input_tokens, None);
    assert_eq!(report.totals.cost_status, "unknown");
    let serialized = serde_json::to_string(&report).unwrap();
    for secret in [
        "never-leak-password",
        "never-leak-key",
        "fixture-a.example.test",
        "deployment-a",
    ] {
        assert!(!serialized.contains(secret));
    }
}

#[tokio::test]
async fn invalid_measurements_are_rejected_without_destroying_the_dispatch_row() {
    let f = Fixture::new().await;
    f.dispatch(&f.user, "invalid", "2026-11-02T00:00:00Z", None)
        .await;
    for measurement in [
        UsageMeasurements {
            input_tokens: Some(-1),
            ..Default::default()
        },
        UsageMeasurements {
            input_tokens: Some(MAX_SAFE_INTEGER + 1),
            ..Default::default()
        },
        UsageMeasurements {
            input_tokens: Some(1),
            cache_read_tokens: Some(2),
            ..Default::default()
        },
    ] {
        assert!(f
            .repo
            .usage_finish(
                &f.user,
                "invalid",
                UsageOutcome::new("succeeded", measurement)
            )
            .await
            .is_err());
    }
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.call_count, 1);
    assert_eq!(report.totals.usage_status, "unknown");
    assert_eq!(report.totals.estimated_cost_cny_micros, None);
}

#[tokio::test]
async fn all_four_capabilities_keep_their_units_and_background_purposes() {
    let f = Fixture::new().await;
    let examples = [
        (
            "asr",
            "voice",
            UsageMeasurements {
                audio_ms: Some(90_000),
                ..Default::default()
            },
            UsageRates {
                audio_cny_micros_per_minute: Some(60_000),
                ..Default::default()
            },
            90_000,
        ),
        (
            "embedding",
            "memory",
            UsageMeasurements {
                input_tokens: Some(2000),
                ..Default::default()
            },
            UsageRates {
                input_cny_micros_per_million: Some(1_000_000),
                ..Default::default()
            },
            2000,
        ),
        (
            "vision",
            "gallery",
            UsageMeasurements {
                input_tokens: Some(100),
                output_tokens: Some(20),
                image_count: Some(3),
                ..Default::default()
            },
            UsageRates {
                image_cny_micros_each: Some(1000),
                ..Default::default()
            },
            3000,
        ),
        (
            "llm",
            "todo",
            measured(),
            UsageRates {
                request_cny_micros_each: Some(17),
                ..Default::default()
            },
            17,
        ),
    ];
    for (capability, purpose, measurements, rates, _) in &examples {
        let mut dispatch = UsageDispatch::new(
            format!("unit-{capability}"),
            identity("https://units.example.test/v1"),
            *capability,
            *purpose,
        );
        dispatch.dispatched_at = Some(at("2026-11-02T00:00:00Z"));
        dispatch.price = Some(UsagePrice {
            version: "units".into(),
            rates: rates.clone(),
        });
        f.repo.usage_dispatch(&f.user, dispatch).await.unwrap();
        f.repo
            .usage_finish(
                &f.user,
                &format!("unit-{capability}"),
                UsageOutcome::new("succeeded", measurements.clone()),
            )
            .await
            .unwrap();
    }
    let report = f
        .repo
        .usage_report_at(&f.user, query("all"), at("2026-11-02T02:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.call_count, 4);
    assert_eq!(report.totals.input_tokens, Some(3100));
    assert_eq!(report.totals.output_tokens, Some(120));
    assert_eq!(report.totals.audio_ms, Some(90_000));
    assert_eq!(report.totals.image_count, Some(3));
    assert_eq!(report.totals.usage_status, "complete");
    assert_eq!(report.totals.estimated_cost_cny_micros, Some(95_017));
    for (capability, purpose, _, _, cost) in examples {
        let cell = report
            .cells
            .iter()
            .find(|cell| cell.capability == capability)
            .unwrap();
        assert_eq!(cell.purpose, purpose);
        assert_eq!(cell.metrics.estimated_cost_cny_micros, Some(cost));
    }
}

#[tokio::test]
async fn actual_compatible_provider_does_not_invent_absent_nonzero_cache_measurements() {
    use tomorrow_domain::{model::UsageContext, Message};
    let f = Fixture::new().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let upstream = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(|| async {
            axum::Json(
                json!({"choices":[{"message":{"content":"synthetic response"}}],
            "usage":{"prompt_tokens":100,"completion_tokens":10}}),
            )
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let model = UsageIdentity::new(
        &base,
        "fixture-no-cache-details",
        "fixture-no-cache-details",
        "fixture",
    );
    f.repo
        .set_usage_pricebook(
            &json!({"version":"cache-fixture","models":{(model.model_key):{
        "input_cny_micros_per_million":1_000_000,"output_cny_micros_per_million":1_000_000,
        "cache_read_cny_micros_per_million":500_000,"cache_write_cny_micros_per_million":750_000}}})
            .to_string(),
        )
        .await
        .unwrap();
    let provider = ModelProvider::from_settings(
        base,
        Some("fixture-only-key".into()),
        Some("fixture-no-cache-details".into()),
    )
    .with_usage(UsageContext::new(
        f.repo.clone(),
        &f.user,
        "memory",
        "independent-no-cache-details",
    ));
    let message = Message {
        id: "fixture".into(),
        conversation_id: "fixture".into(),
        role: "user".into(),
        content: "synthetic fixture".into(),
        created_at: String::new(),
        model_mode: None,
        attachments: vec![],
    };
    let answer = provider.complete(&[message]).await;
    server.abort();
    assert!(answer.is_ok());
    let report = f.repo.usage_report(&f.user, query("all")).await.unwrap();
    assert_eq!(report.totals.call_count, 1);
    assert_eq!(report.totals.input_tokens, Some(100));
    assert_eq!(
        report.totals.cache_read_tokens, None,
        "nonzero total input does not establish zero cached input"
    );
    assert_eq!(report.totals.cache_write_tokens, None);
    assert_eq!(report.totals.estimated_cost_cny_micros, None);
    assert_eq!(report.totals.cost_status, "unknown");
}
