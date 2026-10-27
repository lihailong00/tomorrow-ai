use sqlx::AnyPool;
use tempfile::TempDir;
use tomorrow_domain::{CreateMemory, CreateSchedule, CreateTask, ModelProvider, Repository};
use tomorrow_worker::{WorkerEngine, local_document};

async fn fixture() -> (TempDir, String, Repository, String) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}?mode=rwc",
        directory
            .path()
            .join("worker.db")
            .to_string_lossy()
            .replace('\\', "/")
    );
    let repository = Repository::connect(&url).await.unwrap();
    let user = repository
        .create_user(
            "worker-test@example.com",
            "test-not-a-real-password-hash",
            "小明",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    (directory, url, repository, user.id)
}

fn task(approval: bool) -> CreateTask {
    CreateTask {
        instruction: "根据我的记忆整理今天的关注点".into(),
        title: Some("今日简报".into()),
        kind: Some("briefing".into()),
        approval_required: Some(approval),
        client_request_id: None,
    }
}

#[tokio::test]
async fn approval_blocks_claim_and_cancellation_blocks_publishing() {
    let (_directory, _url, repository, user_id) = fixture().await;
    let pending = repository.create_task(&user_id, task(true)).await.unwrap();
    assert_eq!(pending.status, "waiting_approval");
    assert!(repository.claim_task(90).await.unwrap().is_none());
    repository
        .approve_task(&user_id, &pending.id)
        .await
        .unwrap();
    let claim = repository.claim_task(90).await.unwrap().unwrap();
    repository.cancel_task(&user_id, &pending.id).await.unwrap();
    assert!(!repository.renew_task(&claim, 90).await.unwrap());
    assert!(
        !repository
            .complete_task(&claim, "不应保存", "local")
            .await
            .unwrap()
    );
    assert!(repository.artifacts(&user_id).await.unwrap().is_empty());
    assert!(repository.notifications(&user_id).await.unwrap().is_empty());
    assert_eq!(
        repository.task(&user_id, &pending.id).await.unwrap().status,
        "cancelled"
    );
}

#[tokio::test]
async fn competing_workers_claim_once_and_stale_attempt_cannot_publish() {
    let (_directory, url, repository, user_id) = fixture().await;
    let second = Repository::connect(&url).await.unwrap();
    let created = repository.create_task(&user_id, task(false)).await.unwrap();
    let (one, two) = tokio::join!(repository.claim_task(90), second.claim_task(90));
    let claims: Vec<_> = [one.unwrap(), two.unwrap()].into_iter().flatten().collect();
    assert_eq!(claims.len(), 1);
    let first = &claims[0];
    // Simulate process death and persisted lease expiry without sleeping for 90 seconds.
    let pool = AnyPool::connect(&url).await.unwrap();
    sqlx::query("UPDATE tasks SET claimed_until=0 WHERE id=$1")
        .bind(&created.id)
        .execute(&pool)
        .await
        .unwrap();
    let recovered = second.claim_task(90).await.unwrap().unwrap();
    assert_eq!(recovered.task.id, first.task.id);
    assert_eq!(recovered.attempt, first.attempt + 1);
    assert!(
        !repository
            .complete_task(first, "旧 worker 内容", "local")
            .await
            .unwrap()
    );
    assert!(
        second
            .complete_task(&recovered, "恢复后的结果", "local")
            .await
            .unwrap()
    );
    assert!(
        !second
            .complete_task(&recovered, "重复发布", "local")
            .await
            .unwrap()
    );
    assert_eq!(repository.artifacts(&user_id).await.unwrap().len(), 1);
    assert_eq!(repository.notifications(&user_id).await.unwrap().len(), 1);
}

#[tokio::test]
async fn schedules_coalesce_missed_runs_and_do_not_dispatch_twice() {
    let (_directory, url, repository, user_id) = fixture().await;
    let schedule = repository
        .create_schedule(
            &user_id,
            CreateSchedule {
                title: "早间简报".into(),
                instruction: "整理我的已保存事项".into(),
                frequency: "daily".into(),
                time: "08:00".into(),
                timezone: "Asia/Shanghai".into(),
                enabled: Some(true),
            },
        )
        .await
        .unwrap();
    let pool = AnyPool::connect(&url).await.unwrap();
    sqlx::query("UPDATE schedules SET next_run_at=$1 WHERE id=$2")
        .bind(tomorrow_domain::now() - 3 * 86400)
        .bind(&schedule.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(repository.tick_schedules().await.unwrap(), 1);
    assert_eq!(repository.tick_schedules().await.unwrap(), 0);
    assert_eq!(repository.tasks(&user_id).await.unwrap().len(), 1);
    let updated = repository.schedule(&user_id, &schedule.id).await.unwrap();
    assert!(updated.last_run_at.is_some());
    assert!(
        chrono::DateTime::parse_from_rfc3339(&updated.next_run_at)
            .unwrap()
            .timestamp()
            > tomorrow_domain::now()
    );
}

#[tokio::test]
async fn local_document_uses_only_actual_data_and_labels_capability() {
    let (_directory, _url, repository, user_id) = fixture().await;
    let created = repository.create_task(&user_id, task(false)).await.unwrap();
    let memory = repository
        .create_memory(
            &user_id,
            CreateMemory {
                title: Some("项目目标".into()),
                content: "完成安卓首版".into(),
                kind: "project".into(),
                source: None,
            },
        )
        .await
        .unwrap();
    let output = local_document(&created, &[memory], &[created.clone()], &[]);
    assert!(output.contains("本地模式"));
    assert!(output.contains("完成安卓首版"));
    assert!(output.contains("未访问网页、邮箱或外部日历"));
    assert!(output.contains("当前没有其他待处理任务"));
}

#[tokio::test]
async fn execution_reads_current_memories_and_persists_results_once() {
    let (_directory, _url, repository, user_id) = fixture().await;
    let forgotten = repository
        .create_memory(
            &user_id,
            CreateMemory {
                title: Some("旧资料".into()),
                content: "不该再出现的私人资料".into(),
                kind: "fact".into(),
                source: None,
            },
        )
        .await
        .unwrap();
    let created = repository.create_task(&user_id, task(false)).await.unwrap();
    let engine = WorkerEngine::new(repository.clone(), ModelProvider::local());
    let claim = engine.claim().await.unwrap().unwrap();
    repository
        .delete_resource(&user_id, "memory", &forgotten.id)
        .await
        .unwrap();
    repository
        .create_memory(
            &user_id,
            CreateMemory {
                title: Some("当前目标".into()),
                content: "完成记忆管理功能".into(),
                kind: "goal".into(),
                source: None,
            },
        )
        .await
        .unwrap();
    assert!(engine.execute(&claim).await.unwrap());
    assert!(!engine.execute(&claim).await.unwrap());
    let result = repository.task(&user_id, &created.id).await.unwrap();
    assert_eq!(result.status, "succeeded");
    assert_eq!(result.model_mode, "local");
    assert!(!result.result.as_ref().unwrap().contains("不该再出现"));
    assert!(result.result.as_ref().unwrap().contains("完成记忆管理功能"));
    assert_eq!(repository.artifacts(&user_id).await.unwrap().len(), 1);
    assert_eq!(repository.notifications(&user_id).await.unwrap().len(), 1);
}
