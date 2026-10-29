use serde_json::{json, Value};
use tomorrow_domain::{
    knowledge::{GraphIndexInput, GraphSearch},
    CreateMemory, DomainError, Memory, Repository, UpdateMemory,
};

async fn fixture() -> (Repository, String, String) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let a = repo
        .create_user("graph-a@test.local", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let b = repo
        .create_user("graph-b@test.local", "unused", "乙", "Asia/Shanghai")
        .await
        .unwrap();
    (repo, a.id, b.id)
}
async fn memory(repo: &Repository, user: &str) -> Memory {
    repo.create_memory(
        user,
        CreateMemory {
            title: Some("Tomorrow 决策".into()),
            content:
                "2026-09-21：王伟确认 Tomorrow 方案V3。\n2026-09-21：方案V3 的 API 使用 Rust。"
                    .into(),
            kind: "project".into(),
            source: None,
            client_request_id: None,
        },
    )
    .await
    .unwrap()
}
fn input(memory: &Memory) -> GraphIndexInput {
    serde_json::from_value(json!({"memory_id":memory.id,"version":memory.version,"scope":"Tomorrow","entities":[
        {"key":"p","name":"王伟","kind":"person"},
        {"key":"v","name":"方案V3","kind":"plan"},
        {"key":"r","name":"Rust","kind":"technology"}
    ],"facts":[
        {"subject":"p","relation":"CONFIRMED","object":"v","status":"confirmed","quote":"2026-09-21：王伟确认 Tomorrow 方案V3。","occurred_on":"2026-09-21"},
        {"subject":"v","relation":"USES","object":"r","status":"reported","quote":"2026-09-21：方案V3 的 API 使用 Rust。","occurred_on":"2026-09-21"}
    ]})).unwrap()
}
async fn search(repo: &Repository, user: &str, query: &str) -> Value {
    repo.search_knowledge_graph(
        user,
        GraphSearch {
            query: query.into(),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn index_is_idempotent_and_search_traverses_to_source_backed_neighbors() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    let first = repo.index_memory_graph(&a, input(&source)).await.unwrap();
    let second = repo.index_memory_graph(&a, input(&source)).await.unwrap();
    assert_eq!(first["episode_id"], second["episode_id"]);
    assert_eq!(first["entities"], second["entities"]);
    assert_eq!(second["cached"], true);
    let found = search(&repo, &a, "王伟").await;
    assert_eq!(found["facts"].as_array().unwrap().len(), 1);
    assert_eq!(found["facts"][0]["relation"], "CONFIRMED");
    assert_eq!(found["facts"][0]["source"]["id"], source.id);
    assert_eq!(found["facts"][0]["source"]["version"], 1);
    assert_eq!(found["related_facts"][0]["object"]["name"], "Rust");
    assert_eq!(found["related_facts"][0]["status"], "reported");
    assert_eq!(search(&repo, &a, "unrelated").await["facts"], json!([]));
    assert_eq!(
        search(&repo, &a, "").await["facts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn malformed_extraction_has_no_partial_effects() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    let base = input(&source);
    let mut bad = base.clone();
    bad.facts[0].quote = "王伟确认了不存在的方案".into();
    assert!(matches!(
        repo.index_memory_graph(&a, bad).await,
        Err(DomainError::Validation(_))
    ));
    let mut bad = base.clone();
    bad.facts[0].occurred_on = Some("2026-09-22".into());
    assert!(matches!(
        repo.index_memory_graph(&a, bad).await,
        Err(DomainError::Validation(_))
    ));
    let mut bad = base.clone();
    bad.facts[0].object = "missing".into();
    assert!(matches!(
        repo.index_memory_graph(&a, bad).await,
        Err(DomainError::Validation(_))
    ));
    let mut bad = base.clone();
    bad.entities[0].name = "李四".into();
    assert!(matches!(
        repo.index_memory_graph(&a, bad).await,
        Err(DomainError::Validation(_))
    ));
    let mut bad = base.clone();
    bad.entities[0].match_id = Some("nonexistent".into());
    assert!(matches!(
        repo.index_memory_graph(&a, bad).await,
        Err(DomainError::NotFound)
    ));
    for table in [
        "knowledge_entities",
        "knowledge_episodes",
        "knowledge_facts",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&repo.pool())
            .await
            .unwrap();
        assert_eq!(count, 0, "partial effect in {table}");
    }
}

#[tokio::test]
async fn updates_and_deletes_hide_stale_evidence_without_indexing_hooks() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    repo.index_memory_graph(&a, input(&source)).await.unwrap();
    let revised = repo
        .update_memory(
            &a,
            &source.id,
            UpdateMemory {
                title: None,
                content: Some(source.content.replace("Rust", "Go")),
                kind: None,
                version: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(search(&repo, &a, "").await["facts"], json!([]));
    assert!(matches!(
        repo.index_memory_graph(&a, input(&source)).await,
        Err(DomainError::Conflict(_))
    ));
    let mut next = input(&revised);
    next.entities[2].name = "Go".into();
    next.facts[1].quote = next.facts[1].quote.replace("Rust", "Go");
    repo.index_memory_graph(&a, next).await.unwrap();
    assert_eq!(
        search(&repo, &a, "Go").await["facts"][0]["source"]["version"],
        2
    );
    assert_eq!(search(&repo, &a, "Rust").await["facts"], json!([]));
    repo.delete_resource(&a, "memory", &source.id)
        .await
        .unwrap();
    assert_eq!(search(&repo, &a, "").await["facts"], json!([]));
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_facts")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn people_are_not_automatically_merged_but_explicit_candidates_can_be_reused() {
    let (repo, a, _) = fixture().await;
    let first = memory(&repo, &a).await;
    let first_result = repo.index_memory_graph(&a, input(&first)).await.unwrap();
    let second = memory(&repo, &a).await;
    let second_result = repo.index_memory_graph(&a, input(&second)).await.unwrap();
    assert_ne!(
        first_result["entities"]["p"],
        second_result["entities"]["p"]
    );
    assert_eq!(
        first_result["entities"]["v"],
        second_result["entities"]["v"]
    );
    let third = memory(&repo, &a).await;
    let mut next = input(&third);
    next.entities[0].match_id = Some(first_result["entities"]["p"].as_str().unwrap().into());
    let third_result = repo.index_memory_graph(&a, next).await.unwrap();
    assert_eq!(first_result["entities"]["p"], third_result["entities"]["p"]);
}

#[tokio::test]
async fn source_and_entity_ownership_are_enforced_and_failures_roll_back() {
    let (repo, a, b) = fixture().await;
    let a_source = memory(&repo, &a).await;
    let a_result = repo.index_memory_graph(&a, input(&a_source)).await.unwrap();
    assert_eq!(search(&repo, &b, "").await["facts"], json!([]));
    assert!(matches!(
        repo.index_memory_graph(&b, input(&a_source)).await,
        Err(DomainError::NotFound)
    ));
    let b_source = memory(&repo, &b).await;
    let mut forged = input(&b_source);
    forged.entities[0].match_id = Some(a_result["entities"]["p"].as_str().unwrap().into());
    assert!(matches!(
        repo.index_memory_graph(&b, forged).await,
        Err(DomainError::NotFound)
    ));
    assert_eq!(search(&repo, &b, "").await["facts"], json!([]));
    assert!(matches!(
        repo.delete_memory_graph(&b, &a_source.id).await,
        Err(DomainError::NotFound)
    ));
    repo.delete_memory_graph(&a, &a_source.id).await.unwrap();
    assert_eq!(repo.memories(&a).await.unwrap().len(), 1);
    assert_eq!(search(&repo, &a, "").await["facts"], json!([]));
}

#[tokio::test]
async fn date_filters_exclude_unknown_dates_and_preserve_assertion_status() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    let mut extraction = input(&source);
    extraction.facts[0].status = "proposed".into();
    extraction.facts[1].occurred_on = None;
    repo.index_memory_graph(&a, extraction).await.unwrap();
    let found = repo
        .search_knowledge_graph(
            &a,
            GraphSearch {
                from: Some("2026-09-01".into()),
                before: Some("2026-10-01".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(found["facts"].as_array().unwrap().len(), 1);
    assert_eq!(found["facts"][0]["status"], "proposed");
    let found = repo
        .search_knowledge_graph(
            &a,
            GraphSearch {
                before: Some("2026-09-21".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(found["facts"], json!([]));
    assert!(repo
        .search_knowledge_graph(
            &a,
            GraphSearch {
                from: Some("2026-02-30".into()),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert!(repo
        .search_knowledge_graph(
            &a,
            GraphSearch {
                limit: Some(0),
                ..Default::default()
            }
        )
        .await
        .is_err());
}

#[tokio::test]
async fn changed_extraction_for_same_version_requires_explicit_rebuild() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    repo.index_memory_graph(&a, input(&source)).await.unwrap();
    let mut changed = input(&source);
    changed.facts[0].status = "reported".into();
    assert!(matches!(
        repo.index_memory_graph(&a, changed.clone()).await,
        Err(DomainError::Conflict(_))
    ));
    repo.delete_memory_graph(&a, &source.id).await.unwrap();
    repo.index_memory_graph(&a, changed).await.unwrap();
    assert_eq!(
        search(&repo, &a, "王伟").await["facts"][0]["status"],
        "reported"
    );
}

#[tokio::test]
async fn agent_writes_use_existing_transaction_replay_and_scope_rules() {
    let (repo, a, _) = fixture().await;
    let source = memory(&repo, &a).await;
    let run = repo
        .begin_agent_run(&a, "graph-chat", "explicitly index this memory", None, None)
        .await
        .unwrap();
    let args = serde_json::to_value(input(&source)).unwrap();
    let first = repo
        .execute_agent_tool_at(
            &run.id,
            &run.token,
            "index_memory_graph",
            args.clone(),
            Some(1),
        )
        .await
        .unwrap();
    let second = repo
        .execute_agent_tool_at(&run.id, &run.token, "index_memory_graph", args, Some(1))
        .await
        .unwrap();
    assert_eq!(first["value"]["episode_id"], second["value"]["episode_id"]);
    assert_eq!(second["replayed"], true);
    assert_eq!(
        repo.agent_run(&a, &run.id).await.unwrap().operations.len(),
        1
    );
    let read = repo
        .execute_agent_tool(
            &run.id,
            &run.token,
            "search_knowledge_graph",
            json!({"query":"王伟"}),
        )
        .await
        .unwrap();
    assert_eq!(read["facts"].as_array().unwrap().len(), 1);
    assert!(!tomorrow_domain::agent::tool_definitions("task")
        .iter()
        .any(|t| t.name == "index_memory_graph"));
    assert!(tomorrow_domain::agent::tool_definitions("task")
        .iter()
        .any(|t| t.name == "search_knowledge_graph"));
    assert!(tomorrow_domain::agent::tool_definitions("chat").len() <= 20);
}

#[tokio::test]
async fn graph_survives_reconnecting_to_persistent_database() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite:{}", dir.path().join("knowledge.db").display());
    let repo = Repository::connect(&url).await.unwrap();
    let user = repo
        .create_user("persist@test.local", "unused", "甲", "Asia/Shanghai")
        .await
        .unwrap();
    let source = memory(&repo, &user.id).await;
    repo.index_memory_graph(&user.id, input(&source))
        .await
        .unwrap();
    repo.pool().close().await;
    let restored = Repository::connect(&url).await.unwrap();
    assert_eq!(
        search(&restored, &user.id, "Rust").await["facts"][0]["object"]["name"],
        "Rust"
    );
    restored.pool().close().await;
}

#[tokio::test]
#[ignore = "requires an explicitly supplied TEST_DATABASE_URL"]
async fn postgres_graph_transactions_and_source_versions() {
    let repo = Repository::connect(
        &std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL required"),
    )
    .await
    .unwrap();
    let user = repo
        .create_user(
            &format!("graph-{}@test.local", tomorrow_domain::new_id()),
            "unused",
            "甲",
            "Asia/Shanghai",
        )
        .await
        .unwrap();
    let source = memory(&repo, &user.id).await;
    let (a, b) = tokio::join!(
        repo.index_memory_graph(&user.id, input(&source)),
        repo.index_memory_graph(&user.id, input(&source))
    );
    assert_eq!(a.unwrap()["episode_id"], b.unwrap()["episode_id"]);
    assert_eq!(
        search(&repo, &user.id, "王伟").await["related_facts"][0]["object"]["name"],
        "Rust"
    );
    repo.delete_resource(&user.id, "memory", &source.id)
        .await
        .unwrap();
    assert_eq!(search(&repo, &user.id, "").await["facts"], json!([]));
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(&user.id)
        .execute(&repo.pool())
        .await
        .unwrap();
}
