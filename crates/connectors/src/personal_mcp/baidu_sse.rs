//! The official Baidu Netdisk personal experience endpoint uses the legacy MCP
//! SSE transport: a GET stream announces a same-origin POST endpoint, and RPC
//! replies arrive on that original stream. No endpoint or access token is logged.
use super::{
    Credentials, DEADLINE, MAX_BYTES, PROTOCOL, oversized, protocol_error, rpc_result, timed_out,
    unauthorized, upstream,
};
use crate::Result;
use reqwest::{
    Client, Url,
    header::{ACCEPT, CONTENT_TYPE},
    redirect::Policy,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::timeout;

const MAX_SESSION_BYTES: usize = 2 * 1024 * 1024;

pub(super) struct LegacySse {
    client: Client,
    stream: Option<reqwest::Response>,
    buffer: Vec<u8>,
    consumed: usize,
    endpoint: Url,
    version: String,
    next_id: u64,
}

struct Event {
    kind: String,
    data: String,
}

impl LegacySse {
    pub(super) async fn official(credentials: &Credentials) -> Result<Self> {
        let mut url = Url::parse("https://mcp-pan.baidu.com/sse").map_err(|_| protocol_error())?;
        url.query_pairs_mut()
            .append_pair("access_token", &credentials.token);
        Self::connect_at(url).await
    }

    async fn connect_at(url: Url) -> Result<Self> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| upstream())?;
        // A persistent GET is needed for the full bounded operation. The outer
        // transport deadline cancels this stream; it is never automatically
        // reconnected or replayed after a disconnect.
        let response = client
            .get(url.clone())
            .header(ACCEPT, "text/event-stream")
            .timeout(DEADLINE + Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| upstream())?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(unauthorized());
        }
        if !response.status().is_success() {
            return Err(upstream());
        }
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            != Some("text/event-stream")
        {
            return Err(protocol_error());
        }
        let mut connection = Self {
            client,
            stream: Some(response),
            buffer: Vec::new(),
            consumed: 0,
            endpoint: url.clone(),
            version: PROTOCOL.into(),
            next_id: 1,
        };
        // The endpoint is discovered before any token-bearing request is sent
        // to it. Cross-origin URLs, userinfo and fragments are rejected.
        loop {
            let event = connection.next_event().await?;
            if event.kind == "endpoint" {
                connection.endpoint = validate_endpoint(&url, &event.data)?;
                return Ok(connection);
            }
            if !event.data.is_empty() {
                return Err(protocol_error());
            }
        }
    }

    pub(super) async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.post(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let event = self.next_event().await?;
            if event.kind == "endpoint" {
                return Err(protocol_error());
            }
            if event.kind != "message" || event.data.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&event.data).map_err(|_| protocol_error())?;
            if value.get("id").is_none() {
                if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
                    return Err(protocol_error());
                }
                continue; // Notifications are untrusted data, not client instructions.
            }
            return rpc_result(value, id);
        }
    }

    pub(super) async fn notify(&mut self, method: &str) -> Result<()> {
        self.post(json!({"jsonrpc":"2.0","method":method})).await
    }

    async fn post(&self, body: Value) -> Result<()> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .header(CONTENT_TYPE, "application/json")
            .header("MCP-Protocol-Version", &self.version)
            .timeout(Duration::from_secs(10))
            .json(&body)
            .send()
            .await
            .map_err(|_| upstream())?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(unauthorized());
        }
        if !response.status().is_success() {
            return Err(upstream());
        }
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Event> {
        loop {
            if let Some((offset, separator)) = super::sse_boundary(&self.buffer) {
                let frame = self.buffer[..offset].to_vec();
                self.buffer.drain(..offset + separator);
                let event = parse_event(&frame)?;
                if !event.data.is_empty() || event.kind == "endpoint" {
                    return Ok(event);
                }
                continue;
            }
            let stream = self.stream.as_mut().ok_or_else(protocol_error)?;
            let chunk = timeout(Duration::from_secs(10), stream.chunk())
                .await
                .map_err(|_| timed_out())?
                .map_err(|_| upstream())?
                .ok_or_else(upstream)?;
            self.consumed += chunk.len();
            if self.consumed > MAX_SESSION_BYTES || self.buffer.len() + chunk.len() > MAX_BYTES {
                return Err(oversized());
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }

    pub(super) fn close(&mut self) {
        // Closing the GET response cancels the server's SSE session. No invented
        // DELETE endpoint, background reconnect or write replay is used.
        self.stream.take();
        self.buffer.clear();
    }
    pub(super) fn set_protocol(&mut self, version: &str) {
        self.version = version.into();
    }
}

fn validate_endpoint(origin: &Url, value: &str) -> Result<Url> {
    if value.is_empty()
        || value.len() > 4096
        || value.bytes().any(|value| value <= 0x20 || value == 0x7f)
    {
        return Err(protocol_error());
    }
    let endpoint = origin.join(value).map_err(|_| protocol_error())?;
    if endpoint.origin() != origin.origin()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(protocol_error());
    }
    Ok(endpoint)
}

fn parse_event(frame: &[u8]) -> Result<Event> {
    let text = std::str::from_utf8(frame).map_err(|_| protocol_error())?;
    let mut kind = "message".to_owned();
    let mut data = String::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            kind = value.strip_prefix(' ').unwrap_or(value).into();
        }
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    Ok(Event { kind, data })
}

/// tools/list alone may be a static unauthenticated catalog. A positive account
/// identifier from the actual read-only user_info API is required before save.
pub(super) fn validate_identity(result: &Value) -> Result<()> {
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(unauthorized());
    }
    if result.get("structuredContent").is_some_and(valid_account) {
        return Ok(());
    }
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if serde_json::from_str::<Value>(text)
                    .ok()
                    .as_ref()
                    .is_some_and(valid_account)
                {
                    return Ok(());
                }
            }
        }
    }
    Err(unauthorized())
}

fn valid_account(value: &Value) -> bool {
    if value
        .get("errno")
        .is_some_and(|errno| errno.as_i64() != Some(0))
    {
        return false;
    }
    let account = value
        .get("data")
        .filter(|data| data.is_object())
        .unwrap_or(value);
    if account
        .get("errno")
        .is_some_and(|errno| errno.as_i64() != Some(0))
    {
        return false;
    }
    let id = &account["uk"];
    id.as_u64().is_some_and(|id| id > 0)
        || id.as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 32
                && id.bytes().all(|value| value.is_ascii_digit())
                && id.bytes().any(|value| value != b'0')
        })
}

#[cfg(test)]
#[path = "baidu_sse_tests.rs"]
mod tests;
