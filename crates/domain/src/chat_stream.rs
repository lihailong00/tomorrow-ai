//! Durable chat delivery, separate from the legacy request cancellation contract.
use crate::{auth, new_id, now, Conversation, DomainError, Message, Repository};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Any, Row, Transaction};

pub const CHAT_STREAM_LIFETIME_SECONDS: u64 = crate::agent::AGENT_EXECUTION_TIMEOUT_SECONDS + 60;
const RETAINED_EVENTS: i64 = 500;

#[derive(Clone)]
pub struct ChatStreamProducer {
    pub request_key: String,
    pub attempt_token: String,
    pub accepted: Option<Value>,
}

#[derive(Serialize)]
pub struct ChatStreamView {
    pub sequence: i64,
    pub status: String,
    pub content: String,
    pub accepted: Option<Value>,
    pub error: Option<String>,
    pub response: Option<Value>,
    pub tool_status: Option<Value>,
    pub attempt: i64,
    pub previous_content: Option<String>,
}

pub struct ChatStreamEvent {
    pub sequence: i64,
    pub kind: String,
    pub body: Value,
}

impl Repository {
    /// Atomically reserves the same namespace used by /chat. A stream producer
    /// owns the request until terminal; reattachment never rotates its authority.
    pub async fn begin_chat_stream(
        &self,
        user_id: &str,
        request_id: &str,
        fingerprint: &str,
    ) -> Result<Option<ChatStreamProducer>, DomainError> {
        self.begin_chat_stream_retry(user_id, request_id, fingerprint, false)
            .await
    }

    pub async fn begin_chat_stream_retry(
        &self,
        user_id: &str,
        request_id: &str,
        fingerprint: &str,
        retry: bool,
    ) -> Result<Option<ChatStreamProducer>, DomainError> {
        let key = crate::repository::chat_request_key(user_id, request_id)?;
        let fingerprint = auth::hash_token(fingerprint);
        let token = new_id();
        let mut tx = self.pool.begin().await?;
        crate::chat_messages::valid_request_tx(&mut tx, user_id, &key).await?;
        let inserted = sqlx::query("INSERT INTO chat_requests(request_key,user_id,created_at)VALUES($1,$2,$3)ON CONFLICT(request_key)DO NOTHING")
            .bind(&key).bind(user_id).bind(now()).execute(&mut *tx).await?.rows_affected();
        if inserted == 1 {
            sqlx::query(
                "INSERT INTO chat_request_inputs(request_key,user_id,fingerprint)VALUES($1,$2,$3)",
            )
            .bind(&key)
            .bind(user_id)
            .bind(&fingerprint)
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO chat_request_attempts(request_key,user_id,attempt_token)VALUES($1,$2,$3)")
                .bind(&key).bind(user_id).bind(&token).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO chat_streams(request_key,user_id,attempt_token,lease_until,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$5)")
                .bind(&key).bind(user_id).bind(&token).bind(now()+CHAT_STREAM_LIFETIME_SECONDS as i64+5).bind(now()).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(Some(ChatStreamProducer {
                request_key: key,
                attempt_token: token,
                accepted: None,
            }));
        }
        let row = sqlx::query("SELECT i.fingerprint,s.request_key,s.accepted,s.agent_run_id FROM chat_requests c LEFT JOIN chat_request_inputs i ON i.request_key=c.request_key AND i.user_id=c.user_id LEFT JOIN chat_streams s ON s.request_key=c.request_key AND s.user_id=c.user_id WHERE c.request_key=$1 AND c.user_id=$2")
            .bind(&key).bind(user_id).fetch_one(&mut *tx).await?;
        if row.get::<Option<String>, _>("fingerprint").as_deref() != Some(fingerprint.as_str()) {
            return Err(DomainError::Conflict(
                "同一消息请求编号不能用于不同内容".into(),
            ));
        }
        if row.get::<Option<String>, _>("request_key").is_none() {
            return Err(DomainError::Conflict(
                "这条消息由旧版接口处理，请在原会话查看结果".into(),
            ));
        }
        if retry {
            // Agent callbacks lock the run before the stream; use the same lock
            // order when revoking a stale producer on PostgreSQL.
            if let Some(run) = row.get::<Option<String>, _>("agent_run_id") {
                sqlx::query(
                    "UPDATE agent_runs SET updated_at=updated_at WHERE id=$1 AND user_id=$2",
                )
                .bind(run)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            }
            let acquired=sqlx::query("UPDATE chat_streams SET attempt_token=$1,attempt=attempt+1,previous_content=partial,reset_pending=1,status='running',error=NULL,tool_status=NULL,lease_until=$2,updated_at=$3 WHERE request_key=$4 AND user_id=$5 AND (status='interrupted' OR (status='running' AND lease_until<$3)) RETURNING accepted,agent_run_id")
                .bind(&token).bind(now()+CHAT_STREAM_LIFETIME_SECONDS as i64+5).bind(now()).bind(&key).bind(user_id).fetch_optional(&mut *tx).await?;
            if let Some(acquired) = acquired {
                // Acceptance may have committed after our initial read. Never
                // return stale message IDs or take the run/stream locks backwards.
                if acquired.get::<Option<String>, _>("agent_run_id")
                    != row.get::<Option<String>, _>("agent_run_id")
                {
                    return Err(DomainError::Conflict("消息状态已更新，请重试此回复".into()));
                }
                sqlx::query("UPDATE chat_request_attempts SET attempt_token=$1 WHERE request_key=$2 AND user_id=$3")
                    .bind(&token).bind(&key).bind(user_id).execute(&mut *tx).await?;
                // Revoke a crashed/timed-out producer before the new Agent run
                // rotates its token; durable business-operation replay stays intact.
                if let Some(run) = row.get::<Option<String>, _>("agent_run_id") {
                    sqlx::query("UPDATE agent_runs SET status='failed',lease_until=0,error=$1,updated_at=$2 WHERE id=$3 AND user_id=$4 AND scope='chat' AND status='running'")
                        .bind("用户已明确重试中断回复").bind(now()).bind(run).bind(user_id).execute(&mut *tx).await?;
                }
                let accepted = acquired
                    .get::<Option<String>, _>("accepted")
                    .map(|s| {
                        serde_json::from_str(&s)
                            .map_err(|_| DomainError::Internal("消息记录读取失败".into()))
                    })
                    .transpose()?;
                append_event_tx(&mut tx, &key, "retrying", json!({"preserve_partial":true}))
                    .await?;
                tx.commit().await?;
                return Ok(Some(ChatStreamProducer {
                    request_key: key,
                    attempt_token: token,
                    accepted,
                }));
            }
        }
        tx.commit().await?;
        Ok(None)
    }

    pub async fn accept_chat_stream(
        &self,
        producer: &ChatStreamProducer,
        user_id: &str,
        conversation: &Conversation,
        user_message: &Message,
        message_id: &str,
        message_created_at: &str,
        agent_run_id: Option<&str>,
    ) -> Result<(), DomainError> {
        self.accept_chat_stream_replacing(
            producer,
            user_id,
            conversation,
            user_message,
            message_id,
            message_created_at,
            agent_run_id,
            None,
        )
        .await
    }

    pub async fn accept_chat_stream_replacing(
        &self,
        producer: &ChatStreamProducer,
        user_id: &str,
        conversation: &Conversation,
        user_message: &Message,
        message_id: &str,
        message_created_at: &str,
        agent_run_id: Option<&str>,
        replacement: Option<&crate::chat_messages::ChatReplacement>,
    ) -> Result<(), DomainError> {
        let mut tx = self.pool.begin().await?;
        crate::chat_messages::lock_conversation_tx(&mut tx, user_id, &conversation.id).await?;
        crate::chat_messages::valid_request_tx(&mut tx, user_id, &producer.request_key).await?;
        if let Some(replacement) = replacement {
            crate::chat_messages::validate_replacement_tx(&mut tx, user_id, replacement).await?;
        }
        // Use the callback/retry lock order: run, then stream. Enabling ordinal
        // replay must be atomic with proving that a legacy run has no old effects.
        if let Some(run) = agent_run_id {
            sqlx::query("UPDATE agent_runs SET updated_at=updated_at WHERE id=$1 AND user_id=$2")
                .bind(run)
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        lock_producer(&mut tx, producer).await?;
        if let Some(run) = agent_run_id {
            let enabled: i64 =
                sqlx::query_scalar("SELECT slots_enabled FROM chat_streams WHERE request_key=$1")
                    .bind(&producer.request_key)
                    .fetch_one(&mut *tx)
                    .await?;
            if enabled == 0 {
                let old: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM agent_operations WHERE run_id=$1")
                        .bind(run)
                        .fetch_one(&mut *tx)
                        .await?;
                if old > 0 {
                    return Err(DomainError::AgentReplayConflict);
                }
                sqlx::query("UPDATE chat_streams SET slots_enabled=1 WHERE request_key=$1")
                    .bind(&producer.request_key)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        // Commit the user message before contacting the model. Attachment ownership
        // was validated by preparation and is checked again before final commit.
        for (kind, id, body) in [
            (
                "conversation",
                &conversation.id,
                serde_json::to_string(conversation),
            ),
            (
                "message",
                &user_message.id,
                serde_json::to_string(user_message),
            ),
        ] {
            // An edited stream exposes its tentative text to this subscriber, but
            // keeps the original durable question/reply until successful commit.
            if replacement.is_some() {
                continue;
            }
            let changed = sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$5)ON CONFLICT(id)DO UPDATE SET body=$4,updated_at=$5 WHERE resources.user_id=$2 AND resources.kind=$3")
                .bind(id).bind(user_id).bind(kind).bind(body.map_err(|_|DomainError::Internal("消息保存失败".into()))?).bind(now()).execute(&mut *tx).await?.rows_affected();
            if changed != 1 {
                return Err(DomainError::Forbidden);
            }
        }
        if let Some(replacement) = replacement {
            sqlx::query("INSERT INTO chat_message_requests(request_key,user_id,user_message_id,revision)VALUES($1,$2,$3,$4)ON CONFLICT(request_key)DO NOTHING")
                .bind(&producer.request_key).bind(user_id).bind(&user_message.id).bind(replacement.revision+1).execute(&mut *tx).await?;
        } else {
            crate::chat_messages::track_request_tx(
                &mut tx,
                user_id,
                Some(&producer.request_key),
                user_message,
                message_id,
                0,
            )
            .await?;
        }
        let accepted = json!({"conversation_id":conversation.id,"user_message":user_message,"message_id":message_id,"message_created_at":message_created_at,"agent_run_id":agent_run_id,
            "replacement":replacement,"removed_message_ids":replacement.map(|r|r.removed_message_ids()).unwrap_or_default()});
        sqlx::query("UPDATE chat_streams SET accepted=$1,agent_run_id=$2 WHERE request_key=$3")
            .bind(accepted.to_string())
            .bind(agent_run_id)
            .bind(&producer.request_key)
            .execute(&mut *tx)
            .await?;
        append_event_tx(&mut tx, &producer.request_key, "accepted", accepted).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn append_chat_stream_delta(
        &self,
        producer: &ChatStreamProducer,
        delta: String,
    ) -> Result<(), DomainError> {
        let mut tx = self.pool.begin().await?;
        lock_producer(&mut tx, producer).await?;
        append_visible_tx(
            &mut tx,
            &producer.request_key,
            "text_delta",
            json!({"turn":1,"delta":delta}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn agent_operation_slots_enabled(&self, run_id: &str) -> Result<bool, DomainError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chat_streams WHERE agent_run_id=$1 AND slots_enabled=1",
        )
        .bind(run_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    pub async fn interrupt_chat_stream(
        &self,
        producer: &ChatStreamProducer,
        message: &str,
    ) -> Result<(), DomainError> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query("UPDATE chat_streams SET status='interrupted',error=$1,updated_at=$2,lease_until=0 WHERE request_key=$3 AND attempt_token=$4 AND status='running'")
            .bind(message).bind(now()).bind(&producer.request_key).bind(&producer.attempt_token).execute(&mut *tx).await?.rows_affected();
        if changed == 1 {
            append_event_tx(
                &mut tx,
                &producer.request_key,
                "error",
                json!({"message":message,"partial":true,"retryable":false}),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn chat_stream(
        &self,
        user_id: &str,
        request_id: &str,
    ) -> Result<ChatStreamView, DomainError> {
        self.ensure_chat_request_visible(user_id, request_id)
            .await?;
        let key = crate::repository::chat_request_key(user_id, request_id)?;
        const SELECT:&str="SELECT s.sequence,s.status,s.partial,s.accepted,s.error,s.tool_status,s.attempt,s.previous_content,s.lease_until,c.response FROM chat_streams s JOIN chat_requests c ON c.request_key=s.request_key AND c.user_id=s.user_id WHERE s.request_key=$1 AND s.user_id=$2";
        let mut row = sqlx::query(SELECT)
            .bind(&key)
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(DomainError::NotFound)?;
        // Active subscribers only read. In particular SQLite polling must not
        // compete with model-event checkpoint writes for the writer lock.
        if row.get::<String, _>("status") == "running" && row.get::<i64, _>("lease_until") < now() {
            let mut tx = self.pool.begin().await?;
            let expired = sqlx::query("UPDATE chat_streams SET status='interrupted',error=$1,updated_at=$2,lease_until=0 WHERE request_key=$3 AND user_id=$4 AND status='running' AND lease_until<$2")
            .bind("执行已中断，已保留收到的内容；可重试此回复").bind(now()).bind(&key).bind(user_id).execute(&mut *tx).await?.rows_affected();
            if expired == 1 {
                append_event_tx(&mut tx,&key,"error",json!({"message":"执行已中断，已保留收到的内容；可重试此回复","partial":true,"retryable":false})).await?;
            }
            tx.commit().await?;
            row = sqlx::query(SELECT)
                .bind(&key)
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(DomainError::NotFound)?;
        }
        let parse = |column: &str| -> Result<Option<Value>, DomainError> {
            row.get::<Option<String>, _>(column)
                .map(|s| {
                    serde_json::from_str(&s)
                        .map_err(|_| DomainError::Internal("消息记录读取失败".into()))
                })
                .transpose()
        };
        let view = ChatStreamView {
            sequence: row.get("sequence"),
            status: row.get("status"),
            content: row.get("partial"),
            accepted: parse("accepted")?,
            error: row.get("error"),
            response: parse("response")?,
            tool_status: parse("tool_status")?,
            attempt: row.get("attempt"),
            previous_content: row.get("previous_content"),
        };
        Ok(view)
    }

    pub async fn chat_stream_events(
        &self,
        user_id: &str,
        request_id: &str,
        after: i64,
        through: i64,
    ) -> Result<Vec<ChatStreamEvent>, DomainError> {
        self.ensure_chat_request_visible(user_id, request_id)
            .await?;
        let key = crate::repository::chat_request_key(user_id, request_id)?;
        let rows = sqlx::query("SELECT e.sequence,e.kind,e.body FROM chat_stream_events e JOIN chat_streams s ON s.request_key=e.request_key WHERE s.request_key=$1 AND s.user_id=$2 AND e.sequence>$3 AND e.sequence<=$4 ORDER BY e.sequence LIMIT 500")
            .bind(&key).bind(user_id).bind(after).bind(through).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                Ok(ChatStreamEvent {
                    sequence: r.get("sequence"),
                    kind: r.get("kind"),
                    body: serde_json::from_str(&r.get::<String, _>("body"))
                        .map_err(|_| DomainError::Internal("消息事件读取失败".into()))?,
                })
            })
            .collect()
    }
}

async fn lock_producer(
    tx: &mut Transaction<'_, Any>,
    producer: &ChatStreamProducer,
) -> Result<(), DomainError> {
    let changed = sqlx::query("UPDATE chat_streams SET updated_at=$1 WHERE request_key=$2 AND attempt_token=$3 AND status='running' AND lease_until>=$1")
        .bind(now()).bind(&producer.request_key).bind(&producer.attempt_token).execute(&mut **tx).await?.rows_affected();
    if changed != 1 {
        return Err(DomainError::Conflict("消息执行已结束或已中断".into()));
    }
    Ok(())
}

pub(crate) async fn append_event_tx(
    tx: &mut Transaction<'_, Any>,
    key: &str,
    kind: &str,
    mut body: Value,
) -> Result<(), DomainError> {
    let row=sqlx::query("UPDATE chat_streams SET sequence=sequence+1,updated_at=$1 WHERE request_key=$2 RETURNING sequence,attempt")
        .bind(now()).bind(key).fetch_one(&mut **tx).await?;
    let sequence: i64 = row.get("sequence");
    body["sequence"] = json!(sequence);
    body["attempt"] = json!(row.get::<i64, _>("attempt"));
    sqlx::query(
        "INSERT INTO chat_stream_events(request_key,sequence,kind,body)VALUES($1,$2,$3,$4)",
    )
    .bind(key)
    .bind(sequence)
    .bind(kind)
    .bind(body.to_string())
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM chat_stream_events WHERE request_key=$1 AND sequence<=$2")
        .bind(key)
        .bind(sequence - RETAINED_EVENTS)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// Only bounded public web-operation metadata reaches the client. In particular,
// do not forward raw arguments, tool results, or research conclusions/reasoning.
fn public_activity(body: &Value) -> Value {
    let mut value = json!({});
    let research = &body["research"];
    if body["tool"] == "web_search" {
        if let Some(query) = research["query"].as_str() {
            value["query"] = json!(query
                .chars()
                .filter(|c| !c.is_control())
                .take(128)
                .collect::<String>());
        }
    } else if body["tool"] == "web_fetch" {
        if let Some(raw) = research["url"].as_str().filter(|s| s.len() <= 4096) {
            if let Ok(mut url) = reqwest::Url::parse(raw) {
                if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
                    let _ = url.set_username("");
                    let _ = url.set_password(None);
                    url.set_query(None);
                    url.set_fragment(None);
                    value["url"] = json!(url.to_string().chars().take(1000).collect::<String>());
                }
            }
        }
    }
    value
}

#[cfg(test)]
mod public_activity_tests {
    use super::*;

    #[test]
    fn exposes_only_bounded_public_operation_fields() {
        let body = json!({"tool":"web_fetch","research":{"url":"https://name:secret@example.com/notice?token=private#section","reason":"not public"},"args":{"password":"private"}});
        assert_eq!(
            public_activity(&body),
            json!({"url":"https://example.com/notice"})
        );
        assert_eq!(
            public_activity(&json!({"tool":"save_memory","research":{"query":"private"}})),
            json!({})
        );
        assert_eq!(
            public_activity(&json!({"tool":"web_fetch","research":{"url":"file:///private"}})),
            json!({})
        );
        let query = "a".repeat(200);
        let value = public_activity(&json!({"tool":"web_search","research":{"query":query}}));
        assert_eq!(value["query"].as_str().unwrap().chars().count(), 128);
    }
}

async fn append_visible_tx(
    tx: &mut Transaction<'_, Any>,
    key: &str,
    kind: &str,
    mut body: Value,
) -> Result<(), DomainError> {
    if kind == "text_delta" {
        let row = sqlx::query(
            "SELECT partial,text_turn,reset_pending FROM chat_streams WHERE request_key=$1",
        )
        .bind(key)
        .fetch_one(&mut **tx)
        .await?;
        let mut partial: String = row.get("partial");
        let replace = row.get::<i64, _>("reset_pending") != 0;
        if replace {
            partial.clear();
        }
        let turn = body["turn"]
            .as_i64()
            .filter(|n| *n >= 1 && *n <= 20)
            .ok_or_else(|| DomainError::Validation("文本轮次无效".into()))?;
        let delta = body["delta"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 240000)
            .ok_or_else(|| DomainError::Validation("文本增量无效".into()))?;
        let delta = if !partial.is_empty() && row.get::<i64, _>("text_turn") != turn {
            format!("\n\n{delta}")
        } else {
            delta.to_owned()
        };
        partial.push_str(&delta);
        if partial.chars().count() > 60000 {
            return Err(DomainError::Validation("回复超过大小限制".into()));
        }
        body["delta"] = json!(delta);
        body["replace"] = json!(replace);
        sqlx::query(
            "UPDATE chat_streams SET partial=$1,text_turn=$2,reset_pending=0 WHERE request_key=$3",
        )
        .bind(partial)
        .bind(turn)
        .bind(key)
        .execute(&mut **tx)
        .await?;
    } else if kind == "text_start" {
        let turn = body["turn"]
            .as_i64()
            .filter(|n| *n >= 1 && *n <= 20)
            .ok_or_else(|| DomainError::Validation("文本轮次无效".into()))?;
        if body.get("replace").and_then(Value::as_bool) == Some(true) {
            // A streamed preamble became a tool turn, not a completed answer.
            // Fence/replay remains in this transaction; legacy APKs clear on the
            // next authoritative delta's existing replace flag as well.
            sqlx::query("UPDATE chat_streams SET partial='',text_turn=$1,reset_pending=1 WHERE request_key=$2")
                .bind(turn).bind(key).execute(&mut **tx).await?;
            body = json!({"turn":turn,"replace":true});
        } else {
            body = json!({"turn":turn});
        }
    } else if matches!(kind, "tool_start" | "tool_end") {
        body = json!({"tool":body["tool"],"tool_call_id":body["tool_call_id"],"is_error":body["is_error"],"status":kind,"activity":public_activity(&body)});
        sqlx::query("UPDATE chat_streams SET tool_status=$1 WHERE request_key=$2")
            .bind(body.to_string())
            .bind(key)
            .execute(&mut **tx)
            .await?;
    }
    append_event_tx(tx, key, kind, body).await
}

/// Called inside the existing fenced Agent journal transaction. A checkpoint and
/// its source event commit together, including when callback acknowledgement is lost.
pub(crate) async fn agent_event_tx(
    tx: &mut Transaction<'_, Any>,
    run_id: &str,
    sequence: i64,
    kind: &str,
    body: &Value,
) -> Result<(), DomainError> {
    if !["text_start", "text_delta", "tool_start", "tool_end"].contains(&kind) {
        return Ok(());
    }
    let row = sqlx::query("SELECT request_key FROM chat_streams WHERE agent_run_id=$1 AND status='running' AND source_sequence<$2 AND lease_until>=$3")
        .bind(run_id).bind(sequence).bind(now()).fetch_optional(&mut **tx).await?;
    if let Some(row) = row {
        let key: String = row.get("request_key");
        append_visible_tx(tx, &key, kind, body.clone()).await?;
        sqlx::query("UPDATE chat_streams SET source_sequence=$1 WHERE request_key=$2")
            .bind(sequence)
            .bind(key)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

pub(crate) async fn finish_tx(
    tx: &mut Transaction<'_, Any>,
    user_id: &str,
    key: &str,
    attempt: &str,
    response: &Value,
) -> Result<(), DomainError> {
    let changed = sqlx::query("UPDATE chat_streams SET status='done',partial=$1,lease_until=0,updated_at=$2 WHERE request_key=$3 AND user_id=$4 AND attempt_token=$5 AND status='running' AND lease_until>=$2")
        .bind(response.pointer("/message/content").and_then(Value::as_str).unwrap_or("")).bind(now()).bind(key).bind(user_id).bind(attempt).execute(&mut **tx).await?.rows_affected();
    if changed == 1 {
        append_event_tx(tx, key, "done", json!({"response":response})).await?;
    } else {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM chat_streams WHERE request_key=$1 AND user_id=$2",
        )
        .bind(key)
        .bind(user_id)
        .fetch_one(&mut **tx)
        .await?;
        if exists > 0 {
            return Err(DomainError::Conflict("消息执行已结束或已中断".into()));
        }
    }
    Ok(())
}
