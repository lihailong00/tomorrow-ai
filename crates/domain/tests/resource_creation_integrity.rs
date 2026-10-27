use std::collections::HashSet;
use tomorrow_domain::*;

fn memory(key: Option<&str>) -> CreateMemory {
    CreateMemory {
        title: None,
        content: "Saved information".into(),
        kind: "fact".into(),
        source: None,
        client_request_id: key.map(str::to_owned),
    }
}
fn schedule(key: Option<&str>) -> CreateSchedule {
    CreateSchedule {
        title: "Daily plan".into(),
        instruction: "Read saved information".into(),
        frequency: "daily".into(),
        time: "08:00".into(),
        timezone: "UTC".into(),
        enabled: None,
        client_request_id: key.map(str::to_owned),
    }
}
async fn user(repo: &Repository) -> String {
    repo.create_user(
        &format!("creation-{}@example.test", new_id()),
        "unused",
        "Creation QA",
        "UTC",
    )
    .await
    .unwrap()
    .id
}
async fn count(repo: &Repository, owner: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM resource_creation_requests WHERE user_id=$1")
        .bind(owner)
        .fetch_one(&repo.pool())
        .await
        .unwrap()
}
async fn checks(repo: &Repository) -> (String, String, String, String, String, String, String) {
    let owner = user(repo).await;
    let other = user(repo).await;
    let mut invalid = memory(Some("invalid"));
    invalid.content = " ".into();
    assert!(matches!(
        repo.create_memory(&owner, invalid).await,
        Err(DomainError::Validation(_))
    ));
    let mut invalid = schedule(Some("invalid"));
    invalid.timezone = "Mars/Olympus".into();
    assert!(matches!(
        repo.create_schedule(&owner, invalid).await,
        Err(DomainError::Validation(_))
    ));
    assert!(matches!(
        repo.create_memory(&owner, memory(Some(" "))).await,
        Err(DomainError::Validation(_))
    ));
    assert!(matches!(
        repo.create_schedule(&owner, schedule(Some(&"k".repeat(121))))
            .await,
        Err(DomainError::Validation(_))
    ));
    assert_eq!(count(repo, &owner).await, 0);
    assert!(repo.memories(&owner).await.unwrap().is_empty());
    assert!(repo.schedules(&owner).await.unwrap().is_empty());

    let key = new_id();
    let first = repo
        .create_memory(&owner, memory(Some(&key)))
        .await
        .unwrap();
    let mut equivalent = memory(Some(&format!("  {key}  ")));
    equivalent.title = Some("Saved information".into());
    equivalent.content = "  Saved information  ".into();
    equivalent.source = Some("用户手动创建".into());
    assert_eq!(
        repo.create_memory(&owner, equivalent).await.unwrap().id,
        first.id
    );
    for variant in 0..4 {
        let mut changed = memory(Some(&key));
        match variant {
            0 => changed.content = "Changed".into(),
            1 => changed.title = Some("Changed".into()),
            2 => changed.kind = "preference".into(),
            _ => changed.source = Some("Changed".into()),
        }
        assert!(matches!(
            repo.create_memory(&owner, changed).await,
            Err(DomainError::Conflict(_))
        ));
    }
    let updated = repo
        .update_memory(
            &owner,
            &first.id,
            UpdateMemory {
                title: Some("Edited later".into()),
                content: None,
                kind: None,
                version: Some(1),
            },
        )
        .await
        .unwrap();
    let replay = repo
        .create_memory(&owner, memory(Some(&key)))
        .await
        .unwrap();
    assert_eq!(replay.id, updated.id);
    assert_eq!(replay.version, updated.version);
    assert_eq!(replay.title, "Edited later");
    assert_ne!(
        repo.create_memory(&other, memory(Some(&key)))
            .await
            .unwrap()
            .id,
        first.id
    );
    let same_key_plan = repo
        .create_schedule(&owner, schedule(Some(&key)))
        .await
        .unwrap();
    assert_ne!(same_key_plan.id, first.id);

    let concurrent_key = new_id();
    let mut jobs = Vec::new();
    for _ in 0..12 {
        let repo = repo.clone();
        let owner = owner.clone();
        let key = concurrent_key.clone();
        jobs.push(tokio::spawn(async move {
            repo.create_memory(&owner, memory(Some(&key)))
                .await
                .unwrap()
                .id
        }));
    }
    let mut ids = HashSet::new();
    for job in jobs {
        ids.insert(job.await.unwrap());
    }
    assert_eq!(ids.len(), 1);
    let mismatch = new_id();
    let a = memory(Some(&mismatch));
    let mut b = a.clone();
    b.content = "Concurrent different intent".into();
    let (a, b) = tokio::join!(repo.create_memory(&owner, a), repo.create_memory(&owner, b));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(DomainError::Conflict(_))) || matches!(b, Err(DomainError::Conflict(_)))
    );

    let legacy_a = repo.create_memory(&owner, memory(None)).await.unwrap();
    let legacy_b = repo.create_memory(&owner, memory(None)).await.unwrap();
    assert_ne!(legacy_a.id, legacy_b.id);
    let intentional_a = repo
        .create_memory(&owner, memory(Some(&new_id())))
        .await
        .unwrap();
    let intentional_b = repo
        .create_memory(&owner, memory(Some(&new_id())))
        .await
        .unwrap();
    assert_ne!(intentional_a.id, intentional_b.id);

    repo.delete_resource(&owner, "memory", &first.id)
        .await
        .unwrap();
    let before = repo.memories(&owner).await.unwrap().len();
    assert!(matches!(
        repo.create_memory(&owner, memory(Some(&key))).await,
        Err(DomainError::Conflict(_))
    ));
    assert_eq!(repo.memories(&owner).await.unwrap().len(), before);

    let plan_key = new_id();
    let first = repo
        .create_schedule(&owner, schedule(Some(&plan_key)))
        .await
        .unwrap();
    let mut equivalent = schedule(Some(&format!(" {plan_key} ")));
    equivalent.title = " Daily plan ".into();
    equivalent.instruction = " Read saved information ".into();
    equivalent.enabled = Some(true);
    let replay = repo.create_schedule(&owner, equivalent).await.unwrap();
    assert_eq!(replay.id, first.id);
    assert_eq!(replay.next_run_at, first.next_run_at);
    for variant in 0..7 {
        let mut changed = schedule(Some(&plan_key));
        match variant {
            0 => changed.title = "Changed".into(),
            1 => changed.instruction = "Changed".into(),
            2 => changed.frequency = "weekly".into(),
            3 => changed.time = "09:00".into(),
            4 => changed.timezone = "Asia/Shanghai".into(),
            5 => changed.enabled = Some(false),
            _ => changed.frequency = "once".into(),
        }
        assert!(matches!(
            repo.create_schedule(&owner, changed).await,
            Err(DomainError::Conflict(_))
        ));
    }
    repo.update_schedule(
        &owner,
        &first.id,
        UpdateSchedule {
            enabled: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        !repo
            .create_schedule(&owner, schedule(Some(&plan_key)))
            .await
            .unwrap()
            .enabled
    );
    assert_ne!(
        repo.create_schedule(&other, schedule(Some(&plan_key)))
            .await
            .unwrap()
            .id,
        first.id
    );
    let concurrent = new_id();
    let a = schedule(Some(&concurrent));
    let mut b = a.clone();
    b.title = "Concurrent changed plan".into();
    let (a, b) = tokio::join!(
        repo.create_schedule(&owner, a),
        repo.create_schedule(&owner, b)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(DomainError::Conflict(_))) || matches!(b, Err(DomainError::Conflict(_)))
    );
    repo.delete_schedule(&owner, &first.id).await.unwrap();
    let before = repo.schedules(&owner).await.unwrap().len();
    assert!(matches!(
        repo.create_schedule(&owner, schedule(Some(&plan_key)))
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert_eq!(repo.schedules(&owner).await.unwrap().len(), before);
    assert_ne!(
        repo.create_schedule(&owner, schedule(Some(&new_id())))
            .await
            .unwrap()
            .id,
        first.id
    );
    let legacy_a = repo.create_schedule(&owner, schedule(None)).await.unwrap();
    let legacy_b = repo.create_schedule(&owner, schedule(None)).await.unwrap();
    assert_ne!(legacy_a.id, legacy_b.id);
    let memory_key = new_id();
    let memory = repo
        .create_memory(&owner, memory(Some(&memory_key)))
        .await
        .unwrap();
    let restart_plan_key = new_id();
    let plan = repo
        .create_schedule(&owner, schedule(Some(&restart_plan_key)))
        .await
        .unwrap();
    (
        owner,
        memory_key,
        memory.id,
        restart_plan_key,
        plan.id,
        key,
        plan_key,
    )
}
async fn upgrade_and_checks(url: &str) {
    let repo = Repository::connect(url).await.unwrap();
    let legacy_owner = user(&repo).await;
    let old_memory = repo
        .create_memory(&legacy_owner, memory(None))
        .await
        .unwrap();
    let old_schedule = repo
        .create_schedule(&legacy_owner, schedule(None))
        .await
        .unwrap();
    // Only the dedicated E03 test DB is supplied. Simulate its previous schema.
    sqlx::query("DROP TABLE resource_creation_requests")
        .execute(&repo.pool())
        .await
        .unwrap();
    repo.pool().close().await;
    let repo = Repository::connect(url).await.unwrap();
    assert_eq!(
        repo.memories(&legacy_owner).await.unwrap()[0].id,
        old_memory.id
    );
    assert_eq!(
        repo.schedule(&legacy_owner, &old_schedule.id)
            .await
            .unwrap()
            .id,
        old_schedule.id
    );
    let (owner, memory_key, memory_id, plan_key, plan_id, deleted_memory_key, deleted_plan_key) =
        checks(&repo).await;
    repo.pool().close().await;
    let reopened = Repository::connect(url).await.unwrap();
    assert!(matches!(
        reopened
            .create_memory(&owner, memory(Some(&deleted_memory_key)))
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        reopened
            .create_schedule(&owner, schedule(Some(&deleted_plan_key)))
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert_eq!(
        reopened
            .create_memory(&owner, memory(Some(&memory_key)))
            .await
            .unwrap()
            .id,
        memory_id
    );
    assert_eq!(
        reopened
            .create_schedule(&owner, schedule(Some(&plan_key)))
            .await
            .unwrap()
            .id,
        plan_id
    );
}
#[tokio::test]
async fn sqlite_creation_intents_survive_upgrade_restart_and_delete() {
    let directory = tempfile::tempdir().unwrap();
    upgrade_and_checks(&format!(
        "sqlite:{}",
        directory.path().join("creation.sqlite").display()
    ))
    .await;
}
#[tokio::test]
#[ignore = "Requires isolated tada_qa_e03_* PostgreSQL database"]
async fn postgres_creation_intents_survive_upgrade_restart_and_delete() {
    let url = std::env::var("TEST_E03_DATABASE_URL").unwrap();
    let name = url.split('?').next().unwrap().rsplit('/').next().unwrap();
    assert!(url.starts_with("postgres") && name.starts_with("tada_qa_e03_"));
    upgrade_and_checks(&url).await;
}
