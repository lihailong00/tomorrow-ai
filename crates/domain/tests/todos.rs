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
    assert!(failed.progress_notes.is_none());
    assert_eq!(
        repo.task(&owner, failed.linked_task_id.as_deref().unwrap())
            .await
            .unwrap()
            .error
            .as_deref(),
        Some("模型暂时不可用")
    );
    assert!(failed.version > prepared.version);
}

#[tokio::test]
async fn progress_and_status_edits_preserve_pending_preparation_and_user_notes() {
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
    let mut notes = patch(prepared.version);
    notes.progress_notes = Some(Some("已经读完第一节，借用还需要练习".into()));
    let noted = repo.update_todo(&owner, &todo.id, notes).await.unwrap();
    let mut status = patch(noted.version);
    status.status = Some("in_progress".into());
    // Resubmitting unchanged generation inputs must also preserve the guard.
    status.title = Some(noted.title.clone());
    let edited = repo.update_todo(&owner, &todo.id, status).await.unwrap();
    repo.complete_task(&claim, "所有权解释与练习草稿", "llm")
        .await
        .unwrap();
    let saved = repo.todo(&owner, &todo.id).await.unwrap();
    assert_eq!(saved.draft.as_deref(), Some("所有权解释与练习草稿"));
    assert_eq!(saved.progress_notes, edited.progress_notes);
    assert_eq!(saved.status, "in_progress");
    assert!(saved.completed_at.is_none());
    assert_eq!(saved.version, edited.version + 1);
    assert_eq!(
        repo.todo(&owner, &todo.id).await.unwrap().version,
        saved.version
    );
}

#[tokio::test]
async fn generation_input_edits_still_fence_stale_results_after_later_notes_edits() {
    let (repo, owner, _) = fixture().await;
    for field in [
        "title",
        "description",
        "kind",
        "due_at",
        "estimated_minutes",
        "draft",
    ] {
        let todo = repo
            .create_todo(&owner, create("学习Rust", None))
            .await
            .unwrap();
        let prepared = repo
            .prepare_todo(&owner, &todo.id, PrepareTodo::default())
            .await
            .unwrap();
        let claim = repo.claim_task(90).await.unwrap().unwrap();
        let mut edit = patch(prepared.version);
        match field {
            "title" => edit.title = Some("学习Python".into()),
            "description" => edit.description = Some("只练习异步函数".into()),
            "kind" => edit.kind = Some("learning".into()),
            "due_at" => edit.due_at = Some(Some("2030-01-01T00:00:00Z".into())),
            "estimated_minutes" => edit.estimated_minutes = Some(Some(30)),
            "draft" => edit.draft = Some(None),
            _ => unreachable!(),
        }
        let edited = repo.update_todo(&owner, &todo.id, edit).await.unwrap();
        let mut notes = patch(edited.version);
        notes.progress_notes = Some(Some("保留我写的笔记".into()));
        let noted = repo.update_todo(&owner, &todo.id, notes).await.unwrap();
        repo.complete_task(&claim, "旧输入的过时草稿", "llm")
            .await
            .unwrap();
        let saved = repo.todo(&owner, &todo.id).await.unwrap();
        assert!(saved.draft.is_none(), "{field}");
        assert_eq!(saved.progress_notes, noted.progress_notes, "{field}");
        assert_eq!(saved.version, noted.version, "{field}");
    }
}

#[tokio::test]
async fn failed_cancelled_and_uncertain_preparations_never_overwrite_user_notes() {
    let (repo, owner, _) = fixture().await;
    for terminal in ["failed", "cancelled", "uncertain"] {
        let todo = repo
            .create_todo(&owner, create("学习Rust", None))
            .await
            .unwrap();
        let mut notes = patch(todo.version);
        notes.progress_notes = Some(Some("我的学习记录，不能变成系统错误".into()));
        let noted = repo.update_todo(&owner, &todo.id, notes).await.unwrap();
        let prepared = repo
            .prepare_todo(&owner, &todo.id, PrepareTodo::default())
            .await
            .unwrap();
        let claim = repo.claim_task(90).await.unwrap().unwrap();
        match terminal {
            "failed" => {
                repo.fail_task(&claim, "模型失败", false).await.unwrap();
            }
            "cancelled" => {
                repo.cancel_task(&owner, &claim.task.id).await.unwrap();
            }
            "uncertain" => {
                sqlx::query("UPDATE tasks SET status='uncertain',error='执行结果尚不确定' WHERE user_id=$1 AND id=$2")
                    .bind(&owner).bind(&claim.task.id).execute(&repo.pool()).await.unwrap();
            }
            _ => unreachable!(),
        }
        let saved = repo.todo(&owner, &todo.id).await.unwrap();
        assert_eq!(saved.progress_notes, noted.progress_notes, "{terminal}");
        assert!(saved.draft.is_none(), "{terminal}");
        assert_eq!(saved.status, "pending", "{terminal}");
        assert_eq!(saved.linked_task_id, prepared.linked_task_id, "{terminal}");
        assert_eq!(
            repo.task(&owner, saved.linked_task_id.as_deref().unwrap())
                .await
                .unwrap()
                .status,
            terminal
        );
        assert_eq!(
            repo.todo(&owner, &todo.id).await.unwrap().version,
            saved.version,
            "{terminal}"
        );
    }
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
