use crate::Todo;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GrowthGoal {
    pub kind: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthPreferences {
    pub enabled: bool,
    pub daily_minutes: i64,
    pub use_existing_todos: bool,
    pub goals: Vec<GrowthGoal>,
    pub paused_today: bool,
    pub timezone: String,
    pub version: i64,
    pub halo: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct StoredPreferences {
    pub enabled: bool,
    pub daily_minutes: i64,
    pub use_existing_todos: bool,
    pub goals: Vec<GrowthGoal>,
    pub paused_date: Option<String>,
    pub halo: String,
}
impl Default for StoredPreferences {
    fn default() -> Self {
        Self {
            enabled: false,
            daily_minutes: 15,
            use_existing_todos: true,
            goals: vec![],
            paused_date: None,
            halo: "classic".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateGrowthPreferences {
    pub version: i64,
    pub enabled: Option<bool>,
    pub daily_minutes: Option<i64>,
    pub use_existing_todos: Option<bool>,
    pub goals: Option<Vec<GrowthGoal>>,
    pub paused_today: Option<bool>,
    pub halo: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthReward {
    pub id: String,
    pub todo_id: String,
    pub title: String,
    pub kind: String,
    pub xp: i64,
    pub active: bool,
    pub earned_at: String,
    pub updated_at: String,
    pub version: i64,
    pub local_date: String,
    pub timezone: String,
    pub minutes: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthRewardState {
    pub reward: Option<GrowthReward>,
    pub total_xp: i64,
    pub level: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthDay {
    pub date: String,
    pub action_count: i64,
    pub xp: i64,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthToday {
    pub date: String,
    pub timezone: String,
    pub action_count: i64,
    pub xp: i64,
    pub paused: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthWeek {
    pub start_date: String,
    pub end_date: String,
    pub active_days: i64,
    pub days: Vec<GrowthDay>,
    pub communication_actions: i64,
    pub learning_actions: i64,
    pub exercise_minutes: i64,
    pub records: Vec<GrowthReward>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthMilestone {
    pub id: String,
    pub title: String,
    pub description: String,
    pub progress: i64,
    pub target: i64,
    pub unlocked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct GrowthSummary {
    pub total_xp: i64,
    pub level: i64,
    pub level_xp: i64,
    pub xp_per_level: i64,
    pub halo: String,
    pub available_halos: Vec<String>,
    pub today: GrowthToday,
    pub week: GrowthWeek,
    pub milestones: Vec<GrowthMilestone>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct TodoActions {
    pub replied: bool,
    pub replied_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfirmTodoAction {
    pub kind: String,
    pub version: i64,
    pub client_request_id: String,
    #[serde(
        default,
        deserialize_with = "nullable_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub draft: Option<Option<String>>,
    pub actual_minutes: Option<i64>,
    #[serde(
        default,
        deserialize_with = "nullable_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub progress_notes: Option<Option<String>>,
}

fn nullable_text<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct TodoActionResult {
    pub todo: Todo,
    pub actions: TodoActions,
    pub reward: Option<GrowthReward>,
}

#[derive(Clone, Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EnsureDailyPlan {
    pub client_request_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DailyItemCommand {
    pub version: i64,
    pub client_request_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct DailyPlanItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub kind: String,
    pub reason: String,
    pub estimated_minutes: i64,
    pub source_kind: String,
    pub source_label: String,
    pub todo_id: Option<String>,
    pub todo: Option<Todo>,
    pub status: String,
    pub focus: bool,
    pub can_replace: bool,
    pub version: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct DailyPlan {
    pub id: Option<String>,
    pub local_date: String,
    pub timezone: String,
    pub status: String,
    pub error: Option<String>,
    pub items: Vec<DailyPlanItem>,
    pub can_retry: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct AcceptDailyItem {
    pub item: DailyPlanItem,
    pub todo: Todo,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DailyPlanContext {
    pub plan_id: String,
    pub goals: Vec<GrowthGoal>,
    pub daily_minutes: i64,
    pub existing_todos: Vec<Todo>,
    pub preferences_version: i64,
    pub use_existing_todos: bool,
    pub local_date: String,
    pub timezone: String,
}
