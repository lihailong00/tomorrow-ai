//! Bounded personal-account transports. Preset endpoints and executable
//! selection are server-owned; Memos separately validates user instance URLs.
use std::{path::PathBuf, process::Stdio, time::Duration};

use axum::http::StatusCode;
use reqwest::{
    Client, Url,
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    time::timeout,
};

use crate::{ConnectorError, Result};

#[path = "baidu_sse.rs"]
mod baidu_sse;

const MAX_BYTES: usize = 256 * 1024;
const MAX_TOOLS: usize = 128;
const MAX_PAGES: usize = 8;
const DEADLINE: Duration = Duration::from_secs(30);
const PROTOCOL: &str = "2025-03-26";

fn production() -> String {
    "production".into()
}

// Deliberately no Debug: personal access tokens must never enter diagnostics.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub token: String,
    #[serde(default = "production")]
    pub environment: String,
    #[serde(default)]
    pub server_url: Option<String>,
}

impl Credentials {
    pub fn validate(&self, provider: &str) -> Result<()> {
        let entry = super::catalog::find(provider)?;
        if !entry.supported {
            return Err(unavailable());
        }
        // Only opaque credentials are accepted. URL/import text and control
        // characters cannot accidentally become an Authorization header.
        if self.token.is_empty()
            || self.token.len() > 8192
            || self.token.trim() != self.token
            || self
                .token
                .bytes()
                .any(|value| value <= 0x20 || value == 0x7f)
            || (provider != "memos" && self.server_url.is_some())
            || !(if provider == "baidu_netdisk" {
                self.environment == "experience"
            } else {
                self.environment == "production"
                    || (provider == "didi" && self.environment == "sandbox")
            })
        {
            return Err(invalid());
        }
        if provider == "memos" { super::memos::validate(self)?; }
        Ok(())
    }
}

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "个人连接参数无效，请按官方页面填写个人凭证",
    )
}
fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "not_configured",
        "此个人 MCP 暂不可用，请检查服务配置或使用其他连接",
    )
}
fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "mcp_provider_error",
        "官方 MCP 请求未成功，请稍后重试；授权失效时请重新连接",
    )
}
fn protocol_error() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "mcp_protocol_error",
        "官方 MCP 返回了无法识别的响应",
    )
}
fn oversized() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "mcp_response_limit",
        "官方 MCP 返回内容过大，请缩小查询范围",
    )
}
fn timed_out() -> ConnectorError {
    ConnectorError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "mcp_timeout",
        "官方 MCP 响应超时，操作结果可能尚未确认，请先查询状态",
    )
}
fn unauthorized() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "connection_required",
        "个人凭证无效或已过期，请重新连接账号",
    )
}

pub async fn discover(provider: &str, credentials: &Credentials) -> Result<Vec<Value>> {
    credentials.validate(provider)?;
    if provider == "notion" {
        return timeout(DEADLINE, super::notion::discover(credentials)).await.map_err(|_| timed_out())?;
    }
    if provider == "yinxiang" {
        return timeout(DEADLINE, super::yinxiang::discover(credentials))
            .await
            .map_err(|_| timed_out())?;
    }
    timeout(DEADLINE, async {
        let mut connection = Connection::open(provider, credentials).await?;
        let result = async {
            let mut tools = discover_on(&mut connection).await?;
            if provider == "memos" {
                tools.retain(|tool| tool["name"].as_str().is_some_and(super::memos::enabled_tool));
            }
            // The official stdio server can list its tools entirely offline.
            // A real account read is therefore required before claiming that a
            // personal Yuque token has been validated.
            if provider == "yuque" {
                let identity = connection
                    .rpc(
                        "tools/call",
                        json!({"name":"yuque_get_user","arguments":{}}),
                    )
                    .await?;
                validate_yuque_identity(&identity)?;
            }
            if provider == "baidu_netdisk" {
                if !tools.iter().any(|tool| tool["name"] == "user_info") {
                    return Err(protocol_error());
                }
                let identity = connection
                    .rpc("tools/call", json!({"name":"user_info","arguments":{}}))
                    .await?;
                baidu_sse::validate_identity(&identity)?;
            }
            if provider == "memos" {
                if !tools.iter().any(|tool| tool["name"] == "auth_get_current_user") { return Err(protocol_error()); }
                let identity = connection.rpc("tools/call", json!({"name":"auth_get_current_user","arguments":{}})).await?;
                super::memos::validate_identity(&identity)?;
            }
            Ok(tools)
        }
        .await;
        connection.close().await;
        result
    })
    .await
    .map_err(|_| timed_out())?
}

fn validate_yuque_identity(value: &Value) -> Result<()> {
    if value["isError"] == true { return Err(unauthorized()); }
    let identity = value["content"].as_array().into_iter().flatten()
        .filter_map(|part| part["text"].as_str())
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .find(|user| user["id"].as_u64().is_some_and(|id|id>0)
            && user["login"].as_str().is_some_and(|login|!login.trim().is_empty()));
    if identity.is_none() { return Err(unauthorized()); }
    Ok(())
}

pub async fn call(
    provider: &str,
    credentials: &Credentials,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    credentials.validate(provider)?;
    if tool.is_empty()
        || tool.len() > 128
        || !tool
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"_-.".contains(&v))
        || !arguments.is_object()
        || arguments.to_string().len() > 48 * 1024
    {
        return Err(invalid());
    }
    let arguments = call_arguments(provider, arguments);
    if provider == "notion" {
        return timeout(DEADLINE, super::notion::call(credentials, tool, arguments)).await.map_err(|_| timed_out())?;
    }
    if provider == "yinxiang" {
        return timeout(
            DEADLINE,
            super::yinxiang::call(credentials, tool, arguments),
        )
        .await
        .map_err(|_| timed_out())?;
    }
    timeout(DEADLINE, async {
        let mut connection = Connection::open(provider, credentials).await?;
        // Never retry a tools/call: the provider may already have committed it.
        let result = connection
            .rpc("tools/call", json!({"name":tool,"arguments":arguments}))
            .await;
        connection.close().await;
        result
    })
    .await
    .map_err(|_| timed_out())?
}

fn call_arguments(provider: &str, mut arguments: Value) -> Value {
    if provider == "tencent_meeting" {
        let model = arguments
            .get("_client_info")
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.len() <= 256)
            .unwrap_or("not_provided")
            .to_owned();
        // The run bridge supplies its real frozen model ID. Direct user calls
        // have no originating model, so say so explicitly; never guess one.
        arguments["_client_info"] = json!({"os":std::env::consts::OS,"agent":"Tada","model":model});
    }
    arguments
}

async fn discover_on(connection: &mut Connection) -> Result<Vec<Value>> {
    let mut tools = Vec::new();
    let mut cursors = Vec::new();
    let mut params = json!({});
    for _ in 0..MAX_PAGES {
        let page = connection.rpc("tools/list", params).await?;
        let items = page
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(protocol_error)?;
        for item in items {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(protocol_error)?;
            if name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|v| v.is_ascii_alphanumeric() || b"_-.".contains(&v))
                || !item.get("inputSchema").is_some_and(Value::is_object)
                || tools.iter().any(|prior: &Value| prior["name"] == name)
            {
                return Err(protocol_error());
            }
            tools.push(item.clone());
            if tools.len() > MAX_TOOLS
                || serde_json::to_vec(&tools)
                    .map_err(|_| protocol_error())?
                    .len()
                    > MAX_BYTES
            {
                return Err(oversized());
            }
        }
        match page.get("nextCursor") {
            None | Some(Value::Null) => return Ok(tools),
            Some(Value::String(cursor))
                if !cursor.is_empty() && cursor.len() <= 2048 && !cursors.contains(cursor) =>
            {
                cursors.push(cursor.clone());
                params = json!({"cursor":cursor});
            }
            _ => return Err(protocol_error()),
        }
    }
    Err(oversized())
}

enum Connection {
    Http(HttpConnection),
    Stdio(StdioConnection),
    Baidu(baidu_sse::LegacySse),
}

impl Connection {
    async fn open(provider: &str, credentials: &Credentials) -> Result<Self> {
        let mut connection = if provider == "baidu_netdisk" {
            Self::Baidu(baidu_sse::LegacySse::official(credentials).await?)
        } else if provider == "yuque" {
            Self::Stdio(StdioConnection::open(credentials)?)
        } else if provider == "memos" {
            Self::Http(HttpConnection::memos(credentials).await?)
        } else {
            Self::Http(HttpConnection::official(provider, credentials)?)
        };
        // The official Tencent Meeting Skill uses stateless JSON-RPC POST
        // directly, with no initialize/initialized handshake (package 1.0.16).
        if provider == "tencent_meeting" {
            return Ok(connection);
        }
        connection.initialize().await?;
        Ok(connection)
    }
    async fn initialize(&mut self) -> Result<()> {
        let initialize = self.rpc("initialize", json!({"protocolVersion":PROTOCOL,"capabilities":{},"clientInfo":{"name":"tada-personal-mcp","version":"0.1.0"}})).await?;
        let version = initialize
            .get("protocolVersion")
            .and_then(Value::as_str)
            .ok_or_else(protocol_error)?;
        if !matches!(
            version,
            "2024-11-05" | "2025-03-26" | "2025-06-18" | "2025-11-25"
        ) || !initialize.get("capabilities").is_some_and(Value::is_object)
        {
            return Err(protocol_error());
        }
        if let Self::Http(http) = self {
            http.version = version.into();
        } else if let Self::Baidu(sse) = self {
            sse.set_protocol(version);
        }
        self.notify("notifications/initialized").await
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        match self {
            Self::Http(http) => http.rpc(method, params).await,
            Self::Stdio(stdio) => stdio.rpc(method, params).await,
            Self::Baidu(sse) => sse.rpc(method, params).await,
        }
    }
    async fn notify(&mut self, method: &str) -> Result<()> {
        match self {
            Self::Http(http) => http.notify(method).await,
            Self::Stdio(stdio) => stdio.notify(method).await,
            Self::Baidu(sse) => sse.notify(method).await,
        }
    }
    async fn close(&mut self) {
        match self {
            Self::Stdio(stdio) => {
                let _ = stdio.child.kill().await;
                let _ = stdio.child.wait().await;
            }
            Self::Http(http) => http.close().await,
            Self::Baidu(sse) => sse.close(),
        }
    }
}

struct HttpConnection {
    client: Client,
    url: Url,
    headers: HeaderMap,
    session: Option<HeaderValue>,
    version: String,
    next_id: u64,
}

impl HttpConnection {
    async fn memos(credentials: &Credentials) -> Result<Self> {
        let (url, client) = super::memos::endpoint(credentials).await?;
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", credentials.token)).map_err(|_| invalid())?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);
        Ok(Self { client, url, headers, session: None, version: PROTOCOL.into(), next_id: 1 })
    }
    fn official(provider: &str, credentials: &Credentials) -> Result<Self> {
        let mut headers = HeaderMap::new();
        let address = match provider {
            "mcdonalds" => {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {}", credentials.token))
                        .map_err(|_| invalid())?,
                );
                "https://mcp.mcd.cn"
            }
            "didi" => {
                if credentials.environment == "sandbox" {
                    "https://mcp.didichuxing.com/mcp-servers-sandbox"
                } else {
                    "https://mcp.didichuxing.com/mcp-servers"
                }
            }
            "tencent_docs" => {
                headers.insert(
                    AUTHORIZATION,
                    HeaderValue::from_str(&credentials.token).map_err(|_| invalid())?,
                );
                "https://docs.qq.com/openapi/mcp"
            }
            "tencent_meeting" => {
                headers.insert(
                    "X-Tencent-Meeting-Token",
                    HeaderValue::from_str(&credentials.token).map_err(|_| invalid())?,
                );
                // Official verified Skill package 1.0.16 config.json declares
                // protocol header version v1.0.15; these versions are distinct.
                headers.insert("X-Skill-Version", HeaderValue::from_static("v1.0.15"));
                "https://mcp.meeting.tencent.com/mcp/wemeet-open/v1"
            }
            _ => return Err(unavailable()),
        };
        let mut url = Url::parse(address).map_err(|_| unavailable())?;
        if provider == "didi" {
            url.query_pairs_mut().append_pair("key", &credentials.token);
        }
        Self::new(url, headers)
    }
    fn new(url: Url, headers: HeaderMap) -> Result<Self> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            client,
            url,
            headers,
            session: None,
            version: PROTOCOL.into(),
            next_id: 1,
        })
    }
    fn request(&self) -> reqwest::RequestBuilder {
        let mut request = self
            .client
            .post(self.url.clone())
            .headers(self.headers.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version);
        if let Some(session) = &self.session {
            request = request.header("Mcp-Session-Id", session);
        }
        request
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let response = self
            .request()
            .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    timed_out()
                } else {
                    upstream()
                }
            })?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            return Err(unauthorized());
        }
        if !response.status().is_success() {
            return Err(upstream());
        }
        if let Some(session) = response.headers().get("Mcp-Session-Id") {
            if session.as_bytes().len() > 1024
                || session.as_bytes().iter().any(|v| !v.is_ascii_graphic())
            {
                return Err(protocol_error());
            }
            if self.session.as_ref().is_some_and(|old| old != session) {
                return Err(protocol_error());
            }
            self.session = Some(session.clone());
        }
        read_http_response(response, id).await
    }
    async fn notify(&mut self, method: &str) -> Result<()> {
        let response = self
            .request()
            .json(&json!({"jsonrpc":"2.0","method":method}))
            .send()
            .await
            .map_err(|_| upstream())?;
        if !response.status().is_success() {
            return Err(upstream());
        }
        Ok(())
    }
    async fn close(&self) {
        if let Some(session) = &self.session {
            let _ = self
                .client
                .delete(self.url.clone())
                .headers(self.headers.clone())
                .header("Mcp-Session-Id", session)
                .header("MCP-Protocol-Version", &self.version)
                .timeout(Duration::from_secs(2))
                .send()
                .await;
        }
    }
}

fn rpc_result(value: Value, id: u64) -> Result<Value> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("id").and_then(Value::as_u64) != Some(id)
    {
        return Err(protocol_error());
    }
    if value.get("error").is_some() {
        return Err(upstream());
    }
    value.get("result").cloned().ok_or_else(protocol_error)
}

async fn read_http_response(mut response: reqwest::Response, id: u64) -> Result<Value> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err(oversized());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let sse = content_type == "text/event-stream";
    if !sse && content_type != "application/json" {
        return Err(protocol_error());
    }
    let mut body = Vec::new();
    let mut consumed = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        consumed += chunk.len();
        if consumed > MAX_BYTES {
            return Err(oversized());
        }
        body.extend_from_slice(&chunk);
        if sse {
            while let Some((offset, separator)) = sse_boundary(&body) {
                let frame = body[..offset].to_vec();
                body.drain(..offset + separator);
                if let Some(value) = sse_frame(&frame, id)? {
                    return Ok(value);
                }
            }
        }
    }
    if sse {
        return Err(protocol_error());
    }
    rpc_result(
        serde_json::from_slice(&body).map_err(|_| protocol_error())?,
        id,
    )
}

fn sse_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    bytes
        .windows(2)
        .position(|item| item == b"\n\n")
        .map(|offset| (offset, 2))
        .into_iter()
        .chain(
            bytes
                .windows(4)
                .position(|item| item == b"\r\n\r\n")
                .map(|offset| (offset, 4)),
        )
        .min_by_key(|item| item.0)
}
fn sse_frame(frame: &[u8], id: u64) -> Result<Option<Value>> {
    let text = std::str::from_utf8(frame).map_err(|_| protocol_error())?;
    let mut data = String::new();
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&data).map_err(|_| protocol_error())?;
    if value.get("id").is_none() {
        return Ok(None);
    } // Provider notifications are data, never new instructions.
    if value.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(protocol_error());
    }
    rpc_result(value, id).map(Some)
}

pub(super) fn yuque_script() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PERSONAL_MCP_YUQUE_SCRIPT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("services/agent/node_modules/yuque-mcp/dist/cli.js"));
        candidates.push(cwd.join("node_modules/yuque-mcp/dist/cli.js"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(root) = executable.parent().and_then(|parent| parent.parent()) {
            candidates.push(root.join("services/agent/node_modules/yuque-mcp/dist/cli.js"));
        }
    }
    candidates
        .into_iter()
        .find_map(|path| path.canonicalize().ok().filter(|path| path.is_file()))
}

struct StdioConnection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}
impl StdioConnection {
    fn open(credentials: &Credentials) -> Result<Self> {
        let script = yuque_script().ok_or_else(unavailable)?;
        let node = std::env::var_os("PERSONAL_MCP_NODE").unwrap_or_else(|| "node".into());
        Self::spawn(node, script, &credentials.token)
    }
    fn spawn(node: std::ffi::OsString, script: PathBuf, token: &str) -> Result<Self> {
        let mut command = tokio::process::Command::new(node);
        command
            .arg(script)
            .env_clear()
            .env("YUQUE_TOKEN", token)
            .env("YUQUE_PERSONAL_TOKEN", token)
            .env("NO_COLOR", "1");
        // Do not inherit model keys, signing secrets or other users' credentials.
        for name in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "HOME",
            "USERPROFILE",
            "LANG",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|_| unavailable())?;
        let stdin = child.stdin.take().ok_or_else(unavailable)?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(unavailable)?);
        Ok(Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        })
    }
    async fn write(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
        if bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await.map_err(|_| upstream())?;
        self.stdin.flush().await.map_err(|_| upstream())
    }
    async fn notify(&mut self, method: &str) -> Result<()> {
        self.write(json!({"jsonrpc":"2.0","method":method})).await
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let mut total = 0;
        loop {
            let mut line = Vec::new();
            loop {
                let buffer = self.stdout.fill_buf().await.map_err(|_| upstream())?;
                if buffer.is_empty() {
                    return Err(upstream());
                }
                let end = buffer
                    .iter()
                    .position(|value| *value == b'\n')
                    .map(|offset| offset + 1)
                    .unwrap_or(buffer.len());
                if total + end > MAX_BYTES {
                    return Err(oversized());
                }
                let completed = buffer[end - 1] == b'\n';
                line.extend_from_slice(&buffer[..end]);
                self.stdout.consume(end);
                total += end;
                if completed {
                    break;
                }
            }
            let value: Value = serde_json::from_slice(&line).map_err(|_| protocol_error())?;
            if value.get("id").is_some() {
                return rpc_result(value, id);
            }
        }
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
