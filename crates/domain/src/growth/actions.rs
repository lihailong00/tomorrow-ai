use super::*;
use crate::{DomainError, Repository, Todo, now, timestamp};
use sqlx::Row;

impl Repository {
    pub async fn todo_actions(&self, user: &str, id: &str) -> Result<TodoActions, DomainError> {
        self.todo(user, id).await?;
        let row = sqlx::query(
            "SELECT replied,updated_at FROM growth_todo_actions WHERE user_id=$1 AND todo_id=$2",
        )
        .bind(user)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(match row {
            Some(r) if r.get::<i64, _>("replied") != 0 => TodoActions {
                replied: true,
                replied_at: Some(timestamp(r.get("updated_at"))),
            },
            _ => TodoActions {
                replied: false,
                replied_at: None,
            },
        })
    }

    pub async fn confirm_todo_action(
        &self,
        user: &str,
        id: &str,
        input: ConfirmTodoAction,
    ) -> Result<TodoActionResult, DomainError> {
        self.todo(user, id).await?;
        if !["replied", "undo_replied", "exercise_completed"].contains(&input.kind.as_str()) {
            return Err(DomainError::Validation("不支持的用户动作".into()));
        }
        if input
            .actual_minutes
            .is_some_and(|m| !(1..=360).contains(&m))
        {
            return Err(DomainError::Validation(
                "实际活动分钟数需为1至360的整数".into(),
            ));
        }
        if input
            .draft
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|d| d.chars().count() > 50000)
            || input
                .progress_notes
                .as_ref()
                .and_then(Option::as_ref)
                .is_some_and(|d| d.chars().count() > 12500)
        {
            return Err(DomainError::Validation("内容超过允许长度".into()));
        }
        let mut tx = self.pool.begin().await?;
        if command_start(
            &mut tx,
            user,
            &input.client_request_id,
            &format!("todo_action:{id}"),
            &input,
        )
        .await?
        .is_some()
        {
            tx.commit().await?;
            // Replaying a committed intent is a no-op, not a stale state rewind.
            return Ok(TodoActionResult {
                todo: self.todo(user, id).await?,
                actions: self.todo_actions(user, id).await?,
                reward: self.growth_reward_state(user, id).await?.reward,
            });
        }
        let row = sqlx::query("SELECT body FROM todos WHERE user_id=$1 AND id=$2")
            .bind(user)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(DomainError::NotFound)?;
        let mut todo: Todo = parse(row.get("body"))?;
        if input.version != todo.version {
            return Err(DomainError::Conflict("待办已更新，请刷新后确认动作".into()));
        }
        let old_action=sqlx::query("SELECT replied,actual_minutes,updated_at FROM growth_todo_actions WHERE user_id=$1 AND todo_id=$2").bind(user).bind(id).fetch_optional(&mut *tx).await?;
        let mut replied = old_action
            .as_ref()
            .is_some_and(|r| r.get::<i64, _>("replied") != 0);
        let old_replied = replied;
        let mut actual_minutes = old_action
            .as_ref()
            .map(|r| r.get::<Option<i64>, _>("actual_minutes"))
            .flatten();
        let before_status = todo.status.clone();
        let event;
        match input.kind.as_str() {
            "replied" => {
                if todo.kind != "communication"
                    || !["pending", "in_progress", "waiting"].contains(&todo.status.as_str())
                {
                    return Err(DomainError::Validation("这条待办当前不能确认回复".into()));
                }
                replied = true;
                todo.status = "waiting".into();
                todo.completed_at = None;
                event = if old_replied { "updated" } else { "replied" };
                if let Some(draft) = input.draft {
                    todo.draft = draft;
                }
            }
            "undo_replied" => {
                if todo.kind != "communication" || !replied {
                    return Err(DomainError::Conflict(
                        "当前没有可以撤销的回复记录，请刷新".into(),
                    ));
                }
                replied = false;
                // Correct this fact without erasing another independently valid
                // completion. A closed parent may remain completed and rewarded.
                if todo.status == "waiting" {
                    todo.status = "pending".into();
                    todo.completed_at = None;
                }
                event = "undo_replied";
            }
            _ => {
                if todo.kind != "exercise"
                    || !["pending", "in_progress", "completed"].contains(&todo.status.as_str())
                {
                    return Err(DomainError::Validation(
                        "这条待办当前不能记录活动完成".into(),
                    ));
                }
                actual_minutes = input.actual_minutes;
                if let Some(notes) = input.progress_notes {
                    todo.progress_notes = notes;
                }
                todo.status = "completed".into();
                if before_status != "completed" {
                    todo.completed_at = Some(timestamp(now()));
                }
                event = if before_status != "completed" {
                    "completed"
                } else {
                    "updated"
                };
            }
        }
        todo.version += 1;
        todo.updated_at = timestamp(now());
        let changed=sqlx::query("UPDATE todos SET body=$1,status=$2,version=$3,updated_at=$4,prepare_version=NULL WHERE user_id=$5 AND id=$6 AND version=$7")
            .bind(json(&todo)?).bind(&todo.status).bind(todo.version).bind(now()).bind(user).bind(id).bind(input.version).execute(&mut *tx).await?.rows_affected();
        if changed == 0 {
            return Err(DomainError::Conflict("待办已更新，请刷新后确认动作".into()));
        }
        let action_time = if replied && old_replied {
            old_action
                .as_ref()
                .map(|r| r.get::<i64, _>("updated_at"))
                .unwrap_or_else(now)
        } else {
            now()
        };
        sqlx::query("INSERT INTO growth_todo_actions(user_id,todo_id,replied,actual_minutes,updated_at)VALUES($1,$2,$3,$4,$5)ON CONFLICT(user_id,todo_id)DO UPDATE SET replied=$3,actual_minutes=$4,updated_at=$5")
            .bind(user).bind(id).bind(i64::from(replied)).bind(actual_minutes).bind(action_time).execute(&mut *tx).await?;
        rewards::reconcile_reward(
            &mut tx,
            user,
            &todo,
            todo.status == "completed" || replied,
            event,
        )
        .await?;
        let reward = rewards::reward_in_transaction(&mut tx, user, id).await?;
        let result = TodoActionResult {
            todo,
            actions: TodoActions {
                replied,
                replied_at: replied.then(|| timestamp(action_time)),
            },
            reward,
        };
        command_finish(&mut tx, user, &input.client_request_id, id, &result).await?;
        tx.commit().await?;
        Ok(result)
    }
}
