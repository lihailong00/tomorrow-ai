//! Daily recommendations and server-authored growth facts; AI output is never a completion.
mod types;
pub use types::*;
mod actions;
mod plans;
mod preferences;
pub(crate) mod rewards;
mod journeys;
pub use journeys::*;
mod history;
pub use history::*;

use crate::{DomainError, Repository};
use chrono::TimeZone;
use sqlx::{Any, Row, Transaction};

pub(crate) fn json<T: serde::Serialize>(value: &T) -> Result<String, DomainError> {
    serde_json::to_string(value).map_err(|e| DomainError::Internal(e.to_string()))
}
pub(crate) fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, DomainError> {
    serde_json::from_str(value).map_err(|e| DomainError::Internal(e.to_string()))
}
pub(crate) fn local_date(time: i64, timezone: &str) -> Result<String, DomainError> {
    let zone: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| DomainError::Validation("用户时区无效".into()))?;
    Ok(zone
        .timestamp_opt(time, 0)
        .single()
        .ok_or_else(|| DomainError::Validation("日期无效".into()))?
        .date_naive()
        .to_string())
}
pub(crate) async fn lock_preferences(
    tx: &mut Transaction<'_, Any>,
    user: &str,
) -> Result<(), DomainError> {
    sqlx::query("INSERT INTO growth_preferences(user_id,body,version,guard,last_active_at)VALUES($1,$2,0,0,$3)ON CONFLICT(user_id)DO NOTHING")
        .bind(user).bind(json(&StoredPreferences::default())?).bind(crate::now()).execute(&mut **tx).await?;
    sqlx::query("UPDATE growth_preferences SET guard=guard+1 WHERE user_id=$1")
        .bind(user)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(crate) async fn command_start(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    key: &str,
    op: &str,
    input: &impl serde::Serialize,
) -> Result<Option<String>, DomainError> {
    crate::validate_text(key, "请求编号", 120)?;
    let fingerprint = crate::repository::creation_fingerprint(input)?;
    let changed=sqlx::query("INSERT INTO growth_commands(user_id,request_id,operation,fingerprint,response_body,created_at)VALUES($1,$2,$3,$4,'',$5)ON CONFLICT(user_id,request_id)DO NOTHING")
        .bind(user).bind(key).bind(op).bind(&fingerprint).bind(crate::now()).execute(&mut **tx).await?.rows_affected();
    if changed > 0 {
        return Ok(None);
    }
    let row=sqlx::query("SELECT operation,fingerprint,response_body FROM growth_commands WHERE user_id=$1 AND request_id=$2").bind(user).bind(key).fetch_one(&mut **tx).await?;
    if row.get::<String, _>("operation") != op || row.get::<String, _>("fingerprint") != fingerprint
    {
        return Err(DomainError::Conflict("同一请求编号不能用于不同操作".into()));
    }
    let body: String = row.get("response_body");
    if body.is_empty() {
        return Err(DomainError::Conflict("这次操作已失效，请刷新后继续".into()));
    }
    Ok(Some(body))
}
pub(crate) async fn command_finish(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    key: &str,
    todo_id: &str,
    value: &impl serde::Serialize,
) -> Result<(), DomainError> {
    sqlx::query(
        "UPDATE growth_commands SET response_body=$1,todo_id=$2 WHERE user_id=$3 AND request_id=$4",
    )
    .bind(json(value)?)
    .bind(todo_id)
    .bind(user)
    .bind(key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

impl Repository {
    pub(crate) async fn growth_user_date(
        &self,
        user: &str,
    ) -> Result<(String, String), DomainError> {
        let tz = self.user(user).await?.timezone;
        Ok((local_date(crate::now(), &tz)?, tz))
    }
}
