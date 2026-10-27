use serde_json::{json, Value};
use tomorrow_domain::{
    agent::{AgentOutput, RunTicket},
    CreateTask, DomainError, Repository,
};

async fn fixture() -> (Repository, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("agent-a@test.local", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("agent-b@test.local", "unused", "乙", "Asia/Shanghai")
        .await
        .unwrap();
    (repo, a.id, b.id)
}
async fn begin(repo: &Repository, user: &str, key: &str) -> RunTicket {
    repo.begin_agent_run(user, key, "fixture instruction", Some("conversation"), None)
        .await
        .unwrap()
}
fn memory() -> Value {
    json!({"title":"偏好","content":"喜欢中文回答","kind":"preference"})
}
fn schedule() -> Value {
    json!({"title":"测试计划","instruction":"整理已有资料","frequency":"daily","time":"08:00","timezone":"Asia/Shanghai","enabled":true})
}

#[tokio::test]
async fn effects_are_atomic_replayable_and_reads_are_fresh() {
    let (repo, a, _) = fixture().await;
    let run = begin(&repo, &a, "effects").await;
    let first = repo
        .execute_agent_tool(&run.id, &run.token, "save_memory", memory())
        .await
        .unwrap();
    let same = repo
        .execute_agent_tool(&run.id, &run.token, "save_memory", memory())
        .await
        .unwrap();
    assert_eq!(first["value"]["id"], same["value"]["id"]);
    assert_eq!(same["replayed"], true);
    let read = repo
        .execute_agent_tool(&run.id, &run.token, "list_memories", json!({}))
        .await
        .unwrap();
    assert_eq!(read["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        repo.agent_run(&a, &run.id).await.unwrap().operations.len(),
        1
    );
}

#[tokio::test]
async fn regenerated_arguments_cannot_create_another_effect_in_the_same_step() {
    let (repo, a, _) = fixture().await;
    let run = begin(&repo, &a, "slots").await;
    repo.execute_agent_tool_at(&run.id, &run.token, "save_memory", memory(), Some(1))
        .await
        .unwrap();
    repo.finish_agent_run(&run, None, Some("interrupted"))
        .await
        .unwrap();
    let retry = begin(&repo, &a, "slots").await;
    let changed = json!({"title":"改写标题","content":"喜欢中文回答","kind":"preference"});
    assert!(matches!(
        repo.execute_agent_tool_at(&retry.id, &retry.token, "save_memory", changed, Some(1))
            .await,
        Err(DomainError::AgentReplayConflict)
    ));
    assert_eq!(repo.memories(&a).await.unwrap().len(), 1);
    assert_eq!(
        repo.execute_agent_tool_at(&retry.id, &retry.token, "save_memory", memory(), Some(1))
            .await
            .unwrap()["replayed"],
        true
    );
}

#[tokio::test]
async fn model_cannot_self_approve_tasks_or_enable_schedules() {
    let (repo, a, _) = fixture().await;
    let run = begin(&repo, &a, "approval").await;
    let task = repo
        .execute_agent_tool(
            &run.id,
            &run.token,
            "create_task",
            json!({"title":"任务","instruction":"生成一份计划","approval_required":false}),
        )
        .await
        .unwrap();
    assert_eq!(task["value"]["status"], "waiting_approval");
    assert!(repo.claim_task(90).await.unwrap().is_none());
    let plan = repo
        .execute_agent_tool(&run.id, &run.token, "create_schedule", schedule())
        .await
        .unwrap();
    assert_eq!(plan["value"]["enabled"], false);
    assert!(!repo.schedules(&a).await.unwrap()[0].enabled);
    assert!(repo
        .execute_agent_tool(
            &run.id,
            &run.token,
            "approve_task",
            json!({"id":task["value"]["id"]})
        )
        .await
        .is_err());
}

#[tokio::test]
async fn authority_never_comes_from_model_arguments_and_cancel_revokes_it() {
    let (repo, a, b) = fixture().await;
    let run = begin(&repo, &a, "authority").await;
    repo.execute_agent_tool(
        &run.id,
        &run.token,
        "save_memory",
        json!({"title":"隔离","content":"甲的数据","kind":"fact","user_id":b}),
    )
    .await
    .unwrap();
    assert_eq!(repo.memories(&a).await.unwrap().len(), 1);
    assert!(repo.memories(&b).await.unwrap().is_empty());
    assert!(matches!(
        repo.agent_run(&b, &run.id).await,
        Err(DomainError::NotFound)
    ));
    assert!(repo
        .execute_agent_tool(&run.id, "wrong-token", "save_memory", memory())
        .await
        .is_err());
    repo.cancel_agent_run(&a, &run.id).await.unwrap();
    assert!(repo
        .execute_agent_tool(&run.id, &run.token, "save_memory", memory())
        .await
        .is_err());
    assert_eq!(repo.memories(&a).await.unwrap().len(), 1);
}

#[tokio::test]
async fn failed_run_retry_rotates_authority_and_reuses_committed_effects() {
    let (repo, a, _) = fixture().await;
    let old = begin(&repo, &a, "retry").await;
    let first = repo
        .execute_agent_tool(&old.id, &old.token, "save_memory", memory())
        .await
        .unwrap();
    repo.finish_agent_run(&old, None, Some("fixture failure"))
        .await
        .unwrap();
    let next = begin(&repo, &a, "retry").await;
    assert_eq!(next.id, old.id);
    assert_ne!(next.token, old.token);
    assert!(repo.agent_authority(&old.id, &old.token).await.is_err());
    let replay = repo
        .execute_agent_tool(&next.id, &next.token, "save_memory", memory())
        .await
        .unwrap();
    assert_eq!(first["value"], replay["value"]);
    assert_eq!(replay["replayed"], true);
    repo.finish_agent_run(
        &next,
        Some(&AgentOutput {
            content: "已保存".into(),
            usage: json!({"total_tokens":20}),
        }),
        None,
    )
    .await
    .unwrap();
    let cached = begin(&repo, &a, "retry").await;
    assert_eq!(cached.cached.as_deref(), Some("已保存"));
    assert_eq!(repo.memories(&a).await.unwrap().len(), 1);
}

#[tokio::test]
async fn concurrent_request_and_changed_instruction_cannot_steal_active_run() {
    let (repo, a, _) = fixture().await;
    let run = begin(&repo, &a, "same").await;
    assert!(matches!(
        repo.begin_agent_run(&a, "same", "fixture instruction", None, None)
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repo.begin_agent_run(&a, "same", "different instruction", None, None)
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(repo.agent_authority(&run.id, &run.token).await.is_ok());
}

#[tokio::test]
async fn stale_memory_version_and_foreign_ids_never_write() {
    let (repo, a, b) = fixture().await;
    let run = begin(&repo, &a, "versions").await;
    let created = repo
        .execute_agent_tool(&run.id, &run.token, "save_memory", memory())
        .await
        .unwrap();
    let id = created["value"]["id"].as_str().unwrap();
    repo.execute_agent_tool(
        &run.id,
        &run.token,
        "update_memory",
        json!({"id":id,"version":1,"content":"新偏好"}),
    )
    .await
    .unwrap();
    let bad = repo
        .execute_agent_tool(
            &run.id,
            &run.token,
            "update_memory",
            json!({"id":id,"version":1,"content":"过期覆盖"}),
        )
        .await;
    assert!(matches!(bad, Err(DomainError::Conflict(_))));
    let other = begin(&repo, &b, "other").await;
    assert!(matches!(
        repo.execute_agent_tool(
            &other.id,
            &other.token,
            "delete_memory",
            json!({"id":id,"version":2})
        )
        .await,
        Err(DomainError::NotFound)
    ));
    assert_eq!(repo.memories(&a).await.unwrap()[0].content, "新偏好");
    assert_eq!(
        repo.agent_run(&a, &run.id).await.unwrap().operations.len(),
        2
    );
}

#[tokio::test]
async fn background_runs_have_read_only_tools_and_follow_task_lease_and_cancellation() {
    let (repo, a, _) = fixture().await;
    let task = repo
        .create_task(
            &a,
            CreateTask {
                title: None,
                instruction: "测试后台任务".into(),
                kind: None,
                approval_required: Some(false),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    let run = repo
        .begin_agent_run(
            &a,
            "background",
            "fixture",
            None,
            Some((&task.id, claim.attempt)),
        )
        .await
        .unwrap();
    assert!(repo
        .execute_agent_tool(&run.id, &run.token, "list_memories", json!({}))
        .await
        .is_ok());
    assert!(matches!(
        repo.execute_agent_tool(&run.id, &run.token, "save_memory", memory())
            .await,
        Err(DomainError::Forbidden)
    ));
    repo.cancel_task(&a, &task.id).await.unwrap();
    assert!(repo.agent_authority(&run.id, &run.token).await.is_err());
}

#[tokio::test]
async fn effects_and_trace_survive_database_reopen_without_exposing_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        dir.path()
            .join("agent.db")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user("durable@test.local", "unused", "测试", "Asia/Shanghai")
        .await
        .unwrap();
    let run = begin(&repo, &user.id, "durable").await;
    repo.execute_agent_tool(&run.id, &run.token, "save_memory", memory())
        .await
        .unwrap();
    repo.record_agent_event(&run.id, &run.token, 1, "started", &json!({"harness":"pi"}))
        .await
        .unwrap();
    repo.finish_agent_run(&run, None, Some("interrupted fixture"))
        .await
        .unwrap();
    drop(repo);
    let reopened = Repository::connect(&url).await.unwrap();
    let next = begin(&reopened, &user.id, "durable").await;
    let result = reopened
        .execute_agent_tool(&next.id, &next.token, "save_memory", memory())
        .await
        .unwrap();
    assert_eq!(result["replayed"], true);
    let view = reopened.agent_run(&user.id, &run.id).await.unwrap();
    assert_eq!(view.events.len(), 1);
    let text = serde_json::to_string(&view).unwrap();
    assert!(!text.contains(&run.token));
    assert!(!text.contains("token_hash"));
}
