use std::collections::HashSet;
use tomorrow_domain::*;

async fn insert(repository: &Repository, user: &str, conversation: &str, index: i64) -> Message {
    let message = Message {
        id: format!("{conversation}-{:04}", 2000 - index),
        conversation_id: conversation.into(), role: "user".into(),
        content: format!("sentinel-{index}"),
        created_at: timestamp(1_790_000_000 + index), model_mode: None, attachments: vec![],
    };
    sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,'message',$3,$4,$4)")
        .bind(&message.id).bind(user).bind(serde_json::to_string(&message).unwrap())
        .bind(index).execute(&repository.pool()).await.unwrap();
    message
}

async fn check_pages(repository: Repository) {
    let user = repository.create_user(&format!("messages-{}@qa.test", new_id()), "test", "历史", "UTC").await.unwrap();
    let stranger = repository.create_user(&format!("messages-{}@qa.test", new_id()), "test", "隔离", "UTC").await.unwrap();
    let conversation = repository.create_conversation(&user.id, "1004 messages").await.unwrap();
    let other = repository.create_conversation(&user.id, "other chat").await.unwrap();
    for index in 0..1004 { insert(&repository, &user.id, &conversation.id, index).await; }
    let foreign_cursor = insert(&repository, &user.id, &other.id, 1500).await;
    let legacy = repository.messages(&user.id, &conversation.id).await.unwrap();
    assert_eq!(legacy.len(), 1000);
    assert_eq!(legacy[0].content, "sentinel-4");
    let (first, next) = repository.messages_page(&user.id, &conversation.id, 0, 40, None).await.unwrap();
    assert_eq!(first.len(), 40);
    assert_eq!(first[0].content, "sentinel-964");
    assert_eq!(first[39].content, "sentinel-1003");
    assert_eq!(next, Some(40));
    let (offset, _) = repository.messages_page(&user.id, &conversation.id, 40, 40, None).await.unwrap();
    assert_eq!(offset[0].content, "sentinel-924");
    let mut all: HashSet<String> = first.iter().map(|message| message.id.clone()).collect();
    let mut before = first[0].id.clone();
    // A reply inserted after the first page must neither shift nor duplicate older pages.
    insert(&repository, &user.id, &conversation.id, 1004).await;
    let mut final_content = String::new();
    loop {
        let (page, next) = repository.messages_page(&user.id, &conversation.id, 0, 40, Some(&before)).await.unwrap();
        assert!(page.len() <= 40);
        for message in &page { assert!(all.insert(message.id.clone())); }
        if let Some(first) = page.first() { before = first.id.clone(); final_content = first.content.clone(); }
        if next.is_none() { break; }
    }
    assert_eq!(all.len(), 1004);
    assert_eq!(final_content, "sentinel-0");
    for (offset, limit) in [(-1, 40), (0, 0), (0, 501), (i64::MAX, 40)] {
        assert!(matches!(repository.messages_page(&user.id, &conversation.id, offset, limit, None).await, Err(DomainError::Validation(_))));
    }
    assert!(matches!(repository.messages_page(&stranger.id, &conversation.id, 0, 40, None).await, Err(DomainError::NotFound)));
    assert!(matches!(repository.messages_page(&user.id, &conversation.id, 0, 40, Some(&foreign_cursor.id)).await, Err(DomainError::NotFound)));
    assert!(matches!(repository.messages_page(&user.id, &conversation.id, 0, 40, Some("missing")).await, Err(DomainError::NotFound)));
    let empty = repository.create_conversation(&user.id, "empty").await.unwrap();
    assert!(repository.messages_page(&user.id, &empty.id, 0, 40, None).await.unwrap().0.is_empty());
    // Timestamp offsets and subsecond precision share the same stable id tie-break.
    for (id, time) in [("a", "2026-10-28T00:00:00.123Z"), ("b", "2026-10-28T08:00:00.123000000+08:00"), ("c", "2026-10-27T20:00:00.999999999-04:00"), ("d", "2026-10-28T00:00:01Z")] {
        let mut message = insert(&repository, &user.id, &empty.id, id.as_bytes()[0] as i64).await;
        message.created_at = time.into();
        sqlx::query("UPDATE resources SET body=$1 WHERE id=$2").bind(serde_json::to_string(&message).unwrap()).bind(&message.id).execute(&repository.pool()).await.unwrap();
    }
    let page = repository.messages_page(&user.id, &empty.id, 0, 2, None).await.unwrap().0;
    assert_eq!(page[0].created_at, "2026-10-27T20:00:00.999999999-04:00");
    assert_eq!(page[1].created_at, "2026-10-28T00:00:01Z");
}

#[tokio::test]
async fn sqlite_messages_continue_beyond_context_limit() {
    check_pages(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn postgres_messages_continue_beyond_context_limit() {
    let Ok(url) = std::env::var("TEST_E07_DATABASE_URL") else { return; };
    assert!(url.starts_with("postgres") && url.split('?').next().unwrap().ends_with("/tada_qa_e07_messages_r8"));
    check_pages(Repository::connect(&url).await.unwrap()).await;
}
