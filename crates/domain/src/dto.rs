use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct User {
    pub id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub name: String,
    pub timezone: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AuthSession {
    pub token: String,
    pub user: User,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Memory {
    pub id: String,
    pub title: String,
    pub content: String,
    pub kind: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub version: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Step {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub kind: String,
    pub status: String,
    pub progress: i64,
    pub summary: Option<String>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub steps: Vec<Step>,
    pub model_mode: String,
    pub approval_required: bool,
    pub approved_at: Option<String>,
    pub artifact_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Schedule {
    pub id: String,
    pub title: String,
    pub instruction: String,
    pub frequency: String,
    pub time: String,
    pub timezone: String,
    pub enabled: bool,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MessageAttachment {
    pub upload_id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    #[serde(default)]
    pub unavailable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    pub model_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageAttachment>,
}
pub type ChatMessage = Message;
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Artifact {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub content: String,
    pub mime_type: String,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub task_id: Option<String>,
    pub read: bool,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub status: String,
    pub detail: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RuntimeInfo {
    pub agent_harness: String,
    pub model_mode: String,
    pub model_name: Option<String>,
    pub scheduler_mode: String,
    pub storage_mode: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TodayStats {
    pub tasks_completed: usize,
    pub active_routines: usize,
    pub memory_count: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Today {
    pub date: String,
    pub greeting: String,
    pub briefing: String,
    pub tasks: Vec<Task>,
    pub schedules: Vec<Schedule>,
    pub memories: Vec<Memory>,
    pub notifications: Vec<Notification>,
    pub stats: TodayStats,
    pub runtime: RuntimeInfo,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Items<T> {
    pub items: Vec<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateMemory {
    pub title: Option<String>,
    pub content: String,
    pub kind: String,
    pub source: Option<String>,
    pub client_request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UpdateMemory {
    pub title: Option<String>,
    pub content: Option<String>,
    pub kind: Option<String>,
    pub version: Option<i64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateTask {
    pub instruction: String,
    pub title: Option<String>,
    pub kind: Option<String>,
    pub approval_required: Option<bool>,
    pub client_request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CreateSchedule {
    pub title: String,
    pub instruction: String,
    pub frequency: String,
    pub time: String,
    pub timezone: String,
    pub enabled: Option<bool>,
    pub client_request_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct UpdateSchedule {
    pub title: Option<String>,
    pub instruction: Option<String>,
    pub frequency: Option<String>,
    pub time: Option<String>,
    pub timezone: Option<String>,
    pub enabled: Option<bool>,
}
#[derive(Debug, Clone)]
pub struct ClaimedTask {
    pub task: Task,
    pub user_id: String,
    pub attempt: i64,
}

#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub conversation: Conversation,
    pub user_message: Message,
    pub assistant_message: Message,
    pub memory: Option<Memory>,
    pub request_id: Option<String>,
    pub response: serde_json::Value,
}
