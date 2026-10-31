use tomorrow_domain::*;

async fn setup() -> (tempfile::TempDir, String, Repository, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("test.db").to_string_lossy()
    );
    let repository = Repository::connect(&url).await.unwrap();
    let first = repository
        .create_user("first@example.test", "test-hash", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let second = repository
        .create_user("second@example.test", "test-hash", "乙", "America/New_York")
        .await
        .unwrap();
    (directory, url, repository, first.id, second.id)
}
fn task_input(approval: bool, key: &str) -> CreateTask {
    CreateTask {
        instruction: "整理我的资料".into(),
        title: None,
        kind: None,
        approval_required: Some(approval),
        client_request_id: Some(key.into()),
    }
}

#[tokio::test]
async fn persistence_isolation_and_revocation() {
    let (_directory, url, repository, first, second) = setup().await;
    let memory = repository
        .create_memory(
            &first,
            CreateMemory {
                title: None,
                content: "偏好中文".into(),
                kind: "preference".into(),
                source: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    assert!(repository.memories(&second).await.unwrap().is_empty());
    assert!(matches!(
        repository
            .update_memory(
                &second,
                &memory.id,
                UpdateMemory {
                    title: None,
                    content: Some("攻击".into()),
                    kind: None,
                    version: None
                }
            )
            .await,
        Err(DomainError::NotFound)
    ));
    assert!(matches!(
        repository
            .delete_resource(&second, "memory", &memory.id)
            .await,
        Err(DomainError::NotFound)
    ));
    let token = repository.create_session(&first).await.unwrap();
    assert_eq!(repository.authenticate(&token).await.unwrap(), first);
    assert!(repository
        .authenticate(&format!("{}0", token))
        .await
        .is_err());
    let reopened = Repository::connect(&url).await.unwrap();
    assert_eq!(
        reopened.memories(&first).await.unwrap()[0].content,
        "偏好中文"
    );
    reopened.logout(&token).await.unwrap();
    assert!(repository.authenticate(&token).await.is_err());
}

#[tokio::test]
async fn stale_memory_cannot_overwrite_or_reappear_after_delete() {
    let (_directory, _url, repository, first, _second) = setup().await;
    let memory = repository
        .create_memory(
            &first,
            CreateMemory {
                title: Some("偏好".into()),
                content: "中文".into(),
                kind: "preference".into(),
                source: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let edited = repository
        .update_memory(
            &first,
            &memory.id,
            UpdateMemory {
                title: None,
                content: Some("英文".into()),
                kind: None,
                version: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(edited.version, 2);
    assert!(matches!(
        repository
            .update_memory(
                &first,
                &memory.id,
                UpdateMemory {
                    title: None,
                    content: Some("旧客户端".into()),
                    kind: None,
                    version: Some(1)
                }
            )
            .await,
        Err(DomainError::Conflict(_))
    ));
    repository
        .delete_resource(&first, "memory", &memory.id)
        .await
        .unwrap();
    assert!(repository.memories(&first).await.unwrap().is_empty());
}

#[tokio::test]
async fn task_submission_is_idempotent_and_user_scoped() {
    let (_directory, _url, repository, first, second) = setup().await;
    let a = repository
        .create_task(&first, task_input(false, "request-1"))
        .await
        .unwrap();
    let b = repository
        .create_task(&first, task_input(false, "request-1"))
        .await
        .unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(repository.tasks(&first).await.unwrap().len(), 1);
    let other = repository
        .create_task(&second, task_input(false, "request-1"))
        .await
        .unwrap();
    assert_ne!(a.id, other.id);
    assert!(matches!(
        repository.task(&second, &a.id).await,
        Err(DomainError::NotFound)
    ));
}

#[tokio::test]
async fn approval_and_worker_completion_are_fenced_and_atomic() {
    let (_directory, _url, repository, first, second) = setup().await;
    let task = repository
        .create_task(&first, task_input(true, "approval-1"))
        .await
        .unwrap();
    assert_eq!(task.status, "waiting_approval");
    assert!(repository.claim_task(60).await.unwrap().is_none());
    assert!(matches!(
        repository.approve_task(&second, &task.id).await,
        Err(DomainError::NotFound)
    ));
    repository.approve_task(&first, &task.id).await.unwrap();
    let claim = repository.claim_task(60).await.unwrap().unwrap();
    assert_eq!(claim.attempt, 1);
    assert!(repository.claim_task(60).await.unwrap().is_none());
    assert!(repository
        .complete_task(&claim, "实际本地成果", "local")
        .await
        .unwrap());
    assert!(!repository
        .complete_task(&claim, "重复完成", "local")
        .await
        .unwrap());
    assert_eq!(repository.artifacts(&first).await.unwrap().len(), 1);
    assert_eq!(repository.notifications(&first).await.unwrap().len(), 1);
    assert!(repository.artifacts(&second).await.unwrap().is_empty());
}

#[test]
fn scheduling_respects_weekdays_and_dst() {
    let friday = chrono::DateTime::parse_from_rfc3339("2026-10-23T12:00:00+08:00")
        .unwrap()
        .timestamp();
    let next = tomorrow_domain::repository::next_execution(
        "weekdays",
        "09:00",
        "Asia/Shanghai",
        friday,
        false,
    )
    .unwrap();
    assert_eq!(timestamp(next), "2026-10-26T01:00:00+00:00");
    let spring = chrono::DateTime::parse_from_rfc3339("2026-03-08T00:00:00-05:00")
        .unwrap()
        .timestamp();
    let next = tomorrow_domain::repository::next_execution(
        "daily",
        "02:30",
        "America/New_York",
        spring,
        false,
    )
    .unwrap();
    assert_eq!(timestamp(next), "2026-03-08T07:00:00+00:00");
}

#[test]
fn weekly_schedule_keeps_original_weekday_after_worker_downtime() {
    let monday_due = chrono::DateTime::parse_from_rfc3339("2026-10-19T08:00:00+08:00")
        .unwrap()
        .timestamp();
    let recovered_wednesday = chrono::DateTime::parse_from_rfc3339("2026-10-21T12:00:00+08:00")
        .unwrap()
        .timestamp();
    let next = tomorrow_domain::repository::next_weekly_execution(
        "08:00",
        "Asia/Shanghai",
        monday_due,
        recovered_wednesday,
    )
    .unwrap();
    assert_eq!(timestamp(next), "2026-10-26T00:00:00+00:00");
}
