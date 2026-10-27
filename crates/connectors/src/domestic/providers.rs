//! Fixed-origin read adapters for Chinese providers. All credentials stay in the vault.
//!
//! Official protocol references (checked 2026-10-27):
//! - https://developer.amap.com/api/webservice/guide/api/search/
//! - https://developer.amap.com/api/webservice/guide/api/direction
//! - https://github.com/yuque/openapi-metadata/blob/master/yuque.tea
//! - https://developer.work.weixin.qq.com/document/path/91039
//! - https://developer.work.weixin.qq.com/document/path/95406
//! - https://developer.zhihu.com/console/docs (public docs JSON: /console/api/v3/docs)

use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use futures_util::StreamExt;
use reqwest::{Client, RequestBuilder, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::{ConnectorError, Result, config::http_client};

const RESPONSE_LIMIT: usize = 1024 * 1024;
const ITEM_LIMIT: usize = 20;

pub fn configured(id: &str) -> bool {
    match id {
        "amap" => amap_key().is_ok(),
        // The calling vault separately checks encryption configuration.
        "yuque" | "wecom" | "zhihu" => true,
        _ => false,
    }
}

/// Probe the actual provider before the caller stores these normalized credentials.
/// Returned values are secret vault contents, never an API response body.
pub async fn verify(id: &str, credentials: &Value) -> Result<Value> {
    let client = http_client()?;
    match id {
        "amap" => {
            amap_read(&client, &json!({"keywords":"北京","limit":1})).await?;
            Ok(json!({}))
        }
        "yuque" => {
            let token = secret(credentials, "token", 4096)?;
            let user = yuque_get(&client, &token, &["user"], &[]).await?;
            let login = user["data"]["login"]
                .as_str()
                .filter(|value| valid_segment(value))
                .ok_or_else(provider_error)?;
            Ok(json!({"token":token,"login":login}))
        }
        "wecom" => {
            let corp_id = secret(credentials, "corp_id", 128)?;
            let agent_secret = secret(credentials, "agent_secret", 512)?;
            let normalized = json!({"corp_id":corp_id,"agent_secret":agent_secret});
            let token = wecom_token(&client, &normalized).await?;
            wecom_departments(&client, &token, None).await?;
            Ok(normalized)
        }
        "zhihu" => {
            let token = secret(credentials, "token", 4096)?;
            // The official quota API authenticates without consuming business quota.
            let value = json_response(
                zhihu_request(&client, &token, "/api/v1/quota")
                    .query(&[("APIIDs", "zhihu_search,user_data")]),
            )
            .await?;
            zhihu_success(&value)?;
            if !value["Data"].is_array() {
                return Err(provider_error());
            }
            Ok(json!({"token":token}))
        }
        _ => Err(unsupported()),
    }
}

pub async fn read(id: &str, credentials: &Value, query: &Value) -> Result<Value> {
    read_with_map_key(id, credentials, query, amap_key().ok().as_deref()).await
}

pub async fn read_with_map_key(id: &str, credentials: &Value, query: &Value, map_key: Option<&str>) -> Result<Value> {
    if !query.is_object() {
        return Err(ConnectorError::invalid());
    }
    let client = http_client()?;
    match id {
        "amap" => amap_read_with_key(&client, query, map_key.ok_or_else(|| ConnectorError::new(StatusCode::SERVICE_UNAVAILABLE, "not_configured", "高德地图尚未配置"))?).await,
        "yuque" => yuque_read(&client, credentials, query).await,
        "wecom" => wecom_read(&client, credentials, query).await,
        "zhihu" => zhihu_read(&client, credentials, query).await,
        _ => Err(unsupported()),
    }
}

fn provider_error() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "provider_error",
        "应用服务请求失败，请检查授权范围、服务额度和服务器网络后重试",
    )
}

fn permission_error() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "connection_required",
        "授权无效或权限不足，请检查凭据和应用权限后重新连接",
    )
}

fn limited() -> ConnectorError {
    ConnectorError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "provider_rate_limited",
        "应用服务请求过于频繁或额度不足，请稍后重试",
    )
}

fn unsupported() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "unsupported_operation",
        "当前连接器不支持这项读取操作",
    )
}

fn secret(value: &Value, name: &str, limit: usize) -> Result<String> {
    let token = value.get(name).and_then(Value::as_str).unwrap_or("").trim();
    if token.is_empty() || token.len() > limit || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(ConnectorError::invalid());
    }
    Ok(token.into())
}

fn text_arg<'a>(value: &'a Value, name: &str, maximum: usize) -> Result<Option<&'a str>> {
    let Some(raw) = value.get(name) else {
        return Ok(None);
    };
    let text = raw.as_str().ok_or_else(ConnectorError::invalid)?.trim();
    if text.chars().count() > maximum || text.chars().any(char::is_control) {
        return Err(ConnectorError::invalid());
    }
    Ok((!text.is_empty()).then_some(text))
}

fn required_arg<'a>(value: &'a Value, name: &str, maximum: usize) -> Result<&'a str> {
    text_arg(value, name, maximum)?.ok_or_else(ConnectorError::invalid)
}

fn bounded_number(value: &Value, name: &str, default: u64, maximum: u64) -> Result<u64> {
    let Some(raw) = value.get(name) else {
        return Ok(default);
    };
    let number = raw.as_u64().ok_or_else(ConnectorError::invalid)?;
    if number > maximum || (name == "limit" && number == 0) {
        return Err(ConnectorError::invalid());
    }
    Ok(number)
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|ch| ch.is_control() || "/\\?#%".contains(ch))
}

fn clipped(value: &Value, field: &str, maximum: usize) -> String {
    value[field]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(maximum)
        .collect()
}

fn scalar_id(value: &Value) -> String {
    match value {
        Value::String(value) => value.chars().take(256).collect(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    }
}

fn positive_id(value: &Value) -> Result<u64> {
    let parsed = value.as_u64().or_else(|| {
        value
            .as_str()
            .filter(|value| value.len() <= 19 && value.bytes().all(|byte| byte.is_ascii_digit()))?
            .parse()
            .ok()
    });
    parsed
        .filter(|id| *id > 0 && *id <= i64::MAX as u64)
        .ok_or_else(ConnectorError::invalid)
}

fn safe_link(value: &str, domain: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?;
    if value.len() <= 4096
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (host == domain || host.ends_with(&format!(".{domain}")))
    {
        Some(url.to_string())
    } else {
        None
    }
}

async fn json_response(request: RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|_| provider_error())?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(permission_error());
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(limited());
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > RESPONSE_LIMIT as u64)
    {
        return Err(provider_error());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| provider_error())?;
        if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(provider_error());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| provider_error())
}

fn amap_key() -> Result<String> {
    let value = std::env::var("AMAP_WEB_API_KEY").unwrap_or_default();
    if value.trim().is_empty() {
        return Err(ConnectorError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "高德地图尚未配置服务端 Web API Key",
        ));
    }
    secret(&json!({"key":value}), "key", 256)
}

fn coordinate(value: &str) -> Result<String> {
    let parts: Vec<_> = value.split(',').collect();
    if parts.len() != 2 {
        return Err(ConnectorError::invalid());
    }
    let lon = parts[0]
        .trim()
        .parse::<f64>()
        .map_err(|_| ConnectorError::invalid())?;
    let lat = parts[1]
        .trim()
        .parse::<f64>()
        .map_err(|_| ConnectorError::invalid())?;
    if !lon.is_finite()
        || !lat.is_finite()
        || !(-180.0..=180.0).contains(&lon)
        || !(-90.0..=90.0).contains(&lat)
    {
        return Err(ConnectorError::invalid());
    }
    Ok(format!("{lon:.6},{lat:.6}"))
}

fn amap_success(value: &Value) -> Result<()> {
    if value["status"] == "1" {
        return Ok(());
    }
    match value["infocode"].as_str() {
        Some("10003" | "10004" | "10019" | "10020" | "10021" | "10044" | "10045") => Err(limited()),
        Some(
            "10001" | "10005" | "10006" | "10007" | "10008" | "10009" | "10010" | "10011" | "10012"
            | "10013",
        ) => Err(permission_error()),
        _ => Err(provider_error()),
    }
}

async fn amap_read(client: &Client, query: &Value) -> Result<Value> {
    let key = amap_key()?;
    amap_read_with_key(client, query, &key).await
}

async fn amap_read_with_key(client: &Client, query: &Value, key: &str) -> Result<Value> {
    let key = key.to_owned();
    let operation = text_arg(query, "operation", 32)?.unwrap_or("search");
    let limit = bounded_number(query, "limit", 10, ITEM_LIMIT as u64)? as usize;
    match operation {
        "search" => {
            let keywords = required_arg(query, "keywords", 200)?;
            let city = text_arg(query, "city", 80)?.unwrap_or("");
            let value = json_response(client.get("https://restapi.amap.com/v3/place/text").query(
                &[
                    ("key", key),
                    ("keywords", keywords.into()),
                    ("city", city.into()),
                    ("offset", limit.to_string()),
                    ("page", "1".into()),
                    ("extensions", "base".into()),
                    ("output", "JSON".into()),
                ],
            ))
            .await?;
            amap_success(&value)?;
            let pois = value["pois"].as_array().ok_or_else(provider_error)?;
            let items: Vec<_> = pois.iter().take(limit).map(|poi| {
                let location = clipped(poi, "location", 64);
                let title = clipped(poi, "name", 256);
                let mut link = Url::parse("https://uri.amap.com/marker").expect("fixed URI");
                link.query_pairs_mut().append_pair("position", &location).append_pair("name", &title).append_pair("coordinate", "gaode").append_pair("src", "tada");
                json!({"id":scalar_id(&poi["id"]),"title":title,
                    "text":format!("{} {} {}",clipped(poi,"pname",80),clipped(poi,"cityname",80),clipped(poi,"address",512)).trim(),
                    "url":link.to_string(),"location":location})
            }).collect();
            Ok(
                json!({"source":"amap","operation":"search","items":items,"coordinate_system":"GCJ-02"}),
            )
        }
        "route" => {
            let origin = coordinate(required_arg(query, "origin", 80)?)?;
            let destination = coordinate(required_arg(query, "destination", 80)?)?;
            let mode = text_arg(query, "mode", 32)?.unwrap_or("driving");
            let endpoint = match mode {
                "driving" => "https://restapi.amap.com/v3/direction/driving",
                "walking" => "https://restapi.amap.com/v3/direction/walking",
                _ => return Err(unsupported()),
            };
            let value = json_response(client.get(endpoint).query(&[
                ("key", key),
                ("origin", origin.clone()),
                ("destination", destination.clone()),
                ("extensions", "base".into()),
                ("output", "JSON".into()),
            ]))
            .await?;
            amap_success(&value)?;
            let paths = value["route"]["paths"]
                .as_array()
                .ok_or_else(provider_error)?;
            let mut link = Url::parse("https://uri.amap.com/navigation").expect("fixed URI");
            link.query_pairs_mut()
                .append_pair("from", &origin)
                .append_pair("to", &destination)
                .append_pair("mode", if mode == "walking" { "walk" } else { "car" })
                .append_pair("coordinate", "gaode")
                .append_pair("src", "tada");
            let items: Vec<_> = paths.iter().take(limit.min(3)).enumerate().map(|(index,path)| {
                let instructions: Vec<_> = path["steps"].as_array().into_iter().flatten().take(20).map(|step|clipped(step,"instruction",256)).collect();
                let distance = clipped(path,"distance",32);
                let duration = clipped(path,"duration",32);
                json!({"id":format!("route-{index}"),"title":format!("{}方案 {}",if mode == "walking" {"步行"}else{"驾车"},index+1),
                    "text":format!("距离 {distance} 米，预计 {duration} 秒。{}", instructions.join("；")),"url":link.to_string(),"distance_meters":distance,"duration_seconds":duration})
            }).collect();
            Ok(
                json!({"source":"amap","operation":"route","items":items,"coordinate_system":"GCJ-02","origin":origin,"destination":destination}),
            )
        }
        _ => Err(unsupported()),
    }
}

fn yuque_url(parts: &[&str]) -> Result<Url> {
    if parts.iter().any(|part| !valid_segment(part)) {
        return Err(ConnectorError::invalid());
    }
    let mut url = Url::parse("https://www.yuque.com/api/v2/").expect("fixed URI");
    url.path_segments_mut()
        .map_err(|_| ConnectorError::internal())?
        .pop_if_empty()
        .extend(parts.iter());
    Ok(url)
}

async fn yuque_get(
    client: &Client,
    token: &str,
    parts: &[&str],
    query: &[(String, String)],
) -> Result<Value> {
    let value = json_response(
        client
            .get(yuque_url(parts)?)
            .header("X-Auth-Token", token)
            .header("User-Agent", "Tada/0.1")
            .query(query),
    )
    .await?;
    if value.get("data").is_none() || value.get("errors").is_some() {
        return Err(provider_error());
    }
    Ok(value)
}

async fn yuque_read(client: &Client, credentials: &Value, query: &Value) -> Result<Value> {
    let token = secret(credentials, "token", 4096)?;
    let limit = bounded_number(query, "limit", 10, ITEM_LIMIT as u64)?;
    let offset = bounded_number(query, "offset", 0, 10000)?;
    let operation = text_arg(query, "operation", 32)?.unwrap_or("repos");
    let paging = [
        ("limit".into(), limit.to_string()),
        ("offset".into(), offset.to_string()),
    ];
    let value = match operation {
        "repos" => {
            // Derive owner identity from the provider, never a caller-supplied account ID.
            let user = yuque_get(client, &token, &["user"], &[]).await?;
            let login = user["data"]["login"].as_str().ok_or_else(provider_error)?;
            yuque_get(client, &token, &["users", login, "repos"], &paging).await?
        }
        "docs" | "document" => {
            let repo = required_arg(query, "repo", 256)?;
            let parts: Vec<_> = repo.split('/').collect();
            if parts.len() != 2 || parts.iter().any(|part| !valid_segment(part)) {
                return Err(ConnectorError::invalid());
            }
            if operation == "docs" {
                yuque_get(
                    client,
                    &token,
                    &["repos", parts[0], parts[1], "docs"],
                    &paging,
                )
                .await?
            } else {
                let slug = required_arg(query, "doc_slug", 128)?;
                yuque_get(
                    client,
                    &token,
                    &["repos", parts[0], parts[1], "docs", slug],
                    &[],
                )
                .await?
            }
        }
        _ => return Err(unsupported()),
    };
    let single;
    let rows = if operation == "document" {
        if !value["data"].is_object() {
            return Err(provider_error());
        }
        single = vec![value["data"].clone()];
        &single
    } else {
        value["data"].as_array().ok_or_else(provider_error)?
    };
    let filter = text_arg(query, "keywords", 200)?
        .unwrap_or("")
        .to_lowercase();
    let items: Vec<_> = rows.iter().take(limit as usize).filter_map(|row| {
        let title = if operation == "repos" { clipped(row,"name",256) } else { clipped(row,"title",256) };
        let body = if operation == "repos" { clipped(row,"description",5000) } else if row["body"].is_string() {clipped(row,"body",10000)} else {clipped(row,"description",5000)};
        if !filter.is_empty() && !format!("{title}\n{body}").to_lowercase().contains(&filter) { return None }
        let namespace = row["namespace"].as_str().or_else(||query["repo"].as_str()).unwrap_or("");
        let slug = row["slug"].as_str().unwrap_or("");
        let generated = if operation == "repos" {format!("https://www.yuque.com/{namespace}")} else {format!("https://www.yuque.com/{namespace}/{slug}")};
        Some(json!({"id":scalar_id(&row["id"]),"title":title,"text":body,"url":safe_link(&generated,"yuque.com"),"repo":namespace,"doc_slug":slug}))
    }).collect();
    Ok(
        json!({"source":"yuque","operation":operation,"items":items,"offset":offset,"next_offset":if rows.len() >= limit as usize && operation != "document" {Some(offset+limit)}else{None},"search_scope":"returned_page"}),
    )
}

struct CachedToken {
    token: String,
    expires: Instant,
}
static WECOM_TOKENS: OnceLock<Mutex<HashMap<String, CachedToken>>> = OnceLock::new();

async fn wecom_token(client: &Client, credentials: &Value) -> Result<String> {
    let corp_id = secret(credentials, "corp_id", 128)?;
    let agent_secret = secret(credentials, "agent_secret", 512)?;
    let cache_key = format!("{:x}", Sha256::digest(format!("{corp_id}\0{agent_secret}")));
    let cache = WECOM_TOKENS.get_or_init(|| Mutex::new(HashMap::new()));
    // Serialize refreshes so a burst of reads does not invalidate provider tokens.
    let mut cached = cache.lock().await;
    if let Some(entry) = cached
        .get(&cache_key)
        .filter(|entry| entry.expires > Instant::now())
    {
        return Ok(entry.token.clone());
    }
    let value = json_response(
        client
            .get("https://qyapi.weixin.qq.com/cgi-bin/gettoken")
            .query(&[("corpid", corp_id), ("corpsecret", agent_secret)]),
    )
    .await?;
    wecom_success(&value)?;
    let token = secret(&value, "access_token", 512).map_err(|_| provider_error())?;
    let seconds = value["expires_in"]
        .as_u64()
        .filter(|seconds| *seconds > 60)
        .ok_or_else(provider_error)?
        .min(7200)
        - 60;
    cached.retain(|_, entry| entry.expires > Instant::now());
    if cached.len() >= 128 {
        cached.clear()
    }
    cached.insert(
        cache_key,
        CachedToken {
            token: token.clone(),
            expires: Instant::now() + Duration::from_secs(seconds),
        },
    );
    Ok(token)
}

fn wecom_success(value: &Value) -> Result<()> {
    match value["errcode"].as_i64() {
        Some(0) => Ok(()),
        Some(45009 | 45011 | 45033) => Err(limited()),
        Some(40001 | 40013 | 40014 | 40082 | 42001 | 48002 | 60011 | 60020 | 60021) => {
            Err(permission_error())
        }
        _ => Err(provider_error()),
    }
}

async fn wecom_departments(client: &Client, token: &str, department: Option<u64>) -> Result<Value> {
    let mut query = vec![("access_token", token.to_owned())];
    if let Some(id) = department {
        query.push(("id", id.to_string()))
    }
    let value = json_response(
        client
            .get("https://qyapi.weixin.qq.com/cgi-bin/department/simplelist")
            .query(&query),
    )
    .await?;
    if matches!(value["errcode"].as_i64(), Some(40014 | 42001)) {
        // A provider may revoke a cached token before its advertised expiry.
        // Evict it so reconnect/retry can obtain a fresh token.
        WECOM_TOKENS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .await
            .retain(|_, entry| entry.token != token);
    }
    wecom_success(&value)?;
    if !value["department_id"].is_array() {
        return Err(provider_error());
    }
    Ok(value)
}

async fn wecom_read(client: &Client, credentials: &Value, query: &Value) -> Result<Value> {
    let operation = text_arg(query, "operation", 32)?.unwrap_or("departments");
    if operation != "departments" {
        return Err(unsupported());
    }
    let department = if query.get("department_id").is_some() {
        Some(bounded_number(query, "department_id", 1, i32::MAX as u64)?)
    } else {
        None
    };
    let limit = bounded_number(query, "limit", 10, ITEM_LIMIT as u64)? as usize;
    let token = wecom_token(client, credentials).await?;
    let value = wecom_departments(client, &token, department).await?;
    let rows = value["department_id"]
        .as_array()
        .ok_or_else(provider_error)?;
    let items: Vec<_> = rows.iter().take(limit).map(|row| {
        let id = scalar_id(&row["id"]);
        json!({"id":id,"title":format!("部门 {id}"),"text":format!("上级部门 {}，排序 {}",scalar_id(&row["parentid"]),scalar_id(&row["order"]))})
    }).collect();
    Ok(
        json!({"source":"wecom","operation":"departments","items":items,"truncated":rows.len()>limit,"scope":"应用获企业授权的可见部门 ID；不读取个人微信聊天"}),
    )
}

fn zhihu_request(client: &Client, token: &str, path: &str) -> RequestBuilder {
    client
        .get(format!("https://developer.zhihu.com{path}"))
        .bearer_auth(token)
        .header(
            "X-Request-Timestamp",
            chrono::Utc::now().timestamp().to_string(),
        )
        .header("Content-Type", "application/json")
}

fn zhihu_success(value: &Value) -> Result<()> {
    match value["Code"].as_i64() {
        Some(0) => Ok(()),
        Some(20001) => Err(permission_error()),
        Some(30001 | 30002) => Err(limited()),
        _ => Err(provider_error()),
    }
}

async fn zhihu_read(client: &Client, credentials: &Value, query: &Value) -> Result<Value> {
    let token = secret(credentials, "token", 4096)?;
    let keywords = text_arg(query, "keywords", 200)?.or(text_arg(query, "query", 200)?);
    let operation = text_arg(query, "operation", 32)?.unwrap_or(if keywords.is_some() {
        "search"
    } else {
        "collections"
    });
    let limit = bounded_number(query, "limit", 10, ITEM_LIMIT as u64)?;
    let mut params: Vec<(&str, String)> = Vec::new();
    let path = match operation {
        "search" => {
            params.push((
                "Query",
                keywords.ok_or_else(ConnectorError::invalid)?.into(),
            ));
            params.push(("Count", limit.min(10).to_string()));
            "/api/v1/content/zhihu_search"
        }
        "collections" => {
            params.push(("Limit", limit.to_string()));
            "/api/v1/user/collections"
        }
        "favlists" => {
            params.push(("Limit", limit.to_string()));
            "/api/v1/user/favlists"
        }
        "favlist_contents" => {
            let id = positive_id(&query["favlist_id"])?;
            params.push(("FavlistUrlToken", id.to_string()));
            params.push((
                "Offset",
                bounded_number(query, "offset", 0, 10000)?.to_string(),
            ));
            params.push(("Limit", limit.to_string()));
            "/api/v1/user/favlist_contents"
        }
        _ => return Err(unsupported()),
    };
    let value = json_response(zhihu_request(client, &token, path).query(&params)).await?;
    normalize_zhihu(&value, operation, limit as usize)
}

fn normalize_zhihu(value: &Value, operation: &str, limit: usize) -> Result<Value> {
    zhihu_success(&value)?;
    let rows = value["Data"]["Items"]
        .as_array()
        .ok_or_else(provider_error)?;
    let items: Vec<_> = rows.iter().take(limit.min(ITEM_LIMIT)).map(|row| {
        let url = clipped(row,"Url",4096);
        let text_field = match operation {"search"=>"ContentText","favlists"=>"Description",_=>"Summary"};
        let id = if operation == "search" {scalar_id(&row["ContentID"])} else if operation=="favlists" {scalar_id(&row["UrlToken"])}else{url.clone()};
        json!({"id":id,"title":clipped(row,"Title",256),"text":clipped(row,text_field,10000),"url":safe_link(&url,"zhihu.com")})
    }).collect();
    Ok(
        json!({"source":"zhihu","operation":operation,"items":items,"scope":"Access Secret 所有者的公开数据；不含私人收藏夹", "provider_billing":"遵循知乎开放平台额度与计费"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinate_validation_rejects_non_finite_and_extra_parameters() {
        for value in ["NaN,1", "0,inf", "181,1", "0,-91", "1,2,3", "1,2&key=x"] {
            assert!(coordinate(value).is_err(), "{value}");
        }
        assert_eq!(
            coordinate("116.397, 39.908").unwrap(),
            "116.397000,39.908000"
        );
    }

    #[test]
    fn path_segments_cannot_escape_fixed_provider_origin() {
        for value in ["..", ".", "a/b", "a%2fb", "a\\b", "a?b", "a#b"] {
            assert!(yuque_url(&["repos", value]).is_err());
        }
        let url = yuque_url(&["repos", "my-team", "book", "docs", "中文文档"]).unwrap();
        assert_eq!(url.host_str(), Some("www.yuque.com"));
        assert!(url.path().starts_with("/api/v2/repos/my-team/book/docs/"));
    }

    #[test]
    fn credentials_reject_injected_headers_and_oversize_values() {
        for token in ["", "token\r\nX-Injected: true", "has space", "中文"] {
            assert!(secret(&json!({"token":token}), "token", 256).is_err());
        }
        assert!(secret(&json!({"token":"x".repeat(257)}), "token", 256).is_err());
        assert_eq!(
            secret(&json!({"token":" token-value "}), "token", 256).unwrap(),
            "token-value"
        );
    }

    #[test]
    fn provider_errors_never_reflect_vendor_text_or_secret() {
        let error =
            wecom_success(&json!({"errcode":40013,"errmsg":"secret-from-vendor"})).unwrap_err();
        assert!(!error.to_string().contains("secret-from-vendor"));
        assert_eq!(error.code, "connection_required");
        assert_eq!(
            zhihu_success(&json!({"Code":30002})).unwrap_err().code,
            "provider_rate_limited"
        );
        assert!(zhihu_success(&json!({"Message":"ok"})).is_err());
        assert!(amap_success(&json!({"status":"0","infocode":"10001","info":"secret"})).is_err());
    }

    #[test]
    fn zhihu_official_search_and_collection_shapes_are_normalized() {
        let search = json!({"Code":0,"Data":{"HasMore":false,"Items":[
            {"ContentID":"answer-1","Title":"真实标题","ContentText":"内容摘要","Url":"https://www.zhihu.com/question/1/answer/2?utm_source=openapi"},
            {"ContentID":"answer-2","Title":"Second","ContentText":"Other","Url":"https://evil.example/"}
        ]}});
        let result = normalize_zhihu(&search, "search", 1).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["id"], "answer-1");
        assert_eq!(result["items"][0]["text"], "内容摘要");
        assert!(
            result["items"][0]["url"]
                .as_str()
                .unwrap()
                .contains("utm_source=openapi")
        );
        let collections = json!({"Code":0,"Data":{"Items":[{"Title":"收藏内容","Summary":"收藏摘要","Url":"https://www.zhihu.com/answer/42"}]}});
        assert_eq!(
            normalize_zhihu(&collections, "collections", 10).unwrap()["items"][0]["text"],
            "收藏摘要"
        );
        let folders = json!({"Code":0,"Data":{"Items":[{"UrlToken":9007199254740993_u64,"Title":"公开收藏夹","Description":"说明","Url":"https://www.zhihu.com/collection/9007199254740993"}]}});
        let result = normalize_zhihu(&folders, "favlists", 10).unwrap();
        assert_eq!(result["items"][0]["id"], "9007199254740993");
        assert_eq!(result["items"][0]["text"], "说明");
        assert!(normalize_zhihu(&json!({"Code":0,"Data":{}}), "search", 10).is_err());
    }

    #[test]
    fn source_links_allow_only_https_provider_domains() {
        assert!(safe_link("https://www.zhihu.com/question/1", "zhihu.com").is_some());
        for value in [
            "javascript:alert(1)",
            "https://zhihu.com.evil.example/a",
            "https://evil.example/a",
            "https://user:secret@zhihu.com/",
            "https://zhihu.com:444/a",
        ] {
            assert!(safe_link(value, "zhihu.com").is_none(), "{value}");
        }
    }

    #[test]
    fn input_and_pagination_limits_are_enforced() {
        assert!(bounded_number(&json!({"limit":0}), "limit", 10, 20).is_err());
        assert!(bounded_number(&json!({"limit":21}), "limit", 10, 20).is_err());
        assert!(bounded_number(&json!({"offset":-1}), "offset", 0, 10000).is_err());
        assert!(text_arg(&json!({"query":"bad\nquery"}), "query", 200).is_err());
        assert_eq!(
            positive_id(&json!("9007199254740993")).unwrap(),
            9007199254740993
        );
        for value in [
            json!(0),
            json!(-1),
            json!("1&x=y"),
            json!("9223372036854775808"),
        ] {
            assert!(positive_id(&value).is_err());
        }
    }

    #[tokio::test]
    async fn response_reader_bounds_chunked_bodies_and_redacts_http_errors() {
        use axum::{Router, body::Body, routing::get};
        let app = Router::new()
            .route(
                "/oversize",
                get(|| async {
                    Body::from_stream(futures_util::stream::iter([
                        Ok::<_, std::convert::Infallible>(vec![b'x'; RESPONSE_LIMIT / 2]),
                        Ok(vec![b'x'; RESPONSE_LIMIT / 2 + 1]),
                    ]))
                }),
            )
            .route(
                "/denied",
                get(|| async { (StatusCode::FORBIDDEN, "sensitive-provider-response") }),
            )
            .route("/ok", get(|| async { axum::Json(json!({"items":[]})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = http_client().unwrap();
        assert!(
            json_response(client.get(format!("http://{address}/oversize")))
                .await
                .is_err()
        );
        let denied = json_response(client.get(format!("http://{address}/denied")))
            .await
            .unwrap_err();
        assert_eq!(denied.code, "connection_required");
        assert!(!denied.to_string().contains("sensitive-provider-response"));
        assert_eq!(
            json_response(client.get(format!("http://{address}/ok")))
                .await
                .unwrap(),
            json!({"items":[]})
        );
        task.abort();
    }
}
