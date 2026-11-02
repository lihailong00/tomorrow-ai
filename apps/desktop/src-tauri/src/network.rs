//! A deliberately small bridge: trusted local UI -> the selected Tada server.
//! It does not run agent tools, shell commands, or parse provider/model output.

use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{State, ipc::Channel};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 16;

#[derive(Default)]
struct Requests {
    active: HashMap<String, CancellationToken>,
    // Cancellation can arrive before invoke's async handler starts. Remember it
    // briefly rather than letting a fast stop click miss the registration race.
    cancelled: HashMap<String, Instant>,
}

pub struct DesktopState {
    client: Client,
    requests: Mutex<Requests>,
}

impl DesktopState {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .read_timeout(Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent(concat!("TadaDesktop/", env!("CARGO_PKG_VERSION")))
                .build()?,
            requests: Mutex::default(),
        })
    }

    fn register(&self, id: &str) -> Result<CancellationToken, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        {
            return Err("Invalid request ID".into());
        }
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "Request state unavailable")?;
        requests
            .cancelled
            .retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if requests.cancelled.remove(id).is_some() {
            return Err("request_cancelled".into());
        }
        if requests.active.contains_key(id) {
            return Err("Request ID already active".into());
        }
        if requests.active.len() >= MAX_CONCURRENT_REQUESTS {
            return Err("Too many active requests; please wait".into());
        }
        let token = CancellationToken::new();
        requests.active.insert(id.to_owned(), token.clone());
        Ok(token)
    }

    fn finish(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.active.remove(id);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequest {
    server_url: String,
    path: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    #[serde(default)]
    allow_insecure_lan: bool,
}

#[derive(Serialize)]
pub struct NativeResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NativeEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
}

fn is_private_host(host: Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_private(),
        Host::Ipv6(ip) => ip.is_unique_local(),
        Host::Domain(name) => name.ends_with(".local"),
    }
}

pub fn normalized_server(server: &str, allow_insecure_lan: bool) -> Result<Url, String> {
    if server.trim().len() > 2048 || server.contains('\\') {
        return Err("Invalid server URL".into());
    }
    let mut url = Url::parse(server.trim()).map_err(|_| "Invalid server URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Server URL must contain only the origin, without credentials, path, query or fragment"
                .into(),
        );
    }
    let host = url.host().ok_or("Server host is required")?;
    let loopback = match host {
        Host::Domain(name) => name == "localhost",
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback || (allow_insecure_lan && is_private_host(host)) => {}
        _ => return Err("Use HTTPS; unencrypted HTTP is only available for localhost or explicitly selected private LAN servers".into()),
    }
    url.set_path("/");
    Ok(url)
}

fn request_url(request: &NativeRequest) -> Result<Url, String> {
    let base = normalized_server(&request.server_url, request.allow_insecure_lan)?;
    if !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.contains('\\')
        || request.path.contains('#')
    {
        return Err("Request path must be relative to the selected server".into());
    }
    let joined = base
        .join(&request.path)
        .map_err(|_| "Invalid request path")?;
    if joined.origin() != base.origin() {
        return Err("Request cannot change the selected server".into());
    }
    if joined.path() != "/health" && !joined.path().starts_with("/v1/") {
        return Err("Only Tada API paths can be requested".into());
    }
    Ok(joined)
}

fn request_builder(
    client: &Client,
    request: NativeRequest,
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let url = request_url(&request)?;
    if !matches!(
        request.method.to_ascii_uppercase().as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("HTTP method not allowed".into());
    }
    let method = Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| "Invalid HTTP method")?;
    let mut builder = client
        .request(method, url)
        .timeout(Duration::from_secs(if stream { 900 } else { 45 }));
    for (name, value) in request.headers {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization"
                | "accept"
                | "content-type"
                | "idempotency-key"
                | "x-request-id"
                | "x-client-id"
                | "last-event-id"
                | "x-chat-retry"
        ) {
            return Err("HTTP header not allowed".into());
        }
        if value.len() > 16_384 || value.contains(['\r', '\n']) {
            return Err("Invalid HTTP header".into());
        }
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        if body.len() > MAX_JSON_BYTES {
            return Err("Request exceeds the 8 MB limit".into());
        }
        builder = builder.body(body);
    }
    Ok(builder)
}

fn response_headers(response: &reqwest::Response) -> HashMap<String, String> {
    response
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != "set-cookie")
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_owned()))
        })
        .collect()
}

fn network_error(error: &reqwest::Error) -> String {
    // Never return a full URL/query, request body, password or authorization value.
    if error.is_timeout() {
        "服务器响应超时，请检查连接后重试".into()
    } else if error.is_connect() {
        "无法连接所选服务器，请检查网络、地址和 HTTPS 证书".into()
    } else {
        "网络请求中断，请重试".into()
    }
}

#[tauri::command]
pub async fn desktop_request(
    state: State<'_, DesktopState>,
    request: NativeRequest,
    request_id: Option<String>,
) -> Result<NativeResponse, String> {
    let builder = request_builder(&state.client, request, false)?;
    let token = match request_id.as_deref() {
        Some(id) => state.register(id)?,
        None => CancellationToken::new(),
    };
    let result = async {
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err("request_cancelled".into()),
            response = builder.send() => response.map_err(|error| network_error(&error))?,
        };
        let status = response.status().as_u16();
        let headers = response_headers(&response);
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_JSON_BYTES as u64)
        {
            return Err("Response exceeds the 8 MB limit".into());
        }
        let mut chunks = response.bytes_stream();
        let mut body = Vec::new();
        loop {
            let next = tokio::select! {
                biased;
                _ = token.cancelled() => return Err("request_cancelled".into()),
                next = chunks.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|error| network_error(&error))?;
            if body.len() + chunk.len() > MAX_JSON_BYTES {
                return Err("Response exceeds the 8 MB limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(body).map_err(|_| "Server returned invalid text")?;
        Ok(NativeResponse {
            status,
            headers,
            body,
        })
    }
    .await;
    if let Some(id) = request_id {
        state.finish(&id);
    }
    result
}

#[tauri::command]
pub async fn desktop_stream(
    state: State<'_, DesktopState>,
    request_id: String,
    request: NativeRequest,
    on_event: Channel<NativeEvent>,
) -> Result<(), String> {
    let builder = request_builder(&state.client, request, true)?;
    let token = state.register(&request_id)?;
    let result = async {
        let response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err("request_cancelled".into()),
            response = builder.send() => response.map_err(|error| network_error(&error))?,
        };
        on_event
            .send(NativeEvent::Headers {
                status: response.status().as_u16(),
                headers: response_headers(&response),
            })
            .map_err(|_| "Window closed")?;
        let mut chunks = response.bytes_stream();
        let mut total = 0usize;
        loop {
            let next = tokio::select! {
                biased;
                _ = token.cancelled() => return Err("request_cancelled".into()),
                next = chunks.next() => next,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|error| network_error(&error))?;
            total += chunk.len();
            if total > MAX_STREAM_BYTES {
                return Err("Reply exceeds the 64 MB limit".into());
            }
            // Byte boundaries are not Unicode boundaries. The client keeps one
            // incremental TextDecoder for the entire stream.
            for part in chunk.chunks(32 * 1024) {
                on_event
                    .send(NativeEvent::Chunk {
                        bytes: part.to_vec(),
                    })
                    .map_err(|_| "Window closed")?;
            }
        }
        on_event
            .send(NativeEvent::End)
            .map_err(|_| "Window closed")?;
        Ok(())
    }
    .await;
    state.finish(&request_id);
    result
}

#[tauri::command]
pub fn desktop_cancel(state: State<'_, DesktopState>, request_id: String) -> Result<(), String> {
    if request_id.len() > 128 {
        return Err("Invalid request ID".into());
    }
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "Request state unavailable")?;
    if let Some(token) = requests.active.get(&request_id) {
        token.cancel();
    } else {
        requests
            .cancelled
            .retain(|_, time| time.elapsed() < Duration::from_secs(60));
        if requests.cancelled.len() >= 128 {
            return Err("Too many pending cancellations".into());
        }
        requests.cancelled.insert(request_id, Instant::now());
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_open_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid link")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || url.len() > 8192
    {
        return Err("Only HTTP and HTTPS links can be opened".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        open::that_detached(parsed.as_str()).map_err(|_| "无法打开系统浏览器".to_owned())
    })
    .await
    .map_err(|_| "Cannot open browser")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(server: &str, path: &str, allow: bool) -> NativeRequest {
        NativeRequest {
            server_url: server.into(),
            path: path.into(),
            method: "GET".into(),
            headers: HashMap::new(),
            body: None,
            allow_insecure_lan: allow,
        }
    }

    #[test]
    fn accepts_https_and_normalizes_default_port() {
        assert_eq!(
            normalized_server(" https://EXAMPLE.com:443 ", false)
                .unwrap()
                .as_str(),
            "https://example.com/"
        );
    }

    #[test]
    fn rejects_server_credentials_and_path_tricks() {
        for server in [
            "https://user:secret@example.com",
            "https://example.com/x",
            "https://example.com?token=x",
            "https://example.com/#x",
            "file:///tmp",
            "https://example.com\\@evil.test",
        ] {
            assert!(normalized_server(server, true).is_err(), "{server}");
        }
    }

    #[test]
    fn http_requires_loopback_or_explicit_private_lan() {
        assert!(normalized_server("http://localhost:8080", false).is_ok());
        assert!(normalized_server("http://127.0.0.2:8080", false).is_ok());
        assert!(normalized_server("http://[::1]:8080", false).is_ok());
        assert!(normalized_server("http://192.168.1.5", false).is_err());
        assert!(normalized_server("http://192.168.1.5", true).is_ok());
        assert!(normalized_server("http://api.example.invalid", true).is_err());
        assert!(normalized_server("http://169.254.169.254", true).is_err());
    }

    #[test]
    fn request_path_cannot_escape_selected_server() {
        assert_eq!(
            request_url(&request("https://example.com", "/v1/todos?page=2", false))
                .unwrap()
                .as_str(),
            "https://example.com/v1/todos?page=2"
        );
        for path in [
            "//evil.test/x",
            "https://evil.test/x",
            "/\\evil.test/x",
            "/v1/todos#fragment",
            "/admin",
            "/v1/../admin",
            "/v1/%2e%2e/admin",
        ] {
            assert!(request_url(&request("https://example.com", path, false)).is_err());
        }
    }

    #[test]
    fn cancellation_before_registration_is_respected() {
        let state = DesktopState::new().unwrap();
        state
            .requests
            .lock()
            .unwrap()
            .cancelled
            .insert("test-id".into(), Instant::now());
        assert!(matches!(state.register("test-id"), Err(error) if error == "request_cancelled"));
    }

    #[test]
    fn duplicate_requests_do_not_replace_active_cancellation() {
        let state = DesktopState::new().unwrap();
        let first = state.register("test-id").unwrap();
        assert!(state.register("test-id").is_err());
        assert!(!first.is_cancelled());
        state.finish("test-id");
        assert!(state.register("test-id").is_ok());
    }

    #[test]
    fn rejects_credential_and_header_injection() {
        let state = DesktopState::new().unwrap();
        let mut input = request("https://example.com", "/v1/me", false);
        input.headers.insert("Host".into(), "evil.test".into());
        assert!(request_builder(&state.client, input, false).is_err());
        let mut input = request("https://example.com", "/v1/me", false);
        input.headers.insert(
            "Authorization".into(),
            "Bearer token\r\nOther: injected".into(),
        );
        assert!(request_builder(&state.client, input, false).is_err());
    }
}
