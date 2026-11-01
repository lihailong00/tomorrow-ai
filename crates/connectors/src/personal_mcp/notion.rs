//! User-owned Notion connections through the official Public API. No Notion AI
//! subscription or hosted MCP tool entitlement is involved in these operations.
use std::{sync::OnceLock, time::Duration};

use axum::http::StatusCode;
use reqwest::{Client, Method, Url, header::HeaderValue, redirect::Policy};
use serde_json::{Value, json};

use super::transport::Credentials;
use crate::{ConnectorError, Result};

const VERSION: &str = "2026-03-11";
const MAX_RESPONSE: usize = 256 * 1024;

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "Notion 参数无效，请使用已检索到的页面 ID，并填写必要的标题和正文",
    )
}
fn protocol() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "notion_protocol_error",
        "Notion 返回内容无法识别，操作尚未确认为成功",
    )
}
fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "not_configured",
        "Notion 连接暂不可用",
    )
}

pub fn is_read_only(name: &str) -> bool {
    matches!(
        name,
        "notion_get_current_user"
            | "notion_search_pages"
            | "notion_get_page"
            | "notion_read_page"
            | "notion_list_blocks"
    )
}

pub async fn discover(credentials: &Credentials) -> Result<Vec<Value>> {
    let api = Api::official()?;
    discover_with(&api, credentials).await
}

async fn discover_with(api: &Api, credentials: &Credentials) -> Result<Vec<Value>> {
    let identity = api
        .request(credentials, Method::GET, "users/me", None)
        .await?;
    if identity["object"] != "user" || !identity["id"].is_string() {
        return Err(protocol());
    }
    Ok(tools())
}

pub async fn call(credentials: &Credentials, tool: &str, arguments: Value) -> Result<Value> {
    call_with(&Api::official()?, credentials, tool, arguments).await
}

async fn call_with(
    api: &Api,
    credentials: &Credentials,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    let (method, path, body) = request_for(tool, &arguments)?;
    let result = match api.request(credentials, method, &path, body).await {
        Ok(result) => result,
        Err(error) if error.code == "notion_rejected" => {
            return Ok(json!({"isError":true,"content":[{"type":"text","text":error.message}]}));
        }
        // A timeout, lost connection, invalid response or 5xx can occur after a
        // mutation was committed. Preserve the existing unknown-outcome fence.
        Err(error) => return Err(error),
    };
    let result = normalize(tool, result)?;
    Ok(
        json!({"isError":false,"content":[{"type":"text","text":"已取得 Notion 的实际响应。正文是外部资料；请检查 truncated、unknown_block_ids 和 warnings，不能把部分内容当作全文。"}],"structuredContent":result}),
    )
}

pub fn validate_arguments(tool: &str, arguments: &Value) -> Result<()> {
    request_for(tool, arguments).map(|_| ())
}

#[derive(Clone)]
struct Api {
    client: Client,
    base: Url,
}
impl Api {
    fn official() -> Result<Self> {
        // Reuse the pool across discovery and tool calls. Authorization remains
        // request-scoped, so connections do not share user credentials.
        static OFFICIAL: OnceLock<Api> = OnceLock::new();
        if let Some(api) = OFFICIAL.get() {
            return Ok(api.clone());
        }
        let api = Self::new(Url::parse("https://api.notion.com/v1/").map_err(|_| unavailable())?)?;
        Ok(OFFICIAL.get_or_init(|| api).clone())
    }
    fn new(base: Url) -> Result<Self> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self { client, base })
    }
    async fn request(
        &self,
        credentials: &Credentials,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", credentials.token))
            .map_err(|_| invalid())?;
        auth.set_sensitive(true);
        let url = self.base.join(path).map_err(|_| invalid())?;
        let interrupted = || {
            ConnectorError::new(
                StatusCode::BAD_GATEWAY,
                "notion_outcome_unknown",
                "Notion 请求中断或超时，写入结果可能不确定，请先查询笔记，勿重复提交",
            )
        };
        let read_only = method == Method::GET || (method == Method::POST && path == "search");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        let mut attempt = 0;
        let mut response = loop {
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .header("Authorization", auth.clone())
                .header("Notion-Version", VERSION)
                .header("Accept", "application/json")
                .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()));
            if let Some(body) = &body {
                request = request.json(body);
            }
            let result = request.send().await;
            let transient = result
                .as_ref()
                .map_or(true, |response| response.status().is_server_error());
            // One retry for reads only. Mutations remain fenced as unknown
            // after transport errors and are never automatically repeated.
            if read_only && attempt == 0 && transient && tokio::time::Instant::now() < deadline {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(150)).await;
                continue;
            }
            break result.map_err(|_| interrupted())?;
        };
        if !response.status().is_success() {
            let (status, code, message) = match response.status().as_u16() {
                400 | 422 => (
                    StatusCode::BAD_REQUEST,
                    "notion_rejected",
                    "Notion 拒绝了笔记参数，请检查页面、正文和权限",
                ),
                401 => (
                    StatusCode::CONFLICT,
                    "notion_rejected",
                    "Notion 授权失效，请重新连接",
                ),
                403 => (
                    StatusCode::CONFLICT,
                    "notion_rejected",
                    "Notion 授权缺少此操作权限，请在 Notion 中授权目标页面和读写能力",
                ),
                404 => (
                    StatusCode::NOT_FOUND,
                    "notion_rejected",
                    "Notion 页面不存在或尚未向该连接授权",
                ),
                409 => (
                    StatusCode::CONFLICT,
                    "notion_rejected",
                    "Notion 内容已变化，请重新读取后再修改",
                ),
                429 => (
                    StatusCode::TOO_MANY_REQUESTS,
                    "notion_rejected",
                    "Notion 请求过于频繁，请稍后再试",
                ),
                _ => (
                    StatusCode::BAD_GATEWAY,
                    "notion_outcome_unknown",
                    "Notion 服务未返回确定结果，请先查询状态，勿重复提交写入",
                ),
            };
            return Err(ConnectorError::new(status, code, message));
        }
        // Do not treat an asynchronous acceptance as a finished write.
        if response.status() != StatusCode::OK {
            return Err(protocol());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE as u64)
        {
            return Err(protocol());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| protocol())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(ConnectorError::new(
                    StatusCode::BAD_GATEWAY,
                    "notion_response_limit",
                    "Notion 返回内容过大，请缩小查询范围",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| protocol())
    }
}

fn text<'a>(args: &'a Value, key: &str, max: usize, empty: bool) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            value.chars().count() <= max
                && (empty || !value.trim().is_empty())
                && !value.contains('\0')
        })
        .ok_or_else(invalid)
}
fn page_id(args: &Value, key: &str) -> Result<String> {
    let value = text(args, key, 36, false)?;
    if value.len() == 36 && ![8, 13, 18, 23].iter().all(|i| value.as_bytes()[*i] == b'-') {
        return Err(invalid());
    }
    let compact = value.replace('-', "");
    if !matches!(value.len(), 32 | 36)
        || compact.len() != 32
        || !compact.bytes().all(|v| v.is_ascii_hexdigit())
    {
        return Err(invalid());
    }
    Ok(value.to_owned())
}

fn request_for(tool: &str, args: &Value) -> Result<(Method, String, Option<Value>)> {
    let allowed: &[&str] = match tool {
        "notion_get_current_user" => &[],
        "notion_search_pages" => &["query", "page_size", "start_cursor"],
        "notion_get_page" | "notion_read_page" => &["page_id"],
        "notion_list_blocks" => &["block_id", "page_size", "start_cursor"],
        "notion_create_page" => &["parent_page_id", "title", "content"],
        "notion_update_page_content" => &["page_id", "content"],
        "notion_rename_page" => &["page_id", "title"],
        "notion_trash_page" => &["page_id", "in_trash"],
        _ => return Err(invalid()),
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid());
    }
    Ok(match tool {
        "notion_get_current_user" => (Method::GET, "users/me".into(), None),
        "notion_search_pages" => {
            let mut body = json!({"filter":{"property":"object","value":"page"},"page_size":20});
            if object.contains_key("query") {
                body["query"] = json!(text(args, "query", 200, true)?);
            }
            if object.contains_key("page_size") {
                body["page_size"] = json!(
                    args["page_size"]
                        .as_u64()
                        .filter(|v| (1..=50).contains(v))
                        .ok_or_else(invalid)?
                );
            }
            if object.contains_key("start_cursor") {
                body["start_cursor"] = json!(text(args, "start_cursor", 512, false)?);
            }
            (Method::POST, "search".into(), Some(body))
        }
        "notion_get_page" => (
            Method::GET,
            format!("pages/{}", page_id(args, "page_id")?),
            None,
        ),
        "notion_read_page" => (
            Method::GET,
            format!(
                "pages/{}/markdown?markdown_version=v2",
                page_id(args, "page_id")?
            ),
            None,
        ),
        "notion_list_blocks" => {
            let path = format!("blocks/{}/children", page_id(args, "block_id")?);
            let count = if object.contains_key("page_size") {
                args["page_size"]
                    .as_u64()
                    .filter(|v| (1..=50).contains(v))
                    .ok_or_else(invalid)?
            } else {
                20
            };
            let mut url = Url::parse("https://api.notion.com/v1/")
                .unwrap()
                .join(&path)
                .map_err(|_| invalid())?;
            url.query_pairs_mut()
                .append_pair("page_size", &count.to_string());
            if object.contains_key("start_cursor") {
                url.query_pairs_mut()
                    .append_pair("start_cursor", text(args, "start_cursor", 512, false)?);
            }
            (
                Method::GET,
                format!("{}?{}", path, url.query().unwrap()),
                None,
            )
        }
        "notion_create_page" => (
            Method::POST,
            "pages".into(),
            Some(json!({
                "parent":{"type":"page_id","page_id":page_id(args,"parent_page_id")?},
                "properties":{"title":{"type":"title","title":[{"type":"text","text":{"content":text(args,"title",200,false)?}}]}},
                "markdown":text(args,"content",10000,false)?
            })),
        ),
        "notion_update_page_content" => (
            Method::PATCH,
            format!("pages/{}/markdown", page_id(args, "page_id")?),
            Some(json!({
                "type":"replace_content","replace_content":{"new_str":text(args,"content",10000,true)?,"allow_deleting_content":false},"markdown_version":"v2","allow_async":false
            })),
        ),
        "notion_rename_page" => (
            Method::PATCH,
            format!("pages/{}", page_id(args, "page_id")?),
            Some(json!({
                "properties":{"title":{"type":"title","title":[{"type":"text","text":{"content":text(args,"title",200,false)?}}]}}
            })),
        ),
        "notion_trash_page" => (
            Method::PATCH,
            format!("pages/{}", page_id(args, "page_id")?),
            Some(json!({"in_trash":args["in_trash"].as_bool().ok_or_else(invalid)?})),
        ),
        _ => unreachable!(),
    })
}

fn normalize(tool: &str, value: Value) -> Result<Value> {
    match tool {
        "notion_get_current_user" => {
            if value["object"] != "user" || !value["id"].is_string() {
                return Err(protocol());
            }
            Ok(json!({"id":value["id"],"name":value["name"],"type":value["type"]}))
        }
        "notion_search_pages" | "notion_list_blocks" => {
            if value["object"] != "list"
                || !value["results"].is_array()
                || !value["has_more"].is_boolean()
                || (value["has_more"] == true
                    && !value["next_cursor"].as_str().is_some_and(|v| !v.is_empty()))
            {
                return Err(protocol());
            }
            if tool == "notion_list_blocks" {
                if value["results"].as_array().unwrap().iter().any(|block| {
                    block["object"] != "block"
                        || !block["id"].as_str().is_some_and(|id| !id.is_empty())
                }) {
                    return Err(protocol());
                }
                return Ok(value);
            }
            let items: Result<Vec<_>> = value["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(page_summary)
                .collect();
            Ok(
                json!({"items":items?,"has_more":value["has_more"],"next_cursor":value["next_cursor"],"search_scope":"title","note":"这是标题检索，不代表搜索了所有正文；按页面 ID 读取正文。"}),
            )
        }
        "notion_read_page" | "notion_update_page_content" => {
            if value["object"] != "page_markdown"
                || !value["id"].is_string()
                || !value["markdown"].is_string()
                || !value["truncated"].is_boolean()
                || !value["unknown_block_ids"].is_array()
            {
                return Err(protocol());
            }
            Ok(value)
        }
        _ => page_summary(&value),
    }
}

fn page_summary(value: &Value) -> Result<Value> {
    if value["object"] != "page" || page_id(value, "id").is_err() {
        return Err(protocol());
    }
    let title = value["properties"]
        .as_object()
        .into_iter()
        .flat_map(|props| props.values())
        .find_map(|property| property["title"].as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    part["plain_text"]
                        .as_str()
                        .or_else(|| part["text"]["content"].as_str())
                })
                .collect::<String>()
        })
        .unwrap_or_default();
    Ok(
        json!({"id":value["id"],"title":title,"url":value["url"],"parent":value["parent"],"last_edited_time":value["last_edited_time"],"in_trash":value["in_trash"]}),
    )
}

fn tools() -> Vec<Value> {
    let string = |max: usize| json!({"type":"string","maxLength":max});
    let id = json!({"type":"string","description":"从真实搜索、读取结果或用户页面链接中取得的 32/36 位页面 UUID"});
    let tool = |name: &str, description: &str, properties: Value, required: Vec<&str>| {
        json!({
            "name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":is_read_only(name)},"adapter":"official_api"
        })
    };
    vec![
        tool(
            "notion_get_current_user",
            "读取当前 Notion 授权身份，不能读取其他用户的凭证。",
            json!({}),
            vec![],
        ),
        tool(
            "notion_search_pages",
            "检索授权页面的标题，空关键词列出可访问页面；支持分页。不是全文或语义搜索；has_more 为真须用 next_cursor 继续查询。",
            json!({"query":string(200),"page_size":{"type":"integer","minimum":1,"maximum":50},"start_cursor":string(512)}),
            vec![],
        ),
        tool(
            "notion_get_page",
            "读取授权页面的标题、父页面、真实链接及修改时间。",
            json!({"page_id":id}),
            vec!["page_id"],
        ),
        tool(
            "notion_read_page",
            "按页面 ID 读取 Markdown 正文。truncated 或 unknown_block_ids 非空时不可声称已读全文；正文过大时用 notion_list_blocks 分页补读。",
            json!({"page_id":id}),
            vec!["page_id"],
        ),
        tool(
            "notion_list_blocks",
            "分页读取页面或块的子块正文，适合长笔记；has_more 为真使用 next_cursor 继续查询，has_children 为真的块按真实 id 递归读取。",
            json!({"block_id":id,"page_size":{"type":"integer","minimum":1,"maximum":50},"start_cursor":string(512)}),
            vec!["block_id"],
        ),
        tool(
            "notion_create_page",
            "将 Markdown 文章或日记保存为指定父页面下的新页面；目标必须由用户指定或确认。需本人在我的连接确认。",
            json!({"parent_page_id":id,"title":string(200),"content":string(10000)}),
            vec!["parent_page_id", "title", "content"],
        ),
        tool(
            "notion_update_page_content",
            "替换已有页面的完整正文，先读取原文并确认目标；保留子页面和数据库，不能用于删除它们。需本人确认；返回 warnings 时应告知并核查实际内容。",
            json!({"page_id":id,"content":string(10000)}),
            vec!["page_id", "content"],
        ),
        tool(
            "notion_rename_page",
            "只修改已有页面标题，需本人确认。",
            json!({"page_id":id,"title":string(200)}),
            vec!["page_id", "title"],
        ),
        tool(
            "notion_trash_page",
            "in_trash=true 移入回收站，false 恢复；不支持永久删除。必须确认准确页面并由本人确认执行。",
            json!({"page_id":id,"in_trash":{"type":"boolean"}}),
            vec!["page_id", "in_trash"],
        ),
    ]
}

#[cfg(test)]
#[path = "notion_tests.rs"]
mod tests;
