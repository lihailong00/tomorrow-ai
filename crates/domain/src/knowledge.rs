//! Small, source-backed fact graph inspired by Graphiti. Pi extracts; Rust validates and stores.
//! No inferred identity from a person's name, automatic contradiction handling, or embeddings.
use std::collections::{BTreeMap, BTreeSet};

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Any, Row, Transaction};

use crate::{new_id, now, validate_text, DomainError, Memory, Repository};

const MAX_EPISODES: i64 = 256;
const MAX_ENTITIES: usize = 16;
const MAX_FACTS: usize = 24;
const KINDS: &[&str] = &[
    "person",
    "project",
    "plan",
    "task",
    "technology",
    "place",
    "organization",
    "item",
];
const RELATIONS: &[&str] = &[
    "PROPOSED",
    "CONFIRMED",
    "USES",
    "RESPONSIBLE_FOR",
    "BELONGS_TO",
    "REPLACES",
    "PREFERS",
    "DEPENDS_ON",
];
const STATUSES: &[&str] = &["proposed", "confirmed", "reported", "negated"];

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GraphEntityInput {
    pub key: String,
    pub name: String,
    pub kind: String,
    /// Only a current, same-owner/scope/type/name entity returned by graph search may be reused.
    pub match_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GraphFactInput {
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub status: String,
    pub quote: String,
    pub occurred_on: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GraphIndexInput {
    pub memory_id: String,
    pub version: i64,
    /// A literal project/topic name present in the source, not an inferred global namespace.
    pub scope: String,
    pub entities: Vec<GraphEntityInput>,
    pub facts: Vec<GraphFactInput>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GraphSearch {
    #[serde(default)]
    pub query: String,
    pub scope: Option<String>,
    pub entity_id: Option<String>,
    pub from: Option<String>,
    pub before: Option<String>,
    pub limit: Option<usize>,
}

fn invalid(message: &str) -> DomainError {
    DomainError::Validation(message.into())
}
fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn contains_name(text: &str, name: &str) -> bool {
    normalized(text).contains(&normalized(name))
}
fn date(value: &str) -> Result<NaiveDate, DomainError> {
    if value.len() != 10 {
        return Err(invalid("日期须为 YYYY-MM-DD"));
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| invalid("日期须为有效的 YYYY-MM-DD"))
}

impl Repository {
    pub async fn index_memory_graph(
        &self,
        user_id: &str,
        input: GraphIndexInput,
    ) -> Result<Value, DomainError> {
        let mut tx = self.pool.begin().await?;
        let result = index_memory_graph_tx(&mut tx, user_id, input).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn delete_memory_graph(
        &self,
        user_id: &str,
        memory_id: &str,
    ) -> Result<(), DomainError> {
        // Do not disclose whether another user's source exists.
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM resources WHERE id=$1 AND user_id=$2 AND kind='memory'",
        )
        .bind(memory_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;
        if exists != 1 {
            return Err(DomainError::NotFound);
        }
        sqlx::query("DELETE FROM knowledge_episodes WHERE user_id=$1 AND memory_id=$2")
            .bind(user_id)
            .bind(memory_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn search_knowledge_graph(
        &self,
        user_id: &str,
        input: GraphSearch,
    ) -> Result<Value, DomainError> {
        if input.query.chars().count() > 200 {
            return Err(invalid("图查询最多 200 字"));
        }
        let limit = input.limit.unwrap_or(12);
        if !(1..=30).contains(&limit) {
            return Err(invalid("图查询 limit 须为 1–30"));
        }
        if let Some(scope) = &input.scope {
            validate_text(scope, "图范围", 80)?;
        }
        if let Some(value) = &input.from {
            date(value)?;
        }
        if let Some(value) = &input.before {
            date(value)?;
        }
        if matches!((&input.from, &input.before), (Some(a), Some(b)) if a >= b) {
            return Err(invalid("起始日期须早于结束日期"));
        }
        // Source equality hides stale indexes even when edits/deletes came from another API/tool.
        // The 256-source / 24-fact ingestion limits bound this first-version in-process ranking.
        let rows = sqlx::query("SELECT f.id,f.subject_id,f.object_id,f.relation,f.status,f.quote,f.occurred_on,e.memory_id,e.source_version,e.title,e.scope,r.body AS memory_body,s.name AS subject_name,s.kind AS subject_kind,o.name AS object_name,o.kind AS object_kind FROM knowledge_facts f JOIN knowledge_episodes e ON e.id=f.episode_id AND e.user_id=f.user_id JOIN resources r ON r.id=e.memory_id AND r.user_id=e.user_id AND r.kind='memory' AND r.body=e.source_body JOIN knowledge_entities s ON s.id=f.subject_id AND s.user_id=f.user_id JOIN knowledge_entities o ON o.id=f.object_id AND o.user_id=f.user_id WHERE f.user_id=$1 ORDER BY f.created_at DESC,f.id")
            .bind(user_id).fetch_all(&self.pool).await?;
        let terms = search_terms(&input.query);
        let mut candidates = Vec::new();
        for row in rows {
            let memory: Memory = serde_json::from_str(row.get::<&str, _>("memory_body"))
                .map_err(|_| DomainError::Internal("记忆格式无效".into()))?;
            if !crate::memory_quality::ready(&memory) { continue; }
            let scope: String = row.get("scope");
            if input
                .scope
                .as_ref()
                .is_some_and(|s| normalized(s) != normalized(&scope))
            {
                continue;
            }
            let day: String = row.get("occurred_on");
            if input
                .from
                .as_ref()
                .is_some_and(|s| day.is_empty() || &day < s)
                || input
                    .before
                    .as_ref()
                    .is_some_and(|s| day.is_empty() || &day >= s)
            {
                continue;
            }
            let subject_id: String = row.get("subject_id");
            let object_id: String = row.get("object_id");
            if input
                .entity_id
                .as_ref()
                .is_some_and(|id| id != &subject_id && id != &object_id)
            {
                continue;
            }
            let subject: String = row.get("subject_name");
            let object: String = row.get("object_name");
            let quote: String = row.get("quote");
            let title: String = row.get("title");
            let names = normalized(&format!("{subject} {object} {scope}"));
            let text = normalized(&format!("{quote} {title}"));
            let score: usize = terms
                .iter()
                .map(|t| usize::from(names.contains(t)) * 4 + usize::from(text.contains(t)))
                .sum();
            let value = json!({"id":row.get::<String,_>("id"),"subject":{"id":subject_id,"name":subject,"kind":row.get::<String,_>("subject_kind")},"relation":row.get::<String,_>("relation"),"object":{"id":object_id,"name":object,"kind":row.get::<String,_>("object_kind")},"status":row.get::<String,_>("status"),"occurred_on":if day.is_empty(){None}else{Some(day.clone())},"scope":scope,"source":{"kind":"memory","id":row.get::<String,_>("memory_id"),"version":row.get::<i64,_>("source_version"),"title":title,"quote":quote}});
            candidates.push((score, day, value));
        }
        let mut matched: Vec<_> = candidates
            .iter()
            .filter(|(score, _, _)| terms.is_empty() || *score > 0)
            .cloned()
            .collect();
        matched.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| a.2["id"].as_str().cmp(&b.2["id"].as_str()))
        });
        let matched_count = matched.len();
        matched.truncate(limit);
        // One-hop graph expansion supplements lexical entry points, never reintroduces filtered sources.
        let ids: BTreeSet<String> = matched
            .iter()
            .flat_map(|(_, _, v)| {
                [
                    v["subject"]["id"].as_str().unwrap().to_owned(),
                    v["object"]["id"].as_str().unwrap().to_owned(),
                ]
            })
            .collect();
        let selected: BTreeSet<String> = matched
            .iter()
            .map(|(_, _, v)| v["id"].as_str().unwrap().to_owned())
            .collect();
        let related: Vec<Value> = if terms.is_empty() {
            Vec::new()
        } else {
            candidates
                .iter()
                .filter(|(_, _, v)| {
                    !selected.contains(v["id"].as_str().unwrap())
                        && ["subject", "object"]
                            .iter()
                            .any(|key| ids.contains(v[key]["id"].as_str().unwrap()))
                })
                .take(limit)
                .map(|(_, _, v)| v.clone())
                .collect()
        };
        let mut entities = BTreeMap::new();
        for value in matched.iter().map(|(_, _, v)| v).chain(related.iter()) {
            for key in ["subject", "object"] {
                entities.insert(
                    value[key]["id"].as_str().unwrap().to_owned(),
                    value[key].clone(),
                );
            }
        }
        Ok(
            json!({"facts":matched.into_iter().map(|(_,_,v)|v).collect::<Vec<_>>(),"related_facts":related,"entities":entities.into_values().collect::<Vec<_>>(),"matched_count":matched_count,"has_more":matched_count>limit,"retrieval":"lexical_and_one_hop","source_policy":"current_saved_memory_versions_only","note":"关系是对原文的结构化解读，不是外部事实核验；proposed、reported、negated 不能当作 confirmed。未知日期不参与日期过滤；没有自动判断当前生效方案。"}),
        )
    }
}

pub(crate) async fn index_memory_graph_tx(
    tx: &mut Transaction<'_, Any>,
    user_id: &str,
    input: GraphIndexInput,
) -> Result<Value, DomainError> {
    if input.entities.is_empty()
        || input.entities.len() > MAX_ENTITIES
        || input.facts.is_empty()
        || input.facts.len() > MAX_FACTS
    {
        return Err(invalid("每条记忆需 1–16 个实体、1–24 条关系"));
    }
    let scope = normalized(&validate_text(&input.scope, "图范围", 80)?);
    // Serialize indexing with source edits/deletes and concurrent index requests, on both databases.
    let locked = sqlx::query(
        "UPDATE resources SET updated_at=updated_at WHERE id=$1 AND user_id=$2 AND kind='memory'",
    )
    .bind(&input.memory_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    if locked != 1 {
        return Err(DomainError::NotFound);
    }
    let body: String = sqlx::query_scalar(
        "SELECT body FROM resources WHERE id=$1 AND user_id=$2 AND kind='memory'",
    )
    .bind(&input.memory_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    let memory: Memory =
        serde_json::from_str(&body).map_err(|_| DomainError::Internal("记忆格式无效".into()))?;
    if !crate::memory_quality::ready(&memory) {
        return Err(DomainError::Validation("请先确认这条记忆，再整理关系".into()));
    }
    if input.version != memory.version {
        return Err(DomainError::Conflict(
            "原记忆已更新，请重新读取后提取关系".into(),
        ));
    }
    let text = format!("{}\n{}", memory.title, memory.content);
    if !contains_name(&text, &scope) {
        return Err(invalid("图范围须为原文明示的项目或主题名称"));
    }
    let encoded = serde_json::to_vec(&input).map_err(|_| invalid("图参数无效"))?;
    let hash = format!("{:x}", Sha256::digest(&encoded));
    let existing = sqlx::query("SELECT id,source_version,source_body,extraction_hash,entity_map FROM knowledge_episodes WHERE user_id=$1 AND memory_id=$2")
        .bind(user_id).bind(&input.memory_id).fetch_optional(&mut **tx).await?;
    if let Some(row) = &existing {
        if row.get::<String, _>("source_body") == body {
            if row.get::<String, _>("extraction_hash") != hash {
                return Err(DomainError::Conflict(
                    "该版本已有不同的图索引，请删除旧索引后重建".into(),
                ));
            }
            let entities: Value = serde_json::from_str(row.get("entity_map"))
                .map_err(|_| DomainError::Internal("图实体映射无效".into()))?;
            return Ok(
                json!({"episode_id":row.get::<String,_>("id"),"memory_id":memory.id,"source_version":memory.version,"entities":entities,"entity_count":input.entities.len(),"facts":input.facts.len(),"cached":true}),
            );
        }
    } else {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM knowledge_episodes WHERE user_id=$1")
                .bind(user_id)
                .fetch_one(&mut **tx)
                .await?;
        if count >= MAX_EPISODES {
            return Err(invalid("首版最多索引 256 条记忆，请先删除不用的图索引"));
        }
    }
    let mut local = BTreeMap::new();
    for entity in &input.entities {
        let key = validate_text(&entity.key, "实体局部编号", 40)?;
        let name = validate_text(&entity.name, "实体名称", 120)?;
        if !KINDS.contains(&entity.kind.as_str())
            || !contains_name(&text, &name)
            || local.contains_key(&key)
        {
            return Err(invalid("实体类型、原文名称或局部编号无效"));
        }
        local.insert(key, (name, entity));
    }
    let mut seen = BTreeSet::new();
    for fact in &input.facts {
        let (subject, _) = local
            .get(&fact.subject)
            .ok_or_else(|| invalid("关系主语不存在"))?;
        let (object, _) = local
            .get(&fact.object)
            .ok_or_else(|| invalid("关系宾语不存在"))?;
        let quote = validate_text(&fact.quote, "原文证据", 1200)?;
        if fact.subject == fact.object
            || !RELATIONS.contains(&fact.relation.as_str())
            || !STATUSES.contains(&fact.status.as_str())
            || !text.contains(&quote)
            || !contains_name(&quote, subject)
            || !contains_name(&quote, object)
        {
            return Err(invalid(
                "关系须有同时包含两端实体的原文证据，且类型、状态有效",
            ));
        }
        if !seen.insert((
            &fact.subject,
            &fact.relation,
            &fact.object,
            &fact.status,
            &fact.quote,
            &fact.occurred_on,
        )) {
            return Err(invalid("同一次提取不能重复提交相同关系"));
        }
        if let Some(value) = &fact.occurred_on {
            let parsed = date(value)?;
            if !quote.contains(value)
                && !quote.contains(&format!(
                    "{}年{}月{}日",
                    parsed.year(),
                    parsed.month(),
                    parsed.day()
                ))
            {
                return Err(invalid("关系日期必须在这条原文证据中明示；未知日期请省略"));
            }
        }
    }
    let episode_id = existing
        .as_ref()
        .map(|r| r.get::<String, _>("id"))
        .unwrap_or_else(new_id);
    if existing.is_some() {
        sqlx::query("DELETE FROM knowledge_facts WHERE episode_id=$1 AND user_id=$2")
            .bind(&episode_id)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
        sqlx::query("UPDATE knowledge_episodes SET source_version=$1,source_body=$2,extraction_hash=$3,title=$4,scope=$5,created_at=$6 WHERE id=$7 AND user_id=$8")
            .bind(memory.version).bind(&body).bind(&hash).bind(&memory.title).bind(&scope).bind(now()).bind(&episode_id).bind(user_id).execute(&mut **tx).await?;
    } else {
        sqlx::query("INSERT INTO knowledge_episodes(id,user_id,memory_id,source_version,source_body,extraction_hash,title,scope,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(&episode_id).bind(user_id).bind(&memory.id).bind(memory.version).bind(&body).bind(&hash).bind(&memory.title).bind(&scope).bind(now()).execute(&mut **tx).await?;
    }
    let mut resolved = BTreeMap::new();
    for (key, (name, entity)) in local {
        let name_key = normalized(&name);
        let id: String = if let Some(id) = &entity.match_id {
            let row = sqlx::query("SELECT id,name_key FROM knowledge_entities WHERE id=$1 AND user_id=$2 AND scope=$3 AND kind=$4")
                .bind(id).bind(user_id).bind(&scope).bind(&entity.kind).fetch_optional(&mut **tx).await?.ok_or(DomainError::NotFound)?;
            if row.get::<String, _>("name_key") != name_key {
                return Err(invalid("首版只允许复用同范围同类型同名实体，不做昵称推断"));
            }
            row.get("id")
        } else {
            // People remain source-local unless the caller explicitly chooses a searched candidate.
            let identity = if entity.kind == "person" {
                format!("{}:{name_key}", memory.id)
            } else {
                name_key.clone()
            };
            sqlx::query("INSERT INTO knowledge_entities(id,user_id,scope,kind,name,name_key,identity_key,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)ON CONFLICT(user_id,scope,kind,identity_key)DO NOTHING")
                .bind(new_id()).bind(user_id).bind(&scope).bind(&entity.kind).bind(&name).bind(&name_key).bind(&identity).bind(now()).execute(&mut **tx).await?;
            sqlx::query_scalar("SELECT id FROM knowledge_entities WHERE user_id=$1 AND scope=$2 AND kind=$3 AND identity_key=$4")
                .bind(user_id).bind(&scope).bind(&entity.kind).bind(identity).fetch_one(&mut **tx).await?
        };
        resolved.insert(key, id);
    }
    for fact in &input.facts {
        let subject = &resolved[&fact.subject];
        let object = &resolved[&fact.object];
        if subject == object {
            return Err(invalid("实体对齐后不能生成自指关系"));
        }
        sqlx::query("INSERT INTO knowledge_facts(id,user_id,episode_id,subject_id,relation,object_id,status,quote,occurred_on,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(new_id()).bind(user_id).bind(&episode_id).bind(subject).bind(&fact.relation).bind(object).bind(&fact.status).bind(fact.quote.trim()).bind(fact.occurred_on.as_deref().unwrap_or("")).bind(now()).execute(&mut **tx).await?;
    }
    sqlx::query("UPDATE knowledge_episodes SET entity_map=$1 WHERE id=$2 AND user_id=$3")
        .bind(
            serde_json::to_string(&resolved)
                .map_err(|_| DomainError::Internal("图实体映射无效".into()))?,
        )
        .bind(&episode_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(
        json!({"episode_id":episode_id,"memory_id":memory.id,"source_version":memory.version,"entity_count":resolved.len(),"entities":resolved,"facts":input.facts.len(),"cached":false}),
    )
}

fn search_terms(query: &str) -> BTreeSet<String> {
    let mut result = BTreeSet::new();
    let mut word = String::new();
    let chars: Vec<char> = query.to_lowercase().chars().collect();
    for c in chars.iter().chain(std::iter::once(&' ')) {
        if c.is_ascii_alphanumeric() || *c == '_' {
            word.push(*c);
        } else if !word.is_empty() {
            result.insert(std::mem::take(&mut word));
        }
    }
    for pair in chars.windows(2) {
        if pair.iter().all(|c| !c.is_ascii() && c.is_alphanumeric()) {
            result.insert(pair.iter().collect());
        }
    }
    if result.is_empty() && !query.trim().is_empty() {
        result.insert(normalized(query));
    }
    result
}

pub(crate) fn tool_definitions(scope: &str) -> Vec<crate::agent::ToolDefinition> {
    let mut tools = vec![crate::agent::ToolDefinition {
        name: "search_knowledge_graph".into(),
        description: "查询已由用户主动整理的记忆关系，返回实体ID、提议/确认/否定状态、日期与原文证据，并补充一跳关系。项目决策、方案版本、人物分工可用。未索引不等于不存在，空结果可查 list_memories。没有向量检索或自动判定最终生效方案；必须核对原文与状态。from 含、before 不含，YYYY-MM-DD；未知日期会被日期过滤排除。".into(),
        parameters: json!({"type":"object","properties":{
            "query":{"type":"string","maxLength":200},"scope":{"type":"string","minLength":1,"maxLength":80},
            "entity_id":{"type":"string","minLength":1},"from":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},
            "before":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"},"limit":{"type":"integer","minimum":1,"maximum":30}
        },"required":[],"additionalProperties":false}),
    }];
    if scope == "chat" {
        tools.push(crate::agent::ToolDefinition {
            name:"index_memory_graph".into(),
            description:"仅当用户明确要求整理关系/建立图索引时使用。先 list_memories 读取准确ID、version、原文。针对一条已保存记忆，一次提取实体与关系；scope、name、quote 必须取原文，quote 必须同时包含关系两端名称；不得按共现编造关系或把AI猜测/提议当确认。日期仅填写quote明示的YYYY-MM-DD或中文年月日，未知则省略。先 search_knowledge_graph 查候选；人物不自动合并，仅上下文足以确认且已有同范围同类型同名ID时填写match_id，否则省略。不能自动扫描所有记录。".into(),
            parameters:json!({"type":"object","properties":{
                "memory_id":{"type":"string","minLength":1},"version":{"type":"integer","minimum":1},"scope":{"type":"string","minLength":1,"maxLength":80},
                "entities":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"object","properties":{
                    "key":{"type":"string","minLength":1,"maxLength":40},"name":{"type":"string","minLength":1,"maxLength":120},
                    "kind":{"type":"string","enum":KINDS},"match_id":{"type":"string","minLength":1}
                },"required":["key","name","kind"],"additionalProperties":false}},
                "facts":{"type":"array","minItems":1,"maxItems":24,"items":{"type":"object","properties":{
                    "subject":{"type":"string","minLength":1},"relation":{"type":"string","enum":RELATIONS},"object":{"type":"string","minLength":1},
                    "status":{"type":"string","enum":STATUSES},"quote":{"type":"string","minLength":1,"maxLength":1200},
                    "occurred_on":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$"}
                },"required":["subject","relation","object","status","quote"],"additionalProperties":false}}
            },"required":["memory_id","version","scope","entities","facts"],"additionalProperties":false}),
        });
    }
    tools
}
