use serde_json::json;
use tomorrow_domain::{
    new_id, now, timestamp, ChatTurn, Conversation, DomainError, Message, Repository,
};

async fn retry_fences(repo: Repository) {
    let owner = repo
        .create_user(
            &format!("stream-fences-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let request = new_id();
    let fingerprint = "unchanged synthetic input";
    let first = repo
        .begin_chat_stream(&owner.id, &request, fingerprint)
        .await
        .unwrap()
        .unwrap();
    let run_key = format!("chat:{request}");
    let old_run = repo
        .begin_agent_run(&owner.id, &run_key, fingerprint, None, None)
        .await
        .unwrap();
    let conversation = Conversation {
        id: new_id(),
        title: "Synthetic".into(),
        updated_at: timestamp(now()),
    };
    let user_message = Message {
        id: new_id(),
        conversation_id: conversation.id.clone(),
        role: "user".into(),
        content: "Synthetic input".into(),
        created_at: timestamp(now()),
        model_mode: None,
        attachments: vec![],
    };
    let assistant_id = new_id();
    repo.accept_chat_stream(
        &first,
        &owner.id,
        &conversation,
        &user_message,
        &assistant_id,
        &timestamp(now()),
        Some(&old_run.id),
    )
    .await
    .unwrap();
    repo.record_agent_event(
        &old_run.id,
        &old_run.token,
        1,
        "text_delta",
        &json!({"turn":1,"delta":"旧片段"}),
    )
    .await
    .unwrap();
    let arguments = json!({"title":"Exactly one task","instruction":"Synthetic"});
    let effect = repo
        .execute_agent_tool_with_slot(
            &old_run.id,
            &old_run.token,
            "create_task",
            arguments.clone(),
            Some(1),
            Some(1),
        )
        .await
        .unwrap();
    // A process restart cannot run Drop. Expiring only the durable stream lease
    // simulates this while the stale Agent capability is still otherwise alive.
    sqlx::query("UPDATE chat_streams SET lease_until=0 WHERE request_key=$1")
        .bind(&first.request_key)
        .execute(&repo.pool())
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        repo.begin_chat_stream_retry(&owner.id, &request, fingerprint, true),
        repo.begin_chat_stream_retry(&owner.id, &request, fingerprint, true)
    );
    let mut producers = vec![a.unwrap(), b.unwrap()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(
        producers.len(),
        1,
        "only one explicit retry may acquire the new producer"
    );
    let retry = producers.pop().unwrap();
    assert!(repo
        .agent_authority(&old_run.id, &old_run.token)
        .await
        .is_err());
    assert!(repo
        .append_chat_stream_delta(&first, "stale".into())
        .await
        .is_err());
    repo.interrupt_chat_stream(&first, "stale drop must not cancel replacement")
        .await
        .unwrap();
    let resumed = repo.chat_stream(&owner.id, &request).await.unwrap();
    assert_eq!(resumed.status, "running");
    assert_eq!(resumed.attempt, 2);
    assert_eq!(resumed.content, "旧片段");
    assert_eq!(resumed.previous_content.as_deref(), Some("旧片段"));
    assert_eq!(retry.accepted.as_ref().unwrap()["message_id"], assistant_id);
    assert_eq!(
        retry.accepted.as_ref().unwrap()["user_message"]["id"],
        user_message.id
    );
    let new_run = repo
        .begin_agent_run(
            &owner.id,
            &run_key,
            fingerprint,
            Some(&conversation.id),
            None,
        )
        .await
        .unwrap();
    assert_eq!(old_run.id, new_run.id);
    let replay = repo
        .execute_agent_tool_with_slot(
            &new_run.id,
            &new_run.token,
            "create_task",
            arguments,
            Some(1),
            Some(1),
        )
        .await
        .unwrap();
    assert_eq!(replay["value"], effect["value"]);
    assert_eq!(replay["replayed"], true);
    assert_eq!(repo.tasks(&owner.id).await.unwrap().len(), 1);
    assert!(matches!(
        repo.execute_agent_tool_with_slot(
            &new_run.id,
            &new_run.token,
            "create_task",
            json!({"title":"Changed","instruction":"Different"}),
            Some(1),
            Some(1)
        )
        .await,
        Err(DomainError::AgentReplayConflict)
    ));
    // Old operation indices remain per tool; opted-in slots bind global order.
    let memory_args = json!({"title":"Independent tool","content":"Synthetic","kind":"fact"});
    assert!(matches!(
        repo.execute_agent_tool_with_slot(
            &new_run.id,
            &new_run.token,
            "save_memory",
            memory_args.clone(),
            Some(1),
            Some(1)
        )
        .await,
        Err(DomainError::AgentReplayConflict)
    ));
    assert!(matches!(
        repo.execute_agent_tool_at(
            &new_run.id,
            &new_run.token,
            "save_memory",
            memory_args.clone(),
            Some(1)
        )
        .await,
        Err(DomainError::Validation(_))
    ));
    repo.execute_agent_tool_with_slot(
        &new_run.id,
        &new_run.token,
        "save_memory",
        memory_args.clone(),
        Some(1),
        Some(2),
    )
    .await
    .unwrap();
    let memory_replay = repo
        .execute_agent_tool_with_slot(
            &new_run.id,
            &new_run.token,
            "save_memory",
            memory_args,
            Some(1),
            Some(2),
        )
        .await
        .unwrap();
    assert_eq!(memory_replay["replayed"], true);
    assert_eq!(repo.memories(&owner.id).await.unwrap().len(), 1);
    let assistant = Message {
        id: assistant_id,
        conversation_id: conversation.id.clone(),
        role: "assistant".into(),
        content: "stale final".into(),
        created_at: timestamp(now()),
        model_mode: Some("llm".into()),
        attachments: vec![],
    };
    let stale_turn = ChatTurn {
        conversation: conversation.clone(),
        user_message: user_message.clone(),
        assistant_message: assistant,
        memory: None,
        request_id: Some(request.clone()),
        response: json!({"message":{"content":"stale final"}}),
    };
    assert!(repo
        .commit_chat_turn_attempt(&owner.id, &stale_turn, fingerprint, &first.attempt_token)
        .await
        .is_err());
    assert_eq!(
        repo.messages(&owner.id, &conversation.id)
            .await
            .unwrap()
            .len(),
        1
    );
    let sequence = repo.next_agent_sequence(&new_run.id).await.unwrap();
    repo.record_agent_event(
        &new_run.id,
        &new_run.token,
        sequence,
        "text_delta",
        &json!({"turn":1,"delta":"新片段"}),
    )
    .await
    .unwrap();
    let view = repo.chat_stream(&owner.id, &request).await.unwrap();
    assert_eq!(view.content, "新片段");
    assert_eq!(view.previous_content.as_deref(), Some("旧片段"));
    let events = repo
        .chat_stream_events(&owner.id, &request, resumed.sequence, view.sequence)
        .await
        .unwrap();
    assert_eq!(events.last().unwrap().body["replace"], true);
}

#[tokio::test]
async fn sqlite_restart_explicit_retry_reuses_effects_and_fences_stale_producer() {
    retry_fences(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn postgres_restart_explicit_retry_reuses_effects_and_fences_stale_producer() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    if !url.starts_with("postgres") {
        return;
    }
    retry_fences(Repository::connect(&url).await.unwrap()).await;
}

#[tokio::test]
async fn task_attempt_budget_stays_500_and_rejects_chat_text_callbacks() {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user(
            &format!("task-budget-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let task = repo
        .create_task(
            &owner.id,
            tomorrow_domain::CreateTask {
                instruction: "Synthetic".into(),
                title: None,
                kind: None,
                approval_required: Some(false),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    sqlx::query(
        "UPDATE tasks SET status='running',attempts=1,claimed_until=$1 WHERE id=$2 AND user_id=$3",
    )
    .bind(now() + 150)
    .bind(&task.id)
    .bind(&owner.id)
    .execute(&repo.pool())
    .await
    .unwrap();
    let run = repo
        .begin_agent_run(
            &owner.id,
            "task-budget",
            "synthetic",
            None,
            Some((&task.id, 1)),
        )
        .await
        .unwrap();
    for sequence in 1..=500 {
        repo.record_agent_event(&run.id, &run.token, sequence, "turn", &json!({}))
            .await
            .unwrap();
    }
    assert!(matches!(
        repo.record_agent_event(&run.id, &run.token, 501, "turn", &json!({}))
            .await,
        Err(DomainError::Validation(_))
    ));
    assert!(matches!(
        repo.record_agent_event(
            &run.id,
            &run.token,
            501,
            "text_delta",
            &json!({"turn":1,"delta":"not task output"})
        )
        .await,
        Err(DomainError::Validation(_))
    ));
}

async fn slot_upgrade_and_holes(repo: Repository) {
    let owner = repo
        .create_user(
            &format!("slot-upgrade-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let old_request = new_id();
    let old_key = format!("chat:{old_request}");
    let old = repo
        .begin_agent_run(&owner.id, &old_key, "legacy", None, None)
        .await
        .unwrap();
    repo.execute_agent_tool_at(
        &old.id,
        &old.token,
        "create_task",
        json!({"title":"Legacy task","instruction":"Synthetic"}),
        Some(1),
    )
    .await
    .unwrap();
    repo.finish_agent_run(&old, None, Some("synthetic failure"))
        .await
        .unwrap();
    let legacy_stream = repo
        .begin_chat_stream(&owner.id, &old_request, "legacy")
        .await
        .unwrap()
        .unwrap();
    let conversation = Conversation {
        id: new_id(),
        title: "Synthetic".into(),
        updated_at: timestamp(now()),
    };
    let message = Message {
        id: new_id(),
        conversation_id: conversation.id.clone(),
        role: "user".into(),
        content: "Synthetic".into(),
        created_at: timestamp(now()),
        model_mode: None,
        attachments: vec![],
    };
    assert!(matches!(
        repo.accept_chat_stream(
            &legacy_stream,
            &owner.id,
            &conversation,
            &message,
            &new_id(),
            &timestamp(now()),
            Some(&old.id)
        )
        .await,
        Err(DomainError::AgentReplayConflict)
    ));
    assert!(!repo.agent_operation_slots_enabled(&old.id).await.unwrap());
    assert_eq!(repo.tasks(&owner.id).await.unwrap().len(), 1);

    let request = new_id();
    let key = format!("chat:{request}");
    let stream = repo
        .begin_chat_stream(&owner.id, &request, "ordered")
        .await
        .unwrap()
        .unwrap();
    let run = repo
        .begin_agent_run(&owner.id, &key, "ordered", None, None)
        .await
        .unwrap();
    repo.accept_chat_stream(
        &stream,
        &owner.id,
        &conversation,
        &message,
        &new_id(),
        &timestamp(now()),
        Some(&run.id),
    )
    .await
    .unwrap();
    assert!(matches!(
        repo.execute_agent_tool_with_slot(
            &run.id,
            &run.token,
            "create_task",
            json!({"title":"Invalid","instruction":""}),
            Some(1),
            Some(1)
        )
        .await,
        Err(DomainError::Validation(_))
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_operation_slots WHERE run_id=$1")
            .bind(&run.id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    assert_eq!(
        count, 0,
        "failed effect and slot receipt must roll back together"
    );
    let args = json!({"title":"Second ordinal","instruction":"Synthetic"});
    repo.execute_agent_tool_with_slot(
        &run.id,
        &run.token,
        "create_task",
        args.clone(),
        Some(2),
        Some(2),
    )
    .await
    .unwrap();
    repo.interrupt_chat_stream(&stream, "synthetic interruption")
        .await
        .unwrap();
    let retry = repo
        .begin_chat_stream_retry(&owner.id, &request, "ordered", true)
        .await
        .unwrap()
        .unwrap();
    let new_run = repo
        .begin_agent_run(&owner.id, &key, "ordered", None, None)
        .await
        .unwrap();
    assert!(matches!(repo.execute_agent_tool_with_slot(&new_run.id,&new_run.token,"save_memory",json!({"title":"Changed first ordinal","content":"Would duplicate a later effect","kind":"fact"}),Some(1),Some(1)).await,Err(DomainError::AgentReplayConflict)));
    assert!(repo.memories(&owner.id).await.unwrap().is_empty());
    assert_eq!(
        repo.execute_agent_tool_with_slot(
            &new_run.id,
            &new_run.token,
            "create_task",
            args,
            Some(2),
            Some(2)
        )
        .await
        .unwrap()["replayed"],
        true
    );
    assert_eq!(
        repo.tasks(&owner.id).await.unwrap().len(),
        2,
        "one legacy task and one new task"
    );
    repo.interrupt_chat_stream(&retry, "test complete")
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_slot_upgrade_fails_closed_and_retry_cannot_fill_failed_ordinal_hole() {
    slot_upgrade_and_holes(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn postgres_slot_upgrade_fails_closed_and_retry_cannot_fill_failed_ordinal_hole() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    if !url.starts_with("postgres") {
        return;
    }
    slot_upgrade_and_holes(Repository::connect(&url).await.unwrap()).await;
}

#[tokio::test]
async fn postgres_retry_cannot_reuse_acceptance_metadata_read_before_a_blocked_cas() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL") else {
        return;
    };
    if !url.starts_with("postgres") {
        return;
    }
    let repo = Repository::connect(&url).await.unwrap();
    let owner = repo
        .create_user(
            &format!("accept-race-{}@example.test", new_id()),
            "unused",
            "QA",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let request = new_id();
    let first = repo
        .begin_chat_stream(&owner.id, &request, "same")
        .await
        .unwrap()
        .unwrap();
    let run = repo
        .begin_agent_run(&owner.id, &format!("chat:{request}"), "same", None, None)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_streams SET lease_until=0 WHERE request_key=$1")
        .bind(&first.request_key)
        .execute(&repo.pool())
        .await
        .unwrap();
    let accepted = json!({"conversation_id":new_id(),"message_id":new_id(),"message_created_at":timestamp(now()),"user_message":{"id":new_id(),"created_at":timestamp(now())},"agent_run_id":run.id});
    let pool = repo.pool();
    let mut publication = pool.begin().await.unwrap();
    sqlx::query("UPDATE chat_streams SET accepted=$1,agent_run_id=$2 WHERE request_key=$3")
        .bind(accepted.to_string())
        .bind(&run.id)
        .bind(&first.request_key)
        .execute(&mut *publication)
        .await
        .unwrap();
    let retry_repo = repo.clone();
    let retry_owner = owner.id.clone();
    let retry_request = request.clone();
    let retry = tokio::spawn(async move {
        retry_repo
            .begin_chat_stream_retry(&retry_owner, &retry_request, "same", true)
            .await
    });
    let mut blocked = false;
    for _ in 0..100 {
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE 'UPDATE chat_streams SET attempt_token=%'")
            .fetch_one(&pool).await.unwrap();
        if count > 0 {
            blocked = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        blocked,
        "fixture must suspend retry after its stale metadata read"
    );
    publication.commit().await.unwrap();
    assert!(
        matches!(retry.await.unwrap(), Err(DomainError::Conflict(_))),
        "newly published run identity must fail closed and release all locks"
    );
    let current = repo.chat_stream(&owner.id, &request).await.unwrap();
    assert_eq!(current.accepted.as_ref(), Some(&accepted));
    assert_eq!(current.attempt, 1);
    let reacquired = repo
        .begin_chat_stream_retry(&owner.id, &request, "same", true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reacquired.accepted,
        Some(accepted),
        "a subsequent acquisition uses the authoritative persisted IDs"
    );
}
