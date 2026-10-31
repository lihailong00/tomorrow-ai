use chrono::{Datelike, Timelike};
use tomorrow_domain::*;

async fn check_paging(repository: &Repository) {
    let user = repository
        .create_user(
            &format!("page-{}@qa.test", new_id()),
            "test",
            "分页",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let pool = repository.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in 0..505_i64 {
        let id = format!("{}-{index:04}", user.id);
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,created_at,updated_at) VALUES($1,$2,$3,'fixture','general',$4,$5,$5)")
            .bind(&id).bind(&user.id).bind(format!("任务{index}"))
            .bind(if index == 0 { "waiting_approval" } else if index == 1 { "uncertain" } else { "succeeded" })
            .bind(1000 + index / 5).execute(&mut *tx).await.unwrap();
        let kind = if index < 2 { "person" } else { "fact" };
        let memory = Memory {
            id: id.clone(),
            title: format!("记忆{index}"),
            content: "fixture".into(),
            kind: kind.into(),
            source: "test".into(),
            created_at: timestamp(1000 + index),
            updated_at: timestamp(1000 + index),
            version: 1,
        };
        sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at) VALUES($1,$2,'memory',$3,$4,$4)")
            .bind(id).bind(&user.id).bind(serde_json::to_string(&memory).unwrap()).bind(1000 + index / 5)
            .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (first, next) = repository
        .tasks_page(&user.id, "all", 0, 500)
        .await
        .unwrap();
    assert_eq!(first.len(), 500);
    assert_eq!(next, Some(500));
    assert_eq!(
        first.iter().map(|task| &task.id).collect::<Vec<_>>(),
        repository
            .tasks_page(&user.id, "all", 0, 500)
            .await
            .unwrap()
            .0
            .iter()
            .map(|task| &task.id)
            .collect::<Vec<_>>()
    );
    let (last, next) = repository
        .tasks_page(&user.id, "all", next.unwrap(), 500)
        .await
        .unwrap();
    assert_eq!(last.len(), 5);
    assert_eq!(next, None);
    assert!(
        first
            .iter()
            .all(|task| !last.iter().any(|other| other.id == task.id))
    );
    assert_eq!(last.last().unwrap().status, "waiting_approval");
    let (active, next) = repository
        .tasks_page(&user.id, "active", 0, 50)
        .await
        .unwrap();
    assert_eq!(active.len(), 2);
    assert_eq!(next, None);
    assert_eq!(
        repository
            .tasks_page(&user.id, "waiting_approval", 0, 1)
            .await
            .unwrap()
            .0
            .len(),
        1
    );
    assert_eq!(
        repository
            .tasks_page(&user.id, "done", 500, 50)
            .await
            .unwrap()
            .0
            .len(),
        3
    );
    let (persons, next) = repository
        .memories_page(&user.id, Some("person"), 0, 1)
        .await
        .unwrap();
    assert_eq!(persons[0].title, "记忆1");
    assert_eq!(next, Some(1));
    let (old_person, next) = repository
        .memories_page(&user.id, Some("person"), 1, 1)
        .await
        .unwrap();
    assert_eq!(old_person[0].title, "记忆0");
    assert_eq!(next, None);
    assert_eq!(
        repository
            .memories_page(&user.id, None, 500, 50)
            .await
            .unwrap()
            .0
            .len(),
        5
    );
    let stranger = repository
        .create_user(
            &format!("other-{}@qa.test", new_id()),
            "test",
            "隔离",
            "UTC",
        )
        .await
        .unwrap();
    assert!(
        repository
            .tasks_page(&stranger.id, "all", 0, 50)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        repository
            .memories_page(&stranger.id, Some("person"), 0, 50)
            .await
            .unwrap()
            .0
            .is_empty()
    );
    for (offset, limit) in [(-1, 50), (0, 0), (0, 501), (i64::MAX, 50)] {
        assert!(matches!(
            repository.tasks_page(&user.id, "all", offset, limit).await,
            Err(DomainError::Validation(_))
        ));
        assert!(matches!(
            repository
                .memories_page(&user.id, None, offset, limit)
                .await,
            Err(DomainError::Validation(_))
        ));
    }
    assert!(
        repository
            .tasks_page(&user.id, "unknown", 0, 50)
            .await
            .is_err()
    );
    assert!(
        repository
            .memories_page(&user.id, Some("unknown"), 0, 50)
            .await
            .is_err()
    );
}

fn weekday(schedule: &Schedule) -> chrono::Weekday {
    chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at)
        .unwrap()
        .with_timezone(&schedule.timezone.parse::<chrono_tz::Tz>().unwrap())
        .weekday()
}

async fn check_weekly_timezone(repository: &Repository) {
    let user = repository
        .create_user(
            &format!("schedule-{}@qa.test", new_id()),
            "test",
            "周计划",
            "UTC",
        )
        .await
        .unwrap();
    let schedule = repository
        .create_schedule(
            &user.id,
            CreateSchedule {
                title: "跨日期变更线".into(),
                instruction: "fixture".into(),
                frequency: "weekly".into(),
                time: "23:30".into(),
                timezone: "Pacific/Honolulu".into(),
                enabled: Some(false),
                client_request_id: None,
            },
        )
        .await
        .unwrap();
    let original = weekday(&schedule);
    for zone in ["Pacific/Kiritimati", "America/New_York", "Pacific/Honolulu"] {
        let updated = repository
            .update_schedule(
                &user.id,
                &schedule.id,
                UpdateSchedule {
                    title: None,
                    instruction: None,
                    frequency: None,
                    time: None,
                    timezone: Some(zone.into()),
                    enabled: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(weekday(&updated), original, "weekday changed in {zone}");
        let local = chrono::DateTime::parse_from_rfc3339(&updated.next_run_at)
            .unwrap()
            .with_timezone(&zone.parse::<chrono_tz::Tz>().unwrap());
        assert_eq!((local.hour(), local.minute()), (23, 30));
    }
}

#[tokio::test]
async fn sqlite_lists_and_weekly_timezone_regressions() {
    let repository = Repository::connect("sqlite::memory:").await.unwrap();
    check_paging(&repository).await;
    check_weekly_timezone(&repository).await;
}

#[tokio::test]
async fn postgres_lists_and_weekly_timezone_regressions() {
    let Ok(url) = std::env::var("TEST_E07_DATABASE_URL") else {
        return;
    };
    assert!(
        url.starts_with("postgres") && url.split('?').next().unwrap().ends_with("/tada_qa_e07"),
        "E07 requires its dedicated disposable database"
    );
    let repository = Repository::connect(&url).await.unwrap();
    check_paging(&repository).await;
    check_weekly_timezone(&repository).await;
}

#[test]
fn weekly_anchor_survives_dst_gap_and_overlap() {
    for (anchor, after, expected) in [
        (
            "2026-03-01T02:30:00-05:00",
            "2026-03-07T12:00:00-05:00",
            "2026-03-08T07:00:00+00:00",
        ),
        (
            "2026-10-25T01:30:00-04:00",
            "2026-10-31T12:00:00-04:00",
            "2026-11-01T05:30:00+00:00",
        ),
    ] {
        let anchor = chrono::DateTime::parse_from_rfc3339(anchor).unwrap();
        let after = chrono::DateTime::parse_from_rfc3339(after).unwrap();
        let time = format!("{:02}:{:02}", anchor.hour(), anchor.minute());
        let next = tomorrow_domain::repository::next_weekly_execution(
            &time,
            "America/New_York",
            anchor.timestamp(),
            after.timestamp(),
        )
        .unwrap();
        assert_eq!(timestamp(next), expected);
    }
}
