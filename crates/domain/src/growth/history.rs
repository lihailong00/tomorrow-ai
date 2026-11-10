use super::*;
use chrono::{Datelike, Days, NaiveDate};
use serde::Serialize;
use sqlx::Row;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct GrowthOutcome {
    pub reward: GrowthReward,
    pub note: Option<String>,
}
#[derive(Serialize, ToSchema)]
pub struct GrowthHistory {
    pub period: String,
    pub action_count: i64,
    pub active_days: i64,
    pub learning_actions: i64,
    pub exercise_minutes: i64,
    pub total_xp: i64,
    pub records: Vec<GrowthOutcome>,
    pub next_offset: Option<i64>,
}
impl Repository {
    pub async fn growth_history(
        &self,
        user: &str,
        period: &str,
        offset: i64,
        limit: i64,
    ) -> Result<GrowthHistory, DomainError> {
        if !matches!(period, "week" | "month" | "all")
            || offset < 0
            || offset > 100000
            || !(1..=50).contains(&limit)
        {
            return Err(DomainError::Validation(
                "请选择本周、本月或全部，单页最多50条".into(),
            ));
        }
        let (date, _) = self.growth_user_date(user).await?;
        let today = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
            .map_err(|_| DomainError::Internal("日期无效".into()))?;
        let start = match period {
            "week" => today
                .checked_sub_days(Days::new(today.weekday().num_days_from_monday() as u64))
                .unwrap_or(today)
                .to_string(),
            "month" => today.with_day(1).unwrap_or(today).to_string(),
            _ => String::new(),
        };
        let mut tx = self.pool.begin().await?;
        if tx.backend_name() == "PostgreSQL" {
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx)
                .await?;
        }
        let summary=sqlx::query("SELECT COUNT(*) AS actions,COUNT(DISTINCT local_date) AS days,CAST(COALESCE(SUM(points),0) AS BIGINT) AS xp,CAST(COALESCE(SUM(CASE WHEN kind='learning' THEN 1 ELSE 0 END),0) AS BIGINT) AS learning,CAST(COALESCE(SUM(CASE WHEN kind='exercise' THEN COALESCE(minutes,0) ELSE 0 END),0) AS BIGINT) AS minutes FROM growth_rewards WHERE user_id=$1 AND active=1 AND ($2='' OR (local_date>=$2 AND local_date<=$3))")
            .bind(user).bind(&start).bind(&date).fetch_one(&mut *tx).await?;
        let rows=sqlx::query("SELECT r.*,t.body AS todo_body FROM growth_rewards r LEFT JOIN todos t ON t.id=r.todo_id AND t.user_id=r.user_id WHERE r.user_id=$1 AND r.active=1 AND ($2='' OR (r.local_date>=$2 AND r.local_date<=$3)) ORDER BY r.earned_at DESC,r.todo_id DESC LIMIT $4 OFFSET $5")
            .bind(user).bind(&start).bind(&date).bind(limit+1).bind(offset).fetch_all(&mut *tx).await?;
        let has_more = rows.len() > limit as usize;
        let records = rows
            .into_iter()
            .take(limit as usize)
            .map(|r| {
                let note = r
                    .get::<Option<String>, _>("todo_body")
                    .and_then(|s| parse::<crate::Todo>(&s).ok())
                    .and_then(|t| t.progress_notes)
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| v.chars().take(2000).collect());
                Ok(GrowthOutcome {
                    reward: super::rewards::reward_from_row(&r)?,
                    note,
                })
            })
            .collect::<Result<Vec<_>, DomainError>>()?;
        let value = GrowthHistory {
            period: period.into(),
            action_count: summary.get("actions"),
            active_days: summary.get("days"),
            learning_actions: summary.get("learning"),
            exercise_minutes: summary.get("minutes"),
            total_xp: summary.get("xp"),
            records,
            next_offset: has_more.then_some(offset + limit),
        };
        tx.commit().await?;
        Ok(value)
    }
}
