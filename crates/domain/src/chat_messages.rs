//! Durable user-turn edits/deletion. Request tombstones prevent old SSE/cache replay.
use crate::{now, DomainError, Message, Repository};
use serde::{Deserialize, Serialize};
use sqlx::{Any, Row, Transaction};

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatReplacement {
    pub original: Message,
    pub assistant_id: Option<String>,
    pub assistant_created_at: Option<String>,
    pub revision: i64,
}
impl ChatReplacement {
    pub fn removed_message_ids(&self) -> Vec<String> {
        std::iter::once(self.original.id.clone())
            .chain(self.assistant_id.clone())
            .collect()
    }
}

pub(crate) async fn initialize(pool: &sqlx::AnyPool) -> Result<(), DomainError> {
    for statement in [
        "CREATE TABLE IF NOT EXISTS chat_message_turns(user_id TEXT NOT NULL,user_message_id TEXT NOT NULL,conversation_id TEXT NOT NULL,assistant_id TEXT,revision BIGINT NOT NULL DEFAULT 0,deleted BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(user_id,user_message_id))",
        "CREATE TABLE IF NOT EXISTS chat_message_requests(request_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,user_message_id TEXT NOT NULL,revision BIGINT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS chat_message_requests_turn ON chat_message_requests(user_id,user_message_id)",
        "CREATE TABLE IF NOT EXISTS chat_message_invalid_requests(request_key TEXT PRIMARY KEY,user_id TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS chat_message_replacements(request_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,body TEXT NOT NULL,agent_run_id TEXT)",
    ] { sqlx::query(statement).execute(pool).await?; }
    Ok(())
}

pub(crate) async fn valid_request_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    key: &str,
) -> Result<(), DomainError> {
    let invalid: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_message_invalid_requests WHERE request_key=$1 AND user_id=$2",
    )
    .bind(key)
    .bind(user)
    .fetch_one(&mut **tx)
    .await?;
    if invalid > 0 {
        return Err(DomainError::Conflict(
            "原消息已修改或删除，请发送新消息".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn lock_conversation_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    conversation: &str,
) -> Result<(), DomainError> {
    // Shared by acceptance, commit and mutations. PostgreSQL holds the row lock;
    // SQLite's single writer serializes the same operations.
    sqlx::query("UPDATE resources SET updated_at=updated_at WHERE id=$1 AND user_id=$2 AND kind='conversation'")
        .bind(conversation).bind(user).execute(&mut **tx).await?;
    Ok(())
}

async fn message_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    id: &str,
) -> Result<Message, DomainError> {
    let body: String = sqlx::query_scalar(
        "SELECT body FROM resources WHERE id=$1 AND user_id=$2 AND kind='message'",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(DomainError::NotFound)?;
    serde_json::from_str(&body).map_err(|_| DomainError::Internal("消息记录读取失败".into()))
}

async fn original_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    conversation: &str,
    id: &str,
) -> Result<ChatReplacement, DomainError> {
    let original = message_tx(tx, user, id).await?;
    if original.conversation_id != conversation || original.role != "user" {
        return Err(DomainError::NotFound);
    }
    // Backfill pre-upgrade turns from exact persisted response/acceptance links.
    // Never guess that an unrelated next assistant belongs to this user message.
    let known: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_message_turns WHERE user_id=$1 AND user_message_id=$2",
    )
    .bind(user)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    let rows = if known > 0 {
        sqlx::query("SELECT c.request_key,c.response,s.accepted FROM chat_message_requests r JOIN chat_requests c ON c.request_key=r.request_key AND c.user_id=r.user_id LEFT JOIN chat_streams s ON s.request_key=c.request_key AND s.user_id=c.user_id WHERE r.user_id=$1 AND r.user_message_id=$2 AND (c.response IS NOT NULL OR s.accepted IS NOT NULL)")
            .bind(user).bind(id).fetch_all(&mut **tx).await?
    } else {
        sqlx::query("SELECT c.request_key,c.response,s.accepted FROM chat_requests c LEFT JOIN chat_streams s ON s.request_key=c.request_key AND s.user_id=c.user_id WHERE c.user_id=$1 AND (c.response LIKE $2 OR s.accepted LIKE $2)")
            .bind(user).bind(format!("%{id}%")).fetch_all(&mut **tx).await?
    };
    let mut linked_assistant = None;
    let mut linked_dates = std::collections::HashMap::new();
    for row in rows {
        let value = row
            .get::<Option<String>, _>("response")
            .or_else(|| row.get::<Option<String>, _>("accepted"));
        let Some(value) = value.and_then(|v| serde_json::from_str::<serde_json::Value>(&v).ok())
        else {
            continue;
        };
        if value["conversation_id"].as_str() != Some(conversation)
            || value.pointer("/user_message/id").and_then(|v| v.as_str()) != Some(id)
        {
            continue;
        }
        let assistant = value
            .pointer("/message/id")
            .or_else(|| value.get("message_id"))
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        if let Some(id) = &assistant {
            if let Some(date) = value
                .pointer("/message/created_at")
                .or_else(|| value.get("message_created_at"))
                .and_then(|v| v.as_str())
            {
                linked_dates.insert(id.clone(), date.to_owned());
            }
            linked_assistant = assistant;
        }
        sqlx::query("INSERT INTO chat_message_requests(request_key,user_id,user_message_id,revision)VALUES($1,$2,$3,0)ON CONFLICT(request_key)DO NOTHING")
            .bind(row.get::<String,_>("request_key")).bind(user).bind(id).execute(&mut **tx).await?;
    }
    sqlx::query("INSERT INTO chat_message_turns(user_id,user_message_id,conversation_id,assistant_id)VALUES($1,$2,$3,$4)ON CONFLICT(user_id,user_message_id)DO NOTHING")
        .bind(user).bind(id).bind(conversation).bind(linked_assistant).execute(&mut **tx).await?;
    let row=sqlx::query("SELECT assistant_id,revision,deleted FROM chat_message_turns WHERE user_id=$1 AND user_message_id=$2 AND conversation_id=$3")
        .bind(user).bind(id).bind(conversation).fetch_optional(&mut **tx).await?.ok_or(DomainError::NotFound)?;
    if row.get::<i64, _>("deleted") != 0 {
        return Err(DomainError::NotFound);
    }
    let assistant_id: Option<String> = row.get("assistant_id");
    let assistant_created_at = if let Some(id) = &assistant_id {
        match message_tx(tx, user, id).await {
            Ok(message)
                if message.role == "assistant" && message.conversation_id == conversation =>
            {
                Some(message.created_at)
            }
            Ok(_) => return Err(DomainError::Conflict("消息对应关系已变化".into())),
            Err(DomainError::NotFound) => linked_dates.get(id).cloned(),
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    Ok(ChatReplacement {
        original,
        assistant_id,
        assistant_created_at,
        revision: row.get("revision"),
    })
}

pub(crate) async fn validate_replacement_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    replacement: &ChatReplacement,
) -> Result<(), DomainError> {
    let original = message_tx(tx, user, &replacement.original.id).await?;
    let revision:Option<i64>=sqlx::query_scalar("SELECT revision FROM chat_message_turns WHERE user_id=$1 AND user_message_id=$2 AND conversation_id=$3 AND deleted=0")
        .bind(user).bind(&original.id).bind(&original.conversation_id).fetch_optional(&mut **tx).await?;
    if revision != Some(replacement.revision)
        || serde_json::to_value(&original).ok() != serde_json::to_value(&replacement.original).ok()
    {
        return Err(DomainError::Conflict(
            "这条消息已变化，请重新打开后修改".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn track_request_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    key: Option<&str>,
    message: &Message,
    assistant: &str,
    revision: i64,
) -> Result<(), DomainError> {
    sqlx::query("INSERT INTO chat_message_turns(user_id,user_message_id,conversation_id,assistant_id,revision)VALUES($1,$2,$3,$4,$5)ON CONFLICT(user_id,user_message_id)DO UPDATE SET assistant_id=$4 WHERE chat_message_turns.deleted=0")
        .bind(user).bind(&message.id).bind(&message.conversation_id).bind(assistant).bind(revision).execute(&mut **tx).await?;
    if let Some(key) = key {
        sqlx::query("INSERT INTO chat_message_requests(request_key,user_id,user_message_id,revision)VALUES($1,$2,$3,$4)ON CONFLICT(request_key)DO NOTHING")
        .bind(key).bind(user).bind(&message.id).bind(revision).execute(&mut **tx).await?;
    }
    Ok(())
}

async fn invalidate_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    id: &str,
    keep: Option<&str>,
) -> Result<(), DomainError> {
    let rows=sqlx::query("SELECT r.request_key,COALESCE(s.agent_run_id,x.agent_run_id) AS agent_run_id FROM chat_message_requests r LEFT JOIN chat_streams s ON s.request_key=r.request_key AND s.user_id=r.user_id LEFT JOIN chat_message_replacements x ON x.request_key=r.request_key AND x.user_id=r.user_id WHERE r.user_id=$1 AND r.user_message_id=$2 AND r.request_key<>$3 ORDER BY r.request_key")
        .bind(user).bind(id).bind(keep.unwrap_or("")).fetch_all(&mut **tx).await?;
    for row in &rows {
        if let Some(run) = row.get::<Option<String>, _>("agent_run_id") {
            // Follow the established run-before-stream lock order.
            sqlx::query("UPDATE agent_runs SET status='failed',lease_until=0,error=$1,updated_at=$2 WHERE id=$3 AND user_id=$4 AND status='running'")
            .bind("原消息已修改或删除").bind(now()).bind(run).bind(user).execute(&mut **tx).await?;
        }
    }
    for row in rows {
        let key: String = row.get("request_key");
        sqlx::query("INSERT INTO chat_message_invalid_requests(request_key,user_id)VALUES($1,$2)ON CONFLICT(request_key)DO NOTHING")
            .bind(&key).bind(user).execute(&mut **tx).await?;
        sqlx::query("UPDATE chat_streams SET status='interrupted',partial='',previous_content=NULL,accepted=NULL,tool_status=NULL,error=$1,lease_until=0 WHERE request_key=$2 AND user_id=$3")
            .bind("原消息已修改或删除，请发送新消息").bind(&key).bind(user).execute(&mut **tx).await?;
        sqlx::query("DELETE FROM chat_stream_events WHERE request_key=$1")
            .bind(&key)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE chat_requests SET response=NULL WHERE request_key=$1 AND user_id=$2")
            .bind(&key)
            .bind(user)
            .execute(&mut **tx)
            .await?;
        sqlx::query(
            "UPDATE chat_message_replacements SET body='' WHERE request_key=$1 AND user_id=$2",
        )
        .bind(&key)
        .bind(user)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

pub(crate) async fn replace_tx(
    tx: &mut Transaction<'_, Any>,
    user: &str,
    replacement: &ChatReplacement,
    keep: Option<&str>,
) -> Result<(), DomainError> {
    validate_replacement_tx(tx, user, replacement).await?;
    invalidate_tx(tx, user, &replacement.original.id, keep).await?;
    if let Some(id) = &replacement.assistant_id {
        sqlx::query("DELETE FROM resources WHERE id=$1 AND user_id=$2 AND kind='message'")
            .bind(id)
            .bind(user)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("UPDATE chat_message_turns SET revision=revision+1 WHERE user_id=$1 AND user_message_id=$2 AND deleted=0")
        .bind(user).bind(&replacement.original.id).execute(&mut **tx).await?;
    Ok(())
}

impl Repository {
    /// Keep the initial edit snapshot even if a non-streaming HTTP caller loses
    /// its reservation. Retrying that intent must not overwrite a newer edit.
    pub async fn chat_replacement_for_request(
        &self,
        user: &str,
        conversation: &str,
        id: &str,
        request: &str,
    ) -> Result<ChatReplacement, DomainError> {
        self.conversation(user, conversation).await?;
        let key = crate::repository::chat_request_key(user, request)?;
        let mut tx = self.pool.begin().await?;
        lock_conversation_tx(&mut tx, user, conversation).await?;
        valid_request_tx(&mut tx, user, &key).await?;
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT body FROM chat_message_replacements WHERE request_key=$1 AND user_id=$2",
        )
        .bind(&key)
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?;
        let snapshot = if let Some(body) = stored {
            serde_json::from_str::<ChatReplacement>(&body)
                .map_err(|_| DomainError::Conflict("原消息已变化，请发送新消息".into()))?
        } else {
            let snapshot = original_tx(&mut tx, user, conversation, id).await?;
            sqlx::query(
                "INSERT INTO chat_message_replacements(request_key,user_id,body)VALUES($1,$2,$3)",
            )
            .bind(&key)
            .bind(user)
            .bind(
                serde_json::to_string(&snapshot)
                    .map_err(|_| DomainError::Internal("消息快照保存失败".into()))?,
            )
            .execute(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO chat_message_requests(request_key,user_id,user_message_id,revision)VALUES($1,$2,$3,$4)ON CONFLICT(request_key)DO NOTHING").bind(&key).bind(user).bind(id).bind(snapshot.revision+1).execute(&mut *tx).await?;
            snapshot
        };
        if snapshot.original.id != id || snapshot.original.conversation_id != conversation {
            return Err(DomainError::Conflict("同一请求不能修改不同消息".into()));
        }
        validate_replacement_tx(&mut tx, user, &snapshot).await?;
        tx.commit().await?;
        Ok(snapshot)
    }
    pub async fn bind_chat_replacement_run(
        &self,
        user: &str,
        request: &str,
        run: &str,
    ) -> Result<(), DomainError> {
        let key = crate::repository::chat_request_key(user, request)?;
        let mut tx = self.pool.begin().await?;
        let body: Option<String> = sqlx::query_scalar(
            "SELECT body FROM chat_message_replacements WHERE request_key=$1 AND user_id=$2",
        )
        .bind(&key)
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?;
        let snapshot = body
            .and_then(|body| serde_json::from_str::<ChatReplacement>(&body).ok())
            .ok_or_else(|| DomainError::Conflict("原消息已修改或删除，请发送新消息".into()))?;
        // Bind and delete use the same first lock. Otherwise delete could observe
        // a NULL run, then binding could publish new authority behind its back.
        lock_conversation_tx(&mut tx, user, &snapshot.original.conversation_id).await?;
        valid_request_tx(&mut tx, user, &key).await?;
        sqlx::query("UPDATE chat_message_replacements SET agent_run_id=$1 WHERE request_key=$2 AND user_id=$3 AND EXISTS(SELECT 1 FROM agent_runs WHERE id=$1 AND user_id=$3)")
            .bind(run).bind(&key).bind(user).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn chat_replacement(
        &self,
        user: &str,
        conversation: &str,
        id: &str,
    ) -> Result<ChatReplacement, DomainError> {
        self.conversation(user, conversation).await?;
        let mut tx = self.pool.begin().await?;
        lock_conversation_tx(&mut tx, user, conversation).await?;
        let result = original_tx(&mut tx, user, conversation, id).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn delete_message_turn(
        &self,
        user: &str,
        conversation: &str,
        id: &str,
    ) -> Result<Vec<String>, DomainError> {
        self.conversation(user, conversation).await?;
        let mut tx = self.pool.begin().await?;
        lock_conversation_tx(&mut tx, user, conversation).await?;
        if let Some(row)=sqlx::query("SELECT assistant_id FROM chat_message_turns WHERE user_id=$1 AND user_message_id=$2 AND conversation_id=$3 AND deleted=1")
            .bind(user).bind(id).bind(conversation).fetch_optional(&mut *tx).await? {
            let assistant:Option<String>=row.get("assistant_id");tx.commit().await?;
            return Ok(std::iter::once(id.to_owned()).chain(assistant).collect());
        }
        let replacement = original_tx(&mut tx, user, conversation, id).await?;
        invalidate_tx(&mut tx, user, id, None).await?;
        for id in replacement.removed_message_ids() {
            sqlx::query("DELETE FROM resources WHERE id=$1 AND user_id=$2 AND kind='message'")
                .bind(id)
                .bind(user)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE chat_message_turns SET deleted=1,revision=revision+1 WHERE user_id=$1 AND user_message_id=$2").bind(user).bind(id).execute(&mut *tx).await?;
        let body: String = sqlx::query_scalar(
            "SELECT body FROM resources WHERE id=$1 AND user_id=$2 AND kind='conversation'",
        )
        .bind(conversation)
        .bind(user)
        .fetch_one(&mut *tx)
        .await?;
        let mut current: crate::Conversation = serde_json::from_str(&body)
            .map_err(|_| DomainError::Internal("对话记录读取失败".into()))?;
        if current.title
            == replacement
                .original
                .content
                .chars()
                .take(40)
                .collect::<String>()
        {
            let postgres = tx.backend_name() == "PostgreSQL";
            let field = |name: &str| {
                if postgres {
                    format!("CAST(body AS JSONB)->>'{name}'")
                } else {
                    format!("json_extract(body,'$.{name}')")
                }
            };
            let query=format!("SELECT body FROM resources WHERE user_id=$1 AND kind='message' AND {}=$2 AND {}='user' ORDER BY {},id LIMIT 1",field("conversation_id"),field("role"),field("created_at"));
            let next: Option<String> = sqlx::query_scalar(&query)
                .bind(user)
                .bind(conversation)
                .fetch_optional(&mut *tx)
                .await?;
            current.title = next
                .and_then(|v| serde_json::from_str::<Message>(&v).ok())
                .map(|m| m.content.chars().take(40).collect())
                .unwrap_or_else(|| "新对话".into());
        }
        current.updated_at = crate::timestamp(now());
        sqlx::query("UPDATE resources SET body=$1,updated_at=$2 WHERE id=$3 AND user_id=$4 AND kind='conversation'")
            .bind(serde_json::to_string(&current).map_err(|_|DomainError::Internal("对话记录保存失败".into()))?).bind(now()).bind(conversation).bind(user).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(replacement.removed_message_ids())
    }
    pub async fn ensure_chat_request_visible(
        &self,
        user: &str,
        request: &str,
    ) -> Result<(), DomainError> {
        let key = crate::repository::chat_request_key(user, request)?;
        let invalid:i64=sqlx::query_scalar("SELECT COUNT(*) FROM chat_message_invalid_requests WHERE request_key=$1 AND user_id=$2")
            .bind(&key).bind(user).fetch_one(&self.pool).await?;
        if invalid > 0 {
            return Err(DomainError::Conflict(
                "原消息已修改或删除，请发送新消息".into(),
            ));
        }
        Ok(())
    }
}
