use serde_json::{json, Value};
use tomorrow_domain::{usage::*, Repository};

fn at(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp()
}
async fn setup() -> (Repository, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user(
            "pricing-recovery@test.local",
            "unused",
            "Test",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    (repo, user.id)
}
fn identity() -> UsageIdentity {
    UsageIdentity::new(
        "https://api.deepseek.com",
        "deepseek-flash",
        "flash",
        "DeepSeek",
    )
}
fn usage() -> UsageMeasurements {
    UsageMeasurements {
        input_tokens: Some(1000),
        output_tokens: Some(100),
        cache_read_tokens: Some(0),
        cache_write_tokens: Some(0),
        ..Default::default()
    }
}
async fn record(repo: &Repository, user: &str, id: &str, time: &str) {
    let mut request = UsageDispatch::new(id, identity(), "llm", "chat");
    request.dispatched_at = Some(at(time));
    repo.usage_dispatch(user, request).await.unwrap();
    repo.usage_finish(user, id, UsageOutcome::new("succeeded", usage()))
        .await
        .unwrap();
}
async fn raw(repo: &Repository, user: &str, id: &str) -> String {
    sqlx::query_scalar("SELECT price_json FROM usage_requests WHERE user_id=$1 AND request_id=$2")
        .bind(user)
        .bind(id)
        .fetch_one(&repo.pool())
        .await
        .unwrap()
}

#[tokio::test]
async fn presets_are_automatic_manual_zero_wins_and_snapshot_survives_changes() {
    let (repo, user) = setup().await;
    record(&repo, &user, "offpeak", "2026-11-03T00:40:00+08:00").await;
    record(&repo, &user, "peak", "2026-11-03T10:40:00+08:00").await;
    let previous = raw(&repo, &user, "offpeak").await;
    let off: Value = serde_json::from_str(&previous).unwrap();
    let peak: Value = serde_json::from_str(&raw(&repo, &user, "peak").await).unwrap();
    assert_eq!(off["input_cny_micros_per_million"], 1_000_000);
    assert_eq!(peak["input_cny_micros_per_million"], 2_000_000);
    let custom = json!({"version":"free-private-contract","models":{identity().model_key:{
        "input_cny_micros_per_million":0,"output_cny_micros_per_million":0,
        "cache_read_cny_micros_per_million":0,"cache_write_cny_micros_per_million":0}}});
    repo.set_usage_pricebook(&custom.to_string()).await.unwrap();
    record(&repo, &user, "custom", "2026-11-03T10:41:00+08:00").await;
    let saved: Value = serde_json::from_str(&raw(&repo, &user, "custom").await).unwrap();
    assert_eq!(saved["input_cny_micros_per_million"], 0);
    assert_eq!(previous, raw(&repo, &user, "offpeak").await);
}

#[tokio::test]
async fn missing_prices_recover_idempotently_without_rewriting_existing_or_unknown_deployments() {
    let (repo, user) = setup().await;
    record(&repo, &user, "keep", "2026-11-03T00:40:00+08:00").await;
    record(&repo, &user, "missing", "2026-11-03T10:40:00+08:00").await;
    let original = raw(&repo, &user, "keep").await;
    sqlx::query(
        "UPDATE usage_requests SET price_json='null' WHERE user_id=$1 AND request_id='missing'",
    )
    .bind(&user)
    .execute(&repo.pool())
    .await
    .unwrap();
    let proxy = UsageIdentity::new(
        "https://proxy.invalid/v1",
        "deepseek-flash",
        "flash",
        "Proxy",
    );
    repo.usage_dispatch(&user, UsageDispatch::new("proxy", proxy, "llm", "chat"))
        .await
        .unwrap();
    let result = repo.backfill_missing_usage_prices(0, None).await.unwrap();
    assert_eq!(result.updated, 1);
    assert_eq!(result.skipped, 1);
    assert!(result.next_cursor.is_none());
    assert_eq!(original, raw(&repo, &user, "keep").await);
    let restored: Value = serde_json::from_str(&raw(&repo, &user, "missing").await).unwrap();
    assert!(restored["version"]
        .as_str()
        .unwrap()
        .starts_with("reconstructed-reference-2026-11-03"));
    assert_eq!(restored["input_cny_micros_per_million"], 2_000_000);
    assert_eq!(
        repo.backfill_missing_usage_prices(0, None)
            .await
            .unwrap()
            .updated,
        0
    );
    repo.set_usage_pricebook("").await.unwrap();
    assert!(repo.backfill_missing_usage_prices(0, None).await.is_err());
}

#[tokio::test]
async fn report_explains_missing_measurements_and_marks_reconstructed_estimates() {
    let (repo, user) = setup().await;
    record(&repo, &user, "missing-price", "2026-11-03T00:40:00+08:00").await;
    sqlx::query("UPDATE usage_requests SET price_json='null' WHERE user_id=$1")
        .bind(&user)
        .execute(&repo.pool())
        .await
        .unwrap();
    let query = || UsageQuery {
        period: Some("custom".into()),
        start: Some("2026-11-03".into()),
        end: Some("2026-11-03".into()),
    };
    let report = repo.usage_report(&user, query()).await.unwrap();
    assert_eq!(report.totals.missing_price_call_count, 1);
    assert_eq!(report.totals.missing_measurement_call_count, 0);
    repo.backfill_missing_usage_prices(0, None).await.unwrap();
    let report = repo.usage_report(&user, query()).await.unwrap();
    assert_eq!(report.totals.reconstructed_cost_call_count, 1);
    assert_eq!(report.totals.known_cost_cny_micros, 1400);
    assert_eq!(report.totals.unknown_cost_call_count, 0);
}

#[tokio::test]
async fn unfinished_requests_stay_missing_until_the_usage_arrives() {
    let (repo, user) = setup().await;
    let mut dispatch = UsageDispatch::new("unfinished", identity(), "llm", "chat");
    dispatch.dispatched_at = Some(at("2026-11-03T00:40:00+08:00"));
    repo.usage_dispatch(&user, dispatch).await.unwrap();
    sqlx::query("UPDATE usage_requests SET price_json='null' WHERE user_id=$1")
        .bind(&user)
        .execute(&repo.pool())
        .await
        .unwrap();
    let first = repo.backfill_missing_usage_prices(0, None).await.unwrap();
    assert_eq!((first.updated, first.skipped), (0, 1));
    assert_eq!(raw(&repo, &user, "unfinished").await, "null");
    repo.usage_finish(&user, "unfinished", UsageOutcome::new("succeeded", usage()))
        .await
        .unwrap();
    assert_eq!(
        repo.backfill_missing_usage_prices(0, None)
            .await
            .unwrap()
            .updated,
        1
    );
}

#[tokio::test]
async fn backfill_resumes_after_unpriceable_rows_instead_of_repeating_the_first_page() {
    let (repo, user) = setup().await;
    let proxy = UsageIdentity::new(
        "https://unknown.invalid/v1",
        "unknown",
        "unknown",
        "Unknown",
    );
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<501) INSERT INTO usage_requests(user_id,request_id,dispatched_at,identity_json,capability,purpose,price_json,outcome_json) SELECT $1,printf('r%04d',x),$2,$3,'llm','chat','null','' FROM n")
        .bind(&user).bind(at("2026-11-03T00:40:00+08:00")).bind(serde_json::to_string(&proxy).unwrap())
        .execute(&repo.pool()).await.unwrap();
    let first = repo.backfill_missing_usage_prices(0, None).await.unwrap();
    assert_eq!((first.scanned, first.updated, first.skipped), (500, 0, 500));
    assert!(first.next_cursor.is_some());
    let last = repo
        .backfill_missing_usage_prices(0, first.next_cursor)
        .await
        .unwrap();
    assert_eq!((last.scanned, last.updated, last.skipped), (1, 0, 1));
    assert!(last.next_cursor.is_none());
}
