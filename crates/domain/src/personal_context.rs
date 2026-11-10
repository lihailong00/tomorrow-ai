use chrono::{DateTime, Datelike, Days, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Serialize;

use crate::todos::Todo;
use crate::{DomainError, Message, Repository};

const MAX_AVAILABILITY_MINUTES: i64 = 24 * 60;
const AGENDA_LIMIT: usize = 20;

fn number(text: &str) -> Option<i64> {
    fn digit(ch: char) -> Option<i64> {
        "零一二三四五六七八九"
            .chars()
            .position(|c| c == ch)
            .map(|n| n as i64)
            .or_else(|| (ch == '两').then_some(2))
    }
    if let Ok(value) = text.parse::<i64>() {
        return Some(value);
    }
    match text.chars().collect::<Vec<_>>().as_slice() {
        [one] => digit(*one).or_else(|| (*one == '十').then_some(10)),
        ['十', one] => Some(10 + digit(*one)?),
        [ten, '十'] => Some(digit(*ten)? * 10),
        [ten, '十', one] => Some(digit(*ten)? * 10 + digit(*one)?),
        _ => None,
    }
}

// The input must start with an explicit first-person current-state statement.
// Accept a single availability clause, optionally followed by a stated intent.
fn availability_statement(text: &str) -> Option<(i64, Option<&str>)> {
    let text = text.trim().trim_end_matches(['。', '！', '!', '.']);
    let rest = text
        .strip_prefix("我现在")
        .or_else(|| text.strip_prefix("我这会儿"))?;
    let rest = rest.trim_start();
    if matches!(
        rest,
        "没空" | "没空了" | "没有空闲时间了" | "没时间了" | "已经没空了" | "没有时间了"
    ) {
        return Some((0, None));
    }
    let rest = rest
        .strip_prefix("还有")
        .or_else(|| rest.strip_prefix('有'))?
        .trim_start();
    let (clause, goal) = rest.split_once(['，', ',']).unwrap_or_else(|| {
        ["打算", "准备", "想", "计划"]
            .into_iter()
            .filter_map(|word| rest.find(word))
            .filter(|index| *index > 0)
            .min()
            .map(|index| (rest[..index].trim_end_matches('要'), &rest[index..]))
            .unwrap_or((rest, ""))
    });
    let goal = goal.trim().trim_start_matches('我');
    if !goal.is_empty()
        && (!["打算", "想", "准备", "计划"]
            .iter()
            .any(|word| goal.starts_with(*word))
            || goal.contains(['。', '？', '?', '！', '!', '，', ',', '\n', '；', ';'])
            || goal.chars().count() > 80)
    {
        return None;
    }
    let goal = (!goal.is_empty()).then_some(goal);
    let duration = [
        "空闲时间",
        "空闲",
        "的空闲时间",
        "的空闲",
        "时间",
        "空余时间",
        "空余",
        "的空",
    ]
    .iter()
    .filter_map(|suffix| clause.trim().strip_suffix(*suffix))
    .find_map(|value| {
        let value = value.trim_end();
        if matches!(value, "半小时" | "半个小时" | "半钟头") {
            return Some(30);
        }
        if let Some(value) = value.strip_suffix("分钟") {
            return number(value.trim_end());
        }
        let hours = value
            .strip_suffix("小时")?
            .trim_end()
            .trim_end_matches('个')
            .trim_end();
        number(hours)?.checked_mul(60)
    })?;
    (1..=MAX_AVAILABILITY_MINUTES)
        .contains(&duration)
        .then_some((duration, goal))
}

pub(crate) fn is_availability_statement(text: &str) -> bool {
    availability_statement(text).is_some()
}

pub fn needs_availability(text: &str) -> bool {
    let text = text.trim().trim_end_matches(['？', '?', '。']);
    is_availability_statement(text)
        || matches!(text, "还有多久" | "我还有多久" | "还剩多久" | "我还剩多久")
        || [
            "还剩多少时间",
            "还有多少时间",
            "还有多少空闲",
            "现在学什么",
            "现在可以学",
            "现在能学",
            "现在做什么",
            "空闲时间",
        ]
        .iter()
        .any(|term| text.contains(*term))
}

#[derive(Serialize)]
pub struct CurrentAvailability {
    pub observed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub remaining_minutes: i64,
    pub intent: Option<String>,
    pub source_message_id: String,
    pub source_conversation_id: String,
}

#[derive(Serialize)]
pub struct AgendaWindow {
    pub start: DateTime<Tz>,
    pub end_exclusive: DateTime<Tz>,
}

impl AgendaWindow {
    pub fn from_question(text: &str, timezone: Tz, now: DateTime<Utc>) -> Option<Self> {
        let text = text.trim().trim_end_matches(['？', '?', '。']);
        let named = ["待办", "日程", "安排", "行程"]
            .iter()
            .any(|term| text.contains(*term));
        let asking = [
            "做什么",
            "做啥",
            "干什么",
            "干嘛",
            "有什么事",
            "有事吗",
            "有什么计划",
        ]
        .iter()
        .any(|term| text.contains(*term));
        let personal = [
            "我的待办",
            "我的日程",
            "我的安排",
            "我的行程",
            "查一下",
            "帮我看",
            "有哪些",
            "有啥",
            "有什么",
            "看一下",
        ]
        .iter()
        .any(|term| text.contains(*term))
            || ["待办", "日程", "安排", "行程"]
                .iter()
                .any(|term| text.ends_with(*term));
        if !(asking || named && personal) {
            return None;
        }
        let today = now.with_timezone(&timezone).date_naive();
        let monday =
            today.checked_sub_days(Days::new(today.weekday().num_days_from_monday().into()))?;
        let (start, days) = if text.contains("下周末") {
            (monday.checked_add_days(Days::new(12))?, 2)
        } else if text.contains("周末") {
            (monday.checked_add_days(Days::new(5))?, 2)
        } else if text.contains("下周") {
            (monday.checked_add_days(Days::new(7))?, 7)
        } else if text.contains("这周") || text.contains("本周") {
            (monday, 7)
        } else if text.contains("后天") {
            (today.checked_add_days(Days::new(2))?, 1)
        } else if text.contains("明天") {
            (today.checked_add_days(Days::new(1))?, 1)
        } else if text.contains("今天") {
            (today, 1)
        } else if named && personal {
            (today, 7)
        } else {
            return None;
        };
        let midnight = |day: NaiveDate| {
            // A zone may skip midnight at a clock change.
            (0..24).find_map(|hour| {
                timezone
                    .from_local_datetime(&day.and_hms_opt(hour, 0, 0)?)
                    .earliest()
            })
        };
        Some(Self {
            start: midnight(start)?,
            end_exclusive: midnight(start.checked_add_days(Days::new(days))?)?,
        })
    }
}

impl Repository {
    pub async fn current_availability(
        &self,
        user: &str,
        current: &Message,
        now: DateTime<Utc>,
    ) -> Result<Option<CurrentAvailability>, DomainError> {
        let read = |message: &Message| {
            if message.role != "user" {
                return None;
            }
            let (minutes, goal) = availability_statement(&message.content)?;
            let observed_at = DateTime::parse_from_rfc3339(&message.created_at)
                .ok()?
                .with_timezone(&Utc);
            if observed_at > now {
                return None;
            }
            let expires_at = observed_at.checked_add_signed(Duration::minutes(minutes))?;
            let remaining = expires_at.signed_duration_since(now).num_milliseconds();
            Some(CurrentAvailability {
                observed_at,
                expires_at,
                remaining_minutes: (remaining.max(0) + 59_999) / 60_000,
                intent: goal.map(str::to_owned),
                source_message_id: message.id.clone(),
                source_conversation_id: message.conversation_id.clone(),
            })
        };
        let mut latest = read(current);
        if !self.memory_preferences(user).await?.enabled {
            return Ok(latest.filter(|state| state.expires_at > now));
        }
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT r.body FROM resources r JOIN chat_message_turns t ON t.user_id=r.user_id AND t.user_message_id=r.id
             JOIN resources c ON c.id=t.conversation_id AND c.user_id=r.user_id AND c.kind='conversation'
             WHERE r.user_id=$1 AND r.kind='message' AND r.created_at >= $2 AND r.id<>$3
               AND t.deleted=0 AND t.assistant_id IS NOT NULL
               AND (r.body LIKE '%我现在%' OR r.body LIKE '%我这会儿%')
             ORDER BY r.created_at DESC,r.id DESC LIMIT 200",
        )
        .bind(user)
        .bind((now - Duration::minutes(MAX_AVAILABILITY_MINUTES)).timestamp())
        .bind(&current.id)
        .fetch_all(&self.pool).await?;
        for body in rows {
            let state = serde_json::from_str::<Message>(&body)
                .ok()
                .and_then(|m| read(&m));
            if let Some(state) = state.filter(|s| {
                latest
                    .as_ref()
                    .is_none_or(|l| s.observed_at > l.observed_at)
            }) {
                latest = Some(state);
            }
        }
        // Check expiry after selecting the latest observation so an older,
        // longer window cannot return after a correction or cancellation.
        Ok(latest.filter(|state| state.expires_at > now))
    }

    pub async fn agenda_todos(
        &self,
        user: &str,
        window: &AgendaWindow,
    ) -> Result<(Vec<Todo>, bool), DomainError> {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT body FROM todos WHERE user_id=$1 AND due_at >= $2 AND due_at < $3
             AND status IN ('pending','in_progress','waiting') ORDER BY due_at,id LIMIT $4",
        )
        .bind(user)
        .bind(window.start.timestamp())
        .bind(window.end_exclusive.timestamp())
        .bind((AGENDA_LIMIT + 1) as i64)
        .fetch_all(&self.pool)
        .await?;
        let truncated = rows.len() > AGENDA_LIMIT;
        let todos = rows
            .iter()
            .take(AGENDA_LIMIT)
            .map(|body| {
                serde_json::from_str(body).map_err(|e| DomainError::Internal(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((todos, truncated))
    }
}
