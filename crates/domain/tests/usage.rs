use serde_json::json;
use tomorrow_domain::{new_id, usage::*, DomainError, Repository};

fn ts(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp()
}
async fn owner(repo: &Repository) -> String {
    repo.create_user(
        &format!("usage-{}@test.local", new_id()),
        "unused",
        "用量测试",
        "Asia/Shanghai",
    )
    .await
    .unwrap()
    .id
}
async fn recording_start(repo: &Repository, value: &str) {
    sqlx::query("UPDATE usage_recording SET recording_start=$1 WHERE id=1")
        .bind(ts(value))
        .execute(&repo.pool())
        .await
        .unwrap();
}
fn identity() -> UsageIdentity {
    UsageIdentity::new(
        "https://provider.test/v1/",
        "fixture-model",
        "测试模型",
        "测试服务",
    )
}
fn token_measurements() -> UsageMeasurements {
    UsageMeasurements {
        input_tokens: Some(1200),
        output_tokens: Some(100),
        cache_read_tokens: Some(400),
        cache_write_tokens: Some(0),
        ..Default::default()
    }
}
fn request(id: &str, time: &str) -> UsageDispatch {
    let mut dispatch = UsageDispatch::new(id, identity(), "llm", "chat");
    dispatch.dispatched_at = Some(ts(time));
    dispatch
}
fn book(rate: i64) -> String {
    json!({"version":format!("version-{rate}"),"models":{identity().model_key:{
        "input_cny_micros_per_million":rate,"output_cny_micros_per_million":10_000_000,
        "cache_read_cny_micros_per_million":200_000,"cache_write_cny_micros_per_million":2_000_000
    }}})
    .to_string()
}
fn month() -> UsageQuery {
    UsageQuery {
        period: Some("month".into()),
        ..Default::default()
    }
}

async fn request_ledger_contract(repo: Repository) {
    let first = owner(&repo).await;
    let second = owner(&repo).await;
    recording_start(&repo, "2026-11-02T02:00:00Z").await;
    repo.set_usage_pricebook(&book(2_000_000)).await.unwrap();
    let dispatched = request("same-physical-attempt", "2026-11-02T03:00:00Z");
    repo.usage_dispatch(&first, dispatched.clone())
        .await
        .unwrap();
    // Replay must preserve dispatch price/time instead of following current configuration.
    repo.set_usage_pricebook(&book(900_000_000)).await.unwrap();
    repo.usage_dispatch(&first, dispatched).await.unwrap();
    let result = UsageOutcome::new("succeeded", token_measurements());
    repo.usage_finish(&first, "same-physical-attempt", result.clone())
        .await
        .unwrap();
    repo.usage_finish(&first, "same-physical-attempt", result)
        .await
        .unwrap();
    assert!(matches!(
        repo.usage_finish(
            &second,
            "same-physical-attempt",
            UsageOutcome::new("succeeded", token_measurements())
        )
        .await,
        Err(DomainError::NotFound)
    ));
    let mut conflicting = token_measurements();
    conflicting.input_tokens = Some(9999);
    assert!(matches!(
        repo.usage_finish(
            &first,
            "same-physical-attempt",
            UsageOutcome::new("succeeded", conflicting)
        )
        .await,
        Err(DomainError::Conflict(_))
    ));
    // A real retry remains counted when it times out without measurements.
    repo.usage_dispatch(
        &first,
        request("real-network-retry", "2026-11-02T03:01:00Z"),
    )
    .await
    .unwrap();
    repo.usage_finish(
        &first,
        "real-network-retry",
        UsageOutcome::new("timeout", Default::default()),
    )
    .await
    .unwrap();
    let report = repo
        .usage_report_at(&first, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.call_count, 2);
    assert_eq!(report.totals.input_tokens, Some(1200)); // cache already included
    assert_eq!(report.totals.output_tokens, Some(100));
    assert_eq!(report.totals.cache_read_tokens, Some(400));
    assert_eq!(report.totals.known_cost_cny_micros, 2680);
    assert_eq!(report.totals.estimated_cost_cny_micros, None);
    assert_eq!(report.totals.unknown_cost_call_count, 1);
    assert_eq!(report.totals.cost_status, "partial");
    assert_eq!(report.totals.usage_status, "partial");
    assert_eq!(report.history_status, "partial");
    assert_eq!(report.cells.len(), 1);
    assert_eq!(report.cells[0].metrics.call_count, 2);
    let other = repo
        .usage_report_at(&second, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(other.totals.call_count, 0);
    assert_eq!(other.totals.input_tokens, Some(0));
    assert_eq!(other.totals.audio_ms, None);
    assert_eq!(other.totals.estimated_cost_cny_micros, Some(0));
    assert_eq!(other.totals.usage_status, "complete");
    assert!(other.cells.is_empty());
    // Completing the retry later enriches the original row; cancellation cannot erase usage.
    repo.usage_finish(
        &first,
        "real-network-retry",
        UsageOutcome::new("cancelled", token_measurements()),
    )
    .await
    .unwrap();
    let completed = repo
        .usage_report_at(&first, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(completed.totals.call_count, 2);
    assert_eq!(completed.totals.usage_status, "complete");
    assert_eq!(completed.totals.cost_status, "complete");
}

#[tokio::test]
async fn durable_dispatch_replay_failure_cost_snapshot_and_owner_isolation() {
    request_ledger_contract(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn postgres_request_ledger_contract_when_explicitly_configured() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    assert!(
        url.starts_with("postgres"),
        "Use only an explicitly disposable PostgreSQL database"
    );
    request_ledger_contract(Repository::connect(&url).await.unwrap()).await;
}

#[tokio::test]
async fn shanghai_inclusive_dates_rolling_seven_days_and_strict_validation() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = owner(&repo).await;
    recording_start(&repo, "2026-12-14T16:00:00Z").await;
    let at = ts("2027-01-02T10:00:00Z");
    for (id, time) in [
        ("before-seven", "2026-12-26T15:59:59Z"),
        ("seven-first", "2026-12-26T16:00:00Z"),
        ("today-first", "2027-01-01T16:00:00Z"),
        ("today-last", "2027-01-02T15:59:59Z"),
        ("tomorrow-first", "2027-01-02T16:00:00Z"),
    ] {
        repo.usage_dispatch(&user, request(id, time)).await.unwrap();
    }
    let week = repo
        .usage_report_at(
            &user,
            UsageQuery {
                period: Some("week".into()),
                ..Default::default()
            },
            at,
        )
        .await
        .unwrap();
    assert_eq!(
        (week.start_date.as_str(), week.end_date.as_str()),
        ("2026-12-27", "2027-01-02")
    );
    assert_eq!(week.totals.call_count, 3);
    let custom = UsageQuery {
        period: Some("custom".into()),
        start: Some("2027-01-02".into()),
        end: Some("2027-01-02".into()),
    };
    let today = repo
        .usage_report_at(&user, custom.clone(), at)
        .await
        .unwrap();
    assert_eq!(today.totals.call_count, 2);
    let all = repo
        .usage_report_at(
            &user,
            UsageQuery {
                period: Some("all".into()),
                ..Default::default()
            },
            at,
        )
        .await
        .unwrap();
    assert_eq!(all.start_date, "2026-12-15");
    assert_eq!(all.history_status, "complete");
    for query in [
        UsageQuery {
            start: Some("2027-01-03".into()),
            ..custom.clone()
        },
        UsageQuery {
            end: Some("2027-01-03".into()),
            ..custom.clone()
        },
        UsageQuery {
            start: Some("2026-12-14".into()),
            ..custom.clone()
        },
        UsageQuery {
            start: Some("2027-02-30".into()),
            ..custom.clone()
        },
        UsageQuery {
            start: Some("2027-1-02".into()),
            ..custom.clone()
        },
        UsageQuery {
            end: None,
            ..custom.clone()
        },
        UsageQuery {
            period: Some("month".into()),
            ..custom.clone()
        },
        UsageQuery {
            period: Some("nonsense".into()),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            repo.usage_report_at(&user, query, at).await,
            Err(DomainError::Validation(_))
        ));
    }
}

#[tokio::test]
async fn recorded_start_and_reminder_preferences_persist_without_activity() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}", directory.path().join("ledger.db").display());
    let repo = Repository::connect(&url).await.unwrap();
    let user = owner(&repo).await;
    recording_start(&repo, "2026-11-02T02:00:00Z").await;
    repo.update_usage_reminder(
        &user,
        UpdateUsageReminder {
            enabled: false,
            threshold_cny_micros: 5_000_000,
        },
    )
    .await
    .unwrap();
    let before = repo
        .usage_report_at(&user, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    drop(repo);
    let repo = Repository::connect(&url).await.unwrap();
    let after = repo
        .usage_report_at(&user, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(before.recording_start, after.recording_start);
    assert_eq!(after.totals.call_count, 0);
    assert!(!after.monthly_reminder.enabled);
    assert_eq!(after.monthly_reminder.threshold_cny_micros, 5_000_000);
}

#[tokio::test]
async fn monthly_reminder_equality_partial_cost_disable_and_local_month_reset() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = owner(&repo).await;
    let other = owner(&repo).await;
    recording_start(&repo, "2026-11-01T00:00:00Z").await;
    let mut paid = request("priced-per-request", "2026-11-02T03:00:00Z");
    paid.price = Some(UsagePrice {
        version: "fixture".into(),
        rates: UsageRates {
            request_cny_micros_each: Some(5_000_000),
            ..Default::default()
        },
    });
    repo.usage_dispatch(&user, paid).await.unwrap();
    repo.usage_dispatch(&user, request("unpriced", "2026-11-02T03:00:00Z"))
        .await
        .unwrap();
    repo.update_usage_reminder(
        &user,
        UpdateUsageReminder {
            enabled: true,
            threshold_cny_micros: 5_000_000,
        },
    )
    .await
    .unwrap();
    let current = ts("2026-11-02T08:00:00Z");
    let progress = repo.usage_reminder_at(&user, current).await.unwrap();
    assert!(progress.reached);
    assert_eq!(progress.cost_status, "partial");
    assert_eq!(progress.known_cost_cny_micros, 5_000_000);
    assert_eq!(
        progress.notice_key,
        repo.usage_reminder_at(&user, current)
            .await
            .unwrap()
            .notice_key
    );
    assert!(
        !repo
            .usage_reminder_at(&other, current)
            .await
            .unwrap()
            .reached
    );
    let december = repo
        .usage_reminder_at(&user, ts("2026-11-30T16:00:00Z"))
        .await
        .unwrap();
    assert_eq!(december.month, "2026-12");
    assert!(!december.reached);
    assert_eq!(december.notice_key, None);
    repo.update_usage_reminder(
        &user,
        UpdateUsageReminder {
            enabled: false,
            threshold_cny_micros: 5_000_000,
        },
    )
    .await
    .unwrap();
    assert!(
        !repo
            .usage_reminder_at(&user, current)
            .await
            .unwrap()
            .reached
    );
    assert!(repo
        .update_usage_reminder(
            &user,
            UpdateUsageReminder {
                enabled: true,
                threshold_cny_micros: 1
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn absence_zero_missing_cache_rounding_and_unsafe_values_stay_distinct() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = owner(&repo).await;
    recording_start(&repo, "2026-11-01T00:00:00Z").await;
    let mut zero = request("explicit-zero", "2026-11-02T03:00:00Z");
    zero.price = Some(UsagePrice {
        version: "zero".into(),
        rates: UsageRates {
            request_cny_micros_each: Some(0),
            ..Default::default()
        },
    });
    repo.usage_dispatch(&user, zero).await.unwrap();
    let mut small = request("one-rounding-per-request", "2026-11-02T03:00:00Z");
    small.price = Some(UsagePrice {
        version: "micro".into(),
        rates: UsageRates {
            input_cny_micros_per_million: Some(400_000),
            output_cny_micros_per_million: Some(400_000),
            ..Default::default()
        },
    });
    repo.usage_dispatch(&user, small).await.unwrap();
    let measured = UsageMeasurements {
        input_tokens: Some(1),
        output_tokens: Some(1),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        ..Default::default()
    };
    repo.usage_finish(
        &user,
        "one-rounding-per-request",
        UsageOutcome::new("succeeded", measured),
    )
    .await
    .unwrap();
    let mut unsafe_usage = token_measurements();
    unsafe_usage.input_tokens = Some(MAX_SAFE_INTEGER + 1);
    assert!(repo
        .usage_finish(
            &user,
            "explicit-zero",
            UsageOutcome::new("succeeded", unsafe_usage)
        )
        .await
        .is_err());
    let mut impossible_cache = token_measurements();
    impossible_cache.input_tokens = Some(1);
    assert!(repo
        .usage_finish(
            &user,
            "explicit-zero",
            UsageOutcome::new("failed", impossible_cache)
        )
        .await
        .is_err());
    let report = repo
        .usage_report_at(&user, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.known_cost_cny_micros, 1); // .4 + .4, round once
    assert_eq!(report.totals.unknown_cost_call_count, 0); // explicit request price needs no token measurement
    let price = UsagePrice {
        version: "missing-cache-price".into(),
        rates: UsageRates {
            input_cny_micros_per_million: Some(2_000_000),
            output_cny_micros_per_million: Some(10_000_000),
            ..Default::default()
        },
    };
    let mut cached = request("cache-price-unknown", "2026-11-02T03:00:00Z");
    cached.price = Some(price);
    repo.usage_dispatch(&user, cached).await.unwrap();
    repo.usage_finish(
        &user,
        "cache-price-unknown",
        UsageOutcome::new("succeeded", token_measurements()),
    )
    .await
    .unwrap();
    let report = repo
        .usage_report_at(&user, month(), ts("2026-11-02T08:00:00Z"))
        .await
        .unwrap();
    assert_eq!(report.totals.known_cost_cny_micros, 1);
    assert_eq!(report.totals.unknown_cost_call_count, 1);
}

#[tokio::test]
async fn provider_deployments_and_pricebook_revisions_do_not_merge_or_overwrite() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let (revision, raw) = repo.get_usage_pricebook().await.unwrap();
    assert_eq!(revision, 0);
    assert_eq!(
        raw,
        std::env::var("USAGE_PRICING_JSON")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_default()
    );
    assert_eq!(
        repo.compare_set_usage_pricebook(revision, &book(1))
            .await
            .unwrap(),
        1
    );
    assert!(matches!(
        repo.compare_set_usage_pricebook(revision, &book(2)).await,
        Err(DomainError::Conflict(_))
    ));
    assert_eq!(repo.get_usage_pricebook().await.unwrap().1, book(1));
    assert_ne!(
        model_key("https://first.test/v1", "same"),
        model_key("https://second.test/v1", "same")
    );
    assert_ne!(
        model_key("https://gateway.test/v1?deployment=first", "same"),
        model_key("https://gateway.test/v1?deployment=second", "same")
    );
    assert_eq!(
        model_key(" https://provider.test/v1/ ", "same"),
        model_key(
            "https://provider.test/v1/chat/completions?api_key=secret",
            "same"
        )
    );
    let private = UsageIdentity::new(
        "https://user:secret@provider.test/v1?key=secret",
        "same",
        "same",
        "https://user:secret@provider.test",
    );
    assert!(!serde_json::to_string(&private).unwrap().contains("secret"));
    assert!(validate_pricebook_json(&json!({"version":"bad","models":{"raw-provider/model":{"input_cny_micros_per_million":1}}}).to_string()).is_err());
    assert!(validate_pricebook_json(&book(-1)).is_err());
    assert!(validate_pricebook_json(&book(MAX_SAFE_INTEGER + 1)).is_err());
}
