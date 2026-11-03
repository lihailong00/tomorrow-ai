//! Provider-owned Tencent/WeChatReading skills/SKILL.md version 1.0.5.
use super::transport::Credentials;
use crate::{ConnectorError, Result};
use axum::http::StatusCode;
use reqwest::{
    Client,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde_json::{Value, json};
use std::time::Duration;

const MAX_BYTES: usize = 256 * 1024;
const SKILL_VERSION: &str = "1.0.5";
fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "微信读书此工具不接受额外参数",
    )
}
fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "weread_provider_error",
        "微信读书官方接口未成功，请检查个人 API Key 和接口权限",
    )
}
pub fn is_read_only(tool: &str) -> bool {
    matches!(
        tool,
        "weread_bookshelf" | "weread_api_definitions" | "weread_search_books" | "weread_notebooks"
    )
}
pub fn validate_arguments(tool: &str, args: &Value) -> Result<()> {
    if tool == "weread_search_books" {
        if !args.as_object().is_some_and(|object| object.len() == 1)
            || !args["query"].as_str().is_some_and(|query| {
                !query.trim().is_empty()
                    && query.len() <= 1000
                    && !query.chars().any(char::is_control)
            })
        {
            return Err(invalid());
        }
    } else if !is_read_only(tool) || !args.as_object().is_some_and(|object| object.is_empty()) {
        return Err(invalid());
    }
    Ok(())
}
async fn request(
    client: &Client,
    endpoint: &str,
    credentials: &Credentials,
    tool: &str,
    args: Value,
) -> Result<Value> {
    validate_arguments(tool, &args)?;
    let mut headers = HeaderMap::new();
    let mut auth =
        HeaderValue::from_str(&format!("Bearer {}", credentials.token)).map_err(|_| invalid())?;
    auth.set_sensitive(true);
    headers.insert(AUTHORIZATION, auth);
    let mut body = json!({"api_name":match tool { "weread_bookshelf"=>"/shelf/sync", "weread_api_definitions"=>"/_list", "weread_search_books"=>"/store/search", "weread_notebooks"=>"/user/notebooks", _=>return Err(invalid()) },"skill_version":SKILL_VERSION});
    if tool == "weread_search_books" {
        body["keyword"] = args["query"].clone();
        body["count"] = json!(10);
    }
    if tool == "weread_notebooks" {
        body["count"] = json!(100);
    }
    let mut response = client
        .post(endpoint)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|_| upstream())?;
    if !response.status().is_success() {
        return Err(upstream());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err(upstream());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(upstream());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| upstream())?;
    if value
        .get("upgrade_info")
        .is_some_and(|info| !info.is_null() && info != &Value::Bool(false))
    {
        return Err(ConnectorError::new(
            StatusCode::BAD_GATEWAY,
            "weread_upgrade_required",
            "微信读书要求升级官方 Skill 协议，请更新服务器后重试",
        ));
    }
    if !value.is_object()
        || value
            .get("errcode")
            .is_some_and(|code| code != 0 && code != "0")
        || value["isError"] == true
        || value.get("error").is_some_and(|error| !error.is_null())
    {
        return Err(upstream());
    }
    Ok(value)
}
fn client() -> Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| upstream())
}
pub async fn discover(credentials: &Credentials) -> Result<Vec<Value>> {
    credentials.validate("weread")?;
    request(
        &client()?,
        "https://i.weread.qq.com/api/agent/gateway",
        credentials,
        "weread_bookshelf",
        json!({}),
    )
    .await?;
    Ok([("weread_bookshelf", "读取本人微信读书书架"), ("weread_api_definitions", "读取微信读书官方接口定义"), ("weread_search_books", "搜索微信读书书籍"), ("weread_notebooks", "读取本人微信读书笔记本列表（首批，最多100项）")].into_iter().map(|(name, description)| {
        let schema = if name == "weread_search_books" {
            json!({"type":"object","additionalProperties":false,"required":["query"],"properties":{"query":{"type":"string","minLength":1,"maxLength":1000}}})
        } else { json!({"type":"object","additionalProperties":false,"properties":{}}) };
        json!({"name":name,"description":description,"inputSchema":schema})
    }).collect())
}
pub async fn call(credentials: &Credentials, tool: &str, args: Value) -> Result<Value> {
    credentials.validate("weread")?;
    request(
        &client()?,
        "https://i.weread.qq.com/api/agent/gateway",
        credentials,
        tool,
        args,
    )
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_declared_no_argument_reads_are_enabled() {
        assert!(validate_arguments("weread_bookshelf", &json!({})).is_ok());
        assert!(validate_arguments("weread_bookshelf", &json!({"api_name":"/delete"})).is_err());
        assert!(!is_read_only("weread_delete_book"));
    }
}
