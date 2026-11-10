//! Resolve personal fields inside the trusted host, never by rewriting DSH's
//! already logged tool arguments. Provider writes still use the MCP action journal.
use crate::{
    client_context::{ClientContext, CoordinateSystem, LocationSource, RuntimeLocation},
    AppState, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use tomorrow_domain::{DomainError, Memory, Repository};

const DELIVERY_PROVIDER: &str = "mcdonalds";
const DELIVERY_ADDRESS_LIST: &str = "delivery-query-addresses";
const DELIVERY_ADDRESS_CREATE: &str = "delivery-create-address";

fn personal_delivery_request(message: &str) -> bool {
    let says = |terms: &[&str]| terms.iter().any(|term| message.contains(*term));
    says(&["麦当劳", "麦乐送"])
        && says(&["外卖", "外送", "配送", "麦乐送", "送到"])
        && !says(&[
            "自取", "堂食", "给朋友", "帮朋友", "替朋友", "给同事", "帮同事", "替同事",
            "给别人", "帮别人", "替别人", "给他", "给她", "替他", "替她", "不要", "别用", "团餐",
        ])
}

pub(crate) fn delivery_subject_for_turn(message: &str, previous_user_message: Option<&str>) -> Option<&'static str> {
    let first_clause = message.split(['，', ',', '。', '！', '？']).next().unwrap_or_default().trim();
    let choice = first_clause.trim_start_matches("那就").trim_start_matches("配送地址")
        .trim_start_matches("地址").trim_start_matches("就").trim_end_matches('吧').trim();
    let choices = ["用我现在的位置", "使用我现在的位置", "用我当前的位置", "用我的当前位置",
        "用当前位置", "使用当前位置", "用我现在的地址", "用我当前的地址"];
    let direct = personal_delivery_request(message) && choices.iter().chain(
        ["送到当前位置", "送到我现在的位置", "送到我当前的位置"].iter(),
    ).any(|choice| message.contains(*choice));
    let followup = choices.contains(&choice) && previous_user_message.is_some_and(personal_delivery_request);
    if direct || followup {
        return Some("self");
    }
    delivery_subject(message)
}

fn delivery_subject(message: &str) -> Option<&'static str> {
    if !personal_delivery_request(message) { return None; }
    let says = |terms: &[&str]| terms.iter().any(|term| message.contains(*term));
    if says(&["送到我家", "送到家", "送我家", "送到家里"]) { return Some("home"); }
    if says(&["送到我公司", "送到公司", "送到办公室"]) { return Some("work"); }
    if says(&["送到", "地址", "朋友", "同事", "酒店", "宾馆", "学校", "我不在家"]) { return None; }
    says(&["我想点", "我想吃", "我饿", "我有点饿", "我现在有点饿", "给我点", "帮我点"])
        .then_some("home")
}

struct LocatedAddress {
    city: String,
    address: String,
}

fn prefill_delivery_location(fields: &mut [Field], address: Option<&LocatedAddress>) {
    for field in fields {
        let value = match field.semantic {
            PersonalField::Address => address.map(|address| &address.address),
            PersonalField::City => address.map(|address| &address.city),
            _ => continue,
        };
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            field.value.clone_from(value);
            field.source = "本次选择的位置，请核对".into();
        } else {
            field.value.clear();
            field.source = "未解析到地址，请填写".into();
        }
    }
}

async fn locate_delivery_address(state: &AppState, user: &str, location: RuntimeLocation) -> Option<LocatedAddress> {
    let context = ClientContext { timezone: "UTC".into(), location: Some(location.original) };
    if context.location_status(chrono::Utc::now()) != "available" { return None; }
    let original = context.location.as_ref()?;
    if original.source == LocationSource::Manual {
        let address = original.label.clone()?;
        return Some(LocatedAddress { city: address_part(&address, PersonalField::City), address });
    }
    // Resolve through the user's connected map service, with the already converted coordinate.
    let point = location.map_coordinates.filter(|point| point.coordinate_system == CoordinateSystem::Gcj02)?;
    let result = state.integrations.as_ref()?.read(user, "amap", json!({"operation":"reverse_geocode",
        "location":format!("{:.6},{:.6}", point.longitude, point.latitude)})).await.ok()?;
    Some(LocatedAddress { city: result["city"].as_str().unwrap_or_default().into(), address: result["address"].as_str()?.into() })
}

fn mcd_delivery_data(result: &Value) -> Option<Value> {
    let envelope = &result["result"];
    if result["status"] != "completed" || envelope["isError"] == true { return None; }
    let body = match envelope.get("structuredContent").filter(|value| !value.is_null()) {
        Some(value) => value.clone(),
        None => {
            let [entry] = envelope["content"].as_array()?.as_slice() else { return None; };
            if entry["type"] != "text" { return None; }
            serde_json::from_str(entry["text"].as_str()?).ok()?
        }
    };
    (body["success"] == true && body["code"] == 200).then(|| body["data"].clone())
}

fn delivery_address_id(result: &Value) -> Option<String> {
    let data = mcd_delivery_data(result)?;
    let id = data["addressId"].as_str()?;
    (!id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
        .then(|| id.to_owned())
}

fn delivery_addresses_empty(result: &Value) -> bool {
    mcd_delivery_data(result).is_some_and(|data| {
        data["addresses"].as_array().is_some_and(Vec::is_empty)
    })
}

fn delivery_store_arguments(catalog: &Value, address_id: &str) -> Option<Value> {
    let tool = catalog["items"].as_array()?.iter().find(|tool| tool["name"] == "delivery-query-stores")?;
    let properties = &tool["inputSchema"]["properties"];
    let be_type = match properties["beType"]["type"].as_str()? {
        "string" => json!("2"),
        "number" | "integer" => json!(2),
        _ => return None,
    };
    (properties["addressId"]["type"] == "string").then(|| json!({"addressId":address_id,"beType":be_type}))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PersonalField {
    Name,
    Phone,
    Email,
    Address,
    City,
    AddressDetail,
    Company,
    InvoiceTitle,
}

impl PersonalField {
    fn labels(self, subject: &str) -> &[&str] {
        match self {
            Self::Name => &["姓名", "我的姓名", "收件人姓名"],
            Self::Phone => &[
                "手机号",
                "手机号码",
                "联系电话",
                "我的电话",
                "电话号码",
                "我的手机号",
            ],
            Self::Email => &["邮箱", "电子邮箱", "我的邮箱"],
            Self::Address if subject == "home" => &["家庭地址", "我家地址", "住址"],
            Self::Address if subject == "work" => &["公司地址", "工作地址"],
            Self::City if subject == "home" => &["家庭所在城市"],
            Self::City if subject == "work" => &["公司所在城市"],
            Self::AddressDetail if subject == "home" => &["家庭门牌号"],
            Self::AddressDetail if subject == "work" => &["公司门牌号"],
            Self::Company => &["公司名称", "我的公司"],
            Self::InvoiceTitle => &["发票抬头"],
            _ => &[],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Name => "联系人",
            Self::Phone => "联系电话",
            Self::Email => "电子邮箱",
            Self::Address => "完整地址",
            Self::City => "城市",
            Self::AddressDetail => "门牌及楼栋",
            Self::Company => "公司名称",
            Self::InvoiceTitle => "发票抬头",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    provider: String,
    tool: String,
    purpose: String,
    subject: String,
    #[serde(default)]
    arguments: Map<String, Value>,
    #[serde(default)]
    bindings: BTreeMap<String, PersonalField>,
}

#[derive(Clone, Serialize)]
pub(crate) struct Field {
    pub key: String,
    pub label: String,
    pub semantic: PersonalField,
    pub value: String,
    pub source: String,
    pub required: bool,
}

fn invalid(message: &str) -> DomainError {
    DomainError::Validation(message.into())
}

// Only explicit named facts, not arbitrary chat text, AI history, inferred facts
// or another person's contact. More than one distinct value is a conflict.
fn from_memories(memories: &[Memory], field: PersonalField, subject: &str) -> (String, String) {
    if subject == "other" {
        return (String::new(), "待填写".into());
    }
    let mut values = BTreeSet::new();
    for memory in memories {
        if !tomorrow_domain::memory_quality::ready(memory) {
            continue;
        }
        let label = memory.title.trim();
        if !field.labels(subject).contains(&label) {
            continue;
        }
        let text = memory.content.trim();
        let text = text
            .strip_prefix(label)
            .and_then(|s| s.strip_prefix(['：', ':']))
            .map(str::trim)
            .unwrap_or(text);
        if !text.is_empty() && text.chars().count() <= 500 && !text.chars().any(char::is_control) {
            values.insert(text.to_owned());
        }
    }
    if values.len() == 1 {
        (values.into_iter().next().unwrap(), "已保存资料".into())
    } else if values.len() > 1 {
        (String::new(), "存在多个不同值，请选择或填写".into())
    } else {
        (String::new(), "待填写".into())
    }
}

pub(crate) fn travel_addresses(memories: &[Memory]) -> Map<String, Value> {
    ["home", "work"]
        .into_iter()
        .filter_map(|subject| {
            let (address, _) = from_memories(memories, PersonalField::Address, subject);
            (!address.is_empty() && address.chars().count() <= 200)
                .then(|| (subject.to_owned(), Value::String(address)))
        })
        .collect()
}

async fn facts(
    repo: &Repository,
    user: &str,
    bindings: &BTreeMap<String, PersonalField>,
    subject: &str,
) -> Result<Vec<Memory>> {
    let mut memories = BTreeMap::new();
    let mut labels = BTreeSet::new();
    for field in bindings
        .values()
        .chain(std::iter::once(&PersonalField::Address))
    {
        labels.extend(field.labels(subject).iter().copied());
    }
    if subject == "other" {
        return Ok(Vec::new());
    }
    let expired: Vec<String> = sqlx::query_scalar("SELECT memory_id FROM memory_provenance WHERE user_id=$1 AND expires_at>0 AND expires_at<=$2")
        .bind(user).bind(chrono::Utc::now().timestamp()).fetch_all(&repo.pool()).await
        .map_err(|e| DomainError::Internal(e.to_string()))?;
    for label in labels {
        let mut offset = 0;
        loop {
            let (items, next) = repo
                .search_memories_page(user, None, Some(label), offset, 100)
                .await?;
            for item in items {
                if !expired.contains(&item.id) {
                    memories.insert(item.id.clone(), item);
                }
            }
            match next {
                Some(next) if next < 5000 => offset = next,
                Some(_) => return Err(invalid("资料匹配过多，请整理同名资料后重试").into()),
                None => break,
            }
        }
    }
    Ok(memories.into_values().collect())
}

fn address_part(address: &str, field: PersonalField) -> String {
    if field == PersonalField::City {
        let address = address
            .split_once('省')
            .map(|(_, city)| city)
            .unwrap_or(address);
        return address
            .find('市')
            .map(|at| address[..at + '市'.len_utf8()].to_owned())
            .unwrap_or_default();
    }
    if field == PersonalField::AddressDetail {
        // Preserve the exact user-supplied suffix; never invent a door number.
        if let Some((at, _)) = address.char_indices().find(|(_, c)| c.is_ascii_digit()) {
            let suffix = &address[at..];
            if suffix.contains(['栋', '幢', '室', '号', '单']) {
                return suffix.to_owned();
            }
        }
    }
    String::new()
}

fn bindings(input: &Input, schema: &Value) -> Result<BTreeMap<String, PersonalField>> {
    let mut bindings = input.bindings.clone();
    // Reviewed adapter. Other providers use explicit semantic bindings against
    // the live schema, with the destination and resolved values visible in-card.
    if input.provider == "mcdonalds" && input.tool == "delivery-create-address" {
        for (key, field) in [
            ("contactName", PersonalField::Name),
            ("phone", PersonalField::Phone),
            ("city", PersonalField::City),
            ("address", PersonalField::Address),
            ("addressDetail", PersonalField::AddressDetail),
        ] {
            if schema["properties"].get(key).is_some() {
                if bindings.get(key).is_some_and(|value| *value != field) {
                    return Err(invalid("字段用途与平台适配定义冲突").into());
                }
                bindings.insert(key.into(), field);
            }
        }
    }
    if bindings.is_empty() || bindings.len() > 12 {
        return Err(invalid("请指定 1 至 12 个需要补全的个人资料字段").into());
    }
    for key in bindings.keys() {
        if key.len() > 80
            || !schema["properties"]
                .get(key)
                .is_some_and(|p| p["type"] == "string")
        {
            return Err(invalid("个人资料字段必须来自该工具实际定义的字符串参数").into());
        }
        if matches!(
            key.to_ascii_lowercase().as_str(),
            "token" | "password" | "secret" | "api_key" | "url" | "endpoint"
        ) {
            return Err(invalid("凭证或服务地址不能用个人资料补全").into());
        }
    }
    Ok(bindings)
}

fn resolved_fields(
    input: &Input,
    schema: &Value,
    bindings: &BTreeMap<String, PersonalField>,
    memories: &[Memory],
    user: &tomorrow_domain::User,
) -> Result<Vec<Field>> {
    let (address, _) = from_memories(memories, PersonalField::Address, &input.subject);
    let mut fields = Vec::new();
    for (key, semantic) in bindings {
        let (mut value, mut source) = from_memories(memories, *semantic, &input.subject);
        let explicit = input
            .arguments
            .get(key)
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| invalid("个人资料参数必须是文本"))
            })
            .transpose()?
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(explicit) = explicit {
            value = explicit.into();
            source = "本次提供".into();
        } else if value.is_empty() && source == "待填写" && input.subject != "other" {
            value = match semantic {
                PersonalField::Name => user.name.clone(),
                PersonalField::Phone => user.phone.clone().unwrap_or_default(),
                // Login-only placeholder emails must not become business data.
                PersonalField::Email
                    if !user.email.ends_with(".invalid") && !user.email.ends_with(".local") =>
                {
                    user.email.clone()
                }
                PersonalField::City | PersonalField::AddressDetail => {
                    address_part(&address, *semantic)
                }
                _ => String::new(),
            };
            if !value.is_empty() {
                source =
                    if matches!(semantic, PersonalField::City | PersonalField::AddressDetail) {
                        "已保存地址"
                    } else {
                        "账号资料，请核对"
                    }
                    .into();
            }
        }
        fields.push(Field {
            key: key.clone(),
            label: semantic.label().into(),
            semantic: *semantic,
            value,
            source,
            required: schema["required"]
                .as_array()
                .is_some_and(|r| r.iter().any(|v| v.as_str() == Some(key))),
        });
    }
    Ok(fields)
}

pub(crate) fn apply_values(
    fields: &[Field],
    values: &BTreeMap<String, String>,
) -> std::result::Result<Map<String, Value>, DomainError> {
    if values.len() != fields.len() || values.keys().any(|k| !fields.iter().any(|f| &f.key == k)) {
        return Err(invalid("提交的字段与当前卡片不匹配"));
    }
    let mut out = Map::new();
    for field in fields {
        let value = values[&field.key].trim();
        if (field.required && value.is_empty())
            || value.chars().count() > 500
            || value.chars().any(char::is_control)
        {
            return Err(invalid(&format!("请核对{}", field.label)));
        }
        if !value.is_empty()
            && field.semantic == PersonalField::Phone
            && (value.chars().filter(char::is_ascii_digit).count() < 7
                || !value
                    .chars()
                    .all(|c| c.is_ascii_digit() || "+- ()".contains(c)))
        {
            return Err(invalid("请核对联系电话"));
        }
        if !value.is_empty()
            && field.semantic == PersonalField::Email
            && (!value.contains('@') || value.contains(' '))
        {
            return Err(invalid("请核对电子邮箱"));
        }
        if !value.is_empty() {
            out.insert(field.key.clone(), json!(value));
        }
    }
    Ok(out)
}

pub(crate) fn validate_values(
    fields: &[Field],
    values: &BTreeMap<String, String>,
    schema: &Value,
    provider: &str,
    tool: &str,
) -> std::result::Result<Map<String, Value>, DomainError> {
    let filled = apply_values(fields, values)?;
    for field in fields {
        let Some(value) = filled.get(&field.key).and_then(Value::as_str) else {
            continue;
        };
        let definition = &schema["properties"][&field.key];
        let len = value.chars().count() as u64;
        if definition["minLength"].as_u64().is_some_and(|n| len < n)
            || definition["maxLength"].as_u64().is_some_and(|n| len > n)
            || definition["enum"]
                .as_array()
                .is_some_and(|items| !items.contains(&json!(value)))
        {
            return Err(invalid(&format!(
                "{}不符合平台字段要求，请修改后重试",
                field.label
            )));
        }
    }
    if provider == "mcdonalds"
        && tool == "delivery-create-address"
        && !filled
            .get("phone")
            .and_then(Value::as_str)
            .is_some_and(|p| p.len() == 11 && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(invalid("麦当劳联系电话需要 11 位数字"));
    }
    Ok(filled)
}

fn redact(value: &mut Value, personal: &[String]) {
    match value {
        Value::String(s) => {
            for text in personal {
                if !text.is_empty() {
                    *s = s.replace(text, "[已使用个人资料]");
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact(item, personal);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                redact(item, personal);
            }
        }
        _ => (),
    }
}

pub(crate) async fn execute(
    state: &AppState,
    run: &str,
    token: &str,
    user_id: &str,
    operation: u32,
    args: Value,
) -> Result<Value> {
    execute_form(state, run, token, user_id, &format!("{run}:mcp:personal:{operation}"), args, None).await
}

pub(crate) async fn query_delivery_addresses(
    state: &AppState,
    run: &str,
    token: &str,
    user_id: &str,
    arguments: Value,
    operation_key: &str,
) -> Result<Value> {
    let mcp = state.personal_mcp.as_ref().ok_or_else(|| invalid("个人 MCP 连接尚未配置"))?;
    let Some(subject) = state.interactions.delivery_subject(run, user_id) else {
        return Ok(mcp.invoke_scoped(user_id, DELIVERY_PROVIDER, DELIVERY_ADDRESS_LIST, arguments, operation_key)
            .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?);
    };
    let (catalog, generation) = mcp.personal_form_catalog(user_id, DELIVERY_PROVIDER)
        .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?;
    let mut addresses = mcp.invoke_personal_form(user_id, DELIVERY_PROVIDER, DELIVERY_ADDRESS_LIST, arguments, operation_key, generation)
        .await.map_err(tomorrow_connectors::ConnectorError::into_domain)?;
    if !delivery_addresses_empty(&addresses) ||
        !catalog["items"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["name"] == DELIVERY_ADDRESS_CREATE)) {
        return Ok(addresses);
    }
    let mut form = execute_form(state, run, token, user_id, &format!("{run}:mcp:personal:auto-delivery"),
        json!({"provider":DELIVERY_PROVIDER,"tool":DELIVERY_ADDRESS_CREATE,"purpose":"添加麦乐送配送地址并查询可配送门店","subject":subject}), Some(generation)).await?;
    if let Some(store_arguments) = form["address_id"].as_str().and_then(|address_id| delivery_store_arguments(&catalog, address_id)) {
        let stores = mcp.invoke_personal_form(user_id, DELIVERY_PROVIDER, "delivery-query-stores",
            store_arguments, operation_key, generation).await;
        form["stores"] = match stores {
            // Keep the confirmed address ID visible even if the full store
            // response would overflow the Agent's tool-result budget.
            Ok(result) if result.to_string().len() <= 24_000 => result,
            Ok(_) => json!({"status":"result_too_large"}),
            Err(_) => json!({"status":"unavailable"}),
        };
        form["next"] = json!("地址已保存，门店查询结果见 stores。用真实可配送门店继续查菜单和含配送费的报价；结果过大时可用 address_id 单独重查门店一次。没有有效门店结果时如实说明。不要再次创建地址，不要自动下单。");
    }
    addresses["personal_autofill"] = form;
    Ok(addresses)
}

async fn execute_form(
    state: &AppState,
    run: &str,
    token: &str,
    user_id: &str,
    operation_key: &str,
    args: Value,
    expected_generation: Option<i64>,
) -> Result<Value> {
    if args.to_string().len() > 16 * 1024 {
        return Err(invalid("本次资料请求过长，请减少参数").into());
    }
    let mut input: Input = serde_json::from_value(args).map_err(|_| invalid("资料补全请求格式无效"))?;
    if !matches!(input.subject.as_str(), "home" | "work" | "self" | "other")
        || input.purpose.trim().is_empty()
        || input.purpose.chars().count() > 140
        || input.arguments.len() > 40
    {
        return Err(invalid("请提供有效的用途与资料归属").into());
    }
    let mcp = state
        .personal_mcp
        .as_ref()
        .ok_or_else(|| invalid("个人 MCP 连接尚未配置"))?;
    let (catalog, generation) = mcp
        .personal_form_catalog(user_id, &input.provider)
        .await
        .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
    if expected_generation.is_some_and(|expected| expected != generation) {
        return Ok(json!({"status":"account_changed","next":"麦乐送连接已变更，请重新查询地址。"}));
    }
    let tool = catalog["items"]
        .as_array()
        .and_then(|tools| tools.iter().find(|t| t["name"] == input.tool))
        .ok_or_else(|| invalid("当前账号没有开放这项工具"))?;
    let schema = &tool["inputSchema"];
    let bindings = bindings(&input, schema)?;
    let delivery_address = input.provider == DELIVERY_PROVIDER && input.tool == DELIVERY_ADDRESS_CREATE;
    let delivery_subject = state.interactions.delivery_subject(run, user_id);
    let use_current = delivery_address && delivery_subject == Some("self") && input.subject != "other";
    if use_current {
        input.subject = "self".into();
        for (key, semantic) in &bindings {
            if matches!(semantic, PersonalField::City | PersonalField::Address | PersonalField::AddressDetail) {
                input.arguments.remove(key);
            }
        }
    }
    // A missing non-personal prerequisite must go back to the planner. Do not
    // ask the user to type opaque provider IDs or fabricate them.
    let missing: Vec<_> = schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|key| !bindings.contains_key(*key) && !input.arguments.contains_key(*key))
        .collect();
    if !missing.is_empty() {
        return Ok(
            json!({"status":"needs_prerequisites","fields":missing,"next":"先调用平台查询工具取得缺少的业务参数，再继续同一任务；不要让用户填写内部编号。"}),
        );
    }
    let memories = facts(&state.repository, user_id, &bindings, &input.subject).await?;
    let user = state.repository.user(user_id).await?;
    let mut fields = resolved_fields(&input, schema, &bindings, &memories, &user)?;
    if input
        .arguments
        .keys()
        .any(|key| schema["properties"].get(key).is_none())
    {
        return Err(invalid("存在工具定义以外的参数，请按实际工具定义准备").into());
    }
    if delivery_address && delivery_subject.is_some() &&
        !state.interactions.claim_delivery_autofill(run, user_id) {
        return Ok(json!({"status":"already_offered","next":"本轮已处理配送地址卡。沿用前次结果，无需再次索要地址或重复创建。"}));
    }
    if use_current {
        let address = match state.interactions.delivery_location(run, user_id) {
            Some(location) => locate_delivery_address(state, user_id, location).await,
            None => None,
        };
        prefill_delivery_location(&mut fields, address.as_ref());
        state.repository.agent_authority(run, token).await?;
    }
    let answer = crate::chat_interaction::personal_details(
        state,
        run,
        token,
        user_id,
        &input.provider,
        &input.tool,
        &input.purpose,
        &input.subject,
        fields.clone(),
        input.arguments.clone(),
        schema.clone(),
    )
    .await?;
    if answer["status"] != "answered" {
        return Ok(answer);
    }
    let values: BTreeMap<String, String> =
        serde_json::from_value(answer["values"].clone()).map_err(|_| invalid("资料回答无效"))?;
    let filled = validate_values(&fields, &values, schema, &input.provider, &input.tool)?;
    let mut arguments = input.arguments;
    for field in &fields {
        arguments.remove(&field.key);
    }
    arguments.extend(filled);
    state.repository.agent_authority(run, token).await?;
    // Card submission is the authenticated user's approval for this exact
    // destination + tool + arguments. Never accept a model-provided confirmed flag.
    let mut result = mcp
        .invoke_personal_form(
            user_id,
            &input.provider,
            &input.tool,
            json!(arguments),
            operation_key,
            generation,
        )
        .await
        .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
    if result["status"] == "confirmation_required" {
        let id = result["action"]["id"]
            .as_str()
            .ok_or_else(|| invalid("平台未返回操作编号"))?;
        state.repository.agent_authority(run, token).await?;
        result = mcp
            .confirm(user_id, id)
            .await
            .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
    }
    state.repository.agent_authority(run, token).await?;
    if let Some(object) = result.as_object_mut() {
        object.remove("arguments");
    }
    if let Some(object) = result.get_mut("action").and_then(Value::as_object_mut) {
        object.remove("arguments");
    }
    let address_id = delivery_address.then(|| delivery_address_id(&result)).flatten();
    let status = result["status"].clone();
    redact(&mut result, &values.into_values().collect::<Vec<_>>());
    let mut response = json!({"status":status,"receipt":result,"next":"仅在 completed 时使用平台真实返回的编号继续原任务。failed 报告具体失败；unknown_outcome 先查询真实状态，禁止重复写入。"});
    if let Some(address_id) = address_id {
        response["address_id"] = json!(address_id);
    } else if delivery_address && status == "completed" {
        response["status"] = json!("unverified");
        response["next"] = json!("平台未返回有效地址编号。先查询麦乐送地址列表核对结果，不要重复创建地址或宣称已保存。");
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delivery_location_reply_continues_the_previous_users_delivery_request() {
        let reply = "地址就用我现在的位置吧，我现在加你。";
        assert_eq!(delivery_subject_for_turn(reply, Some("帮我查一下30元以内的麦当劳外卖")), Some("self"));
        assert_eq!(delivery_subject_for_turn("麦乐送送到我现在的位置", None), Some("self"));
        for previous in [None, Some("帮朋友点麦当劳外卖"), Some("查一下附近的麦当劳"), Some("麦当劳到店自取")] {
            assert_eq!(delivery_subject_for_turn(reply, previous), None, "{previous:?}");
        }
        for unrelated in ["用我现在的位置查天气", "地址别用我现在的位置", "解释‘地址就用我现在的位置’"] {
            assert_eq!(delivery_subject_for_turn(unrelated, Some("帮我点麦当劳外卖")), None);
        }
    }

    #[test]
    fn delivery_location_prefills_city_and_street_but_leaves_the_door_number_for_review() {
        let field = |semantic: PersonalField, value: &str| Field {
            key: semantic.label().into(), label: semantic.label().into(), semantic,
            value: value.into(), source: "待填写".into(), required: true,
        };
        let mut fields = [field(PersonalField::City, ""), field(PersonalField::Address, ""),
            field(PersonalField::AddressDetail, ""), field(PersonalField::Phone, "13800000000")];
        let address = LocatedAddress { city: "上海市".into(), address: "测试路100号".into() };
        prefill_delivery_location(&mut fields, Some(&address));
        assert_eq!(fields[0].value, "上海市");
        assert_eq!(fields[1].value, "测试路100号");
        assert_eq!(fields[2].value, "");
        assert_eq!(fields[3].value, "13800000000");
        prefill_delivery_location(&mut fields, None);
        assert!(fields[0].value.is_empty() && fields[1].value.is_empty());
        assert_eq!(fields[3].value, "13800000000");
    }

    #[test]
    fn delivery_autofill_requires_a_personal_delivery_request() {
        assert_eq!(delivery_subject("我现在有点饿了，你给点份麦当劳吧，外卖，30块钱以内。"), Some("home"));
        assert_eq!(delivery_subject("麦乐送送到公司"), Some("work"));
        for message in ["附近哪里有麦当劳？", "帮我点麦当劳自取", "给朋友点麦当劳外卖", "给我点麦当劳外卖送到酒店", "我想点麦当劳外卖，别用家里的地址"] {
            assert_eq!(delivery_subject(message), None, "{message}");
        }
    }

    #[test]
    fn only_confirmed_empty_address_lists_can_start_autofill() {
        let body = json!({"success":true,"code":200,"data":{"addresses":[]}});
        assert!(delivery_addresses_empty(&json!({"status":"completed","result":{"structuredContent":body}})));
        assert!(delivery_addresses_empty(&json!({"status":"completed","result":{"content":[{"type":"text","text":body.to_string()}]}})));
        for result in [
            json!({"status":"failed","result":{"structuredContent":body}}),
            json!({"status":"completed","result":{"isError":true,"structuredContent":body}}),
            json!({"status":"completed","result":{"structuredContent":{"success":false,"code":403,"data":{"addresses":[]}}}}),
            json!({"status":"completed","result":{"structuredContent":{"success":true,"code":200,"data":{"addresses":[{"addressId":"existing"}]}}}}),
            json!({"status":"completed","result":{"content":[{"type":"text","text":"[]"}]}}),
        ] {
            assert!(!delivery_addresses_empty(&result));
        }
    }

    #[test]
    fn delivery_continuation_uses_the_confirmed_address_id_and_live_schema() {
        let result = json!({"status":"completed","result":{"structuredContent":{"success":true,"code":200,"data":{"addressId":"fixture-123"}}}});
        let address_id = delivery_address_id(&result).unwrap();
        let catalog = |kind: &str| json!({"items":[{"name":"delivery-query-stores","inputSchema":{"properties":{"addressId":{"type":"string"},"beType":{"type":kind}}}}]});
        assert_eq!(delivery_store_arguments(&catalog("string"), &address_id), Some(json!({"addressId":"fixture-123","beType":"2"})));
        assert_eq!(delivery_store_arguments(&catalog("integer"), &address_id), Some(json!({"addressId":"fixture-123","beType":2})));
        assert_eq!(delivery_store_arguments(&catalog("object"), &address_id), None);
        assert_eq!(delivery_address_id(&json!({"status":"unknown_outcome","result":result["result"]})), None);
    }

    fn input(provider: &str, tool: &str) -> Input {
        serde_json::from_value(
            json!({"provider":provider,"tool":tool,"purpose":"配送到家","subject":"home"}),
        )
        .unwrap()
    }
    #[test]
    fn reviewed_adapter_and_cross_provider_bindings_use_real_schema() {
        let schema = json!({"properties":{"phone":{"type":"string"},"address":{"type":"string"}}});
        assert_eq!(
            bindings(&input("mcdonalds", "delivery-create-address"), &schema)
                .unwrap_or_else(|_| panic!("valid adapter"))
                .len(),
            2
        );
        let mut shipping = input("shipping-fixture", "create-recipient");
        shipping
            .bindings
            .insert("mobile".into(), PersonalField::Phone);
        assert!(bindings(&shipping, &schema).is_err());
        assert_eq!(
            bindings(
                &shipping,
                &json!({"properties":{"mobile":{"type":"string"}}})
            )
            .unwrap_or_else(|_| panic!("valid mapping"))["mobile"],
            PersonalField::Phone
        );
    }
    #[test]
    fn only_requested_fields_are_accepted_and_required_fields_cannot_be_empty() {
        let fields = vec![Field {
            key: "phone".into(),
            label: "联系电话".into(),
            semantic: PersonalField::Phone,
            value: String::new(),
            source: String::new(),
            required: true,
        }];
        assert!(apply_values(&fields, &BTreeMap::from([("phone".into(), "".into())])).is_err());
        assert!(apply_values(
            &fields,
            &BTreeMap::from([
                ("phone".into(), "13800000000".into()),
                ("confirmed".into(), "true".into())
            ])
        )
        .is_err());
        assert_eq!(
            apply_values(
                &fields,
                &BTreeMap::from([("phone".into(), "13800000000".into())])
            )
            .unwrap()["phone"],
            "13800000000"
        );
    }
    #[test]
    fn result_preserves_provider_ids_but_removes_personal_values() {
        let mut receipt = json!({"addressId":"provider-123","phone":"13800000000","content":[{"text":"accepted 13800000000"}]});
        redact(&mut receipt, &["13800000000".into()]);
        assert_eq!(receipt["addressId"], "provider-123");
        assert!(!receipt.to_string().contains("13800000000"));
    }
    fn memory(id: &str, title: &str, content: &str) -> Memory {
        serde_json::from_value(json!({"id":id,"title":title,"content":content,"kind":"fact","source":"用户手动创建","created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z","version":1})).unwrap()
    }
    #[test]
    fn conflicts_do_not_silently_select_first_and_other_recipient_stays_empty() {
        let memories = vec![
            memory("a", "手机号", "手机号：13800000000"),
            memory("b", "手机号", "手机号：13900000000"),
        ];
        let (value, source) = from_memories(&memories, PersonalField::Phone, "home");
        assert!(value.is_empty());
        assert!(source.contains("多个"));
        assert!(from_memories(&memories[..1], PersonalField::Phone, "other")
            .0
            .is_empty());
        assert_eq!(
            from_memories(&memories[..1], PersonalField::Phone, "home").0,
            "13800000000"
        );
        assert!(from_memories(
            &[memory("c", "朋友手机号", "13900000000")],
            PersonalField::Phone,
            "home"
        )
        .0
        .is_empty());
    }
    #[test]
    fn fills_multiple_fields_preserves_explicit_overrides_and_does_not_mix_recipients() {
        let mut input = input("shipping-fixture", "create-recipient");
        let schema = json!({"properties":{"mobile":{"type":"string"},"recipient":{"type":"string"},"address":{"type":"string"}},"required":["mobile","recipient","address"]});
        let mappings = BTreeMap::from([
            ("mobile".into(), PersonalField::Phone),
            ("recipient".into(), PersonalField::Name),
            ("address".into(), PersonalField::Address),
        ]);
        let user: tomorrow_domain::User = serde_json::from_value(json!({"id":"a","name":"测试收件人","phone":"13800000000","email":"test@example.test","timezone":"Asia/Shanghai","created_at":"2026-11-04T00:00:00Z"})).unwrap();
        let memories = vec![memory("a", "家庭地址", "家庭地址：测试市测试路1号201室")];
        let fields = resolved_fields(&input, &schema, &mappings, &memories, &user)
            .unwrap_or_else(|_| panic!("valid fields"));
        assert!(fields.iter().all(|f| !f.value.is_empty()));
        input
            .arguments
            .insert("mobile".into(), json!("13900000000"));
        let fields = resolved_fields(&input, &schema, &mappings, &memories, &user)
            .unwrap_or_else(|_| panic!("valid override"));
        assert_eq!(
            fields.iter().find(|f| f.key == "mobile").unwrap().value,
            "13900000000"
        );
        input.subject = "other".into();
        input.arguments.clear();
        let fields = resolved_fields(&input, &schema, &mappings, &memories, &user)
            .unwrap_or_else(|_| panic!("other recipient"));
        assert!(fields.iter().all(|f| f.value.is_empty()));
        assert_eq!(
            address_part("广东省深圳市测试路1号201室", PersonalField::City),
            "深圳市"
        );
        assert_eq!(
            address_part("上海市测试路1号201室", PersonalField::AddressDetail),
            "1号201室"
        );
    }
    #[tokio::test]
    async fn named_lookup_is_tenant_scoped_and_not_limited_to_eight_recalled_memories() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let a = repo
            .create_user("autofill-a@example.test", "unused", "A", "Asia/Shanghai")
            .await
            .unwrap();
        let b = repo
            .create_user("autofill-b@example.test", "unused", "B", "Asia/Shanghai")
            .await
            .unwrap();
        for (owner, id, title, content) in [
            (&a.id, "a", "家庭地址", "测试市测试路1号"),
            (&b.id, "b", "家庭地址", "另一个用户的地址"),
        ] {
            sqlx::query("INSERT INTO resources(id,user_id,kind,body,created_at,updated_at)VALUES($1,$2,'memory',$3,1,1)")
                .bind(id).bind(owner).bind(serde_json::to_string(&memory(id,title,content)).unwrap()).execute(&repo.pool()).await.unwrap();
        }
        let fields = BTreeMap::from([("address".into(), PersonalField::Address)]);
        let found = facts(&repo, &a.id, &fields, "home")
            .await
            .unwrap_or_else(|_| panic!("facts lookup"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "a");
        assert!(facts(&repo, &a.id, &fields, "other")
            .await
            .unwrap_or_else(|_| panic!("other lookup"))
            .is_empty());
    }
}
