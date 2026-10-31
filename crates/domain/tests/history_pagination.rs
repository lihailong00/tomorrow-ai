use serde_json::json;
use tomorrow_domain::*;

async fn check_history_pages(repository: &Repository) {
    let user = repository
        .create_user(
            &format!("history-{}@qa.test", new_id()),
            "test",
            "历史",
            "UTC",
        )
        .await
        .unwrap();
    let pool = repository.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in 0..505_i64 {
        for kind in ["conversation", "notification", "artifact"] {
            // Reverse ids relative to activity: slicing by id before sorting loses
            // precisely the newest conversations at the 500-row boundary.
            let id = format!("{}-{kind}-{:04}", user.id, 504 - index);
            let activity = format!("2026-10-28T00:00:00.{index:09}Z");
            let body = match kind {
                "conversation" => {
                    json!({"id":id,"title":format!("conversation{index}"),"updated_at":activity})
                }
                "notification" => {
                    json!({"id":id,"title":format!("notification{index}"),"body":"fixture","task_id":null,"read":index != 504,"created_at":activity})
                }
                _ => {
                    json!({"id":id,"title":format!("artifact{index}"),"task_id":"fixture","content":"fixture","mime_type":"text/markdown","created_at":activity})
                }
            };
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,$3,$4,1000,1000)")
                .bind(id).bind(&user.id).bind(kind).bind(body.to_string()).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let (conversations, next) = repository
        .conversations_page(&user.id, 0, 500)
        .await
        .unwrap();
    assert_eq!(conversations.len(), 500);
    assert_eq!(conversations[0].title, "conversation504");
    assert_eq!(conversations[499].title, "conversation5");
    assert_eq!(next, Some(500));
    let (tail, next) = repository
        .conversations_page(&user.id, 500, 500)
        .await
        .unwrap();
    assert_eq!(tail.len(), 5);
    assert_eq!(tail[0].title, "conversation4");
    assert_eq!(tail[4].title, "conversation0");
    assert_eq!(next, None);
    assert!(
        conversations
            .iter()
            .all(|item| !tail.iter().any(|other| item.id == other.id))
    );
    let (notifications, next) = repository
        .notifications_page(&user.id, None, 0, 500)
        .await
        .unwrap();
    assert_eq!(notifications.len(), 500);
    assert_eq!(next, Some(500));
    assert_eq!(
        repository
            .notifications_page(&user.id, None, 500, 500)
            .await
            .unwrap()
            .0
            .len(),
        5
    );
    let (unread, next) = repository
        .notifications_page(&user.id, Some(false), 0, 50)
        .await
        .unwrap();
    assert_eq!(unread.len(), 1);
    assert_eq!(unread[0].title, "notification504");
    assert_eq!(next, None);
    let (artifacts, next) = repository.artifacts_page(&user.id, 0, 500).await.unwrap();
    assert_eq!(artifacts.len(), 500);
    assert_eq!(next, Some(500));
    let (tail, next) = repository.artifacts_page(&user.id, 500, 500).await.unwrap();
    assert_eq!(tail.len(), 5);
    assert_eq!(next, None);
    assert!(
        artifacts
            .iter()
            .all(|item| !tail.iter().any(|other| item.id == other.id))
    );
    assert_eq!(repository.conversations(&user.id).await.unwrap().len(), 500);
    assert_eq!(repository.notifications(&user.id).await.unwrap().len(), 500);
    assert_eq!(repository.artifacts(&user.id).await.unwrap().len(), 500);
    for (offset, limit) in [(-1, 50), (0, 0), (0, 501), (i64::MAX, 50)] {
        assert!(matches!(
            repository.conversations_page(&user.id, offset, limit).await,
            Err(DomainError::Validation(_))
        ));
        assert!(matches!(
            repository
                .notifications_page(&user.id, None, offset, limit)
                .await,
            Err(DomainError::Validation(_))
        ));
        assert!(matches!(
            repository.artifacts_page(&user.id, offset, limit).await,
            Err(DomainError::Validation(_))
        ));
    }
    let stranger = repository
        .create_user(
            &format!("stranger-{}@qa.test", new_id()),
            "test",
            "隔离",
            "UTC",
        )
        .await
        .unwrap();
    assert!(
        repository
            .conversations_page(&stranger.id, 0, 50)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        repository
            .notifications_page(&stranger.id, None, 0, 50)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        repository
            .artifacts_page(&stranger.id, 0, 50)
            .await
            .unwrap()
            .0
            .is_empty()
    );

    // Equivalent UTC activity in distinct RFC3339 spellings must tie by id,
    // and nanoseconds must not round into the next whole second.
    let precision_user = repository
        .create_user(
            &format!("precision-{}@qa.test", new_id()),
            "test",
            "精度",
            "UTC",
        )
        .await
        .unwrap();
    let entries = [
        ("a", "2026-10-28T00:00:00.123Z"),
        ("b", "2026-10-28T08:00:00.123000000+08:00"),
        ("c", "2026-10-27T20:00:00.999999999-04:00"),
        ("d", "2026-10-28T00:00:01Z"),
    ];
    for (id, activity) in entries {
        let id = format!("{}-{id}", precision_user.id);
        sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,'conversation',$3,1,1)")
            .bind(&id).bind(&precision_user.id).bind(json!({"id":id,"title":activity,"updated_at":activity}).to_string())
            .execute(&pool).await.unwrap();
    }
    let page = repository
        .conversations_page(&precision_user.id, 0, 2)
        .await
        .unwrap();
    assert!(page.0[0].id.ends_with("-d"));
    assert!(page.0[1].id.ends_with("-c"));
    let page = repository
        .conversations_page(&precision_user.id, 2, 2)
        .await
        .unwrap();
    assert!(page.0[0].id.ends_with("-b"));
    assert!(page.0[1].id.ends_with("-a"));
}

#[tokio::test]
async fn sqlite_history_pagination_and_precision() {
    check_history_pages(&Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
async fn postgres_history_pagination_and_precision() {
    let Ok(url) = std::env::var("TEST_E07_DATABASE_URL") else {
        return;
    };
    assert!(
        url.starts_with("postgres") && url.split('?').next().unwrap().ends_with("/tada_qa_e07")
    );
    check_history_pages(&Repository::connect(&url).await.unwrap()).await;
}
