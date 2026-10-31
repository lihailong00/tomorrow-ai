use super::*;
use serde_json::json;

fn parse_json(value: &Value, selected: &str) -> Archive {
    parse(
        serde_json::to_vec(value).unwrap(),
        "conversations.json",
        selected,
    )
    .unwrap()
}

#[test]
fn constructed_mapping_and_linear_pair_import_the_same_visible_messages() {
    // Constructed supported-shape compatibility fixture, not an untouched vendor export.
    let messages = vec![
        json!({"id":"user","author":{"role":"user"},"role":"user",
            "content":{"content_type":"text","parts":["VISIBLE_USER_SENTINEL"]},
            "create_time":1793142314}),
        json!({"id":"thinking","author":{"role":"assistant"},"role":"assistant",
            "channel":"analysis","recipient":"all",
            "content":{"content_type":"text","parts":["HIDDEN_REASONING_SENTINEL"]},
            "create_time":1793142315}),
        json!({"id":"tool-directed","author":{"role":"assistant"},"role":"assistant",
            "channel":"analysis","recipient":"python",
            "content":{"content_type":"text","parts":["TOOL_CODE_SENTINEL"]},
            "create_time":1793142316}),
        json!({"id":"final","author":{"role":"assistant"},"role":"assistant",
            "channel":"final","recipient":"all",
            "content":{"content_type":"text","parts":["VISIBLE_ANSWER_SENTINEL"]},
            "create_time":1793142317}),
    ];
    let base = json!({"id":"same-source-conversation","title":"Visibility pair",
        "create_time":1793142314,"update_time":1793142317,"current_node":"final"});
    let mut linear = base.clone();
    linear["messages"] = json!(messages);
    let mut mapped = base;
    mapped["mapping"] = json!({"root":{"parent":null,"message":null}});
    for (i, message) in messages.iter().enumerate() {
        let id = message["id"].as_str().unwrap();
        let parent = if i == 0 {
            "root"
        } else {
            messages[i - 1]["id"].as_str().unwrap()
        };
        mapped["mapping"][id] = json!({"parent":parent,"message":message});
        assert_eq!(mapped["mapping"][id]["message"], linear["messages"][i]);
    }

    let mapped = parse_json(&json!([mapped]), "chatgpt");
    let linear = parse_json(&json!([linear]), "chatgpt");
    for archive in [&mapped, &linear] {
        assert_eq!(archive.conversations.len(), 1);
        assert_eq!(archive.skipped_blocks, 2);
        assert_eq!(archive.skipped_conversations, 0);
        let conversation = &archive.conversations[0];
        assert_eq!(conversation.external_key, hash(b"same-source-conversation"));
        assert_eq!(conversation.title, "Visibility pair");
        assert_eq!(
            conversation.created_at.as_deref(),
            Some("2026-10-27T23:05:14+00:00")
        );
        assert_eq!(
            conversation.updated_at.as_deref(),
            Some("2026-10-27T23:05:17+00:00")
        );
        let visible: Vec<_> = conversation
            .messages
            .iter()
            .map(|m| {
                (
                    m.id.as_str(),
                    m.role.as_str(),
                    m.content.as_str(),
                    m.created_at.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            visible,
            vec![
                (
                    "user",
                    "user",
                    "VISIBLE_USER_SENTINEL",
                    Some("2026-10-27T23:05:14+00:00")
                ),
                (
                    "final",
                    "assistant",
                    "VISIBLE_ANSWER_SENTINEL",
                    Some("2026-10-27T23:05:17+00:00")
                ),
            ]
        );
    }
    let mapped_messages = &mapped.conversations[0].messages;
    assert_eq!(mapped_messages[0].parent_id.as_deref(), Some("root"));
    assert_eq!(
        mapped_messages[1].parent_id.as_deref(),
        Some("tool-directed")
    );
    assert!(
        mapped_messages
            .iter()
            .all(|m| m.on_current_branch == Some(true))
    );
    assert!(
        linear.conversations[0]
            .messages
            .iter()
            .all(|m| { m.parent_id.is_none() && m.on_current_branch.is_none() })
    );
}

#[test]
fn linear_visibility_preserves_legacy_text_and_skips_each_internal_turn_once() {
    let fixture = json!({"id":"linear-compatibility","messages":[
        {"id":"legacy-user","role":"human","content":"legacy user",
            "created_at":"2026-10-28T02:00:00Z"},
        {"id":"legacy-assistant","author":{"role":"assistant"},
            "content":[{"type":"text","text":"legacy answer"}],"create_time":1793142314},
        {"id":"final","role":"assistant","channel":"final","recipient":"all",
            "content":{"parts":["explicit visible answer"]}},
        {"id":"null-metadata","role":"assistant","channel":null,"recipient":null,
            "content":"visible without metadata"},
        {"id":"analysis-only","role":"assistant","channel":"analysis","recipient":"all",
            "content":[{"type":"text","text":"hidden reasoning"},{"type":"image"}]},
        {"id":"recipient-only","role":"assistant","channel":"final","recipient":"browser",
            "content":{"parts":["tool command"]}}
    ]});
    // Both providers already recognize this linear compatibility shape.
    for selected in ["chatgpt", "deepseek"] {
        let archive = parse_json(&fixture, selected);
        assert_eq!(archive.skipped_blocks, 2);
        assert_eq!(archive.skipped_conversations, 0);
        let messages = &archive.conversations[0].messages;
        let visible: Vec<_> = messages
            .iter()
            .map(|m| (m.id.as_str(), m.role.as_str(), m.content.as_str()))
            .collect();
        assert_eq!(
            visible,
            vec![
                ("legacy-user", "user", "legacy user"),
                ("legacy-assistant", "assistant", "legacy answer"),
                ("final", "assistant", "explicit visible answer"),
                ("null-metadata", "assistant", "visible without metadata"),
            ]
        );
        assert_eq!(
            messages[0].created_at.as_deref(),
            Some("2026-10-28T02:00:00+00:00")
        );
        assert_eq!(
            messages[1].created_at.as_deref(),
            Some("2026-10-27T23:05:14+00:00")
        );
        assert!(
            messages
                .iter()
                .all(|m| m.parent_id.is_none() && m.on_current_branch.is_none())
        );
    }
}

#[test]
fn unknown_conversation_shapes_still_fail_visibly() {
    for selected in ["chatgpt", "claude", "deepseek"] {
        assert!(
            parse(
                br#"[{"id":"unknown","content":"visible-looking text"}]"#.to_vec(),
                "conversations.json",
                selected,
            )
            .is_err()
        );
    }
}
