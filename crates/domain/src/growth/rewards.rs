//! Transactional, server-valued growth receipts. A logical Todo has one lifetime entitlement.
use super::types::{
    GrowthDay, GrowthMilestone, GrowthReward, GrowthRewardState, GrowthSummary, GrowthToday,
    GrowthWeek, StoredPreferences,
};
use crate::{new_id, now, timestamp, DomainError, Repository, Todo};
use chrono::{Datelike, Days, NaiveDate};
use sqlx::{any::AnyRow, Any, Row, Transaction};

const XP_PER_LEVEL: i64 = 60;

fn internal(message: &str) -> DomainError {
    DomainError::Internal(message.into())
}

fn local_date(timezone: &str, time: i64) -> Result<NaiveDate, DomainError> {
    let zone = timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| internal("用户时区无效"))?;
    let instant =
        chrono::DateTime::from_timestamp(time, 0).ok_or_else(|| internal("成长日期超出范围"))?;
    Ok(instant.with_timezone(&zone).date_naive())
}

fn decode_preferences(body: &str) -> Result<StoredPreferences, DomainError> {
    serde_json::from_str(body).map_err(|_| internal("成长偏好记录无效"))
}

/// Only a typed, explicitly confirmed action fact contributes self-reported minutes.
/// Free-form notes and model-generated material are never interpreted as measurements.
fn exercise_minutes(todo: &Todo, confirmed: Option<i64>) -> Option<i64> {
    if todo.kind != "exercise" || todo.status != "completed" {
        return None;
    }
    confirmed.filter(|value| (1..=360).contains(value))
}

pub(crate) fn reward_from_row(row: &AnyRow) -> Result<GrowthReward, DomainError> {
    let todo_id: String = row.try_get("todo_id")?;
    Ok(GrowthReward {
        id: format!("reward:{todo_id}"),
        todo_id,
        title: row.try_get("title")?,
        kind: row.try_get("kind")?,
        xp: row.try_get("points")?,
        active: row.try_get::<i64, _>("active")? != 0,
        earned_at: timestamp(row.try_get("earned_at")?),
        updated_at: timestamp(row.try_get("updated_at")?),
        version: row.try_get("version")?,
        local_date: row.try_get("local_date")?,
        timezone: row.try_get("timezone")?,
        minutes: row.try_get("minutes")?,
    })
}

pub(crate) async fn reward_in_transaction(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    todo_id: &str,
) -> Result<Option<GrowthReward>, DomainError> {
    sqlx::query("SELECT * FROM growth_rewards WHERE user_id=$1 AND todo_id=$2")
        .bind(user)
        .bind(todo_id)
        .fetch_optional(&mut **tx)
        .await?
        .as_ref()
        .map(reward_from_row)
        .transpose()
}

async fn record_fact(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    todo: &Todo,
    event_kind: &str,
    xp_delta: i64,
    receipt_version: i64,
) -> Result<(), DomainError> {
    // Facts contain no source text, draft, progress note or title copy.
    let fact = serde_json::json!({
        "status": todo.status,
        "xp_delta": xp_delta,
        "reward_version": receipt_version,
    });
    sqlx::query("INSERT INTO growth_events(id,user_id,todo_id,event_kind,created_at,body)VALUES($1,$2,$3,$4,$5,$6)")
        .bind(new_id()).bind(user).bind(&todo.id).bind(event_kind).bind(now())
        .bind(fact.to_string()).execute(&mut **tx).await?;
    Ok(())
}

/// Caller first applies the owned Todo CAS/action change and calls this before committing.
/// The preferences guard serializes different Todo receipts for the same user on both databases.
/// No provider, client-supplied points or AI execution state can mint a reward here.
pub(crate) async fn reconcile_reward(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    todo: &Todo,
    eligible: bool,
    event_kind: &str,
) -> Result<(), DomainError> {
    let owns_todo: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM todos WHERE user_id=$1 AND id=$2")
            .bind(user)
            .bind(&todo.id)
            .fetch_one(&mut **tx)
            .await?;
    if owns_todo == 0 {
        return Err(DomainError::NotFound);
    }
    let time = now();
    super::lock_preferences(tx, user).await?;
    let body: String = sqlx::query_scalar("SELECT body FROM growth_preferences WHERE user_id=$1")
        .bind(user)
        .fetch_one(&mut **tx)
        .await?;
    let enabled = decode_preferences(&body)?.enabled;
    let previous = reward_in_transaction(tx, user, &todo.id).await?;
    let deleted = event_kind == "deleted";
    let semantic_event = matches!(
        event_kind,
        "completed" | "restored" | "replied" | "undo_replied" | "deleted"
    );
    // An explicit correction of an existing receipt works after opting out too. New completions
    // during opt-out are not retroactively rewarded when the feature is switched on again.
    let creates_entitlement = matches!(event_kind, "completed" | "replied");
    if previous.is_none() && (!enabled || !eligible || deleted || !creates_entitlement) {
        if enabled && semantic_event {
            record_fact(tx, user, todo, event_kind, 0, 0).await?;
        }
        return Ok(());
    }
    let active = eligible && !deleted;
    let title = if deleted { "" } else { &todo.title };
    let confirmed_minutes: Option<i64> =
        if !deleted && todo.kind == "exercise" && todo.status == "completed" {
            sqlx::query_scalar::<_, Option<i64>>(
                "SELECT actual_minutes FROM growth_todo_actions WHERE user_id=$1 AND todo_id=$2",
            )
            .bind(user)
            .bind(&todo.id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten()
        } else {
            None
        };
    let minutes = if deleted {
        None
    } else {
        exercise_minutes(todo, confirmed_minutes)
    };
    let previous_net = previous
        .as_ref()
        .filter(|old| old.active)
        .map(|old| old.xp)
        .unwrap_or(0);
    let mut receipt_version = previous.as_ref().map(|old| old.version).unwrap_or(1);
    let mut changed = false;
    let points;
    if let Some(old) = previous {
        points = old.xp;
        if old.active != active
            || old.title != title
            || old.kind != todo.kind
            || old.minutes != minutes
        {
            sqlx::query("UPDATE growth_rewards SET active=$1,title=$2,kind=$3,minutes=$4,updated_at=$5,version=version+1 WHERE user_id=$6 AND todo_id=$7")
                .bind(i64::from(active)).bind(title).bind(&todo.kind).bind(minutes).bind(time)
                .bind(user).bind(&todo.id).execute(&mut **tx).await?;
            changed = true;
            receipt_version += 1;
        }
    } else {
        let timezone: String = sqlx::query_scalar("SELECT timezone FROM users WHERE id=$1")
            .bind(user)
            .fetch_one(&mut **tx)
            .await?;
        let date = local_date(&timezone, time)?.to_string();
        let focus: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items i JOIN growth_daily_plans p ON p.id=i.plan_id AND p.user_id=i.user_id WHERE i.user_id=$1 AND i.todo_id=$2 AND i.focus=1 AND i.status IN ('suggested','accepted') AND p.local_date=$3")
            .bind(user).bind(&todo.id).bind(&date).fetch_one(&mut **tx).await?;
        let mut bonus = false;
        if focus > 0 {
            // Keep this reservation even if its receipt is reversed. Undo must not free another
            // focus bonus while allowing the old receipt to be restored as well.
            sqlx::query("INSERT INTO growth_focus_days(user_id,local_date,todo_id)VALUES($1,$2,$3)ON CONFLICT(user_id,local_date)DO NOTHING")
                .bind(user).bind(&date).bind(&todo.id).execute(&mut **tx).await?;
            let winner: String = sqlx::query_scalar(
                "SELECT todo_id FROM growth_focus_days WHERE user_id=$1 AND local_date=$2",
            )
            .bind(user)
            .bind(&date)
            .fetch_one(&mut **tx)
            .await?;
            bonus = winner == todo.id;
        }
        points = if bonus { 20 } else { 10 };
        sqlx::query("INSERT INTO growth_rewards(user_id,todo_id,kind,title,points,active,earned_at,local_date,timezone,minutes,updated_at,version)VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$6,1)")
            .bind(user).bind(&todo.id).bind(&todo.kind).bind(title).bind(points).bind(time)
            .bind(date).bind(timezone).bind(minutes).execute(&mut **tx).await?;
        changed = true;
    }
    if changed || semantic_event {
        // A later closure of an already-replied Todo is a real fact with zero additional XP.
        // The state, audit delta and entitlement commit or roll back as one unit.
        let current_net = if active { points } else { 0 };
        record_fact(
            tx,
            user,
            todo,
            event_kind,
            current_net - previous_net,
            receipt_version,
        )
        .await?;
    }
    Ok(())
}

async fn total_xp(tx: &mut Transaction<'_, Any>, user: &str) -> Result<i64, DomainError> {
    Ok(sqlx::query_scalar("SELECT CAST(COALESCE(SUM(points),0) AS BIGINT) FROM growth_rewards WHERE user_id=$1 AND active=1")
        .bind(user).fetch_one(&mut **tx).await?)
}

impl Repository {
    pub async fn growth_reward_state(
        &self,
        user: &str,
        todo_id: &str,
    ) -> Result<GrowthRewardState, DomainError> {
        self.user(user).await?;
        let mut tx = self.pool.begin().await?;
        let owned = sqlx::query("SELECT id FROM todos WHERE user_id=$1 AND id=$2 UNION SELECT todo_id AS id FROM growth_rewards WHERE user_id=$1 AND todo_id=$2 LIMIT 1")
            .bind(user).bind(todo_id).fetch_optional(&mut *tx).await?;
        if owned.is_none() {
            return Err(DomainError::NotFound);
        }
        let reward = reward_in_transaction(&mut tx, user, todo_id).await?;
        let total_xp = total_xp(&mut tx, user).await?;
        tx.commit().await?;
        Ok(GrowthRewardState {
            reward,
            total_xp,
            level: 1 + total_xp / XP_PER_LEVEL,
        })
    }

    pub async fn growth_summary(&self, user: &str) -> Result<GrowthSummary, DomainError> {
        self.growth_summary_at(user, now()).await
    }

    pub(crate) async fn growth_summary_at(
        &self,
        user: &str,
        time: i64,
    ) -> Result<GrowthSummary, DomainError> {
        let owner = self.user(user).await?;
        let today = local_date(&owner.timezone, time)?;
        let start = today
            .checked_sub_days(Days::new(today.weekday().num_days_from_monday() as u64))
            .ok_or_else(|| internal("成长周日期超出范围"))?;
        let end = start
            .checked_add_days(Days::new(6))
            .ok_or_else(|| internal("成长周日期超出范围"))?;
        let mut tx = self.pool.begin().await?;
        if tx.backend_name() == "PostgreSQL" {
            // Totals and bounded records should describe one snapshot, not different concurrent
            // reward revisions. SQLite's transaction already provides a consistent read snapshot.
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx)
                .await?;
        }
        let stored: Option<String> =
            sqlx::query_scalar("SELECT body FROM growth_preferences WHERE user_id=$1")
                .bind(user)
                .fetch_optional(&mut *tx)
                .await?;
        let prefs = stored
            .as_deref()
            .map(decode_preferences)
            .transpose()?
            .unwrap_or_default();
        let total = total_xp(&mut tx, user).await?;
        let level = 1 + total / XP_PER_LEVEL;
        let rows = sqlx::query("SELECT local_date,COUNT(*) AS actions,CAST(COALESCE(SUM(points),0) AS BIGINT) AS xp FROM growth_rewards WHERE user_id=$1 AND active=1 AND local_date>=$2 AND local_date<=$3 GROUP BY local_date")
            .bind(user).bind(start.to_string()).bind(end.to_string()).fetch_all(&mut *tx).await?;
        let pauses = sqlx::query("SELECT local_date FROM growth_daily_plans WHERE user_id=$1 AND local_date>=$2 AND local_date<=$3 AND status='paused'")
            .bind(user).bind(start.to_string()).bind(end.to_string()).fetch_all(&mut *tx).await?;
        let mut days = Vec::with_capacity(7);
        for offset in 0..7 {
            let date = start
                .checked_add_days(Days::new(offset))
                .ok_or_else(|| internal("成长周日期超出范围"))?
                .to_string();
            let row = rows
                .iter()
                .find(|row| row.get::<String, _>("local_date") == date);
            let paused = prefs.paused_date.as_deref() == Some(date.as_str())
                || pauses
                    .iter()
                    .any(|row| row.get::<String, _>("local_date") == date);
            days.push(GrowthDay {
                date,
                action_count: row.map(|row| row.get::<i64, _>("actions")).unwrap_or(0),
                xp: row.map(|row| row.get::<i64, _>("xp")).unwrap_or(0),
                paused,
            });
        }
        let today_day = days
            .iter()
            .find(|day| day.date == today.to_string())
            .ok_or_else(|| internal("成长周记录缺少今日"))?;
        let today_info = GrowthToday {
            date: today.to_string(),
            timezone: owner.timezone,
            action_count: today_day.action_count,
            xp: today_day.xp,
            paused: today_day.paused,
        };
        let counts = sqlx::query("SELECT COUNT(*) AS all_actions,CAST(COALESCE(SUM(CASE WHEN kind='learning' THEN 1 ELSE 0 END),0) AS BIGINT) AS learning FROM growth_rewards WHERE user_id=$1 AND active=1")
            .bind(user).fetch_one(&mut *tx).await?;
        let week_counts = sqlx::query("SELECT CAST(COALESCE(SUM(CASE WHEN kind='communication' THEN 1 ELSE 0 END),0) AS BIGINT) AS communication,CAST(COALESCE(SUM(CASE WHEN kind='learning' THEN 1 ELSE 0 END),0) AS BIGINT) AS learning,CAST(COALESCE(SUM(CASE WHEN kind='exercise' THEN COALESCE(minutes,0) ELSE 0 END),0) AS BIGINT) AS exercise_minutes FROM growth_rewards WHERE user_id=$1 AND active=1 AND local_date>=$2 AND local_date<=$3")
            .bind(user).bind(start.to_string()).bind(end.to_string()).fetch_one(&mut *tx).await?;
        let records = sqlx::query("SELECT * FROM growth_rewards WHERE user_id=$1 AND active=1 AND local_date>=$2 AND local_date<=$3 ORDER BY earned_at DESC,todo_id DESC LIMIT 100")
            .bind(user).bind(start.to_string()).bind(end.to_string()).fetch_all(&mut *tx).await?
            .iter().map(reward_from_row).collect::<Result<Vec<_>,_>>()?;
        let finished_journeys:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_journeys j WHERE j.user_id=$1 AND EXISTS(SELECT 1 FROM growth_journey_steps s JOIN todos t ON t.user_id=s.user_id AND t.id=s.todo_id WHERE s.user_id=j.user_id AND s.journey_id=j.id AND t.status='completed') AND NOT EXISTS(SELECT 1 FROM growth_journey_steps s LEFT JOIN todos t ON t.user_id=s.user_id AND t.id=s.todo_id WHERE s.user_id=j.user_id AND s.journey_id=j.id AND s.skipped=0 AND (t.status IS NULL OR t.status<>'completed'))")
            .bind(user).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        let active_days = days.iter().filter(|day| day.action_count > 0).count() as i64;
        let lifetime_actions: i64 = counts.try_get("all_actions")?;
        let lifetime_learning: i64 = counts.try_get("learning")?;
        let available_halos = if level >= 5 {
            vec!["classic".into(), "sunrise".into(), "starlight".into()]
        } else if level >= 3 {
            vec!["classic".into(), "sunrise".into()]
        } else {
            vec!["classic".into()]
        };
        let halo = if available_halos.contains(&prefs.halo) {
            prefs.halo
        } else {
            "classic".into()
        };
        Ok(GrowthSummary {
            total_xp: total,
            level,
            level_xp: total % XP_PER_LEVEL,
            xp_per_level: XP_PER_LEVEL,
            halo,
            available_halos,
            today: today_info,
            week: GrowthWeek {
                start_date: start.to_string(),
                end_date: end.to_string(),
                active_days,
                days,
                communication_actions: week_counts.try_get("communication")?,
                learning_actions: week_counts.try_get("learning")?,
                exercise_minutes: week_counts.try_get("exercise_minutes")?,
                records,
            },
            milestones: vec![
                GrowthMilestone {
                    id: "first_action".into(),
                    title: "第一步".into(),
                    description: "确认完成自己的第一件行动".into(),
                    progress: lifetime_actions.min(1),
                    target: 1,
                    unlocked: lifetime_actions >= 1,
                },
                GrowthMilestone {
                    id: "learning_five".into(),
                    title: "练习在发生".into(),
                    description: "累计确认完成五次学习行动".into(),
                    progress: lifetime_learning.min(5),
                    target: 5,
                    unlocked: lifetime_learning >= 5,
                },
                GrowthMilestone {
                    id: "first_journey".into(),
                    title: "第一段旅程".into(),
                    description: "走完一段路线，并确认完成其中的实际行动".into(),
                    progress: finished_journeys.min(1),
                    target: 1,
                    unlocked: finished_journeys >= 1,
                },
                GrowthMilestone {
                    id: "weekly_four".into(),
                    title: "这一周在向前".into(),
                    description: "本周四天留下了实际行动".into(),
                    progress: active_days.min(4),
                    target: 4,
                    unlocked: active_days >= 4,
                },
                GrowthMilestone {
                    id: "sunrise".into(),
                    title: "晨光光环".into(),
                    description: "达到成长 Lv.3 解锁".into(),
                    progress: level.min(3),
                    target: 3,
                    unlocked: level >= 3,
                },
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_typed_bounded_confirmed_minutes_are_used() {
        let mut todo = Todo {
            id: "fixture".into(),
            title: "记录活动".into(),
            description: String::new(),
            kind: "exercise".into(),
            status: "completed".into(),
            source_kind: "manual".into(),
            source_label: "手动添加".into(),
            source_id: None,
            source_excerpt: None,
            due_at: None,
            estimated_minutes: Some(30),
            draft: None,
            progress_notes: None,
            linked_task_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            version: 1,
        };
        assert_eq!(exercise_minutes(&todo, None), None);
        todo.progress_notes = Some("模型/用户自由文本\n实际运动 23 分钟（自行记录）".into());
        assert_eq!(exercise_minutes(&todo, None), None);
        for value in [0, 361, 1000, -2] {
            assert_eq!(exercise_minutes(&todo, Some(value)), None);
        }
        for value in [1, 23, 360] {
            assert_eq!(exercise_minutes(&todo, Some(value)), Some(value));
        }
        todo.kind = "learning".into();
        assert_eq!(exercise_minutes(&todo, Some(23)), None);
        todo.kind = "exercise".into();
        todo.status = "pending".into();
        assert_eq!(exercise_minutes(&todo, Some(23)), None);
    }
}
