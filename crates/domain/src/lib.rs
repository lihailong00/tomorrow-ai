pub mod agent;
pub mod automatic_memory;
pub mod auth;
pub mod chat_stream;
pub mod chat_messages;
pub mod dto;
pub mod knowledge;
pub mod model;
pub mod phone;
pub mod phone_password;
pub mod repository;
pub mod sms;
pub mod todos;
pub mod growth;
pub mod usage;

pub use dto::*;
pub use model::LlmProvider as ModelProvider;
pub use model::{LlmProvider, ModelReply};
pub use repository::Repository;
pub use todos::*;
pub use growth::*;

#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("{0}")]
    Validation(String),
    #[error("请先登录，或重新登录后重试")]
    Unauthorized,
    #[error("手机号或密码错误；如未设置密码，请先重置密码")]
    InvalidCredentials,
    #[error("无权执行该操作")]
    Forbidden,
    #[error("找不到这条记录")]
    NotFound,
    #[error("{0}")]
    Conflict(String),
    #[error("验证码获取过于频繁，请稍后重试")]
    RateLimited { retry_after: i64 },
    #[error("登录繁忙或操作过于频繁，请稍后重试")]
    LoginRateLimited { retry_after: i64 },
    #[error("{0}")]
    Unavailable(String),
    #[error("本次执行重试时改变了已执行步骤的参数；已停止，请查看已有结果后发送新消息")]
    AgentReplayConflict,
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    External(String),
    #[error("{0}")]
    Internal(String),
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
pub fn timestamp(value: i64) -> String {
    chrono::DateTime::from_timestamp(value, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn validate_text(value: &str, field: &str, max: usize) -> Result<String, DomainError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(DomainError::Validation(format!(
            "{field}不能为空且最多 {max} 字"
        )));
    }
    Ok(value.to_owned())
}
