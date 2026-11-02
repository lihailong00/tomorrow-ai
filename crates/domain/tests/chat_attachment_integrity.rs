use serde_json::json;
use tomorrow_domain::{
    new_id, now, timestamp, ChatTurn, Conversation, DomainError, Memory, Message,
    MessageAttachment, Repository, UpdateMemory,
};

async fn user(repo: &Repository) -> String {
    repo.create_user(
        &format!("attachments-{}@example.test", new_id()),
        "test-hash",
        "Attachment QA",
        "Asia/Shanghai",
    )
    .await
    .unwrap()
    .id
}
fn message(conversation: &str, role: &str) -> Message {
    Message {
        id: new_id(),
        conversation_id: conversation.into(),
        role: role.into(),
        content: "Synthetic message".into(),
        created_at: timestamp(now()),
        model_mode: None,
        attachments: Vec::new(),
    }
}
fn turn() -> ChatTurn {
    let conversation = Conversation {
        id: new_id(),
        title: "Attachment QA".into(),
        updated_at: timestamp(now()),
    };
    ChatTurn {
        user_message: message(&conversation.id, "user"),
        assistant_message: message(&conversation.id, "assistant"),
        conversation,
        memory: None,
        request_id: Some(new_id()),
        response: json!({"fixture":true}),
    }
}
async fn insert_memory(repo: &Repository, owner: &str, memory: &Memory) {
    sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'memory',$3,$4,$4)").bind(&memory.id).bind(owner).bind(serde_json::to_string(memory).unwrap()).bind(now()).execute(&repo.pool()).await.unwrap();
}
async fn checks(repo: &Repository) -> (String, String) {
    let owner = user(repo).await;
    let other = user(repo).await;
    let mut attempt = turn();
    let memory = Memory {
        id: new_id(),
        title: "Long legacy memory".into(),
        content: "记".repeat(10031),
        kind: "fact".into(),
        source: "Legacy chat".into(),
        created_at: timestamp(now()),
        updated_at: timestamp(now()),
        version: 1,
        confirmation: None,
    };
    attempt.memory = Some(memory.clone());
    let request_id = attempt.request_id.as_ref().unwrap();
    repo.reserve_chat(&owner, request_id, "memory guard")
        .await
        .unwrap();
    assert!(matches!(
        repo.commit_chat_turn(&owner, &attempt, "memory guard")
            .await,
        Err(DomainError::Validation(_))
    ));
    assert!(repo
        .conversation(&owner, &attempt.conversation.id)
        .await
        .is_err());
    assert!(repo.memories(&owner).await.unwrap().is_empty());
    repo.release_chat(&owner, request_id, "memory guard")
        .await
        .unwrap();

    // Pre-upgrade rows remain editable without silently shortening information.
    insert_memory(repo, &owner, &memory).await;
    let updated = repo
        .update_memory(
            &owner,
            &memory.id,
            UpdateMemory {
                title: Some("Renamed".into()),
                content: Some(memory.content.clone()),
                kind: Some("preference".into()),
                version: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.content, memory.content);
    assert_eq!(updated.title, "Renamed");
    assert!(matches!(
        repo.update_memory(
            &owner,
            &memory.id,
            UpdateMemory {
                title: None,
                content: Some("新".repeat(10001)),
                kind: None,
                version: Some(2)
            }
        )
        .await,
        Err(DomainError::Validation(_))
    ));

    // The automatic agent command uses the same memory size boundary.
    let run = repo
        .begin_agent_run(&owner, &new_id(), "Memory boundary fixture", None, None)
        .await
        .unwrap();
    assert!(matches!(
        repo.execute_agent_tool(
            &run.id,
            &run.token,
            "save_memory",
            json!({"title":"Invalid","content":"x".repeat(10001),"kind":"fact"})
        )
        .await,
        Err(DomainError::Validation(_))
    ));
    let saved = repo
        .execute_agent_tool(
            &run.id,
            &run.token,
            "save_memory",
            json!({"title":"Valid","content":"x".repeat(10000),"kind":"fact"}),
        )
        .await
        .unwrap();
    assert_eq!(saved["value"]["content"].as_str().unwrap().len(), 10000);

    // Message resources from old schemas omit attachments entirely.
    let legacy_conversation = repo
        .create_conversation(&owner, "Legacy messages")
        .await
        .unwrap();
    let old = json!({"id":new_id(),"conversation_id":legacy_conversation.id,"role":"user","content":"Old record","created_at":timestamp(now()),"model_mode":null});
    let decoded: Message = serde_json::from_value(old.clone()).unwrap();
    assert!(decoded.attachments.is_empty());
    sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'message',$3,$4,$4)").bind(&decoded.id).bind(&owner).bind(old.to_string()).bind(now()).execute(&repo.pool()).await.unwrap();
    assert!(repo
        .messages(&owner, &legacy_conversation.id)
        .await
        .unwrap()[0]
        .attachments
        .is_empty());

    // Match the upload metadata schema but never create actual provider/file IO.
    sqlx::query("CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,mime_type TEXT NOT NULL,size BIGINT NOT NULL,created_at TEXT NOT NULL,transcript TEXT,transcript_model TEXT)").execute(&repo.pool()).await.unwrap();
    let upload = new_id();
    sqlx::query("INSERT INTO uploads(id,user_id,name,mime_type,size,created_at)VALUES($1,$2,'project.txt','text/plain',4,$3)").bind(&upload).bind(&owner).bind(timestamp(now())).execute(&repo.pool()).await.unwrap();
    let mut attached = turn();
    attached.user_message.attachments = vec![MessageAttachment {
        upload_id: upload.clone(),
        name: "project.txt".into(),
        mime_type: "text/plain".into(),
        size: 4,
        unavailable: false,
    }];
    let key = attached.request_id.as_ref().unwrap();
    repo.reserve_chat(&owner, key, "attached request")
        .await
        .unwrap();
    repo.commit_chat_turn(&owner, &attached, "attached request")
        .await
        .unwrap();
    let restored = repo
        .messages(&owner, &attached.conversation.id)
        .await
        .unwrap();
    assert_eq!(
        restored
            .iter()
            .find(|message| message.role == "user")
            .unwrap()
            .attachments[0]
            .upload_id,
        upload
    );
    assert_eq!(
        repo.reserve_chat(&owner, key, "attached request")
            .await
            .unwrap(),
        Some(attached.response)
    );

    let mut forbidden = turn();
    forbidden.user_message.attachments = attached.user_message.attachments;
    let key = forbidden.request_id.as_ref().unwrap();
    repo.reserve_chat(&other, key, "foreign upload")
        .await
        .unwrap();
    assert!(matches!(
        repo.commit_chat_turn(&other, &forbidden, "foreign upload")
            .await,
        Err(DomainError::NotFound)
    ));
    assert!(repo
        .conversation(&other, &forbidden.conversation.id)
        .await
        .is_err());
    repo.release_chat(&other, key, "foreign upload")
        .await
        .unwrap();
    (owner, legacy_conversation.id)
}

#[tokio::test]
async fn sqlite_memory_attachment_invariants_and_old_message_compatibility() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!(
        "sqlite:{}",
        directory.path().join("messages.sqlite").display()
    );
    let repo = Repository::connect(&url).await.unwrap();
    let (owner, legacy) = checks(&repo).await;
    repo.pool().close().await;
    // Reopening the existing schema must not require a migration for JSON fields.
    let reopened = Repository::connect(&url).await.unwrap();
    assert!(reopened.messages(&owner, &legacy).await.unwrap()[0]
        .attachments
        .is_empty());
    checks(&reopened).await;
}

#[tokio::test]
#[ignore = "Requires an isolated tada_qa_e03_* PostgreSQL database"]
async fn postgres_memory_attachment_invariants_and_old_message_compatibility() {
    let url = std::env::var("TEST_E03_DATABASE_URL").unwrap();
    let name = url.split('?').next().unwrap().rsplit('/').next().unwrap();
    assert!(url.starts_with("postgres") && name.starts_with("tada_qa_e03_"));
    let repo = Repository::connect(&url).await.unwrap();
    let (owner, legacy) = checks(&repo).await;
    repo.pool().close().await;
    let reopened = Repository::connect(&url).await.unwrap();
    assert!(reopened.messages(&owner, &legacy).await.unwrap()[0]
        .attachments
        .is_empty());
    checks(&reopened).await;
}
