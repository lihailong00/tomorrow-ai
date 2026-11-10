use super::*;
use crate::{ClaimedTask, DomainError, Repository, Todo, new_id, now, timestamp};
use chrono::Timelike;
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProposedPlans {
    items: Vec<ProposedItem>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProposedItem {
    todo_id: Option<String>,
    title: String,
    description: String,
    kind: String,
    reason: String,
    estimated_minutes: i64,
}

fn unconfigured() -> DomainError {
    DomainError::Conflict("请先开启每日成长，并选择目标或允许使用已有待办".into())
}
fn item_conflict() -> DomainError {
    DomainError::Conflict("这条建议已变化，请刷新后继续".into())
}

impl Repository {
    pub async fn daily_plan(&self, user: &str) -> Result<DailyPlan, DomainError> {
        let prefs = self.growth_preferences(user).await?;
        let journey_kind = self.growth_journey_focus_kind(user).await?;
        let today = local_date(now(), &prefs.timezone)?;
        let row=sqlx::query("SELECT p.id,p.local_date,p.status,p.error,p.timezone,p.attempts,p.dispatches,t.status AS task_status FROM growth_daily_plans p LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=$1 AND (p.local_date=$2 OR (p.timezone<>$3 AND p.created_at>$4)) ORDER BY CASE WHEN p.local_date=$2 THEN 0 ELSE 1 END,p.created_at DESC LIMIT 1")
            .bind(user).bind(&today).bind(&prefs.timezone).bind(now()-20*3600).fetch_optional(&self.pool).await?;
        let mut result = DailyPlan {
            id: None,
            local_date: today,
            timezone: prefs.timezone,
            status: if prefs.enabled { "ready" } else { "disabled" }.into(),
            error: None,
            items: vec![],
            can_retry: false,
        };
        if let Some(row) = row {
            let id: String = row.get("id");
            result.id = Some(id.clone());
            result.local_date = row.get("local_date");
            result.status = row.get("status");
            result.error = row.get("error");
            result.timezone = row.get("timezone");
            if ["queued", "generating"].contains(&result.status.as_str())
                && row
                    .get::<Option<String>, _>("task_status")
                    .is_some_and(|s| ["failed", "cancelled", "uncertain"].contains(&s.as_str()))
            {
                result.status = "failed".into();
                result.error = Some("上次生成没有完成，原有事项已保留；可在限额内明确重试".into());
            }
            result.can_retry = result.status == "failed"
                && row.get::<i64, _>("attempts") < 2
                && row.get::<i64, _>("dispatches") < 8;
            let rows=sqlx::query("SELECT body,todo_id,status,version,focus FROM growth_plan_items WHERE user_id=$1 AND plan_id=$2 AND slot>0 AND status IN ('suggested','accepted','skipped') ORDER BY slot")
                .bind(user).bind(&id).fetch_all(&self.pool).await?;
            let spare:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_plan_items WHERE user_id=$1 AND plan_id=$2 AND status='spare'").bind(user).bind(&id).fetch_one(&self.pool).await?;
            for row in rows {
                let mut item: DailyPlanItem = parse(row.get("body"))?;
                // A route already owns this goal's next action. Preserve user-accepted
                // items, but do not advertise another unaccepted duplicate for it.
                if row.get::<String,_>("status")=="suggested" && row.get::<Option<String>,_>("todo_id").is_none() && journey_kind.as_deref()==Some(item.kind.as_str()){continue;}
                item.status = row.get("status");
                item.version = row.get("version");
                item.focus = row.get::<i64, _>("focus") != 0;
                item.todo_id = row.get("todo_id");
                item.can_replace =
                    spare > 0 && item.status == "suggested" && item.todo_id.is_none();
                if let Some(todo_id) = &item.todo_id {
                    match self.todo(user, todo_id).await {
                        Ok(todo) => {
                            item.title = todo.title.clone();
                            item.description = todo.description.clone();
                            item.kind = todo.kind.clone();
                            item.source_kind = todo.source_kind.clone();
                            item.source_label = todo.source_label.clone();
                            item.todo = Some(todo);
                        }
                        Err(DomainError::NotFound) => continue,
                        Err(e) => return Err(e),
                    }
                }
                if !prefs.enabled || prefs.paused_today {
                    // References to original todos remain visible in the ordinary
                    // list; accepted daily todos are never removed from storage.
                    if item.status != "accepted" {
                        continue;
                    }
                }
                result.items.push(item);
            }
        }
        if !prefs.enabled {
            result.status = "disabled".into();
            result.items.clear();
        } else if prefs.paused_today {
            result.status = "paused".into();
        }
        if !prefs.enabled || prefs.paused_today {
            result.can_retry = false;
        }
        Ok(result)
    }

    pub async fn ensure_daily_plan(
        &self,
        user: &str,
        input: EnsureDailyPlan,
    ) -> Result<DailyPlan, DomainError> {
        if let Some(key) = input.client_request_id.as_deref() {
            crate::validate_text(key, "请求编号", 120)?;
        }
        self.enqueue_daily_plan(user, true, input.client_request_id.as_deref())
            .await?;
        self.daily_plan(user).await
    }

    async fn enqueue_daily_plan(
        &self,
        user: &str,
        explicit: bool,
        request_id: Option<&str>,
    ) -> Result<bool, DomainError> {
        let prefs = self.growth_preferences(user).await?;
        if !prefs.enabled {
            if explicit {
                return Err(unconfigured());
            }
            return Ok(false);
        }
        if prefs.paused_today {
            return Ok(false);
        }
        let date = local_date(now(), &prefs.timezone)?;
        let mut tx = self.pool.begin().await?;
        if let Some(key) = request_id {
            if command_start(&mut tx, user, key, "ensure_daily_plan", &date)
                .await?
                .is_some()
            {
                // Re-read the current plan outside this transaction. Replaying
                // a transport retry must never admit another paid attempt.
                tx.commit().await?;
                return Ok(false);
            }
        }
        lock_preferences(&mut tx, user).await?;
        let fresh: StoredPreferences = parse(
            sqlx::query_scalar::<_, String>("SELECT body FROM growth_preferences WHERE user_id=$1")
                .bind(user)
                .fetch_one(&mut *tx)
                .await?
                .as_str(),
        )?;
        if !fresh.enabled || fresh.paused_date.as_deref() == Some(&date) {
            return Ok(false);
        }
        if explicit {
            sqlx::query("UPDATE growth_preferences SET last_active_at=$1 WHERE user_id=$2")
                .bind(now())
                .bind(user)
                .execute(&mut *tx)
                .await?;
        }
        let recent:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_daily_plans WHERE user_id=$1 AND local_date<>$2 AND timezone<>$3 AND created_at>$4")
            .bind(user).bind(&date).bind(&prefs.timezone).bind(now()-20*3600).fetch_one(&mut *tx).await?;
        if recent > 0 {
            if let Some(key) = request_id {
                command_finish(&mut tx, user, key, "", &false).await?;
            }
            tx.commit().await?;
            return Ok(false);
        }
        let plan_id = new_id();
        sqlx::query("INSERT INTO growth_daily_plans(id,user_id,local_date,timezone,status,created_at,updated_at)VALUES($1,$2,$3,$4,'new',$5,$5)ON CONFLICT(user_id,local_date)DO NOTHING")
            .bind(&plan_id).bind(user).bind(&date).bind(&prefs.timezone).bind(now()).execute(&mut *tx).await?;
        let plan=sqlx::query("SELECT p.id,p.status,p.attempts,p.dispatches,t.status AS task_status FROM growth_daily_plans p LEFT JOIN tasks t ON t.id=p.task_id WHERE p.user_id=$1 AND p.local_date=$2").bind(user).bind(&date).fetch_one(&mut *tx).await?;
        let mut status: String = plan.get("status");
        let attempts: i64 = plan.get("attempts");
        let dispatches: i64 = plan.get("dispatches");
        let id: String = plan.get("id");
        if ["queued", "generating"].contains(&status.as_str())
            && plan
                .get::<Option<String>, _>("task_status")
                .is_some_and(|s| ["failed", "cancelled", "uncertain"].contains(&s.as_str()))
        {
            status = "failed".into();
        }
        if status != "new" && !(explicit && status == "failed" && attempts < 2 && dispatches < 8) {
            if let Some(key) = request_id {
                command_finish(&mut tx, user, key, "", &false).await?;
            }
            tx.commit().await?;
            return Ok(false);
        }
        let task_id = new_id();
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at,idempotency_key)VALUES($1,$2,'准备每日成长建议',$3,'daily_plan','queued',$4,$4,$5)")
            .bind(&task_id).bind(user).bind(&id).bind(now()).bind(format!("growth:{id}:{}",dispatches+1)).execute(&mut *tx).await?;
        sqlx::query("UPDATE growth_daily_plans SET status='queued',task_id=$1,dispatches=dispatches+1,model_attempt=NULL,error=NULL,updated_at=$2 WHERE id=$3 AND user_id=$4")
            .bind(task_id).bind(now()).bind(id).bind(user).execute(&mut *tx).await?;
        if let Some(key) = request_id {
            command_finish(&mut tx, user, key, "", &true).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Bounded sweep; key reservation makes multiple worker replicas safe.
    pub async fn tick_daily_growth(&self) -> Result<usize, DomainError> {
        let mut cursor_tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO growth_scheduler_state(id,after_user_id,guard)VALUES(1,'',0)ON CONFLICT(id)DO NOTHING").execute(&mut *cursor_tx).await?;
        sqlx::query("UPDATE growth_scheduler_state SET guard=guard+1 WHERE id=1")
            .execute(&mut *cursor_tx)
            .await?;
        let cursor: String =
            sqlx::query_scalar("SELECT after_user_id FROM growth_scheduler_state WHERE id=1")
                .fetch_one(&mut *cursor_tx)
                .await?;
        let rows=sqlx::query("SELECT p.user_id,p.body,u.timezone FROM growth_preferences p JOIN users u ON u.id=p.user_id WHERE p.last_active_at>=$1 AND p.user_id>$2 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=p.user_id AND c.disabled<>0) ORDER BY p.user_id LIMIT 100")
            .bind(now()-7*86400).bind(cursor).fetch_all(&mut *cursor_tx).await?;
        let next = rows
            .last()
            .map(|r| r.get::<String, _>("user_id"))
            .unwrap_or_default();
        sqlx::query("UPDATE growth_scheduler_state SET after_user_id=$1 WHERE id=1")
            .bind(next)
            .execute(&mut *cursor_tx)
            .await?;
        cursor_tx.commit().await?;
        let mut count = 0;
        for row in rows {
            let prefs: StoredPreferences = parse(row.get("body"))?;
            if !prefs.enabled {
                continue;
            }
            let tz: String = row.get("timezone");
            let zone: chrono_tz::Tz = tz
                .parse()
                .map_err(|_| DomainError::Validation("用户时区无效".into()))?;
            let local = zone
                .timestamp_opt(now(), 0)
                .single()
                .ok_or_else(|| DomainError::Internal("日期无效".into()))?;
            if local.hour() < 8 {
                continue;
            }
            if self
                .enqueue_daily_plan(row.get("user_id"), false, None)
                .await?
            {
                count += 1;
            }
        }
        Ok(count)
    }

    /// A task attempt can start model I/O only once. Reclaimed ambiguous attempts
    /// fail closed instead of silently billing the user for another model call.
    pub async fn begin_daily_generation(
        &self,
        claim: &ClaimedTask,
    ) -> Result<Option<DailyPlanContext>, DomainError> {
        let plan_id = &claim.task.instruction;
        let prefs = self.growth_preferences(&claim.user_id).await?;
        if !prefs.enabled || prefs.paused_today {
            self.fail_daily_generation(claim, "每日建议已暂停，请恢复后重试")
                .await?;
            return Ok(None);
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, &claim.user_id).await?;
        let pref_row = sqlx::query("SELECT body,version FROM growth_preferences WHERE user_id=$1")
            .bind(&claim.user_id)
            .fetch_one(&mut *tx)
            .await?;
        let fresh: StoredPreferences = parse(pref_row.get("body"))?;
        if !fresh.enabled
            || fresh.paused_date.as_deref() == Some(&local_date(now(), &prefs.timezone)?)
        {
            return Err(DomainError::Conflict("成长设置已变化，请明确重试".into()));
        }
        let plan=sqlx::query("SELECT timezone,local_date FROM growth_daily_plans WHERE user_id=$1 AND id=$2 AND task_id=$3").bind(&claim.user_id).bind(plan_id).bind(&claim.task.id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        let plan_zone: String = plan.get("timezone");
        let plan_date: String = plan.get("local_date");
        if local_date(now(), &plan_zone)? != plan_date {
            return Err(DomainError::Conflict(
                "这份每日计划已过期，原待办仍保留".into(),
            ));
        }
        let changed=sqlx::query("UPDATE growth_daily_plans SET status='generating',model_attempt=$1,attempts=attempts+1,updated_at=$2 WHERE user_id=$3 AND id=$4 AND task_id=$5 AND status='queued' AND model_attempt IS NULL AND attempts<2 AND EXISTS(SELECT 1 FROM tasks WHERE id=$5 AND status='running' AND attempts=$1 AND claimed_until>=$2) AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=$3 AND c.disabled<>0)")
            .bind(claim.attempt).bind(now()).bind(&claim.user_id).bind(plan_id).bind(&claim.task.id).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            let row=sqlx::query("SELECT model_attempt,status FROM growth_daily_plans WHERE user_id=$1 AND id=$2 AND task_id=$3").bind(&claim.user_id).bind(plan_id).bind(&claim.task.id).fetch_optional(&mut *tx).await?;
            if row.is_some_and(|r| {
                r.get::<String, _>("status") == "generating"
                    && r.get::<Option<i64>, _>("model_attempt") != Some(claim.attempt)
            }) {
                sqlx::query("UPDATE growth_daily_plans SET status='failed',context='',error='上次生成中断，结果不确定；可以手动重试一次',updated_at=$1 WHERE user_id=$2 AND id=$3").bind(now()).bind(&claim.user_id).bind(plan_id).execute(&mut *tx).await?;
                sqlx::query("UPDATE tasks SET status='failed',error='生成中断，需明确重试',claimed_until=0,updated_at=$1 WHERE id=$2 AND attempts=$3").bind(now()).bind(&claim.task.id).bind(claim.attempt).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            return Ok(None);
        }
        let existing = if fresh.use_existing_todos {
            let zone: chrono_tz::Tz = prefs
                .timezone
                .parse()
                .map_err(|_| DomainError::Validation("用户时区无效".into()))?;
            let next_day = zone
                .timestamp_opt(now(), 0)
                .single()
                .ok_or_else(|| DomainError::Internal("日期无效".into()))?
                .date_naive()
                .succ_opt()
                .ok_or_else(|| DomainError::Internal("日期无效".into()))?;
            let boundary = (0..24)
                .find_map(|hour| {
                    zone.from_local_datetime(&next_day.and_hms_opt(hour, 0, 0)?)
                        .earliest()
                })
                .ok_or_else(|| DomainError::Internal("日期无效".into()))?
                .timestamp();
            sqlx::query("SELECT body FROM todos WHERE user_id=$1 AND status IN ('pending','in_progress') AND (due_at IS NULL OR due_at<$2) ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at DESC LIMIT 20")
                .bind(&claim.user_id).bind(boundary).fetch_all(&mut *tx).await?.into_iter().map(|r|parse::<Todo>(r.get("body"))).collect::<Result<Vec<_>,_>>()?
        } else {
            vec![]
        };
        let mut context = DailyPlanContext {
            plan_id: plan_id.clone(),
            goals: fresh.goals,
            daily_minutes: fresh.daily_minutes,
            existing_todos: existing,
            preferences_version: pref_row.get("version"),
            use_existing_todos: fresh.use_existing_todos,
            local_date: plan_date,
            timezone: plan_zone,
        };
        // Limit private text before it crosses the configured model boundary.
        for todo in &mut context.existing_todos {
            todo.description = todo.description.chars().take(300).collect();
            todo.draft = None;
            todo.source_excerpt = None;
            todo.progress_notes = None;
            todo.linked_task_id = None;
        }
        sqlx::query("UPDATE growth_daily_plans SET context=$1 WHERE id=$2 AND user_id=$3")
            .bind(json(&context)?)
            .bind(plan_id)
            .bind(&claim.user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(context))
    }

    pub async fn complete_daily_generation(
        &self,
        claim: &ClaimedTask,
        context: &DailyPlanContext,
        raw: &str,
    ) -> Result<bool, DomainError> {
        if raw.len() > 30000 {
            return Err(DomainError::Validation("每日建议输出过长".into()));
        }
        let mut proposals: ProposedPlans = serde_json::from_str(raw.trim())
            .map_err(|_| DomainError::Validation("每日建议格式无效，请稍后重试".into()))?;
        if proposals.items.len() > 6 {
            return Err(DomainError::Validation("每日建议数量超过限制".into()));
        }
        let prefs = self.growth_preferences(&claim.user_id).await?;
        if !prefs.enabled || prefs.paused_today {
            return Err(DomainError::Conflict(
                "每日建议已暂停，已保留原有事项".into(),
            ));
        }
        proposals
            .items
            .sort_by_key(|p| i64::from(p.todo_id.is_none()));
        let mut accepted: Vec<(i64, DailyPlanItem)> = vec![];
        let mut seen = std::collections::HashSet::new();
        let mut budget = 0;
        let mut existing_used = false;
        let journey_kind = self.growth_journey_focus_kind(&claim.user_id).await?;
        for p in proposals.items {
            if p.todo_id.is_none() && journey_kind.as_deref()==Some(p.kind.as_str()){continue;}
            if ![
                "general",
                "learning",
                "exercise",
                "errand",
                "reading",
                "expense",
                "communication",
            ]
            .contains(&p.kind.as_str())
                || !(1..=context.daily_minutes).contains(&p.estimated_minutes)
            {
                return Err(DomainError::Validation("建议类型或时间无效".into()));
            }
            let title = crate::validate_text(&p.title, "建议标题", 200)?;
            let reason = crate::validate_text(&p.reason, "推荐理由", 300)?;
            if p.description.chars().count() > 2000 {
                return Err(DomainError::Validation("建议说明过长".into()));
            }
            let (title, description, kind, source_kind, source_label, todo_id) =
                if let Some(id) = p.todo_id {
                    let original = context
                        .existing_todos
                        .iter()
                        .find(|t| t.id == id)
                        .ok_or_else(|| DomainError::Validation("建议引用了未授权的待办".into()))?;
                    if existing_used {
                        continue;
                    }
                    let current = self.todo(&claim.user_id, &id).await?;
                    if !["pending", "in_progress"].contains(&current.status.as_str()) {
                        continue;
                    }
                    existing_used = true;
                    (
                        current.title,
                        current.description,
                        current.kind,
                        original.source_kind.clone(),
                        original.source_label.clone(),
                        Some(id),
                    )
                } else {
                    if !context.goals.iter().any(|g| {
                        g.kind == p.kind
                            || g.kind == "general"
                                && ["general", "errand", "reading", "expense"]
                                    .contains(&p.kind.as_str())
                    }) {
                        return Err(DomainError::Validation("建议超出了用户选择的目标".into()));
                    }
                    (
                        title,
                        p.description,
                        p.kind,
                        "ai_daily".into(),
                        "AI 每日建议".into(),
                        None,
                    )
                };
            let fingerprint = todo_id
                .clone()
                .unwrap_or_else(|| title.trim().to_lowercase());
            if !seen.insert(fingerprint) {
                continue;
            }
            let visible = accepted.iter().filter(|(slot, _)| *slot > 0).count() < 3
                && budget + p.estimated_minutes <= context.daily_minutes;
            let slot = if visible {
                budget += p.estimated_minutes;
                accepted.iter().filter(|(slot, _)| *slot > 0).count() as i64 + 1
            } else {
                0
            };
            let item = DailyPlanItem {
                id: new_id(),
                title,
                description,
                kind,
                reason,
                estimated_minutes: p.estimated_minutes,
                source_kind,
                source_label,
                todo_id,
                todo: None,
                status: if visible { "suggested" } else { "spare" }.into(),
                focus: slot == 1,
                can_replace: false,
                version: 1,
            };
            accepted.push((slot, item));
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, &claim.user_id).await?;
        let current = sqlx::query("SELECT body,version FROM growth_preferences WHERE user_id=$1")
            .bind(&claim.user_id)
            .fetch_one(&mut *tx)
            .await?;
        let current_prefs: StoredPreferences = parse(current.get("body"))?;
        if current.get::<i64, _>("version") != context.preferences_version
            || !current_prefs.enabled
            || current_prefs.paused_date.as_deref() == Some(&local_date(now(), &prefs.timezone)?)
            || local_date(now(), &context.timezone)? != context.local_date
        {
            return Err(DomainError::Conflict(
                "成长设置或日期已变化，本次结果未应用；原有事项已保留".into(),
            ));
        }
        let changed=sqlx::query("UPDATE tasks SET status='succeeded',progress=100,result='每日建议已准备',model_mode='llm',claimed_until=0,updated_at=$1 WHERE id=$2 AND user_id=$3 AND status='running' AND attempts=$4 AND claimed_until>=$1 AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=$3 AND c.disabled<>0)")
            .bind(now()).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        let changed=sqlx::query("UPDATE growth_daily_plans SET status='ready',error=NULL,updated_at=$1 WHERE id=$2 AND user_id=$3 AND task_id=$4 AND status='generating' AND model_attempt=$5 AND context=$6")
            .bind(now()).bind(&context.plan_id).bind(&claim.user_id).bind(&claim.task.id).bind(claim.attempt).bind(json(context)?).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        for (slot, mut item) in accepted {
            if let Some(todo_id) = &item.todo_id {
                let current:Option<String>=sqlx::query_scalar("SELECT body FROM todos WHERE user_id=$1 AND id=$2 AND status IN ('pending','in_progress')").bind(&claim.user_id).bind(todo_id).fetch_optional(&mut *tx).await?;
                let Some(current) = current else {
                    continue;
                };
                let current: Todo = parse(&current)?;
                item.title = current.title;
                item.description = current.description;
                item.kind = current.kind;
                item.source_kind = current.source_kind;
                item.source_label = current.source_label;
            }
            sqlx::query("INSERT INTO growth_plan_items(id,plan_id,user_id,todo_id,body,status,slot,focus,version,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)")
            .bind(&item.id).bind(&context.plan_id).bind(&claim.user_id).bind(&item.todo_id).bind(json(&item)?).bind(&item.status).bind(slot).bind(i64::from(item.focus)).bind(now()).execute(&mut *tx).await?;
        }
        let mut redacted = context.clone();
        redacted.existing_todos.clear();
        redacted.goals.clear();
        sqlx::query("UPDATE growth_daily_plans SET context=$1 WHERE user_id=$2 AND id=$3")
            .bind(json(&redacted)?)
            .bind(&claim.user_id)
            .bind(&context.plan_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn fail_daily_generation(
        &self,
        claim: &ClaimedTask,
        message: &str,
    ) -> Result<(), DomainError> {
        let mut tx = self.pool.begin().await?;
        let changed=sqlx::query("UPDATE tasks SET status='failed',error=$1,claimed_until=0,updated_at=$2 WHERE id=$3 AND user_id=$4 AND status='running' AND attempts=$5")
            .bind(message).bind(now()).bind(&claim.task.id).bind(&claim.user_id).bind(claim.attempt).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(());
        }
        sqlx::query("UPDATE growth_daily_plans SET status='failed',error=$1,context='',updated_at=$2 WHERE user_id=$3 AND task_id=$4 AND status IN ('queued','generating')")
            .bind(message).bind(now()).bind(&claim.user_id).bind(&claim.task.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn accept_daily_item(
        &self,
        user: &str,
        id: &str,
        input: DailyItemCommand,
    ) -> Result<AcceptDailyItem, DomainError> {
        let prefs = self.growth_preferences(user).await?;
        let mut tx = self.pool.begin().await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("accept:{id}"),
            &input.version,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            return self.current_accepted_item(user, id).await;
        }
        let row=sqlx::query("SELECT i.body,i.status,i.version,i.todo_id,i.plan_id,p.local_date,p.timezone,p.status AS plan_status FROM growth_plan_items i JOIN growth_daily_plans p ON p.id=i.plan_id WHERE i.user_id=$1 AND i.id=$2 AND i.slot>0")
            .bind(user).bind(id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        if row.get::<i64, _>("version") != input.version {
            return Err(item_conflict());
        }
        let status: String = row.get("status");
        if !["suggested", "accepted"].contains(&status.as_str()) {
            return Err(item_conflict());
        }
        let mut item: DailyPlanItem = parse(row.get("body"))?;
        let current: Option<String> =
            sqlx::query_scalar("SELECT body FROM growth_preferences WHERE user_id=$1")
                .bind(user)
                .fetch_optional(&mut *tx)
                .await?;
        let current: StoredPreferences =
            current.map(|b| parse(&b)).transpose()?.unwrap_or_default();
        if status != "accepted"
            && (!current.enabled
                || current.paused_date.as_deref() == Some(&local_date(now(), &prefs.timezone)?))
        {
            return Err(DomainError::Conflict(
                "每日建议已暂停，原有待办仍可使用".into(),
            ));
        }
        if status != "accepted"
            && (row.get::<String, _>("plan_status") != "ready"
                || local_date(now(), row.get("timezone"))? != row.get::<String, _>("local_date"))
        {
            return Err(DomainError::Conflict(
                "这份建议已过期，请刷新；已接纳事项不会删除".into(),
            ));
        }
        // Reserve this candidate before inserting a todo. An identical concurrent
        // accept cannot create a second user commitment.
        let changed=sqlx::query("UPDATE growth_plan_items SET version=version+1 WHERE user_id=$1 AND id=$2 AND version=$3")
            .bind(user).bind(id).bind(input.version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(item_conflict());
        }
        let existing: Option<String> = row.get("todo_id");
        let todo = if let Some(todo_id) = existing {
            let body: String =
                sqlx::query_scalar("SELECT body FROM todos WHERE user_id=$1 AND id=$2")
                    .bind(user)
                    .bind(&todo_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .ok_or_else(|| DomainError::Conflict("原待办已删除，不能重新创建".into()))?;
            let todo: Todo = parse(&body)?;
            if !["pending", "in_progress", "waiting", "completed"].contains(&todo.status.as_str()) {
                return Err(item_conflict());
            }
            todo
        } else {
            let time = timestamp(now());
            let todo = Todo {
                id: new_id(),
                title: item.title.clone(),
                description: item.description.clone(),
                kind: item.kind.clone(),
                status: "pending".into(),
                source_kind: "ai_daily".into(),
                source_label: "AI 每日建议".into(),
                source_id: Some(item.id.clone()),
                source_excerpt: None,
                due_at: None,
                estimated_minutes: Some(item.estimated_minutes),
                draft: None,
                progress_notes: None,
                linked_task_id: None,
                created_at: time.clone(),
                updated_at: time,
                completed_at: None,
                version: 1,
            };
            crate::todos::insert(&mut tx, user, &todo).await?;
            todo
        };
        item.todo_id = Some(todo.id.clone());
        item.todo = Some(todo.clone());
        item.status = "accepted".into();
        item.version = input.version + 1;
        item.can_replace = false;
        let mut stored = item.clone();
        stored.todo = None;
        sqlx::query("UPDATE growth_plan_items SET todo_id=$1,status='accepted',body=$2 WHERE user_id=$3 AND id=$4")
            .bind(&todo.id).bind(json(&stored)?).bind(user).bind(id).execute(&mut *tx).await?;
        let result = AcceptDailyItem { item, todo };
        command_finish(
            &mut tx,
            user,
            &input.client_request_id,
            &result.todo.id,
            &result,
        )
        .await?;
        tx.commit().await?;
        Ok(result)
    }

    async fn current_accepted_item(
        &self,
        user: &str,
        id: &str,
    ) -> Result<AcceptDailyItem, DomainError> {
        let row = sqlx::query(
            "SELECT body,todo_id,status,version FROM growth_plan_items WHERE user_id=$1 AND id=$2",
        )
        .bind(user)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(DomainError::NotFound)?;
        if row.get::<String, _>("status") == "deleted" {
            return Err(DomainError::Conflict("原待办已删除，不能重新创建".into()));
        }
        let todo_id: Option<String> = row.get("todo_id");
        let todo = self.todo(user, &todo_id.ok_or_else(item_conflict)?).await?;
        let mut item: DailyPlanItem = parse(row.get("body"))?;
        item.todo_id = Some(todo.id.clone());
        item.todo = Some(todo.clone());
        item.status = row.get("status");
        item.version = row.get("version");
        item.can_replace = false;
        Ok(AcceptDailyItem { item, todo })
    }

    pub async fn skip_daily_item(
        &self,
        user: &str,
        id: &str,
        input: DailyItemCommand,
    ) -> Result<DailyPlan, DomainError> {
        let mut tx = self.pool.begin().await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("skip:{id}"),
            &input.version,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            return self.daily_plan(user).await;
        }
        let changed=sqlx::query("UPDATE growth_plan_items SET status='skipped',version=version+1 WHERE user_id=$1 AND id=$2 AND version=$3 AND slot>0 AND status IN ('suggested','accepted','skipped')")
            .bind(user).bind(id).bind(input.version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(item_conflict());
        }
        command_finish(
            &mut tx,
            user,
            &input.client_request_id,
            "",
            &serde_json::json!({"ok":true}),
        )
        .await?;
        tx.commit().await?;
        self.daily_plan(user).await
    }

    pub async fn replace_daily_item(
        &self,
        user: &str,
        id: &str,
        input: DailyItemCommand,
    ) -> Result<DailyPlan, DomainError> {
        let prefs = self.growth_preferences(user).await?;
        if !prefs.enabled || prefs.paused_today {
            return Err(DomainError::Conflict("每日建议已暂停".into()));
        }
        let mut tx = self.pool.begin().await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("replace:{id}"),
            &input.version,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            return self.daily_plan(user).await;
        }
        let row=sqlx::query("SELECT i.plan_id,i.slot,i.version,i.todo_id,i.status,p.local_date,p.timezone,p.context FROM growth_plan_items i JOIN growth_daily_plans p ON p.id=i.plan_id WHERE i.user_id=$1 AND i.id=$2")
            .bind(user).bind(id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        if row.get::<i64, _>("version") != input.version
            || row.get::<i64, _>("slot") <= 0
            || row.get::<String, _>("status") != "suggested"
            || row.get::<Option<String>, _>("todo_id").is_some()
        {
            return Err(item_conflict());
        }
        if local_date(now(), row.get("timezone"))? != row.get::<String, _>("local_date") {
            return Err(DomainError::Conflict("这份建议已过期，请刷新".into()));
        }
        let plan_id: String = row.get("plan_id");
        let slot: i64 = row.get("slot");
        // Serialize all replacements within the plan, so two slots cannot take
        // the same spare or overrun the fixed accepted time budget.
        sqlx::query(
            "UPDATE growth_daily_plans SET updated_at=updated_at WHERE id=$1 AND user_id=$2",
        )
        .bind(&plan_id)
        .bind(user)
        .execute(&mut *tx)
        .await?;
        let context: DailyPlanContext = parse(row.get("context"))?;
        let others=sqlx::query("SELECT body FROM growth_plan_items WHERE user_id=$1 AND plan_id=$2 AND slot>0 AND id<>$3 AND status IN ('suggested','accepted')")
            .bind(user).bind(&plan_id).bind(id).fetch_all(&mut *tx).await?;
        let used = others
            .iter()
            .map(|r| parse::<DailyPlanItem>(r.get("body")).map(|i| i.estimated_minutes))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .sum::<i64>();
        let spare=sqlx::query("SELECT id,body,version FROM growth_plan_items WHERE user_id=$1 AND plan_id=$2 AND status='spare' ORDER BY created_at,id LIMIT 6")
            .bind(user).bind(&plan_id).fetch_all(&mut *tx).await?.into_iter().find(|r|parse::<DailyPlanItem>(r.get("body")).is_ok_and(|i|used+i.estimated_minutes<=context.daily_minutes)).ok_or_else(||DomainError::Conflict("本批没有更合适的备选，当前建议和事项已保留".into()))?;
        let changed=sqlx::query("UPDATE growth_plan_items SET status='replaced',slot=0,version=version+1 WHERE user_id=$1 AND id=$2 AND version=$3 AND status='suggested'")
            .bind(user).bind(id).bind(input.version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(item_conflict());
        }
        sqlx::query("UPDATE growth_plan_items SET status='suggested',slot=$1,focus=$2,version=version+1 WHERE user_id=$3 AND id=$4 AND status='spare'")
            .bind(slot).bind(i64::from(slot==1)).bind(user).bind(spare.get::<String,_>("id")).execute(&mut *tx).await?;
        command_finish(
            &mut tx,
            user,
            &input.client_request_id,
            "",
            &serde_json::json!({"ok":true}),
        )
        .await?;
        tx.commit().await?;
        self.daily_plan(user).await
    }
}
