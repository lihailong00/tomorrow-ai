use serde_json::json;
use tomorrow_domain::{new_id, now, timestamp, ChatTurn, Conversation, Message, Repository};

fn message(conversation: &Conversation, role: &str, text: &str) -> Message {
    Message {
        id: new_id(),
        conversation_id: conversation.id.clone(),
        role: role.into(),
        content: text.into(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        model_mode: None,
        attachments: vec![],
    }
}
fn turn(conversation: Conversation, user: Message, assistant: Message, request: &str) -> ChatTurn {
    ChatTurn {
        conversation: conversation.clone(),
        user_message: user.clone(),
        assistant_message: assistant.clone(),
        memory: None,
        request_id: Some(request.into()),
        response: json!({"conversation_id":conversation.id,"user_message":user,"message":assistant}),
    }
}
async fn fixture() -> (Repository, String, ChatTurn) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let user = repo
        .create_user("mutations@example.test", "hash", "QA", "Asia/Shanghai")
        .await
        .unwrap();
    let conversation = Conversation {
        id: new_id(),
        title: "QA".into(),
        updated_at: timestamp(now()),
    };
    let first = turn(
        conversation.clone(),
        message(&conversation, "user", "Original"),
        message(&conversation, "assistant", "Old answer"),
        "first",
    );
    let mut reservation = repo
        .reserve_chat_owned(&user.id, "first", "original")
        .await
        .unwrap();
    repo.commit_chat_turn_attempt(&user.id, &first, "original", reservation.attempt_token())
        .await
        .unwrap();
    reservation.committed();
    (repo, user.id, first)
}
#[tokio::test]
async fn failed_edit_and_stream_acceptance_keep_original_durable_until_success() {
    let (repo, user, first) = fixture().await;
    let target = repo
        .chat_replacement(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    let producer = repo
        .begin_chat_stream(&user, "edit", "edit-fingerprint")
        .await
        .unwrap()
        .unwrap();
    let mut edited = first.user_message.clone();
    edited.content = "Edited".into();
    let assistant = message(&first.conversation, "assistant", "New answer");
    repo.accept_chat_stream_replacing(
        &producer,
        &user,
        &first.conversation,
        &edited,
        &assistant.id,
        &assistant.created_at,
        None,
        Some(&target),
    )
    .await
    .unwrap();
    let original = repo.messages(&user, &first.conversation.id).await.unwrap();
    assert_eq!(original.len(), 2);
    assert_eq!(original[0].content, "Original");
    assert_eq!(original[1].content, "Old answer");
    let edit = turn(first.conversation.clone(), edited, assistant, "edit");
    assert!(repo
        .commit_chat_turn_replacing(
            &user,
            &edit,
            "wrong-fingerprint",
            &producer.attempt_token,
            Some(&target)
        )
        .await
        .is_err());
    assert_eq!(
        repo.messages(&user, &first.conversation.id).await.unwrap()[0].content,
        "Original"
    );
    assert!(
        repo.reserve_chat_owned(&user, "first", "original")
            .await
            .unwrap()
            .cached
            .is_some(),
        "rollback must retain original replay too"
    );
    repo.commit_chat_turn_replacing(
        &user,
        &edit,
        "edit-fingerprint",
        &producer.attempt_token,
        Some(&target),
    )
    .await
    .unwrap();
    let messages = repo.messages(&user, &first.conversation.id).await.unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "Edited");
    assert!(repo
        .reserve_chat_owned(&user, "first", "original")
        .await
        .is_err());
}
#[tokio::test]
async fn deleting_during_edit_revokes_producer_and_prevents_resurrection() {
    let (repo, user, first) = fixture().await;
    let target = repo
        .chat_replacement(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    let producer = repo
        .begin_chat_stream(&user, "edit", "edit")
        .await
        .unwrap()
        .unwrap();
    let mut edited = first.user_message.clone();
    edited.content = "Edited".into();
    let assistant = message(&first.conversation, "assistant", "New");
    repo.accept_chat_stream_replacing(
        &producer,
        &user,
        &first.conversation,
        &edited,
        &assistant.id,
        &assistant.created_at,
        None,
        Some(&target),
    )
    .await
    .unwrap();
    repo.append_chat_stream_delta(&producer, "Partial".into())
        .await
        .unwrap();
    repo.delete_message_turn(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    assert!(repo
        .append_chat_stream_delta(&producer, "Late".into())
        .await
        .is_err());
    assert!(repo.chat_stream(&user, "edit").await.is_err());
    let edit = turn(first.conversation.clone(), edited, assistant, "edit");
    assert!(repo
        .commit_chat_turn_replacing(&user, &edit, "edit", &producer.attempt_token, Some(&target))
        .await
        .is_err());
    assert!(repo
        .messages(&user, &first.conversation.id)
        .await
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn stale_edit_snapshot_cannot_overwrite_a_newer_revision() {
    let (repo, user, first) = fixture().await;
    let target = repo
        .chat_replacement(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    let mut one = repo.reserve_chat_owned(&user, "one", "one").await.unwrap();
    let mut two = repo.reserve_chat_owned(&user, "two", "two").await.unwrap();
    let mut edited = first.user_message.clone();
    edited.content = "Winner".into();
    let a = message(&first.conversation, "assistant", "Winner answer");
    let edit = turn(first.conversation.clone(), edited.clone(), a, "one");
    repo.commit_chat_turn_replacing(&user, &edit, "one", one.attempt_token(), Some(&target))
        .await
        .unwrap();
    one.committed();
    edited.content = "Stale".into();
    let a = message(&first.conversation, "assistant", "Stale answer");
    let stale = turn(first.conversation.clone(), edited, a, "two");
    assert!(repo
        .commit_chat_turn_replacing(&user, &stale, "two", two.attempt_token(), Some(&target))
        .await
        .is_err());
    two.release().await.unwrap();
    assert_eq!(
        repo.messages(&user, &first.conversation.id).await.unwrap()[0].content,
        "Winner"
    );
}
#[tokio::test]
async fn deletion_revokes_original_unfinished_stream_without_recreating_user() {
    let (repo, user, first) = fixture().await;
    let conversation = first.conversation;
    let producer = repo
        .begin_chat_stream(&user, "unfinished", "unfinished")
        .await
        .unwrap()
        .unwrap();
    let question = message(&conversation, "user", "Pending");
    let answer = message(&conversation, "assistant", "Late answer");
    repo.accept_chat_stream(
        &producer,
        &user,
        &conversation,
        &question,
        &answer.id,
        &answer.created_at,
        None,
    )
    .await
    .unwrap();
    repo.delete_message_turn(&user, &conversation.id, &question.id)
        .await
        .unwrap();
    assert!(repo
        .commit_chat_turn_attempt(
            &user,
            &turn(conversation.clone(), question, answer, "unfinished"),
            "unfinished",
            &producer.attempt_token
        )
        .await
        .is_err());
    assert_eq!(
        repo.messages(&user, &conversation.id).await.unwrap().len(),
        2
    );
    assert!(repo
        .begin_chat_stream_retry(&user, "unfinished", "unfinished", true)
        .await
        .is_err());
}

#[tokio::test]
async fn released_edit_intent_is_still_invalidated_by_a_newer_edit() {
    let (repo, user, first) = fixture().await;
    let mut abandoned = repo
        .reserve_chat_owned(&user, "abandoned", "abandoned")
        .await
        .unwrap();
    repo.chat_replacement_for_request(
        &user,
        &first.conversation.id,
        &first.user_message.id,
        "abandoned",
    )
    .await
    .unwrap();
    abandoned.release().await.unwrap();
    let target = repo
        .chat_replacement(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    let mut winner = repo
        .reserve_chat_owned(&user, "winner", "winner")
        .await
        .unwrap();
    let mut edited = first.user_message.clone();
    edited.content = "New revision".into();
    let turn = turn(
        first.conversation.clone(),
        edited,
        message(&first.conversation, "assistant", "New answer"),
        "winner",
    );
    repo.commit_chat_turn_replacing(
        &user,
        &turn,
        "winner",
        winner.attempt_token(),
        Some(&target),
    )
    .await
    .unwrap();
    winner.committed();
    assert!(repo
        .reserve_chat_owned(&user, "abandoned", "abandoned")
        .await
        .is_err());
    let erased:String=sqlx::query_scalar("SELECT body FROM chat_message_replacements WHERE request_key IN(SELECT request_key FROM chat_message_requests WHERE user_id=$1 AND user_message_id=$2)")
        .bind(&user).bind(&first.user_message.id).fetch_one(&repo.pool()).await.unwrap();
    assert!(erased.is_empty());
}

#[tokio::test]
async fn deleting_revokes_nonstreaming_edit_agent_authority() {
    let (repo, user, first) = fixture().await;
    let _reservation = repo
        .reserve_chat_owned(&user, "edit-run", "edit-run")
        .await
        .unwrap();
    repo.chat_replacement_for_request(
        &user,
        &first.conversation.id,
        &first.user_message.id,
        "edit-run",
    )
    .await
    .unwrap();
    let run = repo
        .begin_agent_run(
            &user,
            "chat:edit-run",
            "edit-run",
            Some(&first.conversation.id),
            None,
        )
        .await
        .unwrap();
    repo.bind_chat_replacement_run(&user, "edit-run", &run.id)
        .await
        .unwrap();
    repo.delete_message_turn(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    assert!(repo.agent_authority(&run.id, &run.token).await.is_err());
}

#[tokio::test]
async fn obsolete_direct_commit_without_request_id_cannot_restore_deleted_message() {
    let (repo, user, mut first) = fixture().await;
    repo.delete_message_turn(&user, &first.conversation.id, &first.user_message.id)
        .await
        .unwrap();
    first.request_id = None;
    assert!(repo
        .commit_chat_turn(&user, &first, "legacy-direct")
        .await
        .is_err());
    assert!(repo
        .messages(&user, &first.conversation.id)
        .await
        .unwrap()
        .is_empty());
}
