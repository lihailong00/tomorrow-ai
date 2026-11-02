//! Durable, owner-scoped accounting for individual upstream request attempts.
//! Record dispatch before sending, then enrich that same request even if its job fails.
use crate::{now, DomainError, Repository};
use chrono::{Datelike, Days, FixedOffset, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{AnyPool, Row};
use std::collections::BTreeMap;

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const DEFAULT_THRESHOLD: i64 = 20_000_000;
const TIMEZONE: &str = "Asia/Shanghai";

pub(crate) async fn initialize(pool: &AnyPool) -> Result<(), DomainError> {
    sqlx::raw_sql(include_str!("../../../migrations/sqlite/015_usage.sql"))
        .execute(pool)
        .await?;
    // Independent of both account creation and the first provider request. Preserve on restart.
    sqlx::query("INSERT INTO usage_recording(id,recording_start,pricebook_json) VALUES(1,$1,'') ON CONFLICT(id) DO NOTHING")
        .bind(now()).execute(pool).await?;
    Ok(())
}

/// Stable nonsecret key. `deployment` should identify the configured endpoint/deployment,
/// excluding API keys. Only this digest, never the deployment string, enters the ledger.
pub fn model_key(deployment: &str, model: &str) -> String {
    let deployment = normalize_deployment(deployment);
    let mut digest = Sha256::new();
    digest.update(b"usage-model-v1");
    for value in [deployment.as_str(), model] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!("usage_{:x}", digest.finalize())
}
/// Accept a configured base URL or its conventional request URL consistently.
/// Credentials cannot become part of a model's identity. Nonsecret deployment
/// parameters remain significant, so two deployments on one gateway do not merge.
pub fn normalize_deployment(value: &str) -> String {
    const SUFFIXES: [&str; 3] = ["/chat/completions", "/embeddings", "/audio/transcriptions"];
    if let Ok(mut url) = reqwest::Url::parse(value.trim()) {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        let mut parameters = url
            .query_pairs()
            .filter(|(name, _)| {
                let name = name.to_ascii_lowercase();
                ![
                    "key",
                    "token",
                    "secret",
                    "password",
                    "authorization",
                    "signature",
                    "sig",
                ]
                .iter()
                .any(|part| name.contains(part))
            })
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        parameters.sort();
        url.set_query(None);
        url.set_fragment(None);
        let mut path = url.path().trim_end_matches('/').to_owned();
        for suffix in SUFFIXES {
            if let Some(base) = path.strip_suffix(suffix) {
                path = base.trim_end_matches('/').to_owned();
                break;
            }
        }
        url.set_path(&path);
        if !parameters.is_empty() {
            url.query_pairs_mut().extend_pairs(parameters);
        }
        return url.to_string().trim_end_matches('/').to_owned();
    }
    let normalized = value.trim().trim_end_matches('/');
    for suffix in SUFFIXES {
        if let Some(base) = normalized.strip_suffix(suffix) {
            return base.trim_end_matches('/').to_owned();
        }
    }
    normalized.to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageIdentity {
    pub model_key: String,
    pub model: String,
    pub model_name: String,
    pub provider: String,
}
impl UsageIdentity {
    pub fn new(deployment: &str, model: &str, model_name: &str, provider: &str) -> Self {
        Self {
            model_key: model_key(deployment, model),
            model: display_value(model, "unknown"),
            model_name: display_value(model_name, "未知模型"),
            provider: display_value(provider, "已配置服务"),
        }
    }
}
fn display_value(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 240
        || value.chars().any(char::is_control)
        || value.contains("://")
        || value.contains('@')
        || value.contains('?')
    {
        fallback.to_owned()
    } else {
        value.to_owned()
    }
}

/// Rates use integer CNY micros per indicated unit; absent is different from explicit zero.
/// `input` is the uncached portion of canonical input. Cache rates are never inferred.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageRates {
    pub input_cny_micros_per_million: Option<i64>,
    pub output_cny_micros_per_million: Option<i64>,
    pub cache_read_cny_micros_per_million: Option<i64>,
    pub cache_write_cny_micros_per_million: Option<i64>,
    pub audio_cny_micros_per_minute: Option<i64>,
    pub image_cny_micros_each: Option<i64>,
    pub request_cny_micros_each: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsagePrice {
    pub version: String,
    #[serde(flatten)]
    pub rates: UsageRates,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pricebook {
    version: String,
    models: BTreeMap<String, UsageRates>,
}

pub fn validate_pricebook_json(value: &str) -> Result<(), DomainError> {
    parse_pricebook(value).map(|_| ())
}
fn parse_pricebook(value: &str) -> Result<Option<Pricebook>, DomainError> {
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.len() > 64 * 1024 {
        return invalid("价格配置最多 64 KiB");
    }
    let parsed: Pricebook = serde_json::from_str(value)
        .map_err(|_| DomainError::Validation("无效的用量价格 JSON".into()))?;
    if parsed.version.trim().is_empty()
        || parsed.version.len() > 80
        || parsed.version.chars().any(char::is_control)
        || parsed.models.len() > 200
    {
        return invalid("价格配置版本或模型数量无效");
    }
    for (key, rates) in &parsed.models {
        if key.len() != 70
            || !key.starts_with("usage_")
            || !key[6..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return invalid("价格配置必须使用服务部署和模型的 usage_ 标识");
        }
        validate_rates(rates)?;
    }
    Ok(Some(parsed))
}
fn validate_rates(rates: &UsageRates) -> Result<(), DomainError> {
    for value in [
        rates.input_cny_micros_per_million,
        rates.output_cny_micros_per_million,
        rates.cache_read_cny_micros_per_million,
        rates.cache_write_cny_micros_per_million,
        rates.audio_cny_micros_per_minute,
        rates.image_cny_micros_each,
        rates.request_cny_micros_each,
    ]
    .into_iter()
    .flatten()
    {
        safe(value)?;
    }
    Ok(())
}

/// Database configuration takes precedence after its first save, including an
/// explicit empty value. Environment rates are the initial configuration only.
/// Both dispatch and admin editing must use this selection before parsing rates.
fn effective_pricebook(
    revision: i64,
    stored: String,
    environment: Option<String>,
) -> (i64, String, String) {
    if revision > 0 || !stored.trim().is_empty() {
        (revision, stored, "database".into())
    } else if let Some(environment) = environment.filter(|value| !value.trim().is_empty()) {
        (revision, environment, "environment".into())
    } else {
        (revision, String::new(), "unconfigured".into())
    }
}

#[derive(Clone, Debug)]
pub struct UsageDispatch {
    pub request_id: String,
    pub identity: UsageIdentity,
    pub capability: String,
    pub purpose: String,
    pub dispatched_at: Option<i64>,
    pub price: Option<UsagePrice>,
}
impl UsageDispatch {
    pub fn new(
        request_id: impl Into<String>,
        identity: UsageIdentity,
        capability: impl Into<String>,
        purpose: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            identity,
            capability: capability.into(),
            purpose: purpose.into(),
            dispatched_at: None,
            price: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageMeasurements {
    /// Includes cache reads and writes. Never add cache subsets to this again.
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub audio_ms: Option<i64>,
    pub image_count: Option<i64>,
}
impl UsageMeasurements {
    fn values(&self) -> [Option<i64>; 6] {
        [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
            self.audio_ms,
            self.image_count,
        ]
    }
    fn validate(&self) -> Result<(), DomainError> {
        for value in self.values().into_iter().flatten() {
            safe(value)?;
        }
        if let Some(input) = self.input_tokens {
            let cache = self
                .cache_read_tokens
                .unwrap_or(0)
                .checked_add(self.cache_write_tokens.unwrap_or(0))
                .ok_or_else(overflow)?;
            if cache > input {
                return invalid("缓存 token 必须是输入 token 的子集");
            }
        }
        Ok(())
    }
    fn complete(&self, capability: &str) -> bool {
        match capability {
            "llm" => self.input_tokens.is_some() && self.output_tokens.is_some(),
            "vision" => {
                self.input_tokens.is_some()
                    && self.output_tokens.is_some()
                    && self.image_count.is_some()
            }
            "embedding" => self.input_tokens.is_some(),
            "asr" => self.audio_ms.is_some(),
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageOutcome {
    pub status: String,
    pub measurements: UsageMeasurements,
}
impl UsageOutcome {
    pub fn new(status: impl Into<String>, measurements: UsageMeasurements) -> Self {
        let status = status.into();
        Self {
            status: if status == "success" {
                "succeeded".into()
            } else {
                status
            },
            measurements,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageQuery {
    pub period: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpdateUsageReminder {
    pub enabled: bool,
    pub threshold_cny_micros: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UsageReminder {
    pub enabled: bool,
    pub threshold_cny_micros: i64,
    pub month: String,
    pub known_cost_cny_micros: i64,
    pub cost_status: String,
    pub reached: bool,
    pub notice_key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UsageMetrics {
    pub call_count: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub audio_ms: Option<i64>,
    pub image_count: Option<i64>,
    pub usage_status: String,
    pub estimated_cost_cny_micros: Option<i64>,
    pub known_cost_cny_micros: i64,
    pub unknown_cost_call_count: i64,
    pub cost_status: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UsageCell {
    #[serde(flatten)]
    pub identity: UsageIdentity,
    pub capability: String,
    pub purpose: String,
    #[serde(flatten)]
    pub metrics: UsageMetrics,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UsageReport {
    pub period: String,
    pub timezone: String,
    pub start_date: String,
    pub end_date: String,
    pub today: String,
    pub generated_at: String,
    pub recording_start: String,
    pub history_status: String,
    pub totals: UsageMetrics,
    pub cells: Vec<UsageCell>,
    pub monthly_reminder: UsageReminder,
}

impl Repository {
    /// Trusted server configuration path. Never accept this from the personal usage API.
    pub async fn set_usage_pricebook(&self, value: &str) -> Result<(), DomainError> {
        validate_pricebook_json(value)?;
        sqlx::query("UPDATE usage_recording SET pricebook_json=$1,pricebook_revision=pricebook_revision+1 WHERE id=1")
            .bind(value).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get_usage_pricebook(&self) -> Result<(i64, String), DomainError> {
        let (revision, effective, _) = self.get_usage_pricebook_snapshot().await?;
        Ok((revision, effective))
    }

    /// One effective snapshot for admin display and read/merge/CAS editing.
    /// The first database save must merge this JSON, preserving inactive env rates.
    pub async fn get_usage_pricebook_snapshot(&self) -> Result<(i64, String, String), DomainError> {
        let row =
            sqlx::query("SELECT pricebook_revision,pricebook_json FROM usage_recording WHERE id=1")
                .fetch_one(&self.pool)
                .await?;
        Ok(effective_pricebook(
            row.try_get("pricebook_revision")?,
            row.try_get("pricebook_json")?,
            std::env::var("USAGE_PRICING_JSON").ok(),
        ))
    }

    pub async fn compare_set_usage_pricebook(
        &self,
        expected_revision: i64,
        value: &str,
    ) -> Result<i64, DomainError> {
        safe(expected_revision)?;
        let next_revision = sum(expected_revision, 1)?;
        validate_pricebook_json(value)?;
        let changed = sqlx::query("UPDATE usage_recording SET pricebook_json=$1,pricebook_revision=$2 WHERE id=1 AND pricebook_revision=$3")
            .bind(value).bind(next_revision).bind(expected_revision).execute(&self.pool).await?.rows_affected();
        if changed != 1 {
            return Err(DomainError::Conflict(
                "用量价格已被修改，请刷新后重试".into(),
            ));
        }
        Ok(next_revision)
    }

    pub async fn usage_dispatch(
        &self,
        user_id: &str,
        dispatch: UsageDispatch,
    ) -> Result<(), DomainError> {
        let mut transaction = self.pool.begin().await?;
        self.usage_dispatch_in_transaction(&mut transaction, user_id, dispatch)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Allows an internal adapter to atomically fence dispatch with its existing run authority.
    /// Caller owns commit. All reads/writes use this transaction (including one-connection SQLite).
    pub async fn usage_dispatch_in_transaction(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Any>,
        user_id: &str,
        dispatch: UsageDispatch,
    ) -> Result<(), DomainError> {
        validate_dispatch(&dispatch)?;
        let price = match dispatch.price {
            Some(price) => {
                if price.version.trim().is_empty()
                    || price.version.len() > 80
                    || price.version.chars().any(char::is_control)
                {
                    return invalid("无效的用量价格版本");
                }
                validate_rates(&price.rates)?;
                Some(price)
            }
            None => {
                let row = sqlx::query(
                    "SELECT pricebook_revision,pricebook_json FROM usage_recording WHERE id=1",
                )
                .fetch_one(&mut **transaction)
                .await?;
                let (_, configured, _) = effective_pricebook(
                    row.try_get("pricebook_revision")?,
                    row.try_get("pricebook_json")?,
                    std::env::var("USAGE_PRICING_JSON").ok(),
                );
                // Invalid deployer prices do not block paid-call accounting: record unknown cost.
                match parse_pricebook(&configured) {
                    Ok(Some(book)) => {
                        book.models
                            .get(&dispatch.identity.model_key)
                            .map(|rates| UsagePrice {
                                version: book.version,
                                rates: rates.clone(),
                            })
                    }
                    Ok(None) => None,
                    Err(error) => {
                        tracing::warn!(error=%error, "usage pricebook unavailable");
                        None
                    }
                }
            }
        };
        let identity = encode(&dispatch.identity)?;
        sqlx::query("INSERT INTO usage_requests(user_id,request_id,dispatched_at,identity_json,capability,purpose,price_json,outcome_json) VALUES($1,$2,$3,$4,$5,$6,$7,'') ON CONFLICT(user_id,request_id) DO NOTHING")
            .bind(user_id).bind(&dispatch.request_id).bind(dispatch.dispatched_at.unwrap_or_else(now))
            .bind(&identity).bind(&dispatch.capability).bind(&dispatch.purpose).bind(encode(&price)?)
            .execute(&mut **transaction).await?;
        let row = sqlx::query("SELECT identity_json,capability,purpose FROM usage_requests WHERE user_id=$1 AND request_id=$2")
            .bind(user_id).bind(&dispatch.request_id).fetch_one(&mut **transaction).await?;
        if row.try_get::<String, _>("identity_json")? != identity
            || row.try_get::<String, _>("capability")? != dispatch.capability
            || row.try_get::<String, _>("purpose")? != dispatch.purpose
        {
            return Err(DomainError::Conflict("用量请求标识已被另一请求使用".into()));
        }
        Ok(())
    }

    pub async fn usage_finish(
        &self,
        user_id: &str,
        request_id: &str,
        mut outcome: UsageOutcome,
    ) -> Result<(), DomainError> {
        if !matches!(
            outcome.status.as_str(),
            "succeeded" | "failed" | "cancelled" | "timeout"
        ) {
            return invalid("无效的用量请求状态");
        }
        outcome.measurements.validate()?;
        // Compare-and-swap handles duplicate/concurrent callbacks on SQLite and PostgreSQL.
        for _ in 0..5 {
            let row = sqlx::query("SELECT outcome_json,price_json,capability FROM usage_requests WHERE user_id=$1 AND request_id=$2")
                .bind(user_id).bind(request_id).fetch_optional(&self.pool).await?
                .ok_or(DomainError::NotFound)?;
            let previous: String = row.try_get("outcome_json")?;
            let mut merged = outcome.clone();
            if !previous.is_empty() {
                let old: UsageOutcome = decode(&previous)?;
                merged.measurements = merge_measurements(&old.measurements, &outcome.measurements)?;
                // A later failure/cancellation cannot erase an observed successful request.
                if old.status == "succeeded" {
                    merged.status = old.status;
                }
            }
            let price: Option<UsagePrice> = decode(&row.try_get::<String, _>("price_json")?)?;
            estimate_cost(
                price.as_ref(),
                &merged.measurements,
                &row.try_get::<String, _>("capability")?,
            )?;
            let replacement = encode(&merged)?;
            if replacement == previous {
                return Ok(());
            }
            let changed = sqlx::query("UPDATE usage_requests SET outcome_json=$1 WHERE user_id=$2 AND request_id=$3 AND outcome_json=$4")
                .bind(replacement).bind(user_id).bind(request_id).bind(&previous)
                .execute(&self.pool).await?.rows_affected();
            if changed == 1 {
                return Ok(());
            }
            outcome = merged;
        }
        Err(DomainError::Conflict("用量结果正在更新，请重试".into()))
    }

    pub async fn usage_report(
        &self,
        user_id: &str,
        query: UsageQuery,
    ) -> Result<UsageReport, DomainError> {
        self.usage_report_at(user_id, query, now()).await
    }

    /// Clock-injected entry point also makes exact local-date accounting reproducible.
    pub async fn usage_report_at(
        &self,
        user_id: &str,
        query: UsageQuery,
        generated_at: i64,
    ) -> Result<UsageReport, DomainError> {
        let recording_start: i64 =
            sqlx::query("SELECT recording_start FROM usage_recording WHERE id=1")
                .fetch_one(&self.pool)
                .await?
                .try_get("recording_start")?;
        let interval = interval(&query, recording_start, generated_at)?;
        let records = self
            .usage_records(user_id, interval.start_utc, interval.end_utc)
            .await?;
        let mut totals = Accumulator::default();
        let mut cells: BTreeMap<(String, String, String), (UsageIdentity, Accumulator)> =
            BTreeMap::new();
        for record in records {
            totals.add(&record)?;
            let key = (
                record.identity.model_key.clone(),
                record.capability.clone(),
                record.purpose.clone(),
            );
            cells
                .entry(key)
                .or_insert_with(|| (record.identity.clone(), Accumulator::default()))
                .1
                .add(&record)?;
        }
        let cells = cells
            .into_iter()
            .map(|((_, capability, purpose), (identity, metrics))| {
                Ok(UsageCell {
                    identity,
                    capability,
                    purpose,
                    metrics: metrics.finish()?,
                })
            })
            .collect::<Result<Vec<_>, DomainError>>()?;
        let monthly_reminder = self.usage_reminder_at(user_id, generated_at).await?;
        Ok(UsageReport {
            period: interval.period,
            timezone: TIMEZONE.into(),
            start_date: interval.start.to_string(),
            end_date: interval.end.to_string(),
            today: local_date(generated_at)?.to_string(),
            generated_at: crate::timestamp(generated_at),
            recording_start: crate::timestamp(recording_start),
            history_status: if interval.start_utc < recording_start {
                "partial"
            } else {
                "complete"
            }
            .into(),
            totals: totals.finish()?,
            cells,
            monthly_reminder,
        })
    }

    pub async fn usage_reminder(&self, user_id: &str) -> Result<UsageReminder, DomainError> {
        self.usage_reminder_at(user_id, now()).await
    }
    pub async fn update_usage_reminder(
        &self,
        user_id: &str,
        input: UpdateUsageReminder,
    ) -> Result<UsageReminder, DomainError> {
        if !matches!(
            input.threshold_cny_micros,
            5_000_000 | 10_000_000 | 20_000_000 | 50_000_000
        ) {
            return invalid("提醒金额请选择 5、10、20 或 50 元");
        }
        sqlx::query("INSERT INTO usage_reminders(user_id,enabled,threshold_cny_micros) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,threshold_cny_micros=excluded.threshold_cny_micros")
            .bind(user_id).bind(if input.enabled {1_i64} else {0_i64}).bind(input.threshold_cny_micros)
            .execute(&self.pool).await?;
        self.usage_reminder(user_id).await
    }
    pub async fn usage_reminder_at(
        &self,
        user_id: &str,
        generated_at: i64,
    ) -> Result<UsageReminder, DomainError> {
        let settings = sqlx::query(
            "SELECT enabled,threshold_cny_micros FROM usage_reminders WHERE user_id=$1",
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        let (enabled, threshold) = match settings {
            Some(row) => (
                row.try_get::<i64, _>("enabled")? != 0,
                row.try_get("threshold_cny_micros")?,
            ),
            None => (true, DEFAULT_THRESHOLD),
        };
        let today = local_date(generated_at)?;
        let first = today.with_day(1).ok_or_else(overflow)?;
        let mut totals = Accumulator::default();
        for record in self
            .usage_records(user_id, midnight(first)?, midnight(next_day(today)?)?)
            .await?
        {
            totals.add(&record)?;
        }
        let totals = totals.finish()?;
        let month = format!("{:04}-{:02}", today.year(), today.month());
        let reached = enabled && totals.known_cost_cny_micros >= threshold;
        let notice_key = if reached {
            // Owner/server namespace is also included by the mobile dismissal store. The local
            // ledger enablement instant makes independent server instances distinct here too.
            let recording_start: i64 =
                sqlx::query("SELECT recording_start FROM usage_recording WHERE id=1")
                    .fetch_one(&self.pool)
                    .await?
                    .try_get("recording_start")?;
            Some(model_key(
                &format!("notice:{recording_start}:{user_id}"),
                &format!("{month}:{threshold}"),
            ))
        } else {
            None
        };
        Ok(UsageReminder {
            enabled,
            threshold_cny_micros: threshold,
            month,
            known_cost_cny_micros: totals.known_cost_cny_micros,
            cost_status: totals.cost_status,
            reached,
            notice_key,
        })
    }

    async fn usage_records(
        &self,
        user_id: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<Recorded>, DomainError> {
        sqlx::query("SELECT identity_json,capability,purpose,price_json,outcome_json FROM usage_requests WHERE user_id=$1 AND dispatched_at >= $2 AND dispatched_at < $3 ORDER BY dispatched_at,request_id")
            .bind(user_id).bind(start).bind(end).fetch_all(&self.pool).await?
            .into_iter().map(|row| {
                let outcome: String = row.try_get("outcome_json")?;
                Ok(Recorded {identity: decode(&row.try_get::<String,_>("identity_json")?)?,
                    capability: row.try_get("capability")?, purpose: row.try_get("purpose")?,
                    price: decode(&row.try_get::<String,_>("price_json")?)?,
                    measurements: if outcome.is_empty() { UsageMeasurements::default() }
                        else {decode::<UsageOutcome>(&outcome)?.measurements},
                })
            }).collect()
    }
}

fn validate_dispatch(value: &UsageDispatch) -> Result<(), DomainError> {
    if value.request_id.trim().is_empty()
        || value.request_id.len() > 240
        || value.request_id.chars().any(char::is_control)
    {
        return invalid("无效的用量请求标识");
    }
    if !matches!(
        value.capability.as_str(),
        "llm" | "asr" | "vision" | "embedding"
    ) {
        return invalid("无效的用量能力类型");
    }
    if !matches!(
        value.purpose.as_str(),
        "chat" | "brief" | "todo" | "memory" | "voice" | "image" | "gallery" | "index" | "other"
    ) {
        return invalid("无效的用量用途");
    }
    if value.identity.model_key.len() != 70
        || !value.identity.model_key.starts_with("usage_")
        || !value.identity.model_key[6..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return invalid("无效的模型标识");
    }
    for (text, fallback) in [
        (&value.identity.model, "unknown"),
        (&value.identity.model_name, "未知模型"),
        (&value.identity.provider, "已配置服务"),
    ] {
        if display_value(text, fallback) != *text {
            return invalid("模型名称包含不适合公开的信息");
        }
    }
    if let Some(time) = value.dispatched_at {
        if time < 0 || chrono::DateTime::from_timestamp(time, 0).is_none() {
            return invalid("无效的请求时间");
        }
    }
    Ok(())
}

fn merge_measurements(
    old: &UsageMeasurements,
    new: &UsageMeasurements,
) -> Result<UsageMeasurements, DomainError> {
    fn field(old: Option<i64>, new: Option<i64>) -> Result<Option<i64>, DomainError> {
        match (old, new) {
            (Some(a), Some(b)) if a != b => {
                Err(DomainError::Conflict("同一用量请求的测量值发生变化".into()))
            }
            (Some(a), _) => Ok(Some(a)),
            (_, value) => Ok(value),
        }
    }
    let merged = UsageMeasurements {
        input_tokens: field(old.input_tokens, new.input_tokens)?,
        output_tokens: field(old.output_tokens, new.output_tokens)?,
        cache_read_tokens: field(old.cache_read_tokens, new.cache_read_tokens)?,
        cache_write_tokens: field(old.cache_write_tokens, new.cache_write_tokens)?,
        audio_ms: field(old.audio_ms, new.audio_ms)?,
        image_count: field(old.image_count, new.image_count)?,
    };
    merged.validate()?;
    Ok(merged)
}

struct Recorded {
    identity: UsageIdentity,
    capability: String,
    purpose: String,
    price: Option<UsagePrice>,
    measurements: UsageMeasurements,
}
#[derive(Default)]
struct Accumulator {
    calls: i64,
    measured: i64,
    complete: i64,
    sums: [Option<i64>; 6],
    known_cost: i64,
    unknown_cost: i64,
}
impl Accumulator {
    fn add(&mut self, record: &Recorded) -> Result<(), DomainError> {
        self.calls = sum(self.calls, 1)?;
        let values = record.measurements.values();
        if values.iter().any(Option::is_some) {
            self.measured = sum(self.measured, 1)?;
        }
        if record.measurements.complete(&record.capability) {
            self.complete = sum(self.complete, 1)?;
        }
        for (total, value) in self.sums.iter_mut().zip(values) {
            if let Some(value) = value {
                *total = Some(sum(total.unwrap_or(0), value)?);
            }
        }
        match estimate_cost(
            record.price.as_ref(),
            &record.measurements,
            &record.capability,
        )? {
            Some(value) => self.known_cost = sum(self.known_cost, value)?,
            None => self.unknown_cost = sum(self.unknown_cost, 1)?,
        }
        Ok(())
    }
    fn finish(mut self) -> Result<UsageMetrics, DomainError> {
        if self.calls == 0 {
            self.sums[..4].fill(Some(0));
        }
        Ok(UsageMetrics {
            call_count: self.calls,
            input_tokens: self.sums[0],
            output_tokens: self.sums[1],
            cache_read_tokens: self.sums[2],
            cache_write_tokens: self.sums[3],
            audio_ms: self.sums[4],
            image_count: self.sums[5],
            usage_status: if self.calls == self.complete {
                "complete"
            } else if self.measured == 0 {
                "unknown"
            } else {
                "partial"
            }
            .into(),
            estimated_cost_cny_micros: if self.unknown_cost == 0 {
                Some(self.known_cost)
            } else {
                None
            },
            known_cost_cny_micros: self.known_cost,
            unknown_cost_call_count: self.unknown_cost,
            cost_status: if self.unknown_cost == 0 {
                "complete"
            } else if self.unknown_cost == self.calls {
                "unknown"
            } else {
                "partial"
            }
            .into(),
        })
    }
}

/// Calculate one estimate, rounding only once after summing all configured components.
fn estimate_cost(
    price: Option<&UsagePrice>,
    measured: &UsageMeasurements,
    capability: &str,
) -> Result<Option<i64>, DomainError> {
    let Some(price) = price else {
        return Ok(None);
    };
    let rates = &price.rates;
    let token_priced = [
        rates.input_cny_micros_per_million,
        rates.output_cny_micros_per_million,
        rates.cache_read_cny_micros_per_million,
        rates.cache_write_cny_micros_per_million,
    ]
    .iter()
    .any(Option::is_some);
    if !token_priced
        && rates.audio_cny_micros_per_minute.is_none()
        && rates.image_cny_micros_each.is_none()
        && rates.request_cny_micros_each.is_none()
    {
        return Ok(None);
    }
    // Common denominator is 3,000,000 for token-million and millisecond/minute units.
    let mut numerator: i128 = 0;
    let mut add = |count: i64, rate: i64, factor: i128| -> Result<(), DomainError> {
        let part = i128::from(count)
            .checked_mul(i128::from(rate))
            .and_then(|v| v.checked_mul(factor))
            .ok_or_else(overflow)?;
        numerator = numerator.checked_add(part).ok_or_else(overflow)?;
        Ok(())
    };
    if token_priced {
        let Some(input) = measured.input_tokens else {
            return Ok(None);
        };
        let output = if capability == "embedding" {
            measured.output_tokens.unwrap_or(0)
        } else if let Some(output) = measured.output_tokens {
            output
        } else {
            return Ok(None);
        };
        let (read, write) = if capability == "embedding" {
            (
                measured.cache_read_tokens.unwrap_or(0),
                measured.cache_write_tokens.unwrap_or(0),
            )
        } else {
            let (Some(read), Some(write)) =
                (measured.cache_read_tokens, measured.cache_write_tokens)
            else {
                return Ok(None);
            };
            (read, write)
        };
        let uncached = input
            .checked_sub(read)
            .and_then(|v| v.checked_sub(write))
            .ok_or_else(overflow)?;
        for (count, rate) in [
            (uncached, rates.input_cny_micros_per_million),
            (output, rates.output_cny_micros_per_million),
            (read, rates.cache_read_cny_micros_per_million),
            (write, rates.cache_write_cny_micros_per_million),
        ] {
            match rate {
                Some(rate) => add(count, rate, 3)?,
                None if count == 0 => (),
                None => return Ok(None),
            };
        }
    }
    if let Some(rate) = rates.audio_cny_micros_per_minute {
        let Some(duration) = measured.audio_ms else {
            return Ok(None);
        };
        add(duration, rate, 50)?;
    }
    if let Some(rate) = rates.image_cny_micros_each {
        let Some(images) = measured.image_count else {
            return Ok(None);
        };
        add(images, rate, 3_000_000)?;
    }
    if let Some(rate) = rates.request_cny_micros_each {
        add(1, rate, 3_000_000)?;
    }
    let rounded = numerator.checked_add(1_500_000).ok_or_else(overflow)? / 3_000_000;
    let value = i64::try_from(rounded).map_err(|_| overflow())?;
    safe(value)?;
    Ok(Some(value))
}

struct Interval {
    period: String,
    start: NaiveDate,
    end: NaiveDate,
    start_utc: i64,
    end_utc: i64,
}
fn interval(query: &UsageQuery, recording_start: i64, at: i64) -> Result<Interval, DomainError> {
    let today = local_date(at)?;
    let first_recorded = local_date(recording_start)?;
    let period = query.period.as_deref().unwrap_or("month");
    if period != "custom" && (query.start.is_some() || query.end.is_some()) {
        return invalid("只有自定义时段可以指定起止日期");
    }
    let (start, end) = match period {
        "today" => (today, today),
        "week" => (
            today.checked_sub_days(Days::new(6)).ok_or_else(overflow)?,
            today,
        ),
        "month" => (today.with_day(1).ok_or_else(overflow)?, today),
        "all" => (first_recorded, today),
        "custom" => {
            let start = strict_date(
                query
                    .start
                    .as_deref()
                    .ok_or_else(|| DomainError::Validation("请选择开始日期".into()))?,
            )?;
            let end = strict_date(
                query
                    .end
                    .as_deref()
                    .ok_or_else(|| DomainError::Validation("请选择结束日期".into()))?,
            )?;
            if start > end {
                return invalid("开始日期不能晚于结束日期");
            }
            if end > today {
                return invalid("结束日期不能晚于今天");
            }
            if start < first_recorded {
                return invalid("开始日期不能早于用量开始记录日期");
            }
            (start, end)
        }
        _ => return invalid("无效的用量统计时段"),
    };
    Ok(Interval {
        period: period.into(),
        start,
        end,
        start_utc: midnight(start)?,
        end_utc: midnight(next_day(end)?)?,
    })
}
fn strict_date(value: &str) -> Result<NaiveDate, DomainError> {
    if value.len() != 10
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return invalid("日期必须为 YYYY-MM-DD");
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| DomainError::Validation("无效的日历日期".into()))
}
fn local_date(value: i64) -> Result<NaiveDate, DomainError> {
    Ok(chrono::DateTime::from_timestamp(value, 0)
        .ok_or_else(overflow)?
        .with_timezone(&FixedOffset::east_opt(8 * 3600).expect("Asia/Shanghai offset"))
        .date_naive())
}
fn midnight(value: NaiveDate) -> Result<i64, DomainError> {
    FixedOffset::east_opt(8 * 3600)
        .expect("Asia/Shanghai offset")
        .from_local_datetime(&value.and_hms_opt(0, 0, 0).ok_or_else(overflow)?)
        .single()
        .map(|v| v.with_timezone(&Utc).timestamp())
        .ok_or_else(overflow)
}
fn next_day(value: NaiveDate) -> Result<NaiveDate, DomainError> {
    value.checked_add_days(Days::new(1)).ok_or_else(overflow)
}
fn safe(value: i64) -> Result<(), DomainError> {
    if !(0..=MAX_SAFE_INTEGER).contains(&value) {
        return invalid("用量或价格必须为非负安全整数");
    }
    Ok(())
}
fn sum(left: i64, right: i64) -> Result<i64, DomainError> {
    let value = left.checked_add(right).ok_or_else(overflow)?;
    safe(value)?;
    Ok(value)
}
fn invalid<T>(message: &str) -> Result<T, DomainError> {
    Err(DomainError::Validation(message.into()))
}
fn overflow() -> DomainError {
    DomainError::Validation("用量或费用超出安全整数范围".into())
}
fn encode(value: &impl Serialize) -> Result<String, DomainError> {
    serde_json::to_string(value).map_err(|e| DomainError::Internal(e.to_string()))
}
fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, DomainError> {
    serde_json::from_str(value).map_err(|_| DomainError::Internal("无法读取用量账本".into()))
}

#[cfg(test)]
mod pricebook_source_tests {
    use super::*;

    #[test]
    fn effective_environment_first_save_keeps_inactive_rates_and_old_snapshots() {
        let active = model_key("https://active.test/v1", "active");
        let inactive = model_key("https://inactive.test/v1", "inactive");
        let mut models = BTreeMap::new();
        models.insert(
            active.clone(),
            UsageRates {
                request_cny_micros_each: Some(10),
                ..Default::default()
            },
        );
        models.insert(
            inactive.clone(),
            UsageRates {
                request_cny_micros_each: Some(20),
                ..Default::default()
            },
        );
        let environment = encode(&Pricebook {
            version: "environment-v1".into(),
            models,
        })
        .unwrap();

        // Dispatch and admin read the same effective initial JSON and revision.
        let (revision, raw, source) =
            effective_pricebook(0, String::new(), Some(environment.clone()));
        assert_eq!((revision, source.as_str()), (0, "environment"));
        assert_eq!(raw, environment);
        let mut edited = parse_pricebook(&raw).unwrap().unwrap();
        let prior_dispatch = UsagePrice {
            version: edited.version.clone(),
            rates: edited.models[&active].clone(),
        };
        edited
            .models
            .get_mut(&active)
            .unwrap()
            .request_cny_micros_each = Some(30);
        edited.version = "database-v2".into();
        let saved = encode(&edited).unwrap();
        let (revision, raw, source) = effective_pricebook(1, saved.clone(), Some(environment));
        assert_eq!((revision, source.as_str()), (1, "database"));
        assert_eq!(raw, saved);
        let persisted = parse_pricebook(&raw).unwrap().unwrap();
        assert_eq!(persisted.models[&active].request_cny_micros_each, Some(30));
        assert_eq!(
            persisted.models[&inactive].request_cny_micros_each,
            Some(20)
        );
        assert_eq!(
            estimate_cost(Some(&prior_dispatch), &UsageMeasurements::default(), "llm").unwrap(),
            Some(10)
        );
        assert_eq!(prior_dispatch.version, "environment-v1");
    }

    #[test]
    fn explicit_database_clear_never_reactivates_environment_prices() {
        let environment = Some("not selected because database overrides it".into());
        let (revision, raw, source) = effective_pricebook(2, String::new(), environment);
        assert_eq!((revision, source.as_str()), (2, "database"));
        assert!(parse_pricebook(&raw).unwrap().is_none());
        assert_eq!(
            effective_pricebook(0, "  ".into(), None),
            (0, String::new(), "unconfigured".into())
        );
    }

    #[test]
    fn invalid_environment_remains_visible_and_cannot_mask_database_configuration() {
        let (_, raw, source) =
            effective_pricebook(0, String::new(), Some("invalid pricebook".into()));
        assert_eq!(source, "environment");
        // Admin validation reports an invalid source; dispatch retains unknown cost.
        assert!(parse_pricebook(&raw).is_err());
        let database = encode(&Pricebook {
            version: "database".into(),
            models: BTreeMap::new(),
        })
        .unwrap();
        let (_, raw, source) =
            effective_pricebook(1, database.clone(), Some("invalid pricebook".into()));
        assert_eq!(source, "database");
        assert_eq!(raw, database);
        assert!(parse_pricebook(&raw).is_ok());
    }
}
