use super::*;
use crate::{DomainError, Repository, now};
use sqlx::Row;

impl Repository {
    pub async fn growth_preferences(&self, user: &str) -> Result<GrowthPreferences, DomainError> {
        let (today, timezone) = self.growth_user_date(user).await?;
        let row = sqlx::query("SELECT body,version FROM growth_preferences WHERE user_id=$1")
            .bind(user)
            .fetch_optional(&self.pool)
            .await?;
        let (stored, version) = match row {
            Some(r) => (
                parse::<StoredPreferences>(r.get("body"))?,
                r.get::<i64, _>("version"),
            ),
            None => (StoredPreferences::default(), 0),
        };
        Ok(GrowthPreferences {
            enabled: stored.enabled,
            daily_minutes: stored.daily_minutes,
            use_existing_todos: stored.use_existing_todos,
            goals: stored.goals,
            paused_today: stored.paused_date.as_deref() == Some(&today),
            timezone,
            version,
            halo: stored.halo,
        })
    }
    pub async fn update_growth_preferences(
        &self,
        user: &str,
        input: UpdateGrowthPreferences,
    ) -> Result<GrowthPreferences, DomainError> {
        let (today, _) = self.growth_user_date(user).await?;
        if let Some(minutes) = input.daily_minutes {
            if !(5..=120).contains(&minutes) {
                return Err(DomainError::Validation("每日时间需为5至120分钟".into()));
            }
        }
        if let Some(goals) = &input.goals {
            if goals.len() > 3 {
                return Err(DomainError::Validation("最多选择三个成长目标".into()));
            }
            let mut kinds = std::collections::HashSet::new();
            for goal in goals {
                if !["learning", "exercise", "general"].contains(&goal.kind.as_str())
                    || !kinds.insert(&goal.kind)
                {
                    return Err(DomainError::Validation("目标类型无效或重复".into()));
                }
                crate::validate_text(&goal.title, "目标", 100)?;
            }
        }
        if input
            .halo
            .as_deref()
            .is_some_and(|h| !["classic", "sunrise", "starlight"].contains(&h))
        {
            return Err(DomainError::Validation("光环类型无效".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, user).await?;
        let row = sqlx::query("SELECT body,version FROM growth_preferences WHERE user_id=$1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        let mut prefs: StoredPreferences = parse(row.get("body"))?;
        if input.version != row.get::<i64, _>("version") {
            return Err(DomainError::Conflict("成长设置已更新，请刷新".into()));
        }
        if let Some(v) = input.enabled {
            prefs.enabled = v;
        }
        if let Some(v) = input.daily_minutes {
            prefs.daily_minutes = v;
        }
        if let Some(v) = input.use_existing_todos {
            prefs.use_existing_todos = v;
        }
        if let Some(mut v) = input.goals {
            for g in &mut v {
                g.title = g.title.trim().to_owned();
            }
            prefs.goals = v;
        }
        if let Some(v) = input.paused_today {
            prefs.paused_date = v.then_some(today);
        }
        if let Some(v) = input.halo {
            if v == "sunrise" || v == "starlight" {
                let xp:i64=sqlx::query_scalar("SELECT CAST(COALESCE(SUM(points),0) AS BIGINT) FROM growth_rewards WHERE user_id=$1 AND active=1").bind(user).fetch_one(&mut *tx).await?;
                if xp < if v=="starlight" {240} else {120} {
                    return Err(DomainError::Validation(
                        if v=="starlight" {"达到成长Lv.5后可使用星光光环"} else {"达到成长Lv.3后可使用晨光光环"}.into(),
                    ));
                }
            }
            prefs.halo = v;
        }
        sqlx::query("UPDATE growth_preferences SET body=$1,version=version+1,last_active_at=$2 WHERE user_id=$3").bind(json(&prefs)?).bind(now()).bind(user).execute(&mut *tx).await?;
        tx.commit().await?;
        self.growth_preferences(user).await
    }
}
