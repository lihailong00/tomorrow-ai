use serde_json::{Value, json};
use std::collections::HashSet;
use tomorrow_domain::{
    DomainError, Memory, Repository, agent::tool_definitions, new_id, timestamp,
};

async fn retrieval_contract(repo: Repository) {
    let owner = repo
        .create_user(
            &format!("retrieval-{}@qa.test", new_id()),
            "unused",
            "检索",
            "UTC",
        )
        .await
        .unwrap();
    let other = repo
        .create_user(
            &format!("other-{}@qa.test", new_id()),
            "unused",
            "隔离",
            "UTC",
        )
        .await
        .unwrap();
    let oldest = format!("{}-00000", owner.id);
    let secret = "靛蓝柚子甲二九·MÜNCHEN_100%\\\"😀";
    let full = format!("{}{}", "中文😀".repeat(3000), secret);
    let long_escaped = "\u{0001}\n\\\"😀中".repeat(1400);
    let pool = repo.pool();
    let mut tx = pool.begin().await.unwrap();
    for index in 0..5005_i64 {
        let memory = Memory {
            id: format!("{}-{index:05}", owner.id),
            title: if index == 0 {
                "测试存储柜 MÜNCHEN_100%\\\"😀".into()
            } else {
                format!("普通记忆{index}")
            },
            content: if index == 0 {
                full.clone()
            } else if index >= 4905 {
                long_escaped.clone()
            } else {
                "普通资料".into()
            },
            kind: if index < 2 { "person" } else { "fact" }.into(),
            source: "fixture".into(),
            created_at: timestamp(1000 + index),
            updated_at: timestamp(1000 + index),
            version: 1,
            confirmation: None,
        };
        sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'memory',$3,$4,$4)")
            .bind(&memory.id).bind(&owner.id).bind(serde_json::to_string(&memory).unwrap()).bind(1000 + index).execute(&mut *tx).await.unwrap();
    }
    for index in 0..505_i64 {
        let id = format!("{}-task-{index}", owner.id);
        sqlx::query("INSERT INTO tasks(id,user_id,title,prompt,kind,status,result,created_at,updated_at)VALUES($1,$2,$3,$4,'general','succeeded',$5,$6,$6)")
            .bind(&id).bind(&owner.id).bind(format!("任务{index}"))
            .bind(if index == 0 { "旧指令MÜNCHEN_100%".to_owned() } else { "新指令".repeat(2000) })
            .bind("成果😀".repeat(10000)).bind(1000 + index).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO schedules(id,user_id,title,prompt,frequency,time_of_day,timezone,enabled,next_run_at,created_at,updated_at)VALUES($1,$2,$3,$4,'daily','09:00','UTC',0,1,$5,$5)")
            .bind(format!("{}-schedule-{index}", owner.id)).bind(&owner.id).bind(format!("计划{index}"))
            .bind(if index == 0 { "旧计划MÜNCHEN_100%".to_owned() } else { "计划😀".repeat(5000) })
            .bind(1000 + index).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let foreign: Memory = Memory {
        id: new_id(),
        title: "绝密隔离".into(),
        content: secret.into(),
        kind: "person".into(),
        source: "fixture".into(),
        created_at: timestamp(1),
        updated_at: timestamp(1),
        version: 1,
        confirmation: None,
    };
    sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'memory',$3,1,1)")
        .bind(&foreign.id).bind(&other.id).bind(serde_json::to_string(&foreign).unwrap()).execute(&pool).await.unwrap();
    let run = repo
        .begin_agent_run(&owner.id, "retrieval", "fixture", None, None)
        .await
        .unwrap();
    let call =
        |name: &'static str, args: Value| repo.execute_agent_tool(&run.id, &run.token, name, args);
    let legacy = call("list_memories", json!({})).await.unwrap();
    assert!(legacy["items"].as_array().unwrap().len() <= 20);
    assert_eq!(legacy["has_more"], true);
    assert!(legacy.to_string().len() <= 40000);
    let budget_page = call("list_memories", json!({"limit":100})).await.unwrap();
    assert_eq!(budget_page["truncated"], true);
    assert_eq!(
        budget_page["next_offset"].as_u64().unwrap() as usize,
        budget_page["items"].as_array().unwrap().len()
    );
    assert!(budget_page.to_string().len() <= 40000);
    let started = std::time::Instant::now();
    let found = call(
        "list_memories",
        json!({"query":secret,"kind":"person","limit":1}),
    )
    .await
    .unwrap();
    eprintln!(
        "5005-memory literal query elapsed_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(found["items"][0]["id"], oldest);
    assert_eq!(found["items"][0]["version"], 1);
    assert_eq!(found["items"][0]["content_truncated"], true);
    assert_eq!(found["next_offset"], Value::Null);
    assert!(
        call("list_memories", json!({"query":secret,"kind":"fact"}))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        call("list_memories", json!({"query":"münchen"}))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call("list_memories", json!({"query":"MÜNCHEN_100%\\\"😀"}))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut seen = HashSet::new();
    let mut offset = 0;
    loop {
        let page = call("list_memories", json!({"offset":offset,"limit":100}))
            .await
            .unwrap();
        assert!(page.to_string().len() <= 40000);
        let items = page["items"].as_array().unwrap();
        for item in items {
            assert!(seen.insert(item["id"].as_str().unwrap().to_owned()));
        }
        if let Some(next) = page["next_offset"].as_i64() {
            assert!(next > offset);
            offset = next;
        } else {
            break;
        }
    }
    assert_eq!(seen.len(), 5005);
    assert!(seen.contains(&oldest));
    let mut restored = String::new();
    let mut offset = 0;
    loop {
        let part = call(
            "get_memory",
            json!({"id":oldest,"content_offset":offset,"content_limit":4000}),
        )
        .await
        .unwrap();
        assert!(part.to_string().len() <= 40000);
        assert_eq!(
            part["content_length"].as_u64().unwrap() as usize,
            full.chars().count()
        );
        restored.push_str(part["content"].as_str().unwrap());
        if let Some(next) = part["content_next_offset"].as_i64() {
            offset = next;
        } else {
            break;
        }
    }
    assert_eq!(restored, full);
    assert!(matches!(
        call("get_memory", json!({"id":foreign.id})).await,
        Err(DomainError::NotFound)
    ));
    assert!(
        call("list_memories", json!({"query":"绝密隔离"}))
            .await
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for name in ["list_tasks", "list_schedules"] {
        let page = call(name, json!({"offset":500,"limit":100})).await.unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 5);
        assert_eq!(page["next_offset"], Value::Null);
        assert!(page.to_string().len() <= 40000);
        let found = call(name, json!({"query":"MÜNCHEN_100%"})).await.unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
    }
    let part = call(
        "get_task",
        json!({"id":format!("{}-task-0",owner.id),"content_offset":29999,"content_limit":4000}),
    )
    .await
    .unwrap();
    assert_eq!(part["result_length"], 30000);
    assert_eq!(part["result_next_offset"], Value::Null);
    assert_eq!(part["result"], "😀");
    let part = call("get_schedule", json!({"id":format!("{}-schedule-504",owner.id),"content_offset":14999,"content_limit":4000})).await.unwrap();
    assert_eq!(part["instruction_length"], 15000);
    assert_eq!(part["instruction"], "😀");
    assert_eq!(part["enabled"], false);
    for args in [
        json!({"offset":-1}),
        json!({"offset":100001}),
        json!({"offset":0.5}),
        json!({"offset":"1"}),
        json!({"limit":0}),
        json!({"limit":101}),
        json!({"limit":true}),
        json!({"query":null}),
        json!({"query":"字".repeat(201)}),
        json!({"kind":"unknown"}),
        json!({"user_id":other.id}),
        json!([]),
    ] {
        assert!(matches!(
            call("list_memories", args).await,
            Err(DomainError::Validation(_))
        ));
    }
    assert!(
        call("get_memory", json!({"id":oldest,"content_offset":100000}))
            .await
            .is_err()
    );
    assert!(
        call("get_memory", json!({"id":oldest,"content_limit":4001}))
            .await
            .is_err()
    );
    assert!(
        call(
            "get_task",
            json!({"id":format!("{}-task-0",owner.id),"field":"token"})
        )
        .await
        .is_err()
    );
    // The released connection and knowledge baseline extends the tool catalog.
    assert_eq!(tool_definitions("chat").len(), 26);
    repo.cancel_agent_run(&owner.id, &run.id).await.unwrap();
    assert!(matches!(
        call("get_memory", json!({"id":oldest})).await,
        Err(DomainError::Forbidden)
    ));
    for user in [owner, other] {
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(user.id)
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn sqlite_agent_can_search_and_page_all_owned_records_with_bounded_results() {
    retrieval_contract(Repository::connect("sqlite::memory:").await.unwrap()).await;
}

#[tokio::test]
#[ignore = "Requires explicit disposable PostgreSQL TEST_DATABASE_URL"]
async fn postgres_agent_can_search_and_page_all_owned_records_with_bounded_results() {
    let url = std::env::var("TEST_DATABASE_URL").expect("explicit disposable PostgreSQL URL");
    assert!(url.starts_with("postgres"));
    retrieval_contract(Repository::connect(&url).await.unwrap()).await;
}
