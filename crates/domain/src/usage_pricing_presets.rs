//! Dated reference prices. Match exact official deployment identities, never model names alone.
//! Sources: api-docs.deepseek.com/zh-cn/quick_start/pricing/ and
//! help.aliyun.com/zh/model-studio/model-pricing, verified 2026-11-03.
use super::*;
use chrono::Timelike;

const REFERENCE: &str = "reference-2026-11-03";

fn matches(identity: &UsageIdentity, bases: &[&str]) -> bool {
    bases
        .iter()
        .any(|base| model_key(base, &identity.model) == identity.model_key)
}

/// Reference/list-price estimates, excluding account discounts and free credits.
/// An explicit model entry in the administrator pricebook always takes precedence.
pub fn official_usage_price(
    identity: &UsageIdentity,
    capability: &str,
    at: i64,
) -> Option<UsagePrice> {
    let mut rates = UsageRates::default();
    let rule;
    if matches!(capability, "llm" | "vision")
        && identity.model == "deepseek-flash"
        && matches(
            identity,
            &["https://api.deepseek.com", "https://api.deepseek.com/v1"],
        )
    {
        let time = chrono::DateTime::from_timestamp(at, 0)?
            .with_timezone(&FixedOffset::east_opt(8 * 3600)?);
        // Calendar coverage is explicit; a new year must not silently use the wrong holidays.
        if time.year() != 2026 {
            return None;
        }
        // State Council 2026 holiday notice, including the continuous holiday breaks.
        let day = time.format("%m-%d").to_string();
        let holiday = [
            ("01-01", "01-03"),
            ("02-15", "02-23"),
            ("04-04", "04-06"),
            ("05-01", "05-05"),
            ("06-19", "06-21"),
            ("09-25", "09-27"),
            ("10-01", "10-07"),
        ]
        .iter()
        .any(|(start, end)| day.as_str() >= *start && day.as_str() <= *end);
        let peak = time.weekday().number_from_monday() <= 5
            && !holiday
            && ((9..12).contains(&time.hour()) || (14..18).contains(&time.hour()));
        let multiplier = if peak { 2 } else { 1 };
        rates.input_cny_micros_per_million = Some(1_000_000 * multiplier);
        rates.output_cny_micros_per_million = Some(4_000_000 * multiplier);
        rates.cache_read_cny_micros_per_million = Some(20_000 * multiplier);
        // Canonical cache writes are part of uncached input, not an additional charge.
        rates.cache_write_cny_micros_per_million = Some(1_000_000 * multiplier);
        rule = if peak {
            "deepseek-flash:peak"
        } else {
            "deepseek-flash:offpeak"
        };
    } else if capability == "asr"
        && matches!(
            identity.model.as_str(),
            "qwen3-asr-flash" | "qwen3-asr-flash-filetrans"
        )
    {
        let unit = if matches(
            identity,
            &[
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "https://dashscope.aliyuncs.com/api/v1",
            ],
        ) {
            13_200
        } else if matches(
            identity,
            &[
                "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                "https://dashscope-intl.aliyuncs.com/api/v1",
            ],
        ) {
            15_600
        } else {
            return None;
        };
        // 0.00022 / 0.00026 CNY per audio second; token fields intentionally absent.
        rates.audio_cny_micros_per_minute = Some(unit);
        rule = "qwen3-asr:audio";
    } else {
        return None;
    }
    Some(UsagePrice {
        version: format!("{REFERENCE}:{rule}"),
        rates,
    })
}

#[derive(Debug, Serialize)]
pub struct UsageBackfillResult {
    pub scanned: usize,
    pub updated: u64,
    pub skipped: usize,
    pub next_cursor: Option<(String, String)>,
}

impl Repository {
    /// Administrator-only callers. Bounded, resumable and idempotent; never replace a snapshot.
    /// A reconstructed snapshot is visibly versioned and is not a historical vendor invoice.
    pub async fn backfill_missing_usage_prices(
        &self,
        expected_revision: i64,
        cursor: Option<(String, String)>,
    ) -> Result<UsageBackfillResult, DomainError> {
        safe(expected_revision)?;
        let (after_user, after_request) = cursor.unwrap_or_default();
        if after_user.len() > 240 || after_request.len() > 240 {
            return invalid("补算游标无效");
        }
        let mut tx = self.pool.begin().await?;
        let locked = sqlx::query("UPDATE usage_recording SET pricebook_revision=pricebook_revision WHERE id=1 AND pricebook_revision=$1")
            .bind(expected_revision).execute(&mut *tx).await?.rows_affected();
        if locked != 1 {
            return Err(DomainError::Conflict("单价已变化，请重新加载后补算".into()));
        }
        let row =
            sqlx::query("SELECT pricebook_revision,pricebook_json FROM usage_recording WHERE id=1")
                .fetch_one(&mut *tx)
                .await?;
        if row.try_get::<i64, _>("pricebook_revision")? != expected_revision {
            return Err(DomainError::Conflict("单价已变化，请重新加载后补算".into()));
        }
        let (_, raw, _) = effective_pricebook(
            expected_revision,
            row.try_get("pricebook_json")?,
            std::env::var("USAGE_PRICING_JSON").ok(),
        );
        let book = parse_pricebook(&raw)?;
        let rows = sqlx::query("SELECT user_id,request_id,identity_json,capability,dispatched_at,price_json,outcome_json FROM usage_requests WHERE price_json IN ('null','') AND (user_id > $1 OR (user_id=$1 AND request_id > $2)) ORDER BY user_id,request_id LIMIT 501")
            .bind(&after_user).bind(&after_request).fetch_all(&mut *tx).await?;
        let more = rows.len() > 500;
        let mut result = UsageBackfillResult {
            scanned: 0,
            updated: 0,
            skipped: 0,
            next_cursor: None,
        };
        for row in rows.into_iter().take(500) {
            result.scanned += 1;
            let user: String = row.try_get("user_id")?;
            let request: String = row.try_get("request_id")?;
            let identity: UsageIdentity = decode(&row.try_get::<String, _>("identity_json")?)?;
            let mut price = book
                .as_ref()
                .and_then(|book| {
                    book.models
                        .get(&identity.model_key)
                        .map(|rates| UsagePrice {
                            version: format!(
                                "reconstructed:{:x}",
                                Sha256::digest(book.version.as_bytes())
                            ),
                            rates: rates.clone(),
                        })
                })
                .or_else(|| {
                    official_usage_price(
                        &identity,
                        &row.try_get::<String, _>("capability").unwrap_or_default(),
                        row.try_get("dispatched_at").unwrap_or(-1),
                    )
                });
            if let Some(price) = price.as_mut() {
                let outcome: String = row.try_get("outcome_json")?;
                let measured = if outcome.is_empty() {
                    UsageMeasurements::default()
                } else {
                    decode::<UsageOutcome>(&outcome)?.measurements
                };
                if estimate_cost(
                    Some(price),
                    &measured,
                    &row.try_get::<String, _>("capability")?,
                )?
                .is_none()
                {
                    result.skipped += 1;
                    if more {
                        result.next_cursor = Some((user, request));
                    }
                    continue;
                }
                if price.version.starts_with(REFERENCE) {
                    price.version =
                        price
                            .version
                            .replacen("reference", "reconstructed-reference", 1);
                }
                result.updated += sqlx::query("UPDATE usage_requests SET price_json=$1 WHERE user_id=$2 AND request_id=$3 AND price_json=$4 AND EXISTS(SELECT 1 FROM usage_recording WHERE id=1 AND pricebook_revision=$5)")
                    .bind(encode(&price)?).bind(&user).bind(&request).bind(row.try_get::<String,_>("price_json")?)
                    .bind(expected_revision).execute(&mut *tx).await?.rows_affected();
            } else {
                result.skipped += 1;
            }
            if more {
                result.next_cursor = Some((user, request));
            }
        }
        // Also reject a concurrent settings write if none of this batch could be updated.
        let revision: i64 =
            sqlx::query_scalar("SELECT pricebook_revision FROM usage_recording WHERE id=1")
                .fetch_one(&mut *tx)
                .await?;
        if revision != expected_revision {
            return Err(DomainError::Conflict("单价已变化，请重新补算".into()));
        }
        tx.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(date: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(date)
            .unwrap()
            .timestamp()
    }
    fn flash() -> UsageIdentity {
        UsageIdentity::new(
            "https://api.deepseek.com",
            "deepseek-flash",
            "flash",
            "DeepSeek",
        )
    }
    #[test]
    fn official_identity_is_not_a_model_name_guess() {
        let proxy = UsageIdentity::new(
            "https://proxy.invalid/v1",
            "deepseek-flash",
            "flash",
            "DeepSeek",
        );
        assert!(official_usage_price(&proxy, "llm", at("2026-11-03T00:40:00+08:00")).is_none());
        let input = UsageIdentity::new(
            "https://api.deepseek.com/v1/chat/completions",
            "deepseek-flash",
            "flash",
            "DeepSeek",
        );
        assert!(official_usage_price(&input, "llm", at("2026-11-03T00:40:00+08:00")).is_some());
    }
    #[test]
    fn peak_boundaries_weekends_holidays_and_calendar_coverage() {
        for (date, rate) in [
            ("2026-11-03T08:59:59+08:00", 1_000_000),
            ("2026-11-03T09:00:00+08:00", 2_000_000),
            ("2026-11-03T12:00:00+08:00", 1_000_000),
            ("2026-11-03T14:00:00+08:00", 2_000_000),
            ("2026-11-03T18:00:00+08:00", 1_000_000),
            ("2026-10-01T10:00:00+08:00", 1_000_000),
            ("2026-10-10T10:00:00+08:00", 1_000_000),
        ] {
            assert_eq!(
                official_usage_price(&flash(), "llm", at(date))
                    .unwrap()
                    .rates
                    .input_cny_micros_per_million,
                Some(rate),
                "{date}"
            );
        }
        assert!(official_usage_price(&flash(), "llm", at("2027-01-01T00:00:00+08:00")).is_none());
    }
    #[test]
    fn cache_creation_remains_ordinary_uncached_input_not_free_or_double_charged() {
        let price = official_usage_price(&flash(), "llm", at("2026-11-03T00:40:00+08:00")).unwrap();
        let usage = UsageMeasurements {
            input_tokens: Some(1000),
            output_tokens: Some(0),
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(1000),
            ..Default::default()
        };
        assert_eq!(
            estimate_cost(Some(&price), &usage, "llm").unwrap(),
            Some(1000)
        );
    }
    #[test]
    fn missing_cache_creation_does_not_prevent_cost_when_its_rate_equals_ordinary_input() {
        let mut price = official_usage_price(&flash(), "llm", at("2026-11-03T00:40:00+08:00")).unwrap();
        let usage=UsageMeasurements { input_tokens:Some(1000), output_tokens:Some(100), cache_read_tokens:Some(400), cache_write_tokens:None, ..Default::default() };
        assert_eq!(estimate_cost(Some(&price), &usage, "llm").unwrap(), Some(1008));
        assert_eq!(usage.cache_write_tokens, None);
        price.rates.cache_write_cny_micros_per_million=Some(2_000_000);
        assert_eq!(estimate_cost(Some(&price), &usage, "llm").unwrap(), None);
    }

    #[test]
    fn asr_prices_audio_once_and_preserves_region() {
        let id = UsageIdentity::new(
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "qwen3-asr-flash",
            "asr",
            "Aliyun",
        );
        let price = official_usage_price(&id, "asr", 0).unwrap();
        let usage = UsageMeasurements {
            input_tokens: Some(300),
            output_tokens: Some(25),
            audio_ms: Some(9000),
            ..Default::default()
        };
        assert_eq!(
            estimate_cost(Some(&price), &usage, "asr").unwrap(),
            Some(1980)
        );
        let intl = UsageIdentity::new(
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "qwen3-asr-flash",
            "asr",
            "Aliyun",
        );
        assert_eq!(
            official_usage_price(&intl, "asr", 0)
                .unwrap()
                .rates
                .audio_cny_micros_per_minute,
            Some(15600)
        );
    }
}
