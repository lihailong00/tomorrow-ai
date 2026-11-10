use crate::{new_id, now, repository::next_execution, timestamp, DomainError, Repository};
use serde::{Deserialize, Serialize};
use sqlx::{any::AnyRow, Row};

pub const KIND: &str = "daily_news";
pub(crate) const PREFIX: &str = "daily-news:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewsSettings {
    pub topics: Vec<String>,
    pub time: String,
    pub timezone: String,
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct NewsSubscription {
    #[serde(flatten)]
    pub settings: NewsSettings,
    pub next_run_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NewsJob {
    pub settings: NewsSettings,
    pub date: String,
    pub revision: String,
}

const TOPICS: &[&str] = &[
    "人工智能",
    "科技",
    "商业",
    "国际",
    "体育",
    "科学",
    "文化",
    "游戏",
];

impl NewsSettings {
    fn validate(&mut self) -> Result<(), DomainError> {
        self.topics.sort();
        self.topics.dedup();
        if self.topics.is_empty()
            || self.topics.len() > 4
            || self
                .topics
                .iter()
                .any(|topic| !TOPICS.contains(&topic.as_str()))
        {
            return Err(DomainError::Validation("请选择 1 至 4 个新闻主题".into()));
        }
        if self.time.len() != 5 {
            return Err(DomainError::Validation("时间格式应为 HH:MM".into()));
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct StoredSettings {
    settings: NewsSettings,
    revision: String,
}

fn subscription(row: AnyRow) -> Result<NewsSubscription, DomainError> {
    let mut stored: StoredSettings = serde_json::from_str(&row.get::<String, _>("prompt"))
        .map_err(|_| DomainError::Internal("新闻订阅格式无效".into()))?;
    stored.settings.enabled = row.get::<i64, _>("enabled") == 1;
    Ok(NewsSubscription {
        settings: stored.settings,
        next_run_at: (row.get::<i64, _>("enabled") == 1).then(|| timestamp(row.get("next_run_at"))),
    })
}

pub fn local_date(time: i64, timezone: &str) -> Option<String> {
    let zone: chrono_tz::Tz = timezone.parse().ok()?;
    Some(
        chrono::DateTime::from_timestamp(time, 0)?
            .with_timezone(&zone)
            .date_naive()
            .to_string(),
    )
}

pub(crate) fn occurrence(prompt: &str, due: i64, time: i64) -> Option<NewsJob> {
    let stored: StoredSettings = serde_json::from_str(prompt).ok()?;
    let date = local_date(time, &stored.settings.timezone)?;
    // A delayed worker can catch up today's briefing. A previous day's slot
    // never becomes a surprise delivery before today's selected hour.
    let next = next_execution(
        "daily",
        &stored.settings.time,
        &stored.settings.timezone,
        time,
        false,
    )
    .ok()?;
    if local_date(next, &stored.settings.timezone)? == date
        || due > time
        || !stored.settings.enabled
    {
        return None;
    }
    Some(NewsJob {
        settings: stored.settings,
        date,
        revision: stored.revision,
    })
}

impl Repository {
    pub async fn daily_news(&self, user: &str) -> Result<Option<NewsSubscription>, DomainError> {
        sqlx::query("SELECT prompt,enabled,next_run_at FROM schedules WHERE id=$1 AND user_id=$2")
            .bind(format!("{PREFIX}{user}"))
            .bind(user)
            .fetch_optional(&self.pool)
            .await?
            .map(subscription)
            .transpose()
    }

    pub async fn save_daily_news(
        &self,
        user: &str,
        mut settings: NewsSettings,
    ) -> Result<NewsSubscription, DomainError> {
        settings.validate()?;
        let time = now();
        let next = next_execution("daily", &settings.time, &settings.timezone, time, false)?;
        let stored = StoredSettings {
            settings,
            revision: new_id(),
        };
        let prompt = serde_json::to_string(&stored)
            .map_err(|_| DomainError::Internal("新闻订阅无法保存".into()))?;
        let row = sqlx::query("INSERT INTO schedules(id,user_id,title,prompt,frequency,time_of_day,timezone,enabled,next_run_at,created_at,updated_at) VALUES($1,$2,'每日新闻',$3,'daily',$4,$5,$6,$7,$8,$8) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,time_of_day=excluded.time_of_day,timezone=excluded.timezone,enabled=excluded.enabled,next_run_at=CASE WHEN schedules.time_of_day=excluded.time_of_day AND schedules.timezone=excluded.timezone AND schedules.enabled=excluded.enabled THEN schedules.next_run_at ELSE excluded.next_run_at END,updated_at=excluded.updated_at RETURNING prompt,enabled,next_run_at")
            .bind(format!("{PREFIX}{user}")).bind(user).bind(prompt).bind(&stored.settings.time)
            .bind(&stored.settings.timezone).bind(i64::from(stored.settings.enabled)).bind(next).bind(time)
            .fetch_one(&self.pool).await?;
        subscription(row)
    }

    pub async fn daily_news_notification(&self, user: &str) -> Result<Option<String>, DomainError> {
        let Some(subscription) = self
            .daily_news(user)
            .await?
            .filter(|item| item.settings.enabled)
        else {
            return Ok(None);
        };
        let row = sqlx::query("SELECT body,created_at FROM resources WHERE user_id=$1 AND kind='notification' AND id LIKE 'daily-news:%' ORDER BY created_at DESC,id DESC LIMIT 1")
            .bind(user).fetch_optional(&self.pool).await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let time = now();
        let zone = &subscription.settings.timezone;
        if local_date(row.get("created_at"), zone) != local_date(time, zone) {
            return Ok(None);
        }
        let item: crate::Notification = serde_json::from_str(&row.get::<String, _>("body"))
            .map_err(|_| DomainError::Internal("新闻通知格式无效".into()))?;
        Ok((!item.read).then_some(item.id))
    }

    pub async fn daily_news_job_current(
        &self,
        user: &str,
        job: &NewsJob,
    ) -> Result<bool, DomainError> {
        if local_date(now(), &job.settings.timezone).as_deref() != Some(job.date.as_str()) {
            return Ok(false);
        }
        let active = sqlx::query(
            "SELECT id FROM schedules WHERE id=$1 AND user_id=$2 AND enabled=1 AND prompt=$3",
        )
        .bind(format!("{PREFIX}{user}"))
        .bind(user)
        .bind(snapshot(job.clone())?)
        .fetch_optional(&self.pool)
        .await?;
        Ok(active.is_some())
    }
}

pub(crate) fn snapshot(job: NewsJob) -> Result<String, DomainError> {
    serde_json::to_string(&StoredSettings {
        settings: job.settings,
        revision: job.revision,
    })
    .map_err(|_| DomainError::Internal("新闻订阅格式无效".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn daily_news_runs_once_per_day_and_publishes_only_current_subscriptions() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let user = repo
            .create_user("news@example.test", "fixture", "订阅用户", "UTC")
            .await
            .unwrap();
        let other = repo
            .create_user("other-news@example.test", "fixture", "其他用户", "UTC")
            .await
            .unwrap();
        let settings = NewsSettings {
            topics: vec!["科技".into()],
            time: "00:00".into(),
            timezone: "UTC".into(),
            enabled: true,
        };
        repo.save_daily_news(&user.id, settings.clone())
            .await
            .unwrap();
        assert!(repo.daily_news(&other.id).await.unwrap().is_none());
        let schedule_id = format!("{PREFIX}{}", user.id);
        assert!(repo.schedules(&user.id).await.unwrap().is_empty());
        assert!(repo.delete_schedule(&user.id, &schedule_id).await.is_err());
        for offset in [120, 60] {
            sqlx::query("UPDATE schedules SET next_run_at=$1 WHERE id=$2")
                .bind(now() - offset)
                .bind(&schedule_id)
                .execute(&repo.pool)
                .await
                .unwrap();
            repo.tick_schedules().await.unwrap();
        }
        let claim = repo.claim_task(90).await.unwrap().unwrap();
        assert_eq!(claim.task.kind, KIND);
        assert!(repo.claim_task(90).await.unwrap().is_none());
        let article = "# 每日新闻\n\n[阅读原文](https://news.example.org/article)";
        assert!(repo.complete_task(&claim, article, "llm").await.unwrap());
        assert!(!repo.complete_task(&claim, article, "llm").await.unwrap());
        let id = repo
            .daily_news_notification(&user.id)
            .await
            .unwrap()
            .unwrap();
        assert!(repo
            .daily_news_notification(&other.id)
            .await
            .unwrap()
            .is_none());
        repo.read_notification(&user.id, &id).await.unwrap();
        assert!(repo
            .daily_news_notification(&user.id)
            .await
            .unwrap()
            .is_none());

        let job: NewsJob = serde_json::from_str(&claim.task.instruction).unwrap();
        assert!(repo.daily_news_job_current(&user.id, &job).await.unwrap());
        repo.save_daily_news(
            &user.id,
            NewsSettings {
                enabled: false,
                ..settings
            },
        )
        .await
        .unwrap();
        assert!(!repo.daily_news_job_current(&user.id, &job).await.unwrap());
    }
}
