use super::*;

struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        if let Ok(path) = std::fs::canonicalize(&self.0) {
            if path.parent() == Some(root.as_path())
                && path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("tada-e03-context-")
            {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
}
async fn fixture() -> (AttachmentsState, TestDirectory, String, String) {
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("tada-e03-context-{}", uuid::Uuid::new_v4())),
    );
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user(
            "context-a@example.test",
            "unused",
            "Context A",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user(
            "context-b@example.test",
            "unused",
            "Context B",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let state = AttachmentsState::initialize(repo, directory.0.clone(), DEFAULT_MAX_BYTES, None)
        .await
        .unwrap();
    (state, directory, owner, other)
}
async fn file(state: &AttachmentsState, owner: &str, name: &str, text: &str) -> String {
    let id = tomorrow_domain::new_id();
    tokio::fs::write(state.path(&id).unwrap(), text)
        .await
        .unwrap();
    sqlx::query("INSERT INTO uploads(id,user_id,name,mime_type,size,created_at)VALUES($1,$2,$3,'text/plain',$4,$5)")
        .bind(&id).bind(owner).bind(name).bind(text.len() as i64).bind(tomorrow_domain::timestamp(tomorrow_domain::now())).execute(&state.pool).await.unwrap();
    id
}
fn message(attachment: MessageAttachment) -> Message {
    Message {
        id: tomorrow_domain::new_id(),
        conversation_id: "fixture".into(),
        role: "user".into(),
        content: "File reference".into(),
        created_at: tomorrow_domain::timestamp(tomorrow_domain::now()),
        model_mode: None,
        attachments: vec![attachment],
    }
}

#[tokio::test]
async fn attachment_history_deduplicates_recent_first_and_signals_count_budget() {
    let (state, _directory, owner, _) = fixture().await;
    let mut ids = Vec::new();
    let mut history = Vec::new();
    for number in 0..12 {
        let id = file(
            &state,
            &owner,
            &format!("project-{number}.txt"),
            &format!("SOURCE_{number}_MARKER"),
        )
        .await;
        history.push(message(
            state
                .message_attachments(&owner, &[id.clone()])
                .await
                .unwrap()
                .remove(0),
        ));
        ids.push(id);
    }
    let current = vec![ids[11].clone(), ids[11].clone()];
    assert_eq!(
        state
            .message_attachments(&owner, &current)
            .await
            .unwrap()
            .len(),
        1
    );
    let context = state
        .conversation_chat_context(&owner, &current, &history)
        .await
        .unwrap();
    assert_eq!(context.matches("SOURCE_11_MARKER").count(), 1);
    assert!(context.contains("SOURCE_1_MARKER"));
    assert!(!context.contains("SOURCE_0_MARKER"));
    assert!(context.contains("部分较早资料未载入"));
    assert!(context.find("SOURCE_10_MARKER").unwrap() < context.find("SOURCE_1_MARKER").unwrap());
    assert!(context.len() <= MAX_CONTEXT_BYTES);
}

#[tokio::test]
async fn historical_context_respects_bytes_and_current_uploads_never_silently_truncate() {
    let (state, _directory, owner, _) = fixture().await;
    let mut history = Vec::new();
    let mut ids = Vec::new();
    for number in 0..3 {
        let text = format!("LARGE_SOURCE_{number}_{}", "x".repeat(64000));
        let id = file(&state, &owner, &format!("large-{number}.txt"), &text).await;
        history.push(message(
            state
                .message_attachments(&owner, &[id.clone()])
                .await
                .unwrap()
                .remove(0),
        ));
        ids.push(id);
    }
    let context = state
        .conversation_chat_context(&owner, &[], &history)
        .await
        .unwrap();
    assert!(context.contains("LARGE_SOURCE_2_"));
    assert!(!context.contains("LARGE_SOURCE_0_"));
    assert!(context.contains("部分较早资料未载入"));
    assert!(context.len() <= MAX_CONTEXT_BYTES);
    assert!(state
        .conversation_chat_context(&owner, &ids, &[])
        .await
        .is_err());
}

#[tokio::test]
async fn deleted_and_foreign_uploads_are_unavailable_without_reading_their_text() {
    let (state, _directory, owner, other) = fixture().await;
    let id = file(&state, &owner, "deleted-note.txt", "DELETED_SECRET_MARKER").await;
    let mut history = vec![message(
        state
            .message_attachments(&owner, &[id.clone()])
            .await
            .unwrap()
            .remove(0),
    )];
    sqlx::query("DELETE FROM uploads WHERE id=$1 AND user_id=$2")
        .bind(&id)
        .bind(&owner)
        .execute(&state.pool)
        .await
        .unwrap();
    state
        .refresh_message_attachments(&owner, &mut history)
        .await
        .unwrap();
    assert!(history[0].attachments[0].unavailable);
    assert_eq!(history[0].attachments[0].name, "deleted-note.txt");
    let context = state
        .conversation_chat_context(&owner, &[], &history)
        .await
        .unwrap();
    assert!(!context.contains("DELETED_SECRET_MARKER"));
    assert!(context.contains("unavailable="));
    let foreign = file(
        &state,
        &other,
        "foreign-private-name.txt",
        "FOREIGN_SECRET_MARKER",
    )
    .await;
    assert_eq!(
        state
            .message_attachments(&owner, &[foreign.clone()])
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    history[0].attachments[0].upload_id = foreign;
    let context = state
        .conversation_chat_context(&owner, &[], &history)
        .await
        .unwrap();
    assert!(!context.contains("FOREIGN_SECRET_MARKER"));
    assert!(!context.contains("foreign-private-name"));
}

async fn refresh_metadata_batch_contract(database_url: &str) {
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("tada-e03-context-{}", uuid::Uuid::new_v4())),
    );
    let repo = Repository::connect(database_url).await.unwrap();
    let suffix = uuid::Uuid::new_v4();
    let owner = repo
        .create_user(&format!("batch-owner-{suffix}@example.test"), "unused", "Owner", "UTC")
        .await.unwrap().id;
    let other = repo
        .create_user(&format!("batch-other-{suffix}@example.test"), "unused", "Other", "UTC")
        .await.unwrap().id;
    let state = AttachmentsState::initialize(repo, directory.0.clone(), DEFAULT_MAX_BYTES, None)
        .await.unwrap();
    let mut history = Vec::new();
    for number in 0..205 {
        let name = format!("current-{number}.txt");
        let id = file(&state, &owner, &name, "source").await;
        history.push(message(MessageAttachment {
            upload_id: id,
            name: "stale.txt".into(),
            mime_type: "application/stale".into(),
            size: 999,
            unavailable: true,
        }));
    }
    let foreign = file(&state, &other, "foreign-private-name.txt", "private").await;
    for id in [foreign, tomorrow_domain::new_id(), "x') OR 1=1 --".into()] {
        history.push(message(MessageAttachment {
            upload_id: id,
            name: "saved-provenance.txt".into(),
            mime_type: "text/saved".into(),
            size: 42,
            unavailable: false,
        }));
    }
    history.push(history[0].clone());
    state.refresh_message_attachments(&owner, &mut history).await.unwrap();
    for (number, message) in history[..205].iter().enumerate() {
        let item = &message.attachments[0];
        assert_eq!(item.name, format!("current-{number}.txt"));
        assert_eq!(item.mime_type, "text/plain");
        assert_eq!(item.size, 6);
        assert!(!item.unavailable);
    }
    for message in &history[205..208] {
        let item = &message.attachments[0];
        assert!(item.unavailable);
        assert_eq!(item.name, "saved-provenance.txt");
        assert_eq!(item.mime_type, "text/saved");
        assert_eq!(item.size, 42);
    }
    assert_eq!(history[208].attachments[0].name, "current-0.txt");
    assert!(!history[208].attachments[0].unavailable);
    state.refresh_message_attachments(&owner, &mut []).await.unwrap();
}

#[tokio::test]
async fn metadata_refresh_batches_preserve_ownership_and_provenance_sqlite() {
    refresh_metadata_batch_contract("sqlite::memory:").await;
}

#[tokio::test]
#[ignore = "requires TADA_ATTACHMENT_TEST_DATABASE_URL pointing to an isolated PostgreSQL database"]
async fn metadata_refresh_batches_preserve_ownership_and_provenance_postgres() {
    let url = std::env::var("TADA_ATTACHMENT_TEST_DATABASE_URL").unwrap();
    assert!(url.starts_with("postgres://") || url.starts_with("postgresql://"));
    refresh_metadata_batch_contract(&url).await;
}
