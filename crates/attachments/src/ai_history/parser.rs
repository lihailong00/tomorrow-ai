//! Import only visible conversation text. Export formats are versioned by the
//! providers, so unknown shapes fail visibly instead of producing empty success.
use super::{Error, invalid};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    io::{Cursor, Read},
};

pub const MAX_FILE: usize = 25 * 1024 * 1024;
const MAX_JSON: usize = 96 * 1024 * 1024;
const MAX_TEXT: usize = 24 * 1024 * 1024;
const MAX_CONVERSATIONS: usize = 5000;
const MAX_MESSAGES: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub parent_id: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: Option<String>,
    /// None means the export does not identify an active branch.
    pub on_current_branch: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub external_key: String,
    pub title: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub messages: Vec<Message>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Archive {
    pub provider: String,
    pub conversations: Vec<Conversation>,
    pub skipped_conversations: usize,
    pub skipped_blocks: usize,
    pub warnings: Vec<String>,
}
pub fn provider(value: &str) -> Result<&str, Error> {
    match value {
        "chatgpt" | "claude" | "deepseek" => Ok(value),
        _ => Err(invalid("请选择 ChatGPT、Claude 或 DeepSeek")),
    }
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn timestamp(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|v| v.to_utc().to_rfc3339());
    }
    let mut seconds = value.as_f64()?;
    if !seconds.is_finite() {
        return None;
    }
    if seconds > 100_000_000_000.0 {
        seconds /= 1000.0;
    }
    chrono::DateTime::from_timestamp_millis((seconds * 1000.0) as i64).map(|v| v.to_rfc3339())
}
fn time(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| timestamp(&v[k]))
}
fn identity(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match &v[*k] {
        Value::String(s) if !s.is_empty() && s.len() <= 512 => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn visible_text(v: &Value, skipped: &mut usize) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| {
                if let Some(s) = p.as_str() {
                    return Some(s.to_owned());
                }
                match p["type"].as_str().or_else(|| p["content_type"].as_str()) {
                    Some(
                        "text" | "input_text" | "output_text" | "text_transcription" | "voice_note",
                    ) => p["text"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| p["content"].as_str().map(str::to_owned)),
                    _ => {
                        *skipped += 1;
                        None
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => {
            if let Some(parts) = v.get("parts") {
                return visible_text(parts, skipped);
            }
            match v["content_type"].as_str().or_else(|| v["type"].as_str()) {
                Some("text" | "multimodal_text" | "text_transcription") => {
                    v["text"].as_str().unwrap_or_default().to_owned()
                }
                _ => {
                    *skipped += 1;
                    String::new()
                }
            }
        }
        _ => String::new(),
    }
}
fn role(value: &str) -> Option<&'static str> {
    match value {
        "user" | "human" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}

fn parse_conversation(
    v: &Value,
    selected: &str,
    skipped: &mut usize,
) -> Result<Option<Conversation>, Error> {
    let mut messages = Vec::new();
    let mut warnings = Vec::new();
    if selected == "claude" {
        let raw = v["chat_messages"]
            .as_array()
            .ok_or_else(|| invalid("文件不是 Claude 对话导出格式，请检查所选来源"))?;
        let active = identity(v, &["current_leaf_message_uuid"]);
        let mut lineage = HashSet::new();
        if let Some(mut cursor) = active.clone() {
            let by_id: std::collections::HashMap<_, _> = raw
                .iter()
                .filter_map(|m| m["uuid"].as_str().map(|id| (id, m)))
                .collect();
            while let Some(m) = by_id.get(cursor.as_str()) {
                if !lineage.insert(cursor.clone()) {
                    return Err(invalid("Claude 对话包含循环分支，无法可靠恢复顺序"));
                }
                match m["parent_message_uuid"].as_str() {
                    Some(parent) => cursor = parent.into(),
                    None => break,
                }
            }
            if lineage.is_empty() {
                return Err(invalid("Claude 当前分支不存在，请重新导出"));
            }
        }
        for (index, m) in raw.iter().enumerate() {
            let Some(role) = role(
                m["sender"]
                    .as_str()
                    .or_else(|| m["role"].as_str())
                    .unwrap_or_default(),
            ) else {
                *skipped += 1;
                continue;
            };
            // Structured text is authoritative; legacy plain text is a fallback
            // only when there are no structured blocks (not hidden reasoning).
            let text = if m["content"].as_array().is_some_and(|a| !a.is_empty()) {
                visible_text(&m["content"], skipped)
            } else {
                m["text"].as_str().unwrap_or_default().to_owned()
            };
            if text.trim().is_empty() {
                continue;
            }
            let id = identity(m, &["uuid", "id"]).unwrap_or_else(|| format!("message-{index}"));
            messages.push(Message {
                on_current_branch: active.as_ref().map(|_| lineage.contains(&id)),
                id,
                parent_id: identity(m, &["parent_message_uuid"]),
                role: role.into(),
                content: text,
                created_at: time(m, &["created_at", "updated_at"]),
            });
            *skipped += m["attachments"].as_array().map_or(0, Vec::len)
                + m["files"].as_array().map_or(0, Vec::len);
        }
        if active.is_none() && raw.iter().any(|m| !m["parent_message_uuid"].is_null()) {
            warnings.push("此导出未指定当前分支；保留消息及父节点，展示顺序不能证明所有消息属于同一问答分支。".into());
        }
        // Missing timestamps must not reorder an assistant turn before its user.
        if messages.iter().all(|m| m.created_at.is_some()) {
            messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        }
    } else if let Some(mapping) = v["mapping"].as_object() {
        if mapping.len() > MAX_MESSAGES {
            return Err(invalid("单段对话节点过多，请拆分导入"));
        }
        let mut active = HashSet::new();
        let current = identity(v, &["current_node"]);
        if let Some(mut cursor) = current.clone() {
            loop {
                let node = mapping
                    .get(&cursor)
                    .ok_or_else(|| invalid("对话的当前分支指向缺失节点，请重新导出"))?;
                if !active.insert(cursor.clone()) {
                    return Err(invalid("对话包含循环分支"));
                }
                let Some(parent) = node["parent"].as_str() else {
                    break;
                };
                cursor = parent.into();
            }
        }
        // Traverse parent-first without trusting children arrays or recursing.
        let mut ordered = Vec::with_capacity(mapping.len());
        let mut done = HashSet::new();
        for id in mapping.keys() {
            let mut chain = Vec::new();
            let mut visiting = HashSet::new();
            let mut cursor = id.as_str();
            while !done.contains(cursor) {
                if !visiting.insert(cursor) {
                    return Err(invalid("对话包含循环分支"));
                }
                let node = mapping
                    .get(cursor)
                    .ok_or_else(|| invalid("对话缺少父节点，请重新导出"))?;
                chain.push(cursor);
                match node["parent"].as_str() {
                    Some(parent) => cursor = parent,
                    None => break,
                }
            }
            for key in chain.into_iter().rev() {
                if done.insert(key) {
                    ordered.push(key);
                }
            }
        }
        if current.is_none()
            && mapping
                .values()
                .any(|n| n["children"].as_array().is_some_and(|a| a.len() > 1))
        {
            warnings.push(
                "此导出包含多个分支且未指定当前分支；保留原始父节点关系，请勿视为连续问答。".into(),
            );
        }
        for id in ordered {
            let node = &mapping[id];
            let m = &node["message"];
            if m.is_null() {
                continue;
            }
            let parent = identity(node, &["parent"]);
            let created_at = time(m, &["create_time", "created_at", "inserted_at"])
                .or_else(|| time(node, &["created_at", "inserted_at"]));
            if selected == "deepseek" {
                let fragments = m["fragments"]
                    .as_array()
                    .ok_or_else(|| invalid("文件不是 DeepSeek 导出格式，请检查所选来源"))?;
                for (i, f) in fragments.iter().enumerate() {
                    let role = match f["type"].as_str() {
                        Some("REQUEST") => "user",
                        Some("RESPONSE") => "assistant",
                        _ => {
                            *skipped += 1;
                            continue;
                        }
                    };
                    let content = f["content"].as_str().unwrap_or_default();
                    if content.trim().is_empty() {
                        continue;
                    }
                    messages.push(Message {
                        id: format!("{id}/{i}"),
                        parent_id: parent.clone(),
                        role: role.into(),
                        content: content.into(),
                        created_at: created_at.clone(),
                        on_current_branch: current.as_ref().map(|_| active.contains(id)),
                    });
                }
            } else {
                let Some(role) = role(m["author"]["role"].as_str().unwrap_or_default()) else {
                    *skipped += 1;
                    continue;
                };
                // Internal/analysis messages and tool-directed turns are not user-visible replies.
                if m["channel"].as_str().is_some_and(|c| c != "final")
                    || m["recipient"].as_str().is_some_and(|r| r != "all")
                {
                    *skipped += 1;
                    continue;
                }
                let content = visible_text(&m["content"], skipped);
                if content.trim().is_empty() {
                    continue;
                }
                messages.push(Message {
                    id: id.into(),
                    parent_id: parent,
                    role: role.into(),
                    content,
                    created_at,
                    on_current_branch: current.as_ref().map(|_| active.contains(id)),
                });
            }
        }
    } else if let Some(raw) = v["messages"].as_array() {
        // Some provider export versions already linearize the visible messages.
        for (i, m) in raw.iter().enumerate() {
            let Some(role) = role(
                m["role"]
                    .as_str()
                    .or_else(|| m["author"]["role"].as_str())
                    .unwrap_or_default(),
            ) else {
                *skipped += 1;
                continue;
            };
            let content = visible_text(&m["content"], skipped);
            if !content.trim().is_empty() {
                messages.push(Message {
                    id: identity(m, &["id"]).unwrap_or_else(|| format!("message-{i}")),
                    parent_id: None,
                    role: role.into(),
                    content,
                    created_at: time(m, &["created_at", "create_time"]),
                    on_current_branch: None,
                });
            }
        }
    } else {
        return Err(invalid(
            "没有识别到对应平台的对话结构，请选择官方导出的 JSON 或 ZIP 文件",
        ));
    }
    if messages.is_empty() {
        return Ok(None);
    }
    if messages.iter().any(|m| m.content.len() > 2 * 1024 * 1024) {
        return Err(invalid("单条消息超过 2 MB，请拆分导入"));
    }
    let title = v["title"]
        .as_str()
        .or_else(|| v["name"].as_str())
        .unwrap_or("未命名对话")
        .chars()
        .take(240)
        .collect();
    let external_key = identity(v, &["id", "uuid", "conversation_id"])
        .map(|s| hash(s.as_bytes()))
        .unwrap_or_else(|| {
            hash(
                serde_json::to_string(&messages)
                    .unwrap_or_default()
                    .as_bytes(),
            )
        });
    Ok(Some(Conversation {
        external_key,
        title,
        created_at: time(v, &["create_time", "created_at", "inserted_at"]),
        updated_at: time(v, &["update_time", "updated_at"]),
        messages,
        warnings,
    }))
}

fn json_files(
    bytes: Vec<u8>,
    name: &str,
    depth: usize,
    budget: &mut usize,
    files: &mut Vec<Vec<u8>>,
) -> Result<(), Error> {
    if bytes.starts_with(b"PK\x03\x04") {
        if depth > 1 {
            return Err(invalid("压缩包嵌套过深，请解压后选择 conversations.json"));
        }
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|_| invalid("ZIP 文件损坏或格式不支持"))?;
        if zip.len() > 20_000 {
            return Err(invalid("压缩包文件数量过多"));
        }
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|_| invalid("无法读取 ZIP 文件，暂不支持加密压缩包"))?;
            let Some(path) = entry.enclosed_name() else {
                return Err(invalid("压缩包包含不安全的文件路径"));
            };
            let base = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            let candidate = base == "conversations.json"
                || (base.starts_with("conversations-")
                    && (base.ends_with(".json") || base.ends_with(".zip")));
            if !candidate || entry.is_dir() {
                continue;
            }
            if entry.size() > *budget as u64 || files.len() >= 256 {
                return Err(invalid("解压后的对话记录超过限制，请拆分导入"));
            }
            let mut data = Vec::new();
            (&mut entry)
                .take((*budget + 1) as u64)
                .read_to_end(&mut data)
                .map_err(|_| invalid("对话文件解压失败"))?;
            if data.len() > *budget {
                return Err(invalid("解压后的对话记录超过 96 MB"));
            }
            *budget -= data.len();
            json_files(data, &base, depth + 1, budget, files)?;
        }
    } else if name.to_lowercase().ends_with(".json") {
        files.push(bytes);
    } else {
        return Err(invalid("请选择官方导出的 ZIP 或 JSON 文件"));
    }
    Ok(())
}

pub fn parse(bytes: Vec<u8>, name: &str, selected: &str) -> Result<Archive, Error> {
    provider(selected)?;
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Err(invalid(
            "导出文件需在 1 字节到 25 MB 之间；大文件可解压后分批选择对话 JSON",
        ));
    }
    let mut files = Vec::new();
    let mut budget = MAX_JSON;
    json_files(bytes, name, 0, &mut budget, &mut files)?;
    if files.is_empty() {
        return Err(invalid(
            "压缩包里没有 conversations.json 或 conversations-*.json",
        ));
    }
    let mut result = Archive {
        provider: selected.into(),
        conversations: Vec::new(),
        skipped_conversations: 0,
        skipped_blocks: 0,
        warnings: vec![
            "只导入用户与 AI 的可见文字；图片、音视频、附件文件、思考过程和工具调用不导入。".into(),
        ],
    };
    let mut text_bytes = 0;
    let mut message_count = 0;
    let mut keys = BTreeSet::new();
    for file in files {
        let file = file.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&file);
        let root: Value = serde_json::from_slice(file)
            .map_err(|_| invalid("JSON 文件无效或嵌套过深，请重新导出"))?;
        let raw: Vec<&Value> = if let Some(a) = root.as_array() {
            a.iter().collect()
        } else if let Some(a) = root["conversations"]
            .as_array()
            .or_else(|| root["chats"].as_array())
        {
            a.iter().collect()
        } else if root.get("mapping").is_some()
            || root.get("chat_messages").is_some()
            || root.get("messages").is_some()
        {
            vec![&root]
        } else {
            return Err(invalid(
                "文件中没有找到对话列表，请勿选择 users.json 等账号文件",
            ));
        };
        for v in raw {
            if let Some(c) = parse_conversation(v, selected, &mut result.skipped_blocks)? {
                if !keys.insert(c.external_key.clone()) {
                    result.skipped_conversations += 1;
                    continue;
                }
                text_bytes += c.messages.iter().map(|m| m.content.len()).sum::<usize>();
                message_count += c.messages.len();
                result.conversations.push(c);
                if result.conversations.len() > MAX_CONVERSATIONS
                    || message_count > MAX_MESSAGES
                    || text_bytes > MAX_TEXT
                {
                    return Err(invalid(
                        "本次最多导入 5000 段对话、10 万条消息或 24 MB 正文，请拆分导入",
                    ));
                }
            } else {
                result.skipped_conversations += 1;
            }
        }
    }
    if result.conversations.is_empty() {
        return Err(invalid("没有找到可导入的用户或 AI 文字消息"));
    }
    Ok(result)
}
