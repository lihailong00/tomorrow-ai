use crate::dto::*;
use crate::{auth, new_id, now, timestamp, validate_text, DomainError};
use serde::{de::DeserializeOwned, Serialize};
use sqlx::{
    any::{AnyPoolOptions, AnyRow},
    AnyPool, Row,
};

#[derive(Clone)]
pub struct Repository {
    pub(crate) pool: AnyPool,
}

pub const MAX_TASK_ATTEMPTS: i64 = 3;

impl Repository {
    pub fn pool(&self) -> AnyPool {
        self.pool.clone()
    }
    pub async fn update_user(
        &self,
        user_id: &str,
        name: Option<&str>,
        timezone: Option<&str>,
    ) -> Result<User, DomainError> {
        let old = self.user(user_id).await?;
        let name = validate_text(name.unwrap_or(&old.name), "昵称", 80)?;
        let timezone = timezone.unwrap_or(&old.timezone);
        if timezone.parse::<chrono_tz::Tz>().is_err() {
            return Err(DomainError::Validation("无效的 IANA 时区".into()));
        }
        sqlx::query("UPDATE users SET name=$1,timezone=$2 WHERE id=$3")
            .bind(name)
            .bind(timezone)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        self.user(user_id).await
    }

    pub async fn memories(&self, user_id: &str) -> Result<Vec<Memory>, DomainError> {
        Ok(self.memories_page(user_id, None, 0, 500).await?.0)
    }
    pub async fn memories_page(
        &self,
        user_id: &str,
        kind: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<Memory>, Option<i64>), DomainError> {
        validate_page(offset, limit)?;
        if let Some(kind) = kind {
            memory_kind(kind)?;
        }
        let mut connection = self.pool.acquire().await?;
        // Memory categories live in JSON; apply them in SQL before the page limit.
        let category = if connection.backend_name() == "PostgreSQL" {
            "CAST(body AS JSONB)->>'kind'"
        } else {
            "json_extract(body, '$.kind')"
        };
        let query = format!("SELECT body FROM resources WHERE user_id=$1 AND kind='memory' AND ($2='' OR {category}=$2) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4");
        let rows = sqlx::query(&query)
            .bind(user_id).bind(kind.unwrap_or(""))
            .bind(limit + 1).bind(offset)
            .fetch_all(&mut *connection).await?;
        let items = rows.into_iter().map(|row| {
            serde_json::from_str(row.get::<&str, _>("body"))
                .map_err(|e| DomainError::Internal(e.to_string()))
        }).collect::<Result<Vec<Memory>, _>>()?;
        Ok(finish_page(items, offset, limit))
    }
    pub async fn create_memory(
        &self,
        user_id: &str,
        input: CreateMemory,
    ) -> Result<Memory, DomainError> {
        memory_kind(&input.kind)?;
        let content = validate_text(&input.content, "记忆内容", 10000)?;
        let title = match input.title.as_deref().filter(|value| !value.trim().is_empty()) {
            Some(value) => validate_text(value, "标题", 120)?,
            None => validate_text(&content, "标题", 120)
                .unwrap_or_else(|_| content.chars().take(40).collect()),
        };
        let time = timestamp(now());
        let memory = Memory {
            id: new_id(),
            title,
            content,
            kind: input.kind,
            source: input.source.unwrap_or_else(|| "用户手动创建".into()),
            created_at: time.clone(),
            updated_at: time,
            version: 1,
        };
        self.put_resource(user_id, "memory", &memory.id, &memory)
            .await?;
        Ok(memory)
    }
    pub async fn update_memory(
        &self,
        user_id: &str,
        id: &str,
        input: UpdateMemory,
    ) -> Result<Memory, DomainError> {
        let old: Memory = self.resource(user_id, "memory", id).await?;
        if input.version.is_some_and(|v| v != old.version) {
            return Err(DomainError::Conflict("记忆已被更新，请刷新后再修改".into()));
        }
        let mut memory = old.clone();
        if let Some(value) = input.title {
            memory.title = validate_text(&value, "标题", 120)?;
        }
        if let Some(value) = input.content {
            // Previously created overlong memories must remain editable without
            // requiring the user to discard their original information.
            if value != old.content {
                memory.content = validate_text(&value, "记忆内容", 10000)?;
            }
        }
        if let Some(value) = input.kind {
            memory_kind(&value)?;
            memory.kind = value;
        }
        memory.updated_at = timestamp(now());
        memory.version += 1;
        let old_json =
            serde_json::to_string(&old).map_err(|e| DomainError::Internal(e.to_string()))?;
        let new_json =
            serde_json::to_string(&memory).map_err(|e| DomainError::Internal(e.to_string()))?;
        let changed=sqlx::query("UPDATE resources SET body=$1,updated_at=$2 WHERE user_id=$3 AND id=$4 AND kind='memory' AND body=$5")
            .bind(new_json).bind(now()).bind(user_id).bind(id).bind(old_json).execute(&self.pool).await?.rows_affected();
        if changed == 0 {
            return Err(DomainError::Conflict("记忆已被更新，请刷新后再修改".into()));
        }
        Ok(memory)
    }
    pub async fn create_task(&self, user_id: &str, input: CreateTask) -> Result<Task, DomainError> {
        let instruction = validate_text(&input.instruction, "任务要求", 20000)?;
        let title = input
            .title
            .map(|s| validate_text(&s, "标题", 120))
            .transpose()?
            .unwrap_or_else(|| instruction.chars().take(32).collect());
        let kind = input.kind.unwrap_or_else(|| "general".into());
        if !["general", "research", "briefing", "draft", "organize"].contains(&kind.as_str()) {
            return Err(DomainError::Validation("不支持的任务类型".into()));
        }
        let key = input
            .client_request_id
            .map(|v| validate_text(&v, "请求编号", 120).map(|v| format!("{user_id}:{v}")))
            .transpose()?;
        let id = new_id();
        let time = now();
        let approval = input.approval_required.unwrap_or(false);
        sqlx::query("INSERT INTO tasks (id,user_id,title,prompt,kind,status,requires_approval,approval_summary,created_at,updated_at,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT(idempotency_key) DO NOTHING")
            .bind(&id).bind(user_id).bind(&title).bind(&instruction).bind(&kind).bind(if approval{"waiting_approval"}else{"queued"}).bind(if approval{1_i64}else{0}).bind(if approval{Some(instruction.as_str())}else{None}).bind(time).bind(&key).execute(&self.pool).await?;
        if let Some(key) = key {
            let row = sqlx::query("SELECT * FROM tasks WHERE user_id=$1 AND idempotency_key=$2")
                .bind(user_id)
                .bind(key)
                .fetch_one(&self.pool)
                .await?;
            if row.get::<String, _>("title") != title
                || row.get::<String, _>("prompt") != instruction
                || row.get::<String, _>("kind") != kind
                || (row.get::<i64, _>("requires_approval") != 0) != approval
            {
                return Err(DomainError::Conflict(
                    "同一任务请求编号不能用于不同内容，请使用新的请求编号".into(),
                ));
            }
            return task_from(&row);
        }
        self.task(user_id, &id).await
    }
    pub async fn tasks(&self, user_id: &str) -> Result<Vec<Task>, DomainError> {
        Ok(self.tasks_page(user_id, "all", 0, 500).await?.0)
    }
    pub async fn tasks_page(
        &self,
        user_id: &str,
        status: &str,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<Task>, Option<i64>), DomainError> {
        validate_page(offset, limit)?;
        if !["all", "active", "done", "queued", "running", "waiting_approval", "succeeded", "failed", "cancelled", "uncertain"].contains(&status) {
            return Err(DomainError::Validation("无效的任务状态".into()));
        }
        let items = sqlx::query(
            "SELECT * FROM tasks WHERE user_id=$1 AND ($2='all' OR status=$2 OR ($2='active' AND status IN ('queued','running','waiting_approval','uncertain')) OR ($2='done' AND status='succeeded')) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4",
        )
        .bind(user_id).bind(status).bind(limit + 1).bind(offset)
        .fetch_all(&self.pool)
        .await?
        .iter()
        .map(task_from)
        .collect::<Result<Vec<Task>, _>>()?;
        Ok(finish_page(items, offset, limit))
    }
    pub async fn task(&self, user_id: &str, id: &str) -> Result<Task, DomainError> {
        let row = sqlx::query("SELECT * FROM tasks WHERE user_id=$1 AND id=$2")
            .bind(user_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::NotFound)?;
        task_from(&row)
    }
    pub async fn cancel_task(&self, user_id: &str, id: &str) -> Result<Task, DomainError> {
        let old = self.task(user_id, id).await?;
        if ["succeeded", "failed", "cancelled", "uncertain"].contains(&old.status.as_str()) {
            return Ok(old);
        }
        sqlx::query("UPDATE tasks SET status='cancelled',updated_at=$1,claimed_until=0 WHERE user_id=$2 AND id=$3 AND status IN ('queued','running','waiting_approval')").bind(now()).bind(user_id).bind(id).execute(&self.pool).await?;
        self.task(user_id, id).await
    }
    pub async fn approve_task(&self, user_id: &str, id: &str) -> Result<Task, DomainError> {
        let old = self.task(user_id, id).await?;
        if old.approved_at.is_some() {
            return Ok(old);
        }
        if old.status != "waiting_approval" {
            return Err(DomainError::Conflict("任务当前不在等待确认".into()));
        }
        sqlx::query("UPDATE tasks SET status='queued',approved_at=$1,updated_at=$2 WHERE user_id=$3 AND id=$4 AND status='waiting_approval' AND approval_summary=prompt")
            .bind(timestamp(now())).bind(now()).bind(user_id).bind(id).execute(&self.pool).await?;
        self.task(user_id, id).await
    }
    pub async fn claim_task(&self, lease_seconds: i64) -> Result<Option<ClaimedTask>, DomainError> {
        let time = now();
        let rows=sqlx::query("SELECT * FROM tasks WHERE ((status='queued' AND next_attempt_at<=$1) OR (status='running' AND claimed_until<$1)) AND (requires_approval=0 OR approved_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=tasks.user_id AND c.disabled<>0) ORDER BY created_at LIMIT 10").bind(time).fetch_all(&self.pool).await?;
        for row in rows {
            let id: String = row.get("id");
            let attempts: i64 = row.get("attempts");
            let user_id: String = row.get("user_id");
            if attempts >= MAX_TASK_ATTEMPTS {
                sqlx::query("UPDATE tasks SET status='failed',error='任务执行多次中断，请重新发起',updated_at=$1 WHERE id=$2 AND attempts=$3 AND status='running' AND claimed_until<$1").bind(time).bind(&id).bind(attempts).execute(&self.pool).await?;
                continue;
            }
            let updated=sqlx::query("UPDATE tasks SET status='running',progress=15,attempts=attempts+1,claimed_until=$1,updated_at=$2,error=NULL WHERE id=$3 AND attempts=$4 AND ((status='queued' AND next_attempt_at<=$2) OR (status='running' AND claimed_until<$2)) AND (requires_approval=0 OR approved_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=tasks.user_id AND c.disabled<>0)")
                .bind(time+lease_seconds.clamp(10,3600)).bind(time).bind(&id).bind(attempts).execute(&self.pool).await?.rows_affected();
            if updated > 0 {
                return Ok(Some(ClaimedTask {
                    task: self.task(&user_id, &id).await?,
                    user_id,
                    attempt: attempts + 1,
                }));
            }
        }
        Ok(None)
    }
    pub async fn renew_task(
        &self,
        claim: &ClaimedTask,
        lease_seconds: i64,
    ) -> Result<bool, DomainError> {
        Ok(sqlx::query("UPDATE tasks SET claimed_until=$1 WHERE id=$2 AND user_id=$3 AND status='running' AND attempts=$4 AND claimed_until>=$5 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=tasks.user_id AND c.disabled<>0)").bind(now()+lease_seconds.clamp(10,3600)).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).bind(now()).execute(&self.pool).await?.rows_affected()>0)
    }
    pub async fn complete_task(
        &self,
        claim: &ClaimedTask,
        content: &str,
        model_mode: &str,
    ) -> Result<bool, DomainError> {
        let mut transaction = self.pool.begin().await?;
        let time = now();
        let artifact_id = new_id();
        let changed=sqlx::query("UPDATE tasks SET status='succeeded',progress=100,result=$1,summary=$2,model_mode=$3,artifact_id=$4,error=NULL,claimed_until=0,updated_at=$5 WHERE id=$6 AND user_id=$7 AND status='running' AND attempts=$8 AND claimed_until>=$5")
            .bind(content).bind(content.chars().take(160).collect::<String>()).bind(model_mode).bind(&artifact_id).bind(time).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).execute(&mut *transaction).await?.rows_affected();
        if changed == 0 {
            transaction.rollback().await?;
            return Ok(false);
        }
        let artifact = Artifact {
            id: artifact_id,
            title: claim.task.title.clone(),
            task_id: claim.task.id.clone(),
            content: content.to_owned(),
            mime_type: "text/markdown; charset=utf-8".into(),
            created_at: timestamp(time),
        };
        let notification = Notification {
            id: new_id(),
            title: "任务已完成".into(),
            body: claim.task.title.clone(),
            task_id: Some(claim.task.id.clone()),
            read: false,
            created_at: timestamp(time),
        };
        for (kind, id, body) in [
            (
                "artifact",
                artifact.id.clone(),
                serde_json::to_string(&artifact),
            ),
            (
                "notification",
                notification.id.clone(),
                serde_json::to_string(&notification),
            ),
        ] {
            let body = body.map_err(|e| DomainError::Internal(e.to_string()))?;
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$5)").bind(id).bind(&claim.user_id).bind(kind).bind(body).bind(time).execute(&mut *transaction).await?;
        }
        transaction.commit().await?;
        Ok(true)
    }
    pub async fn fail_task(
        &self,
        claim: &ClaimedTask,
        error: &str,
        retry: bool,
    ) -> Result<bool, DomainError> {
        let retry = retry && claim.attempt < MAX_TASK_ATTEMPTS;
        Ok(sqlx::query("UPDATE tasks SET status=$1,error=$2,progress=0,next_attempt_at=$3,claimed_until=0,updated_at=$4 WHERE id=$5 AND user_id=$6 AND status='running' AND attempts=$7 AND claimed_until>=$4")
            .bind(if retry{"queued"}else{"failed"}).bind(error.chars().take(500).collect::<String>()).bind(now()+5*2_i64.pow(claim.attempt.min(6)as u32)).bind(now()).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).execute(&self.pool).await?.rows_affected()>0)
    }

    /// Persist the selected execution route before generation, including failed attempts.
    pub async fn record_task_model_mode(
        &self,
        claim: &ClaimedTask,
        mode: &str,
    ) -> Result<bool, DomainError> {
        if !matches!(mode, "local" | "llm") {
            return Err(DomainError::Validation("任务模型模式无效".into()));
        }
        Ok(sqlx::query("UPDATE tasks SET model_mode=$1 WHERE id=$2 AND user_id=$3 AND status='running' AND attempts=$4 AND claimed_until>=$5 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=tasks.user_id AND c.disabled<>0)")
            .bind(mode).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).bind(now())
            .execute(&self.pool).await?.rows_affected() == 1)
    }
    pub async fn schedules(&self, user_id: &str) -> Result<Vec<Schedule>, DomainError> {
        sqlx::query("SELECT * FROM schedules WHERE user_id=$1 ORDER BY created_at DESC")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(schedule_from)
            .collect()
    }
    pub async fn schedule(&self, user_id: &str, id: &str) -> Result<Schedule, DomainError> {
        let row = sqlx::query("SELECT * FROM schedules WHERE user_id=$1 AND id=$2")
            .bind(user_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::NotFound)?;
        schedule_from(&row)
    }
    pub async fn create_schedule(
        &self,
        user_id: &str,
        input: CreateSchedule,
    ) -> Result<Schedule, DomainError> {
        let title = validate_text(&input.title, "计划名称", 120)?;
        let instruction = validate_text(&input.instruction, "计划内容", 20000)?;
        let next = next_execution(&input.frequency, &input.time, &input.timezone, now(), false)?;
        let id = new_id();
        sqlx::query("INSERT INTO schedules(id,user_id,title,prompt,frequency,time_of_day,timezone,enabled,next_run_at,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)")
            .bind(&id).bind(user_id).bind(title).bind(instruction).bind(input.frequency).bind(input.time).bind(input.timezone).bind(if input.enabled.unwrap_or(true){1_i64}else{0}).bind(next).bind(now()).execute(&self.pool).await?;
        self.schedule(user_id, &id).await
    }
    pub async fn update_schedule(
        &self,
        user_id: &str,
        id: &str,
        input: UpdateSchedule,
    ) -> Result<Schedule, DomainError> {
        let old = self.schedule(user_id, id).await?;
        let title = validate_text(
            input.title.as_deref().unwrap_or(&old.title),
            "计划名称",
            120,
        )?;
        let instruction = validate_text(
            input.instruction.as_deref().unwrap_or(&old.instruction),
            "计划内容",
            20000,
        )?;
        let previous_frequency = old.frequency.clone();
        let frequency = input.frequency.unwrap_or(old.frequency);
        let time = input.time.unwrap_or(old.time);
        let timezone = input.timezone.unwrap_or_else(|| old.timezone.clone());
        let next = if frequency == "weekly" && previous_frequency == "weekly" {
            let anchor = chrono::DateTime::parse_from_rfc3339(&old.next_run_at)
                .map_err(|_| DomainError::Internal("计划时间无效".into()))?
                .timestamp();
            // The stored occurrence anchors a weekday in its original timezone.
            // Reinterpreting its instant in the new timezone can shift that weekday.
            let old_zone: chrono_tz::Tz = old.timezone.parse()
                .map_err(|_| DomainError::Validation("无效的 IANA 时区".into()))?;
            use chrono::Datelike;
            let weekday = chrono::DateTime::from_timestamp(anchor, 0)
                .ok_or_else(|| DomainError::Validation("无效的计划日期".into()))?
                .with_timezone(&old_zone).weekday();
            next_weekday_execution(&time, &timezone, weekday, now())?
        } else {
            next_execution(&frequency, &time, &timezone, now(), false)?
        };
        sqlx::query("UPDATE schedules SET title=$1,prompt=$2,frequency=$3,time_of_day=$4,timezone=$5,enabled=$6,next_run_at=$7,updated_at=$8 WHERE user_id=$9 AND id=$10")
            .bind(title).bind(instruction).bind(frequency).bind(time).bind(timezone).bind(if input.enabled.unwrap_or(old.enabled){1_i64}else{0}).bind(next).bind(now()).bind(user_id).bind(id).execute(&self.pool).await?;
        self.schedule(user_id, id).await
    }
    pub async fn delete_schedule(&self, user_id: &str, id: &str) -> Result<(), DomainError> {
        let rows = sqlx::query("DELETE FROM schedules WHERE user_id=$1 AND id=$2")
            .bind(user_id)
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if rows == 0 {
            return Err(DomainError::NotFound);
        }
        Ok(())
    }
    pub async fn tick_schedules(&self) -> Result<usize, DomainError> {
        let time = now();
        let rows=sqlx::query("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=$1 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=schedules.user_id AND c.disabled<>0) ORDER BY next_run_at LIMIT 100").bind(time).fetch_all(&self.pool).await?;
        let mut count = 0;
        for row in rows {
            let schedule = schedule_from(&row)?;
            let user_id: String = row.get("user_id");
            let due: i64 = row.get("next_run_at");
            // Coalesce missed recurring runs into one; a persisted occurrence key prevents duplicate dispatch.
            let next = if schedule.frequency == "weekly" {
                next_weekly_execution(&schedule.time, &schedule.timezone, due, time)?
            } else {
                next_execution(
                    &schedule.frequency,
                    &schedule.time,
                    &schedule.timezone,
                    time,
                    true,
                )?
            };
            let mut transaction = self.pool.begin().await?;
            let changed=sqlx::query("UPDATE schedules SET next_run_at=$1,last_run_at=$2,enabled=$3,updated_at=$2 WHERE id=$4 AND user_id=$5 AND enabled=1 AND next_run_at=$6 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=schedules.user_id AND c.disabled<>0)")
                .bind(next).bind(time).bind(if schedule.frequency=="once"{0_i64}else{1}).bind(&schedule.id).bind(&user_id).bind(due).execute(&mut *transaction).await?.rows_affected();
            if changed == 0 {
                transaction.rollback().await?;
                continue;
            }
            let key = format!("schedule:{}:{due}", schedule.id);
            sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at,schedule_id,idempotency_key)VALUES($1,$2,$3,$4,'briefing','queued',$5,$5,$6,$7)ON CONFLICT(idempotency_key)DO NOTHING")
                .bind(new_id()).bind(user_id).bind(schedule.title).bind(schedule.instruction).bind(time).bind(schedule.id).bind(key).execute(&mut *transaction).await?;
            transaction.commit().await?;
            count += 1;
        }
        Ok(count)
    }
    pub async fn conversations(&self, user_id: &str) -> Result<Vec<Conversation>, DomainError> {
        Ok(self.conversations_page(user_id, 0, 500).await?.0)
    }
    pub async fn conversations_page(
        &self, user_id: &str, offset: i64, limit: i64,
    ) -> Result<(Vec<Conversation>, Option<i64>), DomainError> {
        self.resources_page(user_id, "conversation", None, offset, limit).await
    }
    pub async fn conversation(&self, user_id: &str, id: &str) -> Result<Conversation, DomainError> {
        self.resource(user_id, "conversation", id).await
    }
    pub async fn create_conversation(
        &self,
        user_id: &str,
        title: &str,
    ) -> Result<Conversation, DomainError> {
        let conversation = Conversation {
            id: new_id(),
            title: title.chars().take(40).collect(),
            updated_at: timestamp(now()),
        };
        self.put_resource(user_id, "conversation", &conversation.id, &conversation)
            .await?;
        Ok(conversation)
    }
    pub async fn messages(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<Message>, DomainError> {
        self.conversation(user_id, conversation_id).await?;
        // Filter by conversation before limiting, so activity in other chats
        // cannot evict the visible history of an older conversation.
        let rows=sqlx::query("SELECT body FROM resources WHERE user_id=$1 AND kind='message' AND body LIKE $2 ORDER BY created_at DESC,id DESC LIMIT 1000")
            .bind(user_id).bind(format!("%\"conversation_id\":\"{conversation_id}\"%" )).fetch_all(&self.pool).await?;
        let mut messages: Vec<Message> = rows
            .into_iter()
            .map(|row| {
                serde_json::from_str(row.get::<&str, _>("body"))
                    .map_err(|e| DomainError::Internal(e.to_string()))
            })
            .collect::<Result<_, _>>()?;
        messages.retain(|m| m.conversation_id == conversation_id);
        messages.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(messages)
    }
    pub async fn save_message(&self, user_id: &str, message: &Message) -> Result<(), DomainError> {
        let mut conversation = self.conversation(user_id, &message.conversation_id).await?;
        self.put_resource(user_id, "message", &message.id, message)
            .await?;
        conversation.updated_at = message.created_at.clone();
        self.put_resource(user_id, "conversation", &conversation.id, &conversation)
            .await
    }
    pub async fn reserve_chat(
        &self,
        user_id: &str,
        request_id: &str,
        input_fingerprint: &str,
    ) -> Result<Option<serde_json::Value>, DomainError> {
        let key = chat_request_key(user_id, request_id)?;
        let fingerprint = auth::hash_token(input_fingerprint);
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM chat_requests WHERE request_key=$1 AND user_id=$2 AND response IS NULL AND created_at<$3").bind(&key).bind(user_id).bind(now()-300).execute(&mut *transaction).await?;
        let inserted=sqlx::query("INSERT INTO chat_requests(request_key,user_id,created_at)VALUES($1,$2,$3)ON CONFLICT(request_key)DO NOTHING").bind(&key).bind(user_id).bind(now()).execute(&mut *transaction).await?.rows_affected();
        if inserted > 0 {
            sqlx::query("INSERT INTO chat_request_inputs(request_key,user_id,fingerprint)VALUES($1,$2,$3)")
                .bind(&key).bind(user_id).bind(&fingerprint).execute(&mut *transaction).await?;
            transaction.commit().await?;
            return Ok(None);
        }
        let row = sqlx::query("SELECT c.response,i.fingerprint FROM chat_requests c LEFT JOIN chat_request_inputs i ON i.request_key=c.request_key AND i.user_id=c.user_id WHERE c.request_key=$1 AND c.user_id=$2")
                .bind(&key)
                .bind(user_id)
                .fetch_one(&mut *transaction)
                .await?;
        let stored_fingerprint: Option<String> = row.get("fingerprint");
        if stored_fingerprint.as_deref() != Some(fingerprint.as_str()) {
            // Older cached rows cannot prove which attachments, memory flag or
            // conversation the original caller supplied. Never guess or replay.
            return Err(DomainError::Conflict(
                "同一消息请求编号不能用于不同内容；旧版请求请使用新的请求编号".into(),
            ));
        }
        let response: Option<String> = row.get("response");
        transaction.commit().await?;
        match response {
            Some(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|e| DomainError::Internal(e.to_string())),
            None => Err(DomainError::Conflict("这条消息正在处理，请稍后重试".into())),
        }
    }
    pub async fn commit_chat_turn(
        &self,
        user_id: &str,
        turn: &ChatTurn,
        input_fingerprint: &str,
    ) -> Result<(), DomainError> {
        let mut memory = turn.memory.clone();
        if let Some(memory) = &mut memory {
            memory.content = validate_text(&memory.content, "记忆内容", 10000)?;
            memory.title = validate_text(&memory.title, "标题", 120)?;
            memory_kind(&memory.kind)?;
        }
        let request_key = turn
            .request_id
            .as_deref()
            .map(|request_id| chat_request_key(user_id, request_id))
            .transpose()?;
        let mut transaction = self.pool.begin().await?;
        for message in [&turn.user_message, &turn.assistant_message] {
            if message.attachments.len() > 5 {
                return Err(DomainError::Validation("每条消息最多附带 5 个附件".into()));
            }
            for attachment in &message.attachments {
                let owned: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM uploads WHERE user_id=$1 AND id=$2")
                        .bind(user_id)
                        .bind(&attachment.upload_id)
                        .fetch_one(&mut *transaction)
                        .await?;
                if owned != 1 {
                    return Err(DomainError::NotFound);
                }
            }
        }
        if let Some(key) = request_key {
            let changed=sqlx::query("UPDATE chat_requests SET response=$1 WHERE request_key=$2 AND user_id=$3 AND response IS NULL AND EXISTS(SELECT 1 FROM chat_request_inputs i WHERE i.request_key=$2 AND i.user_id=$3 AND i.fingerprint=$4)")
                .bind(turn.response.to_string()).bind(key).bind(user_id).bind(auth::hash_token(input_fingerprint)).execute(&mut *transaction).await?.rows_affected();
            if changed != 1 {
                return Err(DomainError::Conflict(
                    "消息请求已被处理，请重试获取结果".into(),
                ));
            }
        }
        let mut conversation = turn.conversation.clone();
        conversation.updated_at = turn.assistant_message.created_at.clone();
        let mut resources = vec![
            (
                "conversation",
                conversation.id.clone(),
                serde_json::to_string(&conversation),
            ),
            (
                "message",
                turn.user_message.id.clone(),
                serde_json::to_string(&turn.user_message),
            ),
            (
                "message",
                turn.assistant_message.id.clone(),
                serde_json::to_string(&turn.assistant_message),
            ),
        ];
        if let Some(memory) = &memory {
            resources.push(("memory", memory.id.clone(), serde_json::to_string(memory)));
        }
        for (kind, id, body) in resources {
            let changed=sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$5)ON CONFLICT(id)DO UPDATE SET body=$4,updated_at=$5 WHERE resources.user_id=$2 AND resources.kind=$3")
                .bind(id).bind(user_id).bind(kind).bind(body.map_err(|e|DomainError::Internal(e.to_string()))?).bind(now()).execute(&mut *transaction).await?.rows_affected();
            if changed != 1 {
                return Err(DomainError::Forbidden);
            }
        }
        transaction.commit().await?;
        Ok(())
    }
    pub async fn complete_chat(
        &self,
        user_id: &str,
        request_id: &str,
        response: &serde_json::Value,
        input_fingerprint: &str,
    ) -> Result<(), DomainError> {
        let key = chat_request_key(user_id, request_id)?;
        let changed = sqlx::query("UPDATE chat_requests SET response=$1 WHERE request_key=$2 AND user_id=$3 AND response IS NULL AND EXISTS(SELECT 1 FROM chat_request_inputs i WHERE i.request_key=$2 AND i.user_id=$3 AND i.fingerprint=$4)")
            .bind(response.to_string())
            .bind(key)
            .bind(user_id)
            .bind(auth::hash_token(input_fingerprint))
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed != 1 {
            return Err(DomainError::Conflict(
                "消息请求已被处理，请重试获取结果".into(),
            ));
        }
        Ok(())
    }
    pub async fn release_chat(
        &self,
        user_id: &str,
        request_id: &str,
        input_fingerprint: &str,
    ) -> Result<(), DomainError> {
        let key = chat_request_key(user_id, request_id)?;
        sqlx::query(
            "DELETE FROM chat_requests WHERE request_key=$1 AND user_id=$2 AND response IS NULL AND EXISTS(SELECT 1 FROM chat_request_inputs i WHERE i.request_key=$1 AND i.user_id=$2 AND i.fingerprint=$3)",
        )
        .bind(key)
        .bind(user_id)
        .bind(auth::hash_token(input_fingerprint))
        .execute(&self.pool)
        .await?;
        Ok(())
    }
    pub async fn artifacts(&self, user_id: &str) -> Result<Vec<Artifact>, DomainError> {
        self.resources(user_id, "artifact").await
    }
    pub async fn artifacts_page(
        &self, user_id: &str, offset: i64, limit: i64,
    ) -> Result<(Vec<Artifact>, Option<i64>), DomainError> {
        self.resources_page(user_id, "artifact", None, offset, limit).await
    }
    pub async fn artifact(&self, user_id: &str, id: &str) -> Result<Artifact, DomainError> {
        self.resource(user_id, "artifact", id).await
    }
    pub async fn notifications(&self, user_id: &str) -> Result<Vec<Notification>, DomainError> {
        self.resources(user_id, "notification").await
    }
    pub async fn notifications_page(
        &self, user_id: &str, read: Option<bool>, offset: i64, limit: i64,
    ) -> Result<(Vec<Notification>, Option<i64>), DomainError> {
        self.resources_page(user_id, "notification", read, offset, limit).await
    }
    pub async fn read_notification(&self, user_id: &str, id: &str) -> Result<(), DomainError> {
        let mut notification: Notification = self.resource(user_id, "notification", id).await?;
        notification.read = true;
        self.put_resource(user_id, "notification", id, &notification)
            .await
    }
    pub async fn connect(database_url: &str) -> Result<Self, DomainError> {
        sqlx::any::install_default_drivers();
        if database_url.starts_with("sqlite:") && !database_url.contains(":memory:") {
            let path = database_url
                .trim_start_matches("sqlite:")
                .split('?')
                .next()
                .unwrap_or("");
            if let Some(parent) = std::path::Path::new(path).parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| DomainError::Internal(e.to_string()))?;
                }
            }
        }
        let url = if database_url.starts_with("sqlite:")
            && !database_url.contains('?')
            && !database_url.contains(":memory:")
        {
            format!("{database_url}?mode=rwc")
        } else {
            database_url.to_owned()
        };
        let sqlite = url.starts_with("sqlite:");
        let pool = AnyPoolOptions::new()
            .max_connections(if sqlite { 1 } else { 10 })
            .connect(&url)
            .await?;
        if sqlite {
            sqlx::query("PRAGMA foreign_keys = ON")
                .execute(&pool)
                .await?;
            sqlx::query("PRAGMA busy_timeout = 5000")
                .execute(&pool)
                .await?;
        }
        sqlx::raw_sql(include_str!("../../../migrations/sqlite/001_initial.sql"))
            .execute(&pool)
            .await?;
        sqlx::raw_sql(include_str!("../../../migrations/sqlite/002_agent.sql"))
            .execute(&pool)
            .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/003_phone_auth.sql"
        ))
        .execute(&pool)
        .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/004_phone_sms_limits.sql"
        ))
        .execute(&pool)
        .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/005_phone_sms_attempts.sql"
        ))
        .execute(&pool)
        .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/006_phone_password.sql"
        ))
        .execute(&pool)
        .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/008_chat_request_inputs.sql"
        ))
        .execute(&pool)
        .await?;
        sqlx::raw_sql(include_str!(
            "../../../migrations/sqlite/009_agent_event_cursors.sql"
        ))
        .execute(&pool)
        .await?;
        // Authentication checks this table even in non-admin processes such as
        // attachment and connector services; it must exist before any login.
        sqlx::query("CREATE TABLE IF NOT EXISTS admin_user_controls(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,disabled BIGINT NOT NULL DEFAULT 0,updated_at BIGINT NOT NULL)")
            .execute(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn ping(&self) -> Result<(), DomainError> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn create_user(
        &self,
        email: &str,
        password_hash: &str,
        name: &str,
        timezone: &str,
    ) -> Result<User, DomainError> {
        let email = auth::normalize_email(email)?;
        let name = validate_text(name, "昵称", 80)?;
        if timezone.parse::<chrono_tz::Tz>().is_err() {
            return Err(DomainError::Validation("无效的 IANA 时区".into()));
        }
        let id = new_id();
        let created = now();
        let result = sqlx::query("INSERT INTO users (id,email,password_hash,name,timezone,created_at) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(&id).bind(&email).bind(password_hash).bind(&name).bind(timezone).bind(created).execute(&self.pool).await;
        if let Err(error) = result {
            if error
                .as_database_error()
                .map(|e| e.is_unique_violation())
                .unwrap_or(false)
            {
                return Err(DomainError::Conflict("该邮箱已注册".into()));
            }
            return Err(error.into());
        }
        Ok(User {
            id,
            email,
            phone: None,
            name,
            timezone: timezone.to_owned(),
            created_at: timestamp(created),
        })
    }

    pub async fn credentials(&self, email: &str) -> Result<Option<(User, String)>, DomainError> {
        let row = sqlx::query("SELECT * FROM users WHERE email=$1 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=users.id AND c.disabled<>0)")
            .bind(email.trim().to_lowercase())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| (user_from(&row), row.get("password_hash"))))
    }
    pub async fn user(&self, id: &str) -> Result<User, DomainError> {
        let row = sqlx::query("SELECT u.*,p.phone FROM users u LEFT JOIN phone_identities p ON p.user_id=u.id WHERE u.id=$1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::NotFound)?;
        Ok(user_from(&row))
    }
    pub async fn create_session(&self, user_id: &str) -> Result<String, DomainError> {
        let token = auth::generate_token();
        let mut transaction = self.pool.begin().await?;
        crate::phone_password::lock_password_state(&mut transaction).await?;
        let inserted=sqlx::query(
            "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) SELECT $1,u.id,$3,$4 FROM users u WHERE u.id=$2 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=u.id AND c.disabled<>0)",
        )
        .bind(auth::hash_token(&token))
        .bind(user_id)
        .bind(now() + 30 * 86400)
        .bind(now())
        .execute(&mut *transaction)
        .await?.rows_affected();
        if inserted != 1 {
            return Err(DomainError::Unauthorized);
        }
        transaction.commit().await?;
        Ok(token)
    }
    /// Finalize an email password verification only while that exact credential
    /// is still current. A concurrent administrator reset cannot mint a session
    /// from a hash that was verified before the reset.
    pub async fn create_session_for_password(
        &self,
        user_id: &str,
        verified_hash: &str,
    ) -> Result<String, DomainError> {
        let token = auth::generate_token();
        let mut transaction = self.pool.begin().await?;
        crate::phone_password::lock_password_state(&mut transaction).await?;
        let inserted=sqlx::query("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) SELECT $1,u.id,$2,$3 FROM users u WHERE u.id=$4 AND u.password_hash=$5 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=u.id AND c.disabled<>0)")
            .bind(auth::hash_token(&token)).bind(now()+30*86400).bind(now()).bind(user_id).bind(verified_hash).execute(&mut *transaction).await?.rows_affected();
        if inserted != 1 {
            return Err(DomainError::Unauthorized);
        }
        transaction.commit().await?;
        Ok(token)
    }
    pub async fn authenticate(&self, token: &str) -> Result<String, DomainError> {
        if token.len() < 32 || token.len() > 256 {
            return Err(DomainError::Unauthorized);
        }
        let row = sqlx::query("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>$2 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=sessions.user_id AND c.disabled<>0)")
            .bind(auth::hash_token(token))
            .bind(now())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::Unauthorized)?;
        Ok(row.get("user_id"))
    }
    pub async fn logout(&self, token: &str) -> Result<(), DomainError> {
        sqlx::query("DELETE FROM sessions WHERE token_hash=$1")
            .bind(auth::hash_token(token))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub(crate) async fn put_resource<T: Serialize>(
        &self,
        user_id: &str,
        kind: &str,
        id: &str,
        body: &T,
    ) -> Result<(), DomainError> {
        let body = serde_json::to_string(body).map_err(|e| DomainError::Internal(e.to_string()))?;
        sqlx::query("INSERT INTO resources (id,user_id,kind,body,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(id) DO UPDATE SET body=$4,updated_at=$5 WHERE resources.user_id=$2 AND resources.kind=$3")
            .bind(id).bind(user_id).bind(kind).bind(body).bind(now()).execute(&self.pool).await?;
        Ok(())
    }
    pub(crate) async fn resources<T: DeserializeOwned>(
        &self,
        user_id: &str,
        kind: &str,
    ) -> Result<Vec<T>, DomainError> {
        Ok(self.resources_page(user_id, kind, None, 0, 500).await?.0)
    }
    async fn resources_page<T: DeserializeOwned>(
        &self, user_id: &str, kind: &str, read: Option<bool>, offset: i64, limit: i64,
    ) -> Result<(Vec<T>, Option<i64>), DomainError> {
        validate_page(offset, limit)?;
        let mut connection = self.pool.acquire().await?;
        let postgres = connection.backend_name() == "PostgreSQL";
        let query = if kind == "conversation" {
            let activity = if postgres { "CAST(body AS JSONB)->>'updated_at'" } else { "json_extract(body, '$.updated_at')" };
            let seconds = if postgres { "EXTRACT(EPOCH FROM CAST(whole_seconds AS TIMESTAMPTZ))" } else { "CAST(strftime('%s', whole_seconds) AS BIGINT)" };
            // Sort activity before pagination. Split RFC3339 seconds and nanoseconds:
            // SQLite Julian dates and PostgreSQL timestamps both lose subsecond precision.
            format!("WITH activity_rows AS (
                SELECT body,id,{activity} AS activity FROM resources WHERE user_id=$1 AND kind=$2 AND $3=-1
            ), normalized AS (
                SELECT body,id,
                    substr(activity,1,19) || CASE WHEN upper(substr(activity,length(activity),1))='Z' THEN 'Z' ELSE substr(activity,length(activity)-5,6) END AS whole_seconds,
                    CASE WHEN substr(activity,20,1)='.' THEN substr(substr(activity,21,length(activity)-20-CASE WHEN upper(substr(activity,length(activity),1))='Z' THEN 1 ELSE 6 END) || '000000000',1,9) ELSE '000000000' END AS fractional_seconds
                FROM activity_rows
            ) SELECT body FROM normalized ORDER BY {seconds} DESC,fractional_seconds DESC,id DESC LIMIT $4 OFFSET $5")
        } else {
            let read_value = if postgres { "CASE WHEN CAST(body AS JSONB)->>'read'='true' THEN 1 ELSE 0 END" } else { "json_extract(body, '$.read')" };
            format!("SELECT body FROM resources WHERE user_id=$1 AND kind=$2 AND ($3=-1 OR {read_value}=$3) ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5")
        };
        let rows = sqlx::query(&query).bind(user_id).bind(kind)
            .bind(read.map(i64::from).unwrap_or(-1)).bind(limit + 1).bind(offset)
            .fetch_all(&mut *connection).await?;
        let items = rows.into_iter()
            .map(|row| {
                serde_json::from_str(row.get::<&str, _>("body"))
                    .map_err(|e| DomainError::Internal(e.to_string()))
            })
            .collect::<Result<Vec<T>, _>>()?;
        Ok(finish_page(items, offset, limit))
    }
    pub(crate) async fn resource<T: DeserializeOwned>(
        &self,
        user_id: &str,
        kind: &str,
        id: &str,
    ) -> Result<T, DomainError> {
        let row = sqlx::query("SELECT body FROM resources WHERE user_id=$1 AND kind=$2 AND id=$3")
            .bind(user_id)
            .bind(kind)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::NotFound)?;
        serde_json::from_str(row.get::<&str, _>("body"))
            .map_err(|e| DomainError::Internal(e.to_string()))
    }
    pub async fn delete_resource(
        &self,
        user_id: &str,
        kind: &str,
        id: &str,
    ) -> Result<(), DomainError> {
        let result = sqlx::query("DELETE FROM resources WHERE user_id=$1 AND kind=$2 AND id=$3")
            .bind(user_id)
            .bind(kind)
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(DomainError::NotFound);
        }
        Ok(())
    }
}

fn chat_request_key(user_id: &str, request_id: &str) -> Result<String, DomainError> {
    Ok(format!("{user_id}:{}", validate_text(request_id, "请求编号", 120)?))
}

fn validate_page(offset: i64, limit: i64) -> Result<(), DomainError> {
    if offset < 0 || offset > i64::MAX - 500 || !(1..=500).contains(&limit) {
        return Err(DomainError::Validation("分页参数无效：offset 必须非负，limit 必须为 1 至 500".into()));
    }
    Ok(())
}

fn finish_page<T>(mut items: Vec<T>, offset: i64, limit: i64) -> (Vec<T>, Option<i64>) {
    let next = (items.len() > limit as usize).then_some(offset + limit);
    items.truncate(limit as usize);
    (items, next)
}

fn user_from(row: &AnyRow) -> User {
    User {
        id: row.get("id"),
        email: row.get("email"),
        phone: row.try_get("phone").unwrap_or(None),
        name: row.get("name"),
        timezone: row.get("timezone"),
        created_at: timestamp(row.get("created_at")),
    }
}

pub(crate) fn memory_kind(value: &str) -> Result<(), DomainError> {
    if ["preference", "person", "project", "goal", "fact"].contains(&value) {
        Ok(())
    } else {
        Err(DomainError::Validation("无效的记忆类型".into()))
    }
}
fn task_from(row: &AnyRow) -> Result<Task, DomainError> {
    let status: String = row.get("status");
    let steps = vec![
        Step {
            id: "context".into(),
            title: "读取当前记忆与任务要求".into(),
            status: if status == "queued" || status == "waiting_approval" {
                "pending"
            } else if status == "running" {
                "running"
            } else if status == "succeeded" {
                "completed"
            } else {
                "pending"
            }
            .into(),
            detail: None,
        },
        Step {
            id: "generate".into(),
            title: "组织内容并保存成果".into(),
            status: if status == "succeeded" {
                "completed"
            } else if status == "failed" {
                "failed"
            } else {
                "pending"
            }
            .into(),
            detail: None,
        },
    ];
    Ok(Task {
        id: row.get("id"),
        title: row.get("title"),
        instruction: row.get("prompt"),
        kind: row.get("kind"),
        status,
        progress: row.get("progress"),
        summary: row.get("summary"),
        result: row.get("result"),
        error: row.get("error"),
        created_at: timestamp(row.get("created_at")),
        updated_at: timestamp(row.get("updated_at")),
        steps,
        model_mode: row.get("model_mode"),
        approval_required: row.get::<i64, _>("requires_approval") != 0,
        approved_at: row.get("approved_at"),
        artifact_id: row.get("artifact_id"),
    })
}
fn schedule_from(row: &AnyRow) -> Result<Schedule, DomainError> {
    Ok(Schedule {
        id: row.get("id"),
        title: row.get("title"),
        instruction: row.get("prompt"),
        frequency: row.get("frequency"),
        time: row.get("time_of_day"),
        timezone: row.get("timezone"),
        enabled: row.get::<i64, _>("enabled") != 0,
        next_run_at: timestamp(row.get("next_run_at")),
        last_run_at: row.get::<Option<i64>, _>("last_run_at").map(timestamp),
        created_at: timestamp(row.get("created_at")),
    })
}

pub fn next_execution(
    frequency: &str,
    time: &str,
    timezone: &str,
    after: i64,
    recurring: bool,
) -> Result<i64, DomainError> {
    use chrono::{Datelike, TimeZone};
    if !["daily", "weekdays", "weekly", "once"].contains(&frequency) {
        return Err(DomainError::Validation("无效的计划频率".into()));
    }
    let timezone: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| DomainError::Validation("无效的 IANA 时区".into()))?;
    let clock = chrono::NaiveTime::parse_from_str(time, "%H:%M")
        .map_err(|_| DomainError::Validation("时间格式应为 HH:MM".into()))?;
    let base = chrono::DateTime::from_timestamp(after, 0)
        .ok_or_else(|| DomainError::Validation("无效的时间戳".into()))?
        .with_timezone(&timezone);
    for offset in 0..15 {
        if recurring && frequency == "weekly" && offset < 7 {
            continue;
        }
        let date = base.date_naive() + chrono::Duration::days(offset);
        if frequency == "weekdays" && date.weekday().number_from_monday() > 5 {
            continue;
        }
        let mut local = date.and_time(clock);
        // During DST spring-forward, select the first existing minute after the requested clock time.
        for _ in 0..180 {
            if let Some(candidate) = timezone.from_local_datetime(&local).earliest() {
                if candidate.timestamp() > after {
                    return Ok(candidate.timestamp());
                }
                break;
            }
            local += chrono::Duration::minutes(1);
        }
    }
    Err(DomainError::Validation("无法计算下一次运行时间".into()))
}

pub fn next_weekly_execution(
    time: &str,
    timezone: &str,
    anchor: i64,
    after: i64,
) -> Result<i64, DomainError> {
    use chrono::Datelike;
    let zone: chrono_tz::Tz = timezone
        .parse()
        .map_err(|_| DomainError::Validation("无效的 IANA 时区".into()))?;
    let weekday = chrono::DateTime::from_timestamp(anchor, 0)
        .ok_or_else(|| DomainError::Validation("无效的计划日期".into()))?
        .with_timezone(&zone)
        .weekday();
    next_weekday_execution(time, timezone, weekday, after)
}

fn next_weekday_execution(
    time: &str,
    timezone: &str,
    weekday: chrono::Weekday,
    after: i64,
) -> Result<i64, DomainError> {
    use chrono::Datelike;
    let zone: chrono_tz::Tz = timezone.parse()
        .map_err(|_| DomainError::Validation("无效的 IANA 时区".into()))?;
    let mut candidate = next_execution("daily", time, timezone, after, false)?;
    for _ in 0..7 {
        if chrono::DateTime::from_timestamp(candidate, 0)
            .ok_or_else(|| DomainError::Validation("无效的计划日期".into()))?
            .with_timezone(&zone)
            .weekday()
            == weekday
        {
            return Ok(candidate);
        }
        candidate = next_execution("daily", time, timezone, candidate, false)?;
    }
    Err(DomainError::Internal("无法计算周计划日期".into()))
}

#[cfg(test)]
mod administration_auth_tests {
    use super::*;

    #[tokio::test]
    async fn password_session_uses_current_hash_and_disabled_accounts_fail_closed() {
        let repository = Repository::connect("sqlite::memory:").await.unwrap();
        let old_hash = auth::hash_password("original email password").unwrap();
        let user = repository
            .create_user("guard@example.test", &old_hash, "Guard", "Asia/Shanghai")
            .await
            .unwrap();
        let old_session = repository
            .create_session_for_password(&user.id, &old_hash)
            .await
            .unwrap();
        let mut transaction = repository.pool.begin().await.unwrap();
        crate::phone_password::lock_password_state(&mut transaction)
            .await
            .unwrap();
        let new_hash = auth::hash_password("replacement email password").unwrap();
        sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2")
            .bind(&new_hash)
            .bind(&user.id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        sqlx::query("DELETE FROM sessions WHERE user_id=$1")
            .bind(&user.id)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        assert!(matches!(
            repository
                .create_session_for_password(&user.id, &old_hash)
                .await,
            Err(DomainError::Unauthorized)
        ));
        assert!(matches!(
            repository.authenticate(&old_session).await,
            Err(DomainError::Unauthorized)
        ));
        let new_session = repository
            .create_session_for_password(&user.id, &new_hash)
            .await
            .unwrap();
        let task_input = || CreateTask {
            instruction: "Background fixture".into(),
            title: None,
            kind: None,
            approval_required: None,
            client_request_id: None,
        };
        repository
            .create_task(&user.id, task_input())
            .await
            .unwrap();
        let claim = repository.claim_task(60).await.unwrap().unwrap();
        repository
            .create_task(&user.id, task_input())
            .await
            .unwrap();
        let schedule = repository
            .create_schedule(
                &user.id,
                CreateSchedule {
                    title: "Fixture".into(),
                    instruction: "Fixture".into(),
                    frequency: "daily".into(),
                    time: "09:00".into(),
                    timezone: "Asia/Shanghai".into(),
                    enabled: Some(true),
                },
            )
            .await
            .unwrap();
        sqlx::query("UPDATE schedules SET next_run_at=$1 WHERE id=$2")
            .bind(now() - 60)
            .bind(schedule.id)
            .execute(&repository.pool)
            .await
            .unwrap();
        let run = repository
            .begin_agent_run(&user.id, "disabled-fixture", "fixture", None, None)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_user_controls(user_id,disabled,updated_at) VALUES($1,1,$2)")
            .bind(&user.id)
            .bind(now())
            .execute(&repository.pool)
            .await
            .unwrap();
        assert!(repository
            .credentials("guard@example.test")
            .await
            .unwrap()
            .is_none());
        assert!(matches!(
            repository
                .create_session_for_password(&user.id, &new_hash)
                .await,
            Err(DomainError::Unauthorized)
        ));
        assert!(matches!(
            repository.create_session(&user.id).await,
            Err(DomainError::Unauthorized)
        ));
        assert!(matches!(
            repository.authenticate(&new_session).await,
            Err(DomainError::Unauthorized)
        ));
        assert!(repository.claim_task(60).await.unwrap().is_none());
        assert!(!repository.renew_task(&claim, 60).await.unwrap());
        assert_eq!(repository.tick_schedules().await.unwrap(), 0);
        assert!(matches!(
            repository.agent_authority(&run.id, &run.token).await,
            Err(DomainError::Forbidden)
        ));
    }
}
