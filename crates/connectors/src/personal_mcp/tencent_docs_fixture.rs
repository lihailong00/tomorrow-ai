use serde_json::{json, Value};
use std::sync::LazyLock;

static SCENARIO: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("tencent_docs_fixture.json"))
        .expect("valid Tencent Docs fixture")
});

const SEARCH: &str = "search_documents";
const READ: &str = "read_document";

pub(super) fn tools() -> Value {
    json!({"items":[
        {
            "name":SEARCH, "description":"按关键词搜索腾讯文档标题及团队，取得文档 ID。返回列表，不包含正文。",
            "inputSchema":{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":120}},
                "required":["query"],"additionalProperties":false}
        },
        {
            "name":READ, "description":"按搜索回执中的 document_id 读取腾讯文档正文。",
            "inputSchema":{"type":"object","properties":{"document_id":{"type":"string","minLength":1,"maxLength":80}},
                "required":["document_id"],"additionalProperties":false}
        }
    ]})
}

fn failure(code: &str, message: &str) -> Value {
    json!({"status":"failed","simulated":true,"error":{"code":code,"message":message}})
}

pub(super) fn call(tool: &str, arguments: &Value) -> Value {
    let (field, max) = match tool {
        SEARCH => ("query", 120),
        READ => ("document_id", 80),
        _ => {
            return failure(
                "fixture_tool_unavailable",
                "调试剧本仅开放文档搜索和正文读取",
            )
        }
    };
    let Some(value) = arguments
        .as_object()
        .filter(|args| args.len() == 1)
        .and_then(|args| args.get(field))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= max
                && !value.chars().any(char::is_control)
        })
    else {
        return failure(
            "fixture_invalid_arguments",
            "请按工具定义传入关键词或真实文档编号",
        );
    };
    let documents = SCENARIO["documents"]
        .as_array()
        .expect("valid fixture documents");
    let data = if tool == SEARCH {
        let items: Vec<_> = documents
            .iter()
            .filter(|document| {
                let title = document["title"].as_str().unwrap_or_default();
                let team = document["team"].as_str().unwrap_or_default();
                let project = title.strip_suffix("周会纪要").unwrap_or(title);
                let query = value.split_whitespace().collect::<String>();
                let required_team = ["研发", "销售"]
                    .into_iter()
                    .find(|name| query.contains(name));
                let named_project = ["青禾", "星桥"]
                    .into_iter()
                    .find(|name| query.contains(name));
                required_team.is_none_or(|name| team.contains(name))
                    && named_project.map_or_else(
                        || {
                            title.contains(&query)
                                || query.contains(title)
                                || team.contains(&query)
                                || query.contains(team)
                        },
                        |name| project == name,
                    )
            })
            .map(|document| {
                json!({
                    "document_id":document["document_id"], "title":document["title"],
                    "team":document["team"], "updated_at":document["updated_at"]
                })
            })
            .collect();
        json!({"items":items})
    } else {
        let Some(document) = documents
            .iter()
            .find(|document| document["document_id"] == value)
        else {
            return failure(
                "fixture_document_not_found",
                "未找到该文档，请使用搜索结果返回的文档编号",
            );
        };
        json!({"document_id":document["document_id"],"title":document["title"],"team":document["team"],
            "updated_at":document["updated_at"],"content":document["content"]})
    };
    json!({"status":"completed","simulated":true,"result":{"structuredContent":data}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_hides_answers_and_read_checks_exact_identifier() {
        let found = call(SEARCH, &json!({"query":"青禾周会"}));
        assert_eq!(
            found["result"]["structuredContent"]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(!found.to_string().contains("周宁"));
        assert_eq!(
            call(SEARCH, &json!({"query":"不存在"}))["result"]["structuredContent"]["items"],
            json!([])
        );
        let read = call(READ, &json!({"document_id":"sim-qinghe-rd-27"}));
        assert!(read["result"]["structuredContent"]["content"]
            .as_str()
            .unwrap()
            .contains("周宁"));
        let other = call(READ, &json!({"document_id":"sim-qinghe-sales-08"}));
        assert!(other["result"]["structuredContent"]["content"]
            .as_str()
            .unwrap()
            .contains("赵南"));
        assert_eq!(
            call(READ, &json!({"document_id":"invented"}))["error"]["code"],
            "fixture_document_not_found"
        );
        assert_eq!(
            call("create_document", &json!({}))["error"]["code"],
            "fixture_tool_unavailable"
        );
    }
}
