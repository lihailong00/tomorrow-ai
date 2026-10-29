use tomorrow_domain::*;

async fn fixture() -> (Repository, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user("todos-owner@test.invalid", "test", "owner", "Asia/Shanghai")
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user("todos-other@test.invalid", "test", "other", "UTC")
        .await
        .unwrap()
        .id;
    (repo, owner, other)
}
fn create(title: &str, key: Option<&str>) -> CreateTodo {
    CreateTodo {
        title: title.into(),
        description: None,
        kind: None,
        due_at: None,
        estimated_minutes: None,
        client_request_id: key.map(str::to_owned),
    }
}
fn patch(version: i64) -> UpdateTodo {
    UpdateTodo {
        version,
        ..Default::default()
    }
}

#[tokio::test]
async fn personal_todo_crud_versions_owner_and_idempotency() {
    let (repo, owner, other) = fixture().await;
    let todo = repo
        .create_todo(&owner, create("回复客户", Some("create-1")))
        .await
        .unwrap();
    assert_eq!(todo.status, "pending");
    assert_eq!(todo.source_kind, "manual");
    assert!(todo.linked_task_id.is_none());
    assert_eq!(
        repo.create_todo(&owner, create(" 回复客户 ", Some("create-1")))
            .await
            .unwrap()
            .id,
        todo.id
    );
    assert!(matches!(
        repo.create_todo(&owner, create("不同内容", Some("create-1")))
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repo.todo(&other, &todo.id).await,
        Err(DomainError::NotFound)
    ));
    assert!(matches!(
        repo.update_todo(&other, &todo.id, patch(todo.version))
            .await,
        Err(DomainError::NotFound)
    ));
    assert!(repo
        .todos_page(&other, "all", "all", 0, 10)
        .await
        .unwrap()
        .0
        .is_empty());
    let mut edit = patch(todo.version);
    edit.draft = Some(Some("我的草稿".into()));
    edit.status = Some("completed".into());
    let done = repo.update_todo(&owner, &todo.id, edit).await.unwrap();
    assert!(done.completed_at.is_some());
    assert_eq!(done.version, todo.version + 1);
    assert!(matches!(
        repo.update_todo(&owner, &todo.id, patch(todo.version))
            .await,
        Err(DomainError::Conflict(_))
    ));
    let mut reopen = patch(done.version);
    reopen.status = Some("pending".into());
    reopen.draft = Some(None);
    let reopened = repo.update_todo(&owner, &todo.id, reopen).await.unwrap();
    assert!(reopened.completed_at.is_none());
    assert!(reopened.draft.is_none());
    repo.delete_todo(&owner, &todo.id).await.unwrap();
    assert!(matches!(
        repo.create_todo(&owner, create("回复客户", Some("create-1")))
            .await,
        Err(DomainError::Conflict(_))
    ));
    assert!(matches!(
        repo.delete_todo(&other, &todo.id).await,
        Err(DomainError::NotFound)
    ));
}

#[tokio::test]
async fn today_and_status_filtering_happen_before_pagination() {
    let (repo, owner, _) = fixture().await;
    repo.create_todo(&owner, create("无日期", None))
        .await
        .unwrap();
    let mut overdue = create("已过期", None);
    overdue.due_at = Some("2000-01-01T00:00:00Z".into());
    repo.create_todo(&owner, overdue).await.unwrap();
    let mut future = create("未来", None);
    future.due_at = Some("2099-01-01T00:00:00Z".into());
    repo.create_todo(&owner, future).await.unwrap();
    let mut today = create("今天", None);
    today.due_at = Some(chrono::Utc::now().to_rfc3339());
    let today = repo.create_todo(&owner, today).await.unwrap();
    let mut waiting = patch(today.version);
    waiting.status = Some("waiting".into());
    repo.update_todo(&owner, &today.id, waiting).await.unwrap();
    let (page, next) = repo.todos_page(&owner, "all", "today", 0, 2).await.unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(next, Some(2));
    let (tail, next) = repo.todos_page(&owner, "all", "today", 2, 2).await.unwrap();
    assert_eq!(tail.len(), 1);
    assert!(next.is_none());
    assert!(!page.iter().chain(tail.iter()).any(|t| t.title == "未来"));
    assert_eq!(
        repo.todos_page(&owner, "waiting", "today", 0, 10)
            .await
            .unwrap()
            .0
            .len(),
        1
    );
    assert_eq!(
        repo.todos_page(&owner, "active", "today", 0, 10)
            .await
            .unwrap()
            .0
            .len(),
        2
    );
    assert!(repo.todos_page(&owner, "bad", "all", 0, 10).await.is_err());
    assert!(repo.todos_page(&owner, "all", "all", -1, 10).await.is_err());
    assert!(repo.todos_page(&owner, "all", "all", 0, 501).await.is_err());
}

#[tokio::test]
async fn prepare_is_atomic_idempotent_and_never_completes_personal_todo() {
    let (repo, owner, other) = fixture().await;
    let todo = repo
        .create_todo(&owner, create("准备回复客户", None))
        .await
        .unwrap();
    let prepared = repo
        .prepare_todo(
            &owner,
            &todo.id,
            PrepareTodo {
                client_request_id: Some("prep-1".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(prepared.status, "pending");
    let task_id = prepared.linked_task_id.clone().unwrap();
    let task = repo.task(&owner, &task_id).await.unwrap();
    assert_eq!(task.kind, "todo_prepare");
    assert_eq!(task.status, "queued");
    let again = repo
        .prepare_todo(
            &owner,
            &todo.id,
            PrepareTodo {
                client_request_id: Some("prep-1".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(again.linked_task_id.as_deref(), Some(task_id.as_str()));
    repo.prepare_todo(
        &owner,
        &todo.id,
        PrepareTodo {
            client_request_id: Some("prep-2".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(repo.tasks(&owner).await.unwrap().len(), 1);
    assert!(matches!(
        repo.prepare_todo(&other, &todo.id, PrepareTodo::default())
            .await,
        Err(DomainError::NotFound)
    ));
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    assert!(repo
        .complete_task(&claim, "AI 准备草稿", "llm")
        .await
        .unwrap());
    let hydrated = repo.todo(&owner, &todo.id).await.unwrap();
    assert_eq!(hydrated.draft.as_deref(), Some("AI 准备草稿"));
    assert_eq!(hydrated.status, "pending");
    assert!(hydrated.completed_at.is_none());
    let version = hydrated.version;
    assert_eq!(repo.todo(&owner, &todo.id).await.unwrap().version, version);
    repo.prepare_todo(
        &owner,
        &todo.id,
        PrepareTodo {
            client_request_id: Some("prep-1".into()),
        },
    )
    .await
    .unwrap();
    assert_eq!(repo.tasks(&owner).await.unwrap().len(), 1);
}

#[tokio::test]
async fn late_preparation_never_overwrites_user_edits_and_failure_preserves_todo() {
    let (repo, owner, _) = fixture().await;
    let todo = repo
        .create_todo(&owner, create("学习Rust", None))
        .await
        .unwrap();
    let prepared = repo
        .prepare_todo(&owner, &todo.id, PrepareTodo::default())
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    let mut update = patch(prepared.version);
    update.draft = Some(Some("我自己修改的学习计划".into()));
    let edited = repo.update_todo(&owner, &todo.id, update).await.unwrap();
    repo.complete_task(&claim, "过时AI草稿", "llm")
        .await
        .unwrap();
    let final_todo = repo.todo(&owner, &todo.id).await.unwrap();
    assert_eq!(final_todo.draft, edited.draft);
    assert_eq!(final_todo.version, edited.version);
    let prepared = repo
        .prepare_todo(&owner, &todo.id, PrepareTodo::default())
        .await
        .unwrap();
    let claim = repo.claim_task(90).await.unwrap().unwrap();
    repo.fail_task(&claim, "模型暂时不可用", false)
        .await
        .unwrap();
    let failed = repo.todo(&owner, &todo.id).await.unwrap();
    assert_eq!(failed.status, "pending");
    assert_eq!(failed.draft, edited.draft);
    assert_eq!(failed.progress_notes.as_deref(), Some("模型暂时不可用"));
    assert!(failed.version > prepared.version);
}

#[tokio::test]
async fn invalid_fields_and_missing_models_leave_source_and_todos_unchanged() {
    let (repo, owner, other) = fixture().await;
    for input in [
        CreateTodo {
            due_at: Some("tomorrow".into()),
            ..create("x", None)
        },
        CreateTodo {
            estimated_minutes: Some(0),
            ..create("x", None)
        },
        create(" ", None),
    ] {
        assert!(matches!(
            repo.create_todo(&owner, input).await,
            Err(DomainError::Validation(_))
        ));
    }
    let conversation = repo.create_conversation(&owner, "目标").await.unwrap();
    let input = || ExtractTodos {
        source_kind: "conversation".into(),
        source_id: conversation.id.clone(),
        client_request_id: None,
    };
    assert!(matches!(
        repo.extract_todos(&other, input(), &ModelProvider::local())
            .await,
        Err(DomainError::NotFound)
    ));
    assert!(matches!(
        repo.extract_todos(&owner, input(), &ModelProvider::local())
            .await,
        Err(DomainError::Unavailable(_))
    ));
    assert!(repo.conversation(&owner, &conversation.id).await.is_ok());
    assert!(repo
        .todos_page(&owner, "all", "all", 0, 10)
        .await
        .unwrap()
        .0
        .is_empty());
}
