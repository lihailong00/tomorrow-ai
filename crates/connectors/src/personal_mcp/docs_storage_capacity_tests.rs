use super::*;

fn catalog() -> Vec<Value> {
    (0..227)
        .map(|index| {
            json!({"name":format!("docs_tool_{index}"),"description":"d".repeat(1700),
        "inputSchema":{"type":"object","required":["id"],"additionalProperties":false,
            "properties":{"id":{"type":"string","minLength":1,"description":"s".repeat(1100)}}}})
        })
        .collect()
}
fn credentials() -> Credentials {
    serde_json::from_value(
        json!({"token":"private-fixture-token-not-in-tool-schema","environment":"production"}),
    )
    .unwrap()
}

#[tokio::test]
async fn large_docs_catalog_roundtrips_all_schemas_in_owner_bound_chunks() {
    let original = catalog();
    let clean = clean_tools("tencent_docs", &credentials(), original.clone()).unwrap();
    assert_eq!(clean.len(), 227);
    for (expected, actual) in original.iter().zip(&clean) {
        assert_eq!(actual["inputSchema"], expected["inputSchema"]);
    }
    assert!(serde_json::to_vec(&clean).unwrap().len() > 16 * 24 * 1024);
    assert!(clean_tools("didi", &credentials(), original).is_err());
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let state = PersonalMcpState::with_transport(
        repo,
        Some(Crypto::from_hex(&"ab".repeat(32)).unwrap()),
        Arc::new(OfficialTransport),
    )
    .await
    .unwrap();
    let encrypted = state
        .encrypt("owner-a", "tencent_docs", "personal_mcp_tools", &clean)
        .unwrap();
    let decoded: Vec<Value> = state
        .decode("owner-a", "tencent_docs", "personal_mcp_tools", &encrypted)
        .unwrap();
    assert_eq!(decoded, clean);
    assert!(
        state
            .decode::<Value>("owner-b", "tencent_docs", "personal_mcp_tools", &encrypted)
            .is_err()
    );
    assert!(
        state
            .decode::<Value>("owner-a", "didi", "personal_mcp_tools", &encrypted)
            .is_err()
    );
    assert!(
        state
            .decode::<Value>(
                "owner-a",
                "tencent_docs",
                "personal_mcp_credentials",
                &encrypted
            )
            .is_err()
    );
    let mut chunks: Vec<String> =
        serde_json::from_str(encrypted.strip_prefix("chunks-v1:").unwrap()).unwrap();
    chunks.swap(0, 1);
    let reordered = format!("chunks-v1:{}", serde_json::to_string(&chunks).unwrap());
    assert!(
        state
            .decode::<Value>("owner-a", "tencent_docs", "personal_mcp_tools", &reordered)
            .is_err()
    );
    assert!(
        state
            .encrypt(
                "owner-a",
                "tencent_docs",
                "personal_mcp_credentials",
                &clean
            )
            .is_err()
    );
}

#[test]
fn docs_catalog_limit_does_not_disable_description_or_total_size_guards() {
    let mut tools = catalog();
    tools[0]["description"] = json!("x".repeat(8001));
    assert!(clean_tools("tencent_docs", &credentials(), tools).is_err());
    let huge = vec![
        json!({"name":"huge_schema","inputSchema":{"type":"object","description":"x".repeat(1024*1024)}}),
    ];
    assert!(clean_tools("tencent_docs", &credentials(), huge).is_err());
    assert_eq!(
        storage_byte_limit("tencent_docs", "personal_mcp_action_arguments:x"),
        TOOL_BYTES
    );
}
