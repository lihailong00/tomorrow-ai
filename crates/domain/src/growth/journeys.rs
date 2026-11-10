//! A user-confirmed goal, a bounded generated route, and ordinary owned Todos.
//! Progress always derives from Todo facts; generating a route never completes it.
use super::*;
use crate::{new_id, now, timestamp, ClaimedTask, Todo};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use utoipa::ToSchema;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthJourneyStep {
    pub id: String,
    pub title: String,
    pub description: String,
    pub criterion: String,
    pub estimated_minutes: i64,
    pub status: String,
    pub todo: Option<Todo>,
    pub difficulty: Option<String>,
    pub version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthJourney {
    pub id: String,
    pub goal: String,
    pub kind: String,
    pub daily_minutes: i64,
    pub status: String,
    pub error: Option<String>,
    pub can_retry: bool,
    pub version: i64,
    pub steps: Vec<GrowthJourneyStep>,
    pub completed_steps: i64,
    pub skipped_steps: i64,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthJourneys {
    pub active: Option<GrowthJourney>,
    pub past: Vec<GrowthJourney>,
}
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct StartGrowthJourney {
    pub goal: String,
    pub kind: String,
    pub daily_minutes: i64,
    pub preferences_version: i64,
    pub client_request_id: String,
}
#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GrowthJourneyCommand {
    pub version: i64,
    pub client_request_id: String,
    pub action: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GrowthJourneyContext {
    pub id: String,
    pub goal: String,
    pub kind: String,
    pub daily_minutes: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposedJourney {
    steps: Vec<ProposedStep>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposedStep {
    title: String,
    description: String,
    criterion: String,
    estimated_minutes: i64,
}
fn changed() -> DomainError {
    DomainError::Conflict("成长旅程已变化，请刷新后继续".into())
}

impl Repository {
    pub async fn growth_journey_focus_kind(
        &self,
        user: &str,
    ) -> Result<Option<String>, DomainError> {
        Ok(sqlx::query_scalar("SELECT j.kind FROM growth_journeys j WHERE j.user_id=$1 AND j.status IN ('queued','generating','ready') AND (j.status<>'ready' OR EXISTS(SELECT 1 FROM growth_journey_steps s LEFT JOIN todos t ON t.user_id=s.user_id AND t.id=s.todo_id WHERE s.journey_id=j.id AND s.user_id=j.user_id AND s.skipped=0 AND (t.status IS NULL OR t.status<>'completed'))) ORDER BY j.created_at DESC,j.id DESC LIMIT 1").bind(user).fetch_optional(&self.pool).await?)
    }
    pub async fn growth_journey(&self, user: &str, id: &str) -> Result<GrowthJourney, DomainError> {
        let row=sqlx::query("SELECT j.*,t.status AS task_status FROM growth_journeys j LEFT JOIN tasks t ON t.id=j.task_id AND t.user_id=j.user_id WHERE j.user_id=$1 AND j.id=$2")
            .bind(user).bind(id).fetch_optional(&self.pool).await?.ok_or(DomainError::NotFound)?;
        let mut status: String = row.get("status");
        let mut error: Option<String> = row.get("error");
        if matches!(status.as_str(), "queued" | "generating")
            && row
                .get::<Option<String>, _>("task_status")
                .is_some_and(|s| {
                    matches!(
                        s.as_str(),
                        "failed" | "cancelled" | "uncertain" | "succeeded"
                    )
                })
        {
            status = "failed".into();
            error = Some("上次准备没有完成，可以明确重试一次".into());
        }
        let rows=sqlx::query("SELECT s.*,t.body AS todo_body FROM growth_journey_steps s LEFT JOIN todos t ON t.user_id=s.user_id AND t.id=s.todo_id WHERE s.user_id=$1 AND s.journey_id=$2 ORDER BY s.position")
            .bind(user).bind(id).fetch_all(&self.pool).await?;
        let mut steps = vec![];
        let mut completed = 0;
        let mut skipped = 0;
        let mut current = false;
        for r in rows {
            let mut todo = r
                .get::<Option<String>, _>("todo_body")
                .map(|v| parse::<Todo>(&v))
                .transpose()?;
            if let Some(todo) = &mut todo {
                todo.description = todo.description.chars().take(400).collect();
                todo.draft = None;
                todo.source_excerpt = None;
                todo.progress_notes = None;
                todo.linked_task_id = None;
            }
            let state = if todo.as_ref().is_some_and(|t| t.status == "completed") {
                completed += 1;
                "completed"
            } else if r.get::<i64, _>("skipped") == 1 {
                skipped += 1;
                "skipped"
            } else if !current {
                current = true;
                if r.get::<Option<String>, _>("todo_id").is_some() && todo.is_none() {
                    "deleted"
                } else {
                    "current"
                }
            } else {
                "locked"
            };
            steps.push(GrowthJourneyStep {
                id: r.get("id"),
                title: r.get("title"),
                description: r.get("description"),
                criterion: r.get("criterion"),
                estimated_minutes: r.get("minutes"),
                status: state.into(),
                todo,
                difficulty: r.get("difficulty"),
                version: r.get("version"),
            });
        }
        if status == "ready" && !steps.is_empty() && completed + skipped == steps.len() as i64 {
            status = "completed".into();
        }
        // A correction to an old Todo must not leave a false completed route,
        // nor displace the user's newer active goal.
        if status == "completed" && completed + skipped != steps.len() as i64 {
            status = "archived".into();
        }
        Ok(GrowthJourney {
            id: id.into(),
            goal: row.get("goal"),
            kind: row.get("kind"),
            daily_minutes: row.get("daily_minutes"),
            can_retry: status == "failed"
                && row.get::<i64, _>("attempts") < 2
                && row.get::<i64, _>("dispatches") < 4,
            status,
            error,
            version: row.get("version"),
            steps,
            completed_steps: completed,
            skipped_steps: skipped,
        })
    }
    pub async fn growth_journeys(&self, user: &str) -> Result<GrowthJourneys, DomainError> {
        self.user(user).await?;
        let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM growth_journeys WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 21").bind(user).fetch_all(&self.pool).await?;
        let mut result = GrowthJourneys {
            active: None,
            past: vec![],
        };
        for id in ids {
            let j = self.growth_journey(user, &id).await?;
            if !matches!(j.status.as_str(), "completed" | "archived") && result.active.is_none() {
                result.active = Some(j);
            } else if result.past.len() < 20 {
                result.past.push(j);
            }
        }
        Ok(result)
    }
    pub async fn start_growth_journey(
        &self,
        user: &str,
        input: StartGrowthJourney,
    ) -> Result<GrowthJourney, DomainError> {
        let goal = crate::validate_text(&input.goal, "成长目标", 120)?;
        if !matches!(input.kind.as_str(), "learning" | "exercise" | "general")
            || !(5..=120).contains(&input.daily_minutes)
        {
            return Err(DomainError::Validation(
                "请选择成长方向和5至120分钟的时间".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, user).await?;
        if let Some(id) = command_start(
            &mut tx,
            user,
            &input.client_request_id,
            "start_journey",
            &input,
        )
        .await?
        {
            let id: String = parse(&id)?;
            tx.commit().await?;
            return self.growth_journey(user, &id).await;
        }
        let row = sqlx::query("SELECT body,version FROM growth_preferences WHERE user_id=$1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        if row.get::<i64, _>("version") != input.preferences_version {
            return Err(changed());
        }
        let previous:Vec<String>=sqlx::query_scalar("SELECT id FROM growth_journeys WHERE user_id=$1 AND status IN ('ready','queued','generating','failed') ORDER BY created_at DESC,id DESC").bind(user).fetch_all(&mut *tx).await?;
        for old in previous {
            let pending:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_journey_steps s LEFT JOIN todos t ON t.id=s.todo_id AND t.user_id=s.user_id WHERE s.user_id=$1 AND s.journey_id=$2 AND s.skipped=0 AND (t.status IS NULL OR t.status<>'completed')").bind(user).bind(&old).fetch_one(&mut *tx).await?;
            let total: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM growth_journey_steps WHERE user_id=$1 AND journey_id=$2",
            )
            .bind(user)
            .bind(&old)
            .fetch_one(&mut *tx)
            .await?;
            if pending > 0 || total == 0 {
                return Err(DomainError::Conflict(
                    "先继续当前旅程，或将它放一放后再开始新的目标".into(),
                ));
            }
            sqlx::query("UPDATE growth_journeys SET status='completed',version=version+1 WHERE user_id=$1 AND id=$2").bind(user).bind(old).execute(&mut *tx).await?;
        }
        let recent: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM growth_journeys WHERE user_id=$1 AND created_at>$2",
        )
        .bind(user)
        .bind(now() - 86400)
        .fetch_one(&mut *tx)
        .await?;
        if recent >= 3 {
            return Err(DomainError::Conflict(
                "今天已准备了三段旅程，先试试已有路线，明天再开始新的目标".into(),
            ));
        }
        let mut prefs: StoredPreferences = parse(row.get("body"))?;
        prefs.enabled = true;
        prefs.paused_date = None;
        prefs.daily_minutes = input.daily_minutes;
        prefs.goals.retain(|g| g.kind != input.kind);
        prefs.goals.insert(
            0,
            GrowthGoal {
                kind: input.kind.clone(),
                title: goal.clone(),
            },
        );
        prefs.goals.truncate(3);
        sqlx::query("UPDATE growth_preferences SET body=$1,version=version+1,last_active_at=$2 WHERE user_id=$3").bind(json(&prefs)?).bind(now()).bind(user).execute(&mut *tx).await?;
        let id = new_id();
        let task = new_id();
        sqlx::query("INSERT INTO growth_journeys(id,user_id,goal,kind,daily_minutes,status,task_id,created_at,updated_at)VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$7)").bind(&id).bind(user).bind(goal).bind(&input.kind).bind(input.daily_minutes).bind(&task).bind(now()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at)VALUES($1,$2,'准备我的成长旅程',$3,'growth_journey','queued',$4,$4)").bind(task).bind(user).bind(&id).bind(now()).execute(&mut *tx).await?;
        command_finish(&mut tx, user, &input.client_request_id, "", &id).await?;
        tx.commit().await?;
        self.growth_journey(user, &id).await
    }
    pub async fn command_growth_journey(
        &self,
        user: &str,
        id: &str,
        input: GrowthJourneyCommand,
    ) -> Result<GrowthJourney, DomainError> {
        if !matches!(input.action.as_str(), "archive" | "retry") {
            return Err(DomainError::Validation("不支持的旅程操作".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, user).await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("journey:{id}"),
            &input,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            return self.growth_journey(user, id).await;
        }
        let row=sqlx::query("SELECT status,version,attempts,dispatches,task_id FROM growth_journeys WHERE user_id=$1 AND id=$2").bind(user).bind(id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        if row.get::<i64, _>("version") != input.version {
            return Err(changed());
        }
        if input.action == "archive" {
            sqlx::query("UPDATE growth_journeys SET status='archived',version=version+1,updated_at=$1 WHERE user_id=$2 AND id=$3").bind(now()).bind(user).bind(id).execute(&mut *tx).await?;
            if let Some(task) = row.get::<Option<String>, _>("task_id") {
                sqlx::query("UPDATE tasks SET status='cancelled',claimed_until=0,updated_at=$1 WHERE user_id=$2 AND id=$3 AND status IN ('queued','running')").bind(now()).bind(user).bind(task).execute(&mut *tx).await?;
            }
        } else {
            let pref: StoredPreferences = parse(
                &sqlx::query_scalar::<_, String>(
                    "SELECT body FROM growth_preferences WHERE user_id=$1",
                )
                .bind(user)
                .fetch_one(&mut *tx)
                .await?,
            )?;
            let status: String = row.get("status");
            let task_failed = if let Some(task) = row.get::<Option<String>, _>("task_id") {
                sqlx::query_scalar::<_, String>(
                    "SELECT status FROM tasks WHERE user_id=$1 AND id=$2",
                )
                .bind(user)
                .bind(task)
                .fetch_optional(&mut *tx)
                .await?
                .is_some_and(|s| {
                    matches!(
                        s.as_str(),
                        "failed" | "cancelled" | "uncertain" | "succeeded"
                    )
                })
            } else {
                false
            };
            if !pref.enabled
                || row.get::<i64, _>("attempts") >= 2
                || row.get::<i64, _>("dispatches") >= 4
                || !(status == "failed"
                    || (matches!(status.as_str(), "queued" | "generating") && task_failed))
            {
                return Err(changed());
            }
            let task = new_id();
            sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at)VALUES($1,$2,'重新准备成长旅程',$3,'growth_journey','queued',$4,$4)").bind(&task).bind(user).bind(id).bind(now()).execute(&mut *tx).await?;
            sqlx::query("UPDATE growth_journeys SET status='queued',task_id=$1,dispatches=dispatches+1,model_attempt=NULL,error=NULL,version=version+1,updated_at=$2 WHERE user_id=$3 AND id=$4").bind(task).bind(now()).bind(user).bind(id).execute(&mut *tx).await?;
        }
        command_finish(&mut tx, user, &input.client_request_id, "", &true).await?;
        tx.commit().await?;
        self.growth_journey(user, id).await
    }
    pub async fn begin_growth_journey(
        &self,
        claim: &ClaimedTask,
    ) -> Result<Option<GrowthJourneyContext>, DomainError> {
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, &claim.user_id).await?;
        let pref: StoredPreferences = parse(
            &sqlx::query_scalar::<_, String>(
                "SELECT body FROM growth_preferences WHERE user_id=$1",
            )
            .bind(&claim.user_id)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        if !pref.enabled {
            return Err(changed());
        }
        let row =
            sqlx::query("SELECT * FROM growth_journeys WHERE user_id=$1 AND id=$2 AND task_id=$3")
                .bind(&claim.user_id)
                .bind(&claim.task.instruction)
                .bind(&claim.task.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(DomainError::NotFound)?;
        if row.get::<String, _>("status") == "generating"
            && row.get::<Option<i64>, _>("model_attempt") != Some(claim.attempt)
        {
            tx.commit().await?;
            self.fail_growth_journey(claim, "上次生成中断，请明确重试；不会自动重复付费调用")
                .await?;
            return Ok(None);
        }
        let changed=sqlx::query("UPDATE growth_journeys SET status='generating',attempts=attempts+1,model_attempt=$1 WHERE user_id=$2 AND id=$3 AND task_id=$4 AND status='queued' AND model_attempt IS NULL AND attempts<2 AND EXISTS(SELECT 1 FROM tasks WHERE id=$4 AND user_id=$2 AND status='running' AND attempts=$1 AND claimed_until>=$5) AND NOT EXISTS(SELECT 1 FROM admin_user_controls c WHERE c.user_id=$2 AND c.disabled<>0)").bind(claim.attempt).bind(&claim.user_id).bind(&claim.task.instruction).bind(&claim.task.id).bind(now()).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            tx.commit().await?;
            return Ok(None);
        }
        let context = GrowthJourneyContext {
            id: row.get("id"),
            goal: row.get("goal"),
            kind: row.get("kind"),
            daily_minutes: row.get("daily_minutes"),
        };
        tx.commit().await?;
        Ok(Some(context))
    }
    pub async fn complete_growth_journey(
        &self,
        claim: &ClaimedTask,
        context: &GrowthJourneyContext,
        raw: &str,
    ) -> Result<bool, DomainError> {
        if raw.len() > 20000 {
            return Err(DomainError::Validation("成长路线过长".into()));
        }
        let proposal: ProposedJourney = serde_json::from_str(raw.trim())
            .map_err(|_| DomainError::Validation("成长路线格式无效".into()))?;
        if !(3..=6).contains(&proposal.steps.len()) {
            return Err(DomainError::Validation("成长路线应包含3至6个步骤".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for step in &proposal.steps {
            crate::validate_text(&step.title, "步骤标题", 120)?;
            crate::validate_text(&step.description, "步骤说明", 1500)?;
            crate::validate_text(&step.criterion, "完成标准", 400)?;
            if !seen.insert(step.title.trim())
                || !(1..=context.daily_minutes).contains(&step.estimated_minutes)
            {
                return Err(DomainError::Validation(
                    "步骤重复或超出了你选择的时间".into(),
                ));
            }
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, &claim.user_id).await?;
        let prefs: StoredPreferences = parse(
            &sqlx::query_scalar::<_, String>(
                "SELECT body FROM growth_preferences WHERE user_id=$1",
            )
            .bind(&claim.user_id)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        if !prefs.enabled {
            return Err(changed());
        }
        let changed=sqlx::query("UPDATE growth_journeys SET status='ready',error=NULL,version=version+1,updated_at=$1 WHERE user_id=$2 AND id=$3 AND task_id=$4 AND status='generating' AND model_attempt=$5 AND goal=$6 AND kind=$7 AND daily_minutes=$8 AND EXISTS(SELECT 1 FROM tasks WHERE user_id=$2 AND id=$4 AND status='running' AND attempts=$5 AND claimed_until>=$1) AND NOT EXISTS(SELECT 1 FROM admin_user_controls WHERE user_id=$2 AND disabled<>0)")
            .bind(now()).bind(&claim.user_id).bind(&context.id).bind(&claim.task.id).bind(claim.attempt).bind(&context.goal).bind(&context.kind).bind(context.daily_minutes).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Ok(false);
        }
        for (position, step) in proposal.steps.into_iter().enumerate() {
            sqlx::query("INSERT INTO growth_journey_steps(id,journey_id,user_id,position,title,description,criterion,minutes)VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(new_id()).bind(&context.id).bind(&claim.user_id).bind(position as i64).bind(step.title.trim()).bind(step.description.trim()).bind(step.criterion.trim()).bind(step.estimated_minutes).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE tasks SET status='succeeded',progress=100,result='成长路线已准备',model_mode='llm',claimed_until=0,updated_at=$1 WHERE user_id=$2 AND id=$3 AND status='running' AND attempts=$4").bind(now()).bind(&claim.user_id).bind(&claim.task.id).bind(claim.attempt).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }
    pub async fn fail_growth_journey(
        &self,
        claim: &ClaimedTask,
        message: &str,
    ) -> Result<(), DomainError> {
        let mut tx = self.pool.begin().await?;
        let changed=sqlx::query("UPDATE tasks SET status='failed',error=$1,claimed_until=0,updated_at=$2 WHERE user_id=$3 AND id=$4 AND status='running' AND attempts=$5").bind(message).bind(now()).bind(&claim.user_id).bind(&claim.task.id).bind(claim.attempt).execute(&mut *tx).await?.rows_affected();
        if changed > 0 {
            sqlx::query("UPDATE growth_journeys SET status='failed',error=$1,version=version+1,updated_at=$2 WHERE user_id=$3 AND task_id=$4 AND status IN ('queued','generating')").bind(message).bind(now()).bind(&claim.user_id).bind(&claim.task.id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn start_growth_step(
        &self,
        user: &str,
        journey: &str,
        id: &str,
        input: DailyItemCommand,
    ) -> Result<Todo, DomainError> {
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, user).await?;
        let replay = command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("journey_step:{id}"),
            &input.version,
        )
        .await?
        .is_some();
        let row=sqlx::query("SELECT s.*,j.kind,j.status AS journey_status FROM growth_journey_steps s JOIN growth_journeys j ON j.id=s.journey_id AND j.user_id=s.user_id WHERE s.user_id=$1 AND s.journey_id=$2 AND s.id=$3").bind(user).bind(journey).bind(id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        if let Some(todo) = row.get::<Option<String>, _>("todo_id") {
            let body: Option<String> =
                sqlx::query_scalar("SELECT body FROM todos WHERE user_id=$1 AND id=$2")
                    .bind(user)
                    .bind(&todo)
                    .fetch_optional(&mut *tx)
                    .await?;
            let todo: Todo = parse(&body.ok_or_else(|| {
                DomainError::Conflict("这一步的待办已删除；可以跳过，不会重新创建".into())
            })?)?;
            if !replay {
                command_finish(&mut tx, user, &input.client_request_id, &todo.id, &true).await?;
            }
            tx.commit().await?;
            return Ok(todo);
        }
        if replay
            || row.get::<i64, _>("version") != input.version
            || row.get::<String, _>("journey_status") != "ready"
            || row.get::<i64, _>("skipped") != 0
        {
            return Err(changed());
        }
        let pref: StoredPreferences = parse(
            &sqlx::query_scalar::<_, String>(
                "SELECT body FROM growth_preferences WHERE user_id=$1",
            )
            .bind(user)
            .fetch_one(&mut *tx)
            .await?,
        )?;
        let zone: String = sqlx::query_scalar("SELECT timezone FROM users WHERE id=$1")
            .bind(user)
            .fetch_one(&mut *tx)
            .await?;
        if !pref.enabled || pref.paused_date.as_deref() == Some(&local_date(now(), &zone)?) {
            return Err(DomainError::Conflict(
                "今天已暂停新行动，可以在调整节奏中恢复".into(),
            ));
        }
        let earlier:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_journey_steps s LEFT JOIN todos t ON t.id=s.todo_id AND t.user_id=s.user_id WHERE s.user_id=$1 AND s.journey_id=$2 AND s.position<$3 AND s.skipped=0 AND (t.status IS NULL OR t.status<>'completed')").bind(user).bind(journey).bind(row.get::<i64,_>("position")).fetch_one(&mut *tx).await?;
        if earlier > 0 {
            return Err(DomainError::Conflict(
                "先完成当前这一步，或明确跳过它".into(),
            ));
        }
        let time = timestamp(now());
        let todo = Todo {
            id: new_id(),
            title: row.get("title"),
            description: format!(
                "{}\n\n完成标准：{}",
                row.get::<String, _>("description"),
                row.get::<String, _>("criterion")
            ),
            kind: row.get("kind"),
            status: "pending".into(),
            source_kind: "growth_journey".into(),
            source_label: "我的成长旅程".into(),
            source_id: Some(id.into()),
            source_excerpt: None,
            due_at: None,
            estimated_minutes: Some(row.get("minutes")),
            draft: None,
            progress_notes: None,
            linked_task_id: None,
            created_at: time.clone(),
            updated_at: time,
            completed_at: None,
            version: 1,
        };
        crate::todos::insert(&mut tx, user, &todo).await?;
        sqlx::query("UPDATE growth_journey_steps SET todo_id=$1,version=version+1 WHERE user_id=$2 AND id=$3").bind(&todo.id).bind(user).bind(id).execute(&mut *tx).await?;
        command_finish(&mut tx, user, &input.client_request_id, &todo.id, &true).await?;
        tx.commit().await?;
        Ok(todo)
    }
    pub async fn command_growth_step(
        &self,
        user: &str,
        journey: &str,
        id: &str,
        input: GrowthJourneyCommand,
    ) -> Result<GrowthJourney, DomainError> {
        if !matches!(
            input.action.as_str(),
            "skip" | "too_hard" | "just_right" | "too_easy"
        ) {
            return Err(DomainError::Validation("请选择有效的步骤反馈".into()));
        }
        let mut tx = self.pool.begin().await?;
        lock_preferences(&mut tx, user).await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("step_feedback:{id}"),
            &input,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            return self.growth_journey(user, journey).await;
        }
        let row=sqlx::query("SELECT s.version,s.position,t.status AS todo_status,j.status AS journey_status FROM growth_journey_steps s JOIN growth_journeys j ON j.id=s.journey_id AND j.user_id=s.user_id LEFT JOIN todos t ON t.id=s.todo_id AND t.user_id=s.user_id WHERE s.user_id=$1 AND s.journey_id=$2 AND s.id=$3").bind(user).bind(journey).bind(id).fetch_optional(&mut *tx).await?.ok_or(DomainError::NotFound)?;
        let status: String = row.get("journey_status");
        if row.get::<i64, _>("version") != input.version
            || !matches!(status.as_str(), "ready" | "completed")
            || (input.action == "skip" && status != "ready")
        {
            return Err(changed());
        }
        if input.action == "skip" {
            let earlier:i64=sqlx::query_scalar("SELECT COUNT(*) FROM growth_journey_steps s LEFT JOIN todos t ON t.id=s.todo_id AND t.user_id=s.user_id WHERE s.user_id=$1 AND s.journey_id=$2 AND s.position<$3 AND s.skipped=0 AND (t.status IS NULL OR t.status<>'completed')").bind(user).bind(journey).bind(row.get::<i64,_>("position")).fetch_one(&mut *tx).await?;
            if earlier > 0
                || row.get::<Option<String>, _>("todo_status").as_deref() == Some("completed")
            {
                return Err(changed());
            }
            sqlx::query("UPDATE growth_journey_steps SET skipped=1,version=version+1 WHERE user_id=$1 AND id=$2").bind(user).bind(id).execute(&mut *tx).await?;
        } else {
            if row.get::<Option<String>, _>("todo_status").is_none() {
                return Err(DomainError::Conflict("开始这一步后再告诉我难度".into()));
            }
            sqlx::query("UPDATE growth_journey_steps SET difficulty=$1,version=version+1 WHERE user_id=$2 AND id=$3").bind(&input.action).bind(user).bind(id).execute(&mut *tx).await?;
        }
        command_finish(&mut tx, user, &input.client_request_id, "", &true).await?;
        tx.commit().await?;
        self.growth_journey(user, journey).await
    }
}
