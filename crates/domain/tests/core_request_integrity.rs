use serde_json::json;
use tomorrow_domain::{
    auth, new_id, now, ChatTurn, CreateMemory, CreateTask, DomainError, Message, Repository,
};

async fn user(repository: &Repository) -> String {
    repository
        .create_user(
            &format!("core-{}@example.test", new_id()),
            "test-password-hash",
            "Core QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id
}
fn task(key: &str) -> CreateTask {
    CreateTask {
        instruction: "Original task".into(),
        title: None,
        kind: None,
        approval_required: Some(true),
        client_request_id: Some(key.into()),
    }
}
fn message(conversation_id: &str, role: &str, at: &str) -> Message {
    Message {
        id: new_id(),
        conversation_id: conversation_id.into(),
        role: role.into(),
        content: format!("Synthetic {role}"),
        created_at: at.into(),
        model_mode: None,
        attachments: Vec::new(),
    }
}

async fn check_memory_titles(repository: &Repository) {
    let id = user(repository).await;
    let invalid = repository
        .create_memory(
            &id,
            CreateMemory {
                title: Some("记".repeat(121)),
                content: "Original content".into(),
                kind: "fact".into(),
                source: None,
            },
        )
        .await;
    assert!(matches!(invalid, Err(DomainError::Validation(_))));
    assert!(repository.memories(&id).await.unwrap().is_empty());
    for title in [None, Some("  ".into())] {
        let memory = repository
            .create_memory(
                &id,
                CreateMemory {
                    title,
                    content: "x".repeat(150),
                    kind: "fact".into(),
                    source: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(memory.title, "x".repeat(40));
    }
    let valid = repository
        .create_memory(
            &id,
            CreateMemory {
                title: Some("记".repeat(120)),
                content: "Content".into(),
                kind: "fact".into(),
                source: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(valid.title.chars().count(), 120);
}

async fn check_task_payloads(repository: &Repository) {
    let id = user(repository).await;
    let key = new_id();
    let first = repository.create_task(&id, task(&key)).await.unwrap();
    let mut equivalent = task(&format!("  {key}  "));
    equivalent.title = Some("Original task".into());
    equivalent.kind = Some("general".into());
    assert_eq!(
        repository.create_task(&id, equivalent).await.unwrap().id,
        first.id
    );
    for variant in 0..4 {
        let mut different = task(&key);
        match variant {
            0 => different.instruction = "Different task".into(),
            1 => different.title = Some("Different title".into()),
            2 => different.kind = Some("research".into()),
            _ => different.approval_required = Some(false),
        }
        assert!(matches!(
            repository.create_task(&id, different).await,
            Err(DomainError::Conflict(_))
        ));
    }
    assert_eq!(repository.tasks(&id).await.unwrap().len(), 1);
    repository.approve_task(&id, &first.id).await.unwrap();
    assert_eq!(
        repository.create_task(&id, task(&key)).await.unwrap().id,
        first.id
    );
    let other = user(repository).await;
    assert_ne!(
        repository.create_task(&other, task(&key)).await.unwrap().id,
        first.id
    );

    let concurrent_key = new_id();
    let a = task(&concurrent_key);
    let mut b = task(&concurrent_key);
    b.instruction = "Concurrent different task".into();
    let (a, b) = tokio::join!(
        repository.create_task(&id, a),
        repository.create_task(&id, b)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(DomainError::Conflict(_))) || matches!(b, Err(DomainError::Conflict(_)))
    );
}

async fn check_chat_payloads(repository: &Repository) {
    let id = user(repository).await;
    let concurrent = new_id();
    let (a, b) = tokio::join!(
        repository.reserve_chat(&id, &concurrent, "concurrent a"),
        repository.reserve_chat(&id, &concurrent, "concurrent b")
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let winner = if a.is_ok() {
        "concurrent a"
    } else {
        "concurrent b"
    };
    assert!(
        matches!(a, Err(DomainError::Conflict(_))) || matches!(b, Err(DomainError::Conflict(_)))
    );
    repository
        .complete_chat(&id, &concurrent, &json!({"winner":winner}), winner)
        .await
        .unwrap();
    assert_eq!(
        repository
            .reserve_chat(&id, &concurrent, winner)
            .await
            .unwrap(),
        Some(json!({"winner":winner}))
    );
    let key = new_id();
    assert!(repository
        .reserve_chat(&id, &format!("  {key}  "), "canonical payload")
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        repository
            .reserve_chat(&id, &key, "different payload")
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repository
            .reserve_chat(&id, &key, "canonical payload")
            .await,
        Err(DomainError::Conflict(_))
    ));
    let conversation = repository
        .create_conversation(&id, "Chat fixture")
        .await
        .unwrap();
    let response = json!({"synthetic":"accepted"});
    repository
        .commit_chat_turn(
            &id,
            &ChatTurn {
                user_message: message(&conversation.id, "user", "2026-10-28T01:00:00.100Z"),
                assistant_message: message(
                    &conversation.id,
                    "assistant",
                    "2026-10-28T01:00:00.200Z",
                ),
                conversation: conversation.clone(),
                memory: None,
                request_id: Some(format!("  {key}  ")),
                response: response.clone(),
            },
            "canonical payload",
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .reserve_chat(&id, &key, "canonical payload")
            .await
            .unwrap(),
        Some(response)
    );
    assert!(matches!(
        repository
            .reserve_chat(&id, &key, "different payload")
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert_eq!(
        repository
            .messages(&id, &conversation.id)
            .await
            .unwrap()
            .len(),
        2
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chat_request_inputs WHERE user_id=$1 AND fingerprint=$2",
    )
    .bind(&id)
    .bind(auth::hash_token("canonical payload"))
    .fetch_one(&repository.pool())
    .await
    .unwrap();
    assert_eq!(count, 1);
    let other = user(repository).await;
    assert!(repository
        .reserve_chat(&other, &key, "different user's payload")
        .await
        .unwrap()
        .is_none());
    let release = new_id();
    repository
        .reserve_chat(&id, &format!(" {release} "), "release")
        .await
        .unwrap();
    repository
        .release_chat(&id, &format!(" {release} "), "release")
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_request_inputs WHERE request_key=$1")
            .bind(format!("{id}:{release}"))
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert!(repository
        .reserve_chat(&id, &release, "new payload after released failure")
        .await
        .unwrap()
        .is_none());
    let stale = new_id();
    repository
        .reserve_chat(&id, &stale, "old in-flight payload")
        .await
        .unwrap();
    sqlx::query("UPDATE chat_requests SET created_at=$1 WHERE request_key=$2")
        .bind(now() - 301)
        .bind(format!("{id}:{stale}"))
        .execute(&repository.pool())
        .await
        .unwrap();
    assert!(repository
        .reserve_chat(&id, &stale, "replacement payload")
        .await
        .unwrap()
        .is_none());
    repository
        .release_chat(&id, &stale, "old in-flight payload")
        .await
        .unwrap();
    assert!(matches!(
        repository
            .complete_chat(&id, &stale, &json!({"stale":true}), "old in-flight payload")
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repository
            .reserve_chat(&id, &stale, "replacement payload")
            .await,
        Err(DomainError::Conflict(_))
    ));
    repository
        .complete_chat(
            &id,
            &stale,
            &json!({"replacement":true}),
            "replacement payload",
        )
        .await
        .unwrap();
    assert_eq!(
        repository
            .reserve_chat(&id, &stale, "replacement payload")
            .await
            .unwrap(),
        Some(json!({"replacement":true}))
    );
}

async fn check_legacy_chat_rows(repository: &Repository) {
    let id = user(repository).await;
    let key = new_id();
    sqlx::query(
        "INSERT INTO chat_requests(request_key,user_id,response,created_at)VALUES($1,$2,$3,$4)",
    )
    .bind(format!("{id}:{key}"))
    .bind(&id)
    .bind(json!({"legacy":true}).to_string())
    .bind(now())
    .execute(&repository.pool())
    .await
    .unwrap();
    assert!(matches!(
        repository
            .reserve_chat(&id, &key, "unprovable old request")
            .await,
        Err(DomainError::Conflict(_))
    ));
    let stored: String =
        sqlx::query_scalar("SELECT response FROM chat_requests WHERE request_key=$1")
            .bind(format!("{id}:{key}"))
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stored).unwrap(),
        json!({"legacy":true})
    );
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM chat_request_inputs WHERE request_key=$1")
            .bind(format!("{id}:{key}"))
            .fetch_one(&repository.pool())
            .await
            .unwrap();
    assert_eq!(count, 0);
    let expired = new_id();
    sqlx::query("INSERT INTO chat_requests(request_key,user_id,created_at)VALUES($1,$2,$3)")
        .bind(format!("{id}:{expired}"))
        .bind(&id)
        .bind(now() - 301)
        .execute(&repository.pool())
        .await
        .unwrap();
    assert!(repository
        .reserve_chat(&id, &expired, "new attempt")
        .await
        .unwrap()
        .is_none());
}

async fn check_conversation_activity(repository: &Repository) {
    let id = user(repository).await;
    let a = repository.create_conversation(&id, "First").await.unwrap();
    let b = repository.create_conversation(&id, "Second").await.unwrap();
    repository
        .save_message(&id, &message(&b.id, "user", "2026-10-28T01:00:00.100Z"))
        .await
        .unwrap();
    repository
        .save_message(&id, &message(&a.id, "user", "2026-10-28T01:00:00.900Z"))
        .await
        .unwrap();
    let conversations = repository.conversations(&id).await.unwrap();
    assert_eq!(conversations[0].id, a.id);
    assert_eq!(conversations[1].id, b.id);
}

async fn all_checks(repository: &Repository) {
    check_memory_titles(repository).await;
    check_task_payloads(repository).await;
    check_chat_payloads(repository).await;
    check_legacy_chat_rows(repository).await;
    check_conversation_activity(repository).await;
}

#[tokio::test]
async fn sqlite_core_request_integrity_and_legacy_rows() {
    all_checks(&Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn existing_sqlite_database_upgrades_without_reinterpreting_cached_requests() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("upgrade.sqlite").display()
    );
    let repository = Repository::connect(&url).await.unwrap();
    let id = user(&repository).await;
    let key = new_id();
    // Simulate the old schema and a completed request before the upgrade.
    sqlx::query("DROP TABLE chat_request_inputs")
        .execute(&repository.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chat_requests(request_key,user_id,response,created_at)VALUES($1,$2,$3,$4)",
    )
    .bind(format!("{id}:{key}"))
    .bind(&id)
    .bind("{}")
    .bind(now())
    .execute(&repository.pool())
    .await
    .unwrap();
    repository.pool().close().await;
    let upgraded = Repository::connect(&url).await.unwrap();
    assert!(matches!(
        upgraded.reserve_chat(&id, &key, "new body").await,
        Err(DomainError::Conflict(_))
    ));
    upgraded.pool().close().await;
    let reopened = Repository::connect(&url).await.unwrap();
    all_checks(&reopened).await;
}

#[tokio::test]
#[ignore = "Requires an isolated tada_qa_e03_* PostgreSQL database; no provider calls"]
async fn postgres_core_request_integrity_and_legacy_rows() {
    let url = std::env::var("TEST_E03_DATABASE_URL").expect("set isolated TEST_E03_DATABASE_URL");
    let name = url.split('?').next().unwrap().rsplit('/').next().unwrap();
    assert!(
        url.starts_with("postgres") && name.starts_with("tada_qa_e03_"),
        "isolated E03 database required"
    );
    let repository = Repository::connect(&url).await.unwrap();
    let id = user(&repository).await;
    let key = new_id();
    // This database name is guarded above and dedicated to this test. Simulate
    // the old deployed schema, then verify connect applies the new migration.
    sqlx::query("DROP TABLE chat_request_inputs")
        .execute(&repository.pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chat_requests(request_key,user_id,response,created_at)VALUES($1,$2,$3,$4)",
    )
    .bind(format!("{id}:{key}"))
    .bind(&id)
    .bind("{}")
    .bind(now())
    .execute(&repository.pool())
    .await
    .unwrap();
    repository.pool().close().await;
    let upgraded = Repository::connect(&url).await.unwrap();
    assert!(matches!(
        upgraded.reserve_chat(&id, &key, "new body").await,
        Err(DomainError::Conflict(_))
    ));
    upgraded.pool().close().await;
    all_checks(&Repository::connect(&url).await.unwrap()).await;
}
