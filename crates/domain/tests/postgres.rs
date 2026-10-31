use tomorrow_domain::*;

/// Set TEST_DATABASE_URL explicitly; never fall back to a developer's live DATABASE_URL.
#[tokio::test]
async fn postgres_persistence_claims_and_tenant_isolation() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    assert!(
        url.starts_with("postgres"),
        "TEST_DATABASE_URL must point to a disposable PostgreSQL test database"
    );
    let repository = Repository::connect(&url).await.unwrap();
    let suffix = new_id();
    let first = repository
        .create_user(
            &format!("first-{suffix}@pg.test"),
            "test-only",
            "甲",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let second = repository
        .create_user(
            &format!("second-{suffix}@pg.test"),
            "test-only",
            "乙",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let token = repository.create_session(&first.id).await.unwrap();
    assert_eq!(repository.authenticate(&token).await.unwrap(), first.id);
    let memory = repository
        .create_memory(
            &first.id,
            CreateMemory {
                title: None,
                content: "仅第一位用户可见".into(),
                kind: "fact".into(),
                source: None,
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    assert!(repository.memories(&second.id).await.unwrap().is_empty());
    assert!(matches!(
        repository
            .delete_resource(&second.id, "memory", &memory.id)
            .await,
        Err(DomainError::NotFound)
    ));
    let input = CreateTask {
        instruction: "整理资料".into(),
        title: None,
        kind: None,
        approval_required: Some(true),
        client_request_id: Some("pg-test-request".into()),
    };
    let task = repository
        .create_task(&first.id, input.clone())
        .await
        .unwrap();
    assert_eq!(
        repository.create_task(&first.id, input).await.unwrap().id,
        task.id
    );
    assert!(repository.claim_task(60).await.unwrap().is_none());
    repository.approve_task(&first.id, &task.id).await.unwrap();
    let claim = repository.claim_task(60).await.unwrap().unwrap();
    assert_eq!(claim.task.id, task.id);
    assert!(repository
        .complete_task(&claim, "PG事务保存的成果", "local")
        .await
        .unwrap());
    assert!(!repository
        .complete_task(&claim, "重复", "local")
        .await
        .unwrap());
    assert_eq!(repository.artifacts(&first.id).await.unwrap().len(), 1);
    assert!(repository.artifacts(&second.id).await.unwrap().is_empty());
    let schedule = repository
        .create_schedule(
            &first.id,
            CreateSchedule {
                title: "每日计划".into(),
                instruction: "整理记忆".into(),
                frequency: "daily".into(),
                time: "08:00".into(),
                timezone: "Asia/Shanghai".into(),
                enabled: Some(false),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    assert!(!repository.schedules(&first.id).await.unwrap()[0].enabled);
    assert!(repository
        .delete_schedule(&second.id, &schedule.id)
        .await
        .is_err());
    repository
        .delete_schedule(&first.id, &schedule.id)
        .await
        .unwrap();
    // Only clean up the two test-owned rows and their cascading children.
    sqlx::query("DELETE FROM users WHERE id=$1 OR id=$2")
        .bind(first.id)
        .bind(second.id)
        .execute(&repository.pool())
        .await
        .unwrap();
}
