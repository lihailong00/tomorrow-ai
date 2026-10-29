use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use reqwest::Response;
use serde_json::{Value, json};
use std::collections::HashSet;
use tomorrow_domain::now;

const MAX_RECORDS: usize = 2000;
const MAX_PAGES: usize = 20;

impl HealthState {
    pub(super) async fn exchange(
        &self,
        provider: Provider,
        pending: &Consumed,
        code: &str,
    ) -> Result<Tokens> {
        let config = self.config(provider)?;
        let endpoint = match provider {
            Provider::Huawei => &self.inner.config.endpoints.huawei_token,
            Provider::Xiaomi => &self.inner.config.endpoints.xiaomi_token,
        };
        let response = self
            .inner
            .client
            .post(endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.secret.as_str()),
                ("redirect_uri", config.redirect.as_str()),
                ("code", code),
            ])
            .send()
            .await
            .map_err(|_| upstream())?;
        let value = read_json(response, 65536).await?;
        parse_tokens(
            provider,
            value,
            &pending.pending.metrics,
            None,
            &config.fingerprint,
        )
    }

    pub(super) async fn access_tokens(&self, user: &str, provider: Provider) -> Result<Tokens> {
        let _guard = self.inner.refresh.lock().await;
        let account = self
            .account(user, provider)
            .await?
            .filter(|a| !a.ciphertext.is_empty())
            .ok_or_else(reconnect)?;
        let old = self.decode(user, provider, &account.ciphertext)?;
        if old.expires_at > now() + 60 {
            return Ok(old);
        }
        let refresh = old.refresh_token.as_deref().ok_or_else(reconnect)?;
        let config = self.config(provider)?;
        let endpoint = match provider {
            Provider::Huawei => &self.inner.config.endpoints.huawei_token,
            Provider::Xiaomi => &self.inner.config.endpoints.xiaomi_refresh,
        };
        let response = self
            .inner
            .client
            .post(endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.secret.as_str()),
                ("redirect_uri", config.redirect.as_str()),
                ("pt", "0"),
            ])
            .send()
            .await
            .map_err(|_| upstream())?;
        if matches!(
            response.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED
        ) {
            let mut expired = old.clone();
            expired.expires_at = 0;
            expired.refresh_token = None;
            self.save_tokens(user, provider, &account, &expired).await?;
            return Err(reconnect());
        }
        let value = read_json(response, 65536).await?;
        let tokens = parse_tokens(
            provider,
            value,
            &old.metrics,
            Some(&old),
            &config.fingerprint,
        )?;
        self.save_tokens(user, provider, &account, &tokens).await?;
        Ok(tokens)
    }

    async fn save_tokens(
        &self,
        user: &str,
        provider: Provider,
        account: &Account,
        tokens: &Tokens,
    ) -> Result<()> {
        let cipher = self.inner.config.crypto()?.encrypt(
            user,
            provider.id(),
            "health_tokens",
            &serde_json::to_vec(tokens).map_err(|_| ConnectorError::internal())?,
        )?;
        let changed=sqlx::query("UPDATE health_connector_accounts SET encrypted_tokens=$1 WHERE user_id=$2 AND provider=$3 AND generation=$4 AND encrypted_tokens=$5").bind(cipher).bind(user).bind(provider.id()).bind(account.generation).bind(&account.ciphertext).execute(&self.inner.pool).await?.rows_affected();
        if changed != 1 {
            return Err(reconnect());
        }
        Ok(())
    }

    pub(super) async fn read_records(
        &self,
        provider: Provider,
        tokens: &Tokens,
        days: i64,
    ) -> Result<(Vec<HealthRecord>, bool)> {
        let end = now() * 1000;
        let mut start = end - days * 86_400_000;
        if provider == Provider::Huawei || !tokens.scopes.iter().any(|s| s == "200013") {
            start = start.max(tokens.authorized_at * 1000)
        }
        // Huawei default scopes grant no pre-authorization history. The first
        // probe still uses a strictly increasing range within this instant.
        let end = end.max(start + 1);
        match provider {
            Provider::Huawei => self.huawei_steps(tokens, start, end).await,
            Provider::Xiaomi => self.xiaomi_records(tokens, start, end).await,
        }
    }

    async fn xiaomi_records(
        &self,
        tokens: &Tokens,
        start: i64,
        end: i64,
    ) -> Result<(Vec<HealthRecord>, bool)> {
        let config = self.config(Provider::Xiaomi)?;
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        let mut truncated = false;
        for metric in &tokens.metrics {
            let (data_type, field, unit, path) = xiaomi_metric(metric).ok_or_else(invalid)?;
            let mut cursor = String::new();
            let mut seen = HashSet::new();
            for page in 0..MAX_PAGES {
                let mut request = self
                    .inner
                    .client
                    .get(format!(
                        "{}{}",
                        self.inner.config.endpoints.xiaomi_data, path
                    ))
                    .bearer_auth(&tokens.access_token)
                    .header("X-Client-ID", &config.client_id)
                    .header("X-Client-Nonce", xiaomi_nonce())
                    .header("Content-Type", "application/json")
                    .query(&[
                        ("dataTypeName", data_type.to_owned()),
                        ("startTime", start.to_string()),
                        ("endTime", end.to_string()),
                        ("limit", "200".into()),
                    ]);
                if !cursor.is_empty() {
                    request = request.query(&[("cursor", &cursor)])
                }
                let response = request.send().await.map_err(|_| upstream())?;
                let value = unwrap_business(read_json(response, 2 * 1024 * 1024).await?)?;
                let points = if metric == "sleep" {
                    value
                        .get("healthRecords")
                        .and_then(Value::as_array)
                        .ok_or_else(upstream)?
                        .iter()
                        .map(|point| (point, None))
                        .collect::<Vec<_>>()
                } else {
                    let groups = value
                        .get("group")
                        .and_then(Value::as_array)
                        .ok_or_else(upstream)?;
                    let mut points = Vec::new();
                    for group in groups {
                        let sets = group
                            .get("dataSet")
                            .and_then(Value::as_array)
                            .ok_or_else(upstream)?;
                        for set in sets {
                            points.extend(
                                set.get("dataPoints")
                                    .and_then(Value::as_array)
                                    .ok_or_else(upstream)?
                                    .iter()
                                    .map(|point| (point, source_identifier(set))),
                            )
                        }
                    }
                    points
                };
                for (point, set_source) in points {
                    if point.get("dataTypeName").and_then(Value::as_str) != Some(data_type) {
                        return Err(upstream());
                    }
                    let a = point
                        .get("startTime")
                        .and_then(Value::as_i64)
                        .ok_or_else(upstream)?;
                    let b = point
                        .get("endTime")
                        .and_then(Value::as_i64)
                        .ok_or_else(upstream)?;
                    if a < start || a > end || b < a || b > end + 86_400_000 {
                        return Err(upstream());
                    }
                    let fields = point
                        .get("value")
                        .and_then(Value::as_array)
                        .ok_or_else(upstream)?;
                    let raw = fields
                        .iter()
                        .find(|f| f.get("fieldName").and_then(Value::as_str) == Some(field))
                        .ok_or_else(upstream)?;
                    let amount = numeric_field(raw).ok_or_else(upstream)?;
                    if !valid_value(metric, amount) {
                        return Err(upstream());
                    }
                    let source_id = source_identifier(point).or(set_source);
                    let id = digest(&format!(
                        "xiaomi:{metric}:{}:{a}:{b}",
                        source_id.as_deref().unwrap_or("fused")
                    ));
                    if ids.insert(id.clone()) {
                        if result.len() >= MAX_RECORDS {
                            truncated = true;
                            break;
                        }
                        result.push(HealthRecord {
                            id,
                            source: "xiaomi".into(),
                            source_id,
                            aggregation: None,
                            metric: metric.clone(),
                            start_at: rfc3339(a)?,
                            end_at: rfc3339(b)?,
                            value: amount,
                            unit: unit.into(),
                        });
                    }
                }
                if truncated {
                    break;
                }
                match next_cursor(&value)? {
                    Some(next) => {
                        if !seen.insert(next.clone()) {
                            return Err(upstream());
                        }
                        cursor = next;
                        if page == MAX_PAGES - 1 {
                            truncated = true
                        }
                    }
                    None => break,
                }
            }
            if truncated {
                break;
            }
        }
        result.sort_by(|a, b| a.start_at.cmp(&b.start_at).then(a.id.cmp(&b.id)));
        Ok((result, truncated))
    }

    async fn huawei_steps(
        &self,
        tokens: &Tokens,
        start: i64,
        end: i64,
    ) -> Result<(Vec<HealthRecord>, bool)> {
        let config = self.config(Provider::Huawei)?;
        let response=self.inner.client.post(format!("{}/healthkit/v2/sampleSet:polymerize",self.inner.config.endpoints.huawei_data))
            .bearer_auth(&tokens.access_token).header("x-client-id",&config.client_id).header("x-version","1.0.0")
            .header("x-caller-trace-id",random_secret())
            .json(&json!({"polymerizeWith":[{"dataTypeName":"com.huawei.continuous.steps.delta"}],"startTime":start,"endTime":end,"groupByTime":{"groupPeriod":{"unit":"day","value":1,"timeZone":"+0000"}}}))
            .send().await.map_err(|_|upstream())?;
        // Never follow a regional Location with a user's bearer token.
        if matches!(
            response
                .headers()
                .get("x-health-app-privacy")
                .and_then(|v| v.to_str().ok()),
            Some("2" | "3")
        ) {
            return Err(ConnectorError::new(
                StatusCode::CONFLICT,
                "huawei_health_privacy_required",
                "请先在华为运动健康中开启健康数据共享，并同步设备数据",
            ));
        }
        let value = unwrap_business(read_json(response, 2 * 1024 * 1024).await?)?;
        let groups = value
            .get("group")
            .and_then(Value::as_array)
            .ok_or_else(upstream)?;
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        let mut truncated = false;
        for group in groups {
            let sets = group
                .get("sampleSet")
                .and_then(Value::as_array)
                .ok_or_else(upstream)?;
            for set in sets {
                let points = set
                    .get("samplePoints")
                    .and_then(Value::as_array)
                    .ok_or_else(upstream)?;
                for point in points {
                    if point.get("dataTypeName").and_then(Value::as_str)
                        != Some("com.huawei.continuous.steps.total")
                    {
                        return Err(upstream());
                    }
                    // Cloud sample point timestamps are nanoseconds, unlike
                    // query/group bounds (milliseconds).
                    let a = integer(point.get("startTime")).ok_or_else(upstream)? / 1_000_000;
                    let b = integer(point.get("endTime")).ok_or_else(upstream)? / 1_000_000;
                    // Daily buckets may begin before the requested instant.
                    if a < start - 86_400_000 || a > end || b < a || b > end + 86_400_000 {
                        return Err(upstream());
                    }
                    let fields = point
                        .get("value")
                        .and_then(Value::as_array)
                        .ok_or_else(upstream)?;
                    let raw = fields
                        .iter()
                        .find(|f| f.get("fieldName").and_then(Value::as_str) == Some("steps"))
                        .ok_or_else(upstream)?;
                    let amount = numeric_field(raw).ok_or_else(upstream)?;
                    if !valid_value("steps", amount) {
                        return Err(upstream());
                    }
                    let source_id = source_identifier(point).or_else(|| source_identifier(set));
                    let id = digest(&format!(
                        "huawei:steps:{}:{a}:{b}",
                        source_id.as_deref().unwrap_or("aggregate")
                    ));
                    if ids.insert(id.clone()) {
                        if result.len() >= MAX_RECORDS {
                            truncated = true;
                            break;
                        }
                        result.push(HealthRecord {
                            id,
                            source: "huawei".into(),
                            source_id,
                            aggregation: Some("day_utc".into()),
                            metric: "steps".into(),
                            start_at: rfc3339(a)?,
                            end_at: rfc3339(b)?,
                            value: amount,
                            unit: "count".into(),
                        });
                    }
                }
            }
        }
        Ok((result, truncated))
    }
}

fn parse_tokens(
    provider: Provider,
    value: Value,
    requested: &[String],
    old: Option<&Tokens>,
    fingerprint: &str,
) -> Result<Tokens> {
    let value = unwrap_business(value)?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or_else(reconnect)?
        .to_owned();
    let expires = value
        .get("expires_in")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .filter(|v| *v > 0 && *v <= 366 * 86400)
        .ok_or_else(reconnect)?;
    if value
        .get("token_type")
        .or_else(|| value.get("token_type "))
        .and_then(Value::as_str)
        .is_some_and(|t| {
            !t.eq_ignore_ascii_case("bearer")
                && !(provider == Provider::Xiaomi && t.eq_ignore_ascii_case("mac"))
        })
    {
        return Err(reconnect());
    }
    let scopes = if let Some(scope) = value.get("scope").and_then(Value::as_str) {
        scope
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        old.map(|t| t.scopes.clone()).ok_or_else(reconnect)?
    };
    let allowed: HashSet<&str> = requested
        .iter()
        .filter_map(|m| provider.scope(m))
        .chain((provider == Provider::Xiaomi).then_some("200013"))
        .collect();
    if scopes.len() > 16 || scopes.iter().any(|s| !allowed.contains(s.as_str())) {
        return Err(reconnect());
    }
    let metrics = requested
        .iter()
        .filter(|m| {
            provider
                .scope(m)
                .is_some_and(|scope| scopes.iter().any(|s| s == scope))
        })
        .cloned()
        .collect::<Vec<_>>();
    if metrics.is_empty() {
        return Err(reconnect());
    }
    let refresh_token = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .or_else(|| old.and_then(|t| t.refresh_token.clone()));
    Ok(Tokens {
        access_token: access,
        refresh_token,
        expires_at: now() + expires,
        scopes,
        metrics,
        authorized_at: old.map(|t| t.authorized_at).unwrap_or_else(now),
        config_fingerprint: fingerprint.into(),
    })
}

fn xiaomi_metric(metric: &str) -> Option<(&'static str, &'static str, &'static str, &'static str)> {
    let (data_type, field, unit) = match metric {
        "steps" => ("com.xiaomi.steps.delta", "steps_delta", "count"),
        "heart_rate" => ("com.xiaomi.heart_rate.delta", "bpm", "bpm"),
        "weight" => ("com.xiaomi.weight.instantaneous", "weight", "kg"),
        "active_energy" => ("com.xiaomi.calories.delta", "calories", "kcal"),
        // Cloud schema pId=2329 defines minutes. The similarly named *local*
        // SDK schema pId=2331 uses seconds; do not apply its unit here.
        "sleep" => ("com.xiaomi.sleep.health", "all_sleep_duration", "min"),
        _ => return None,
    };
    Some((
        data_type,
        field,
        unit,
        if metric == "sleep" {
            "/healthkit/healthRecords"
        } else {
            "/healthkit/dataSources/dataPoints"
        },
    ))
}
fn valid_value(metric: &str, value: f64) -> bool {
    value.is_finite()
        && value >= 0.0
        && match metric {
            "steps" => value <= 1_000_000.0 && value.fract() == 0.0,
            "heart_rate" => value > 0.0 && value <= 400.0,
            "sleep" => value <= 7.0 * 1440.0,
            "weight" => value > 0.0 && value <= 1000.0,
            "active_energy" => value <= 1_000_000.0,
            _ => false,
        }
}
fn numeric_field(value: &Value) -> Option<f64> {
    value
        .get("integerValue")
        .or_else(|| value.get("floatValue"))
        .or_else(|| value.get("longValue"))
        .and_then(Value::as_f64)
}
fn source_identifier(value: &Value) -> Option<String> {
    ["originDataSourceId", "sourceId", "dataCollectorId"]
        .iter()
        .find_map(|key| {
            value.get(*key).and_then(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
        })
        .filter(|id| !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control))
}
fn integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn next_cursor(value: &Value) -> Result<Option<String>> {
    let cursor = value
        .get("cursor")
        .and_then(|v| {
            v.as_str()
                .map(str::to_owned)
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .filter(|s| !s.is_empty());
    let more = value
        .get("hasMore")
        .and_then(Value::as_bool)
        .unwrap_or(cursor.is_some());
    if !more {
        return Ok(None);
    }
    cursor
        .filter(|c| c.len() <= 1000 && !c.chars().any(char::is_control))
        .map(Some)
        .ok_or_else(upstream)
}
fn unwrap_business(value: Value) -> Result<Value> {
    if value.get("error").is_some() {
        return Err(reconnect());
    }
    if let Some(code) = value.get("code") {
        if code.as_i64() != Some(0) {
            return Err(upstream());
        }
        return value.get("data").cloned().ok_or_else(upstream);
    }
    Ok(value)
}
fn xiaomi_nonce() -> String {
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes[..8]);
    bytes[8..].copy_from_slice(&((now() / 60) as u32).to_be_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}
async fn read_json(mut response: Response, limit: usize) -> Result<Value> {
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(reconnect());
    }
    if !response.status().is_success() {
        return Err(upstream());
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(upstream());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if bytes.len() + chunk.len() > limit {
            return Err(upstream());
        }
        bytes.extend_from_slice(&chunk);
    }
    let bytes = bytes.strip_prefix(b"&&&START&&&").unwrap_or(&bytes);
    serde_json::from_slice(bytes).map_err(|_| upstream())
}
