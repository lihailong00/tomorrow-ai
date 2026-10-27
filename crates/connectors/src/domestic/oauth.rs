//! Chinese document/calendar OAuth adapters. Credentials stay in the caller's encrypted vault.
//!
//! Protocol sources (checked 2026-10-27):
//! - https://docs.qq.com/open/document/app/oauth2/authorize.html
//! - https://docs.qq.com/open/document/app/oauth2/access_token.html
//! - https://docs.qq.com/open/document/app/openapi/v2/file/
//! - https://open.wps.cn/documents/app-integration-dev/wps365/server/certification-authorization/user-authorization/flow
//! - https://open.wps.cn/documents/app-integration-dev/wps365/server/api-description/signature-description
//! - https://github.com/larksuite/cli/blob/main/internal/auth/paths.go
//! - https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/drive/v1/model/list_file_request.py
//! - https://open.dingtalk.com/document/isvapp/obtain-user-token
//! - Alibaba's `alibabacloud-dingtalk` 2.2.65 OAuth/calendar SDK (official PyPI distribution).
//!
//! These adapters deliberately expose reads only. Platform console approval and the user's
//! actual resource permissions remain mandatory even when a deployment has configured scopes.

use std::{env, time::Duration};

use axum::http::StatusCode;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use reqwest::{Client, RequestBuilder, Url, redirect::Policy};
use serde_json::{Map, Value, json};
use sha2::Sha256;

use crate::{ConnectorError, Result};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS: usize = 80_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    TencentDocs,
    Wps,
    Feishu,
    DingTalk,
}

impl Kind {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "tencent_docs" => Some(Self::TencentDocs),
            "wps" => Some(Self::Wps),
            "feishu" => Some(Self::Feishu),
            "dingtalk" => Some(Self::DingTalk),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::TencentDocs => "tencent_docs",
            Self::Wps => "wps",
            Self::Feishu => "feishu",
            Self::DingTalk => "dingtalk",
        }
    }

    fn required_scope(self) -> &'static str {
        match self {
            Self::TencentDocs => "scope.drive.readonly",
            Self::Wps => "kso.file.read",
            Self::Feishu => "drive:drive.metadata:readonly",
            // DingTalk resource scopes are additionally granted in its developer console.
            Self::DingTalk => "openid",
        }
    }

    fn authorize(self) -> &'static str {
        match self {
            Self::TencentDocs => "https://docs.qq.com/oauth/v2/authorize",
            Self::Wps => "https://openapi.wps.cn/oauth2/auth",
            Self::Feishu => "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
            Self::DingTalk => "https://login.dingtalk.com/oauth2/auth",
        }
    }

    fn origin(self) -> &'static str {
        match self {
            Self::TencentDocs => "https://docs.qq.com",
            Self::Wps => "https://openapi.wps.cn",
            Self::Feishu => "https://open.feishu.cn",
            Self::DingTalk => "https://api.dingtalk.com",
        }
    }

    fn token_path(self) -> &'static str {
        match self {
            Self::TencentDocs => "/oauth/v2/token",
            Self::Wps => "/oauth2/token",
            // v2 remains the documented compatibility endpoint. No fallback can reuse a code.
            Self::Feishu => "/open-apis/authen/v2/oauth/token",
            Self::DingTalk => "/v1.0/oauth2/userAccessToken",
        }
    }
}

/// No Debug implementation: this object contains the app secret.
#[derive(Clone)]
pub(super) struct OAuthProvider {
    kind: Kind,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    scopes: Vec<String>,
    client: Client,
    // No environment override is accepted for an upstream origin. Tests inject loopback here.
    origin: String,
}

pub(super) fn required_configuration(id: &str) -> Vec<&'static str> {
    match id {
        "tencent_docs" => vec![
            "TENCENT_DOCS_CLIENT_ID",
            "TENCENT_DOCS_CLIENT_SECRET",
            "TENCENT_DOCS_REDIRECT_URI",
            "TENCENT_DOCS_SCOPES",
        ],
        "wps" => vec![
            "WPS_CLIENT_ID",
            "WPS_CLIENT_SECRET",
            "WPS_REDIRECT_URI",
            "WPS_SCOPES",
        ],
        "feishu" => vec![
            "FEISHU_CLIENT_ID",
            "FEISHU_CLIENT_SECRET",
            "FEISHU_REDIRECT_URI",
            "FEISHU_SCOPES",
        ],
        "dingtalk" => vec![
            "DINGTALK_CLIENT_ID",
            "DINGTALK_CLIENT_SECRET",
            "DINGTALK_REDIRECT_URI",
            "DINGTALK_SCOPES",
        ],
        _ => Vec::new(),
    }
}

impl OAuthProvider {
    pub(super) fn from_env(id: &str) -> Option<Self> {
        Self::from_lookup(id, |key| env::var(key).ok())
    }
    pub(super) fn from_lookup(id: &str, get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let names = required_configuration(id);
        let mut values = names.iter().map(|key| get(key));
        let client_id = values.next()??;
        let client_secret = values.next()??;
        let redirect_uri = values.next()??;
        let scopes = values.next()??;
        Self::configured(id, client_id, client_secret, redirect_uri, &scopes).ok()
    }

    fn configured(
        id: &str,
        client_id: String,
        client_secret: String,
        redirect_uri: String,
        scopes: &str,
    ) -> Result<Self> {
        let kind = Kind::parse(id).ok_or_else(invalid)?;
        let redirect = Url::parse(&redirect_uri).map_err(|_| invalid())?;
        if redirect.scheme() != "https"
            || redirect.host_str().is_none()
            || !redirect.username().is_empty()
            || redirect.password().is_some()
            || redirect.query().is_some()
            || redirect.fragment().is_some()
            || redirect.path() != format!("/v1/integrations/{id}/callback")
            || !safe_text(&client_id, 1024)
            || !safe_text(&client_secret, 8192)
        {
            return Err(invalid());
        }
        let scopes: Vec<String> = scopes
            .split(|c: char| c.is_ascii_whitespace() || c == ',')
            .filter(|scope| !scope.is_empty())
            .map(str::to_owned)
            .collect();
        if scopes.len() > 30
            || scopes.iter().any(|s| !safe_text(s, 256))
            || !scopes.iter().any(|s| s == kind.required_scope())
        {
            return Err(permission_required());
        }
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .redirect(Policy::none())
            .build()
            .map_err(|_| ConnectorError::internal())?;
        Ok(Self {
            kind,
            client_id,
            client_secret,
            redirect_uri,
            scopes,
            client,
            origin: kind.origin().into(),
        })
    }

    pub(super) fn authorize_url(&self, state: &str) -> Result<String> {
        if !safe_text(state, 1024) {
            return Err(invalid());
        }
        let mut url = Url::parse(self.kind.authorize()).map_err(|_| invalid())?;
        let scope = match self.kind {
            // Tencent Docs accepts "all"; approved app permissions constrain actual access.
            Kind::TencentDocs => "all".into(),
            Kind::Wps => self.scopes.join(","),
            _ => self.scopes.join(" "),
        };
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("scope", &scope)
            .append_pair("state", state);
        if self.kind == Kind::TencentDocs {
            url.query_pairs_mut().append_pair("new_login", "1");
        }
        if self.kind == Kind::DingTalk {
            url.query_pairs_mut().append_pair("prompt", "consent");
        }
        Ok(url.into())
    }

    pub(super) async fn exchange(&self, code: &str) -> Result<Value> {
        if !safe_text(code, 8192) {
            return Err(invalid());
        }
        let mut credentials = self.token("authorization_code", code, None).await?;
        if self.kind == Kind::DingTalk {
            // Calendar identifiers must derive from this account, never an arbitrary caller user_id.
            let token = credential(&credentials, "access_token")?;
            let profile = read_json(
                self.client
                    .get(self.url("/v1.0/contact/users/me")?)
                    .header("x-acs-dingtalk-access-token", token),
            )
            .await?;
            let union_id = profile
                .get("unionId")
                .and_then(Value::as_str)
                .filter(|v| safe_text(v, 1024))
                .ok_or_else(upstream)?;
            credentials["union_id"] = json!(union_id);
        }
        Ok(credentials)
    }

    async fn token(
        &self,
        grant: &str,
        code_or_refresh: &str,
        previous: Option<&Value>,
    ) -> Result<Value> {
        let token_url = self.url(self.kind.token_path())?;
        let mut body = json!({"client_id":self.client_id,"client_secret":self.client_secret,"grant_type":grant});
        if grant == "authorization_code" {
            body["code"] = json!(code_or_refresh);
            body["redirect_uri"] = json!(self.redirect_uri);
        } else {
            body["refresh_token"] = json!(code_or_refresh);
        }
        let request = match self.kind {
            // The vendor explicitly documents query credentials on its fixed HTTPS token endpoint.
            Kind::TencentDocs => self.client.get(token_url).query(&body),
            Kind::Wps => self.client.post(token_url).form(&body),
            Kind::Feishu => self.client.post(token_url).json(&body),
            Kind::DingTalk => {
                let mut ding = json!({"clientId":self.client_id,"clientSecret":self.client_secret,"grantType":grant});
                ding[if grant == "authorization_code" {
                    "code"
                } else {
                    "refreshToken"
                }] = json!(code_or_refresh);
                self.client.post(token_url).json(&ding)
            }
        };
        let response = read_json(request).await?;
        let source = response
            .get("data")
            .filter(|v| v.is_object())
            .unwrap_or(&response);
        let access_key = if self.kind == Kind::DingTalk {
            "accessToken"
        } else {
            "access_token"
        };
        let refresh_key = if self.kind == Kind::DingTalk {
            "refreshToken"
        } else {
            "refresh_token"
        };
        let expiry_key = if self.kind == Kind::DingTalk {
            "expireIn"
        } else {
            "expires_in"
        };
        let access_token = source
            .get(access_key)
            .and_then(Value::as_str)
            .filter(|v| safe_text(v, 16384))
            .ok_or_else(upstream)?;
        let expires_in = source
            .get(expiry_key)
            .and_then(number)
            .filter(|v| (1..=31_536_000).contains(v))
            .ok_or_else(upstream)?;
        let refresh = source.get(refresh_key).and_then(Value::as_str).or_else(|| {
            previous
                .and_then(|v| v.get("refresh_token"))
                .and_then(Value::as_str)
        });
        if refresh.is_some_and(|v| !safe_text(v, 16384)) {
            return Err(upstream());
        }
        let granted = source.get("scope").and_then(Value::as_str);
        if granted.is_some_and(|value| !has_scope(value, self.kind.required_scope())) {
            return Err(permission_required());
        }
        let mut output = json!({"access_token":access_token,"expires_at":epoch()+expires_in});
        if let Some(value) = refresh {
            output["refresh_token"] = json!(value);
        }
        if let Some(value) = granted {
            output["scope"] = json!(value);
        }
        if self.kind == Kind::TencentDocs {
            let user = source
                .get("user_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    previous
                        .and_then(|v| v.get("open_id"))
                        .and_then(Value::as_str)
                })
                .filter(|v| safe_text(v, 1024))
                .ok_or_else(upstream)?;
            output["open_id"] = json!(user);
        }
        if let Some(value) = previous.and_then(|v| v.get("union_id")) {
            output["union_id"] = value.clone();
        }
        Ok(output)
    }

    /// Returns displayable, credential-free data and optional rotated vault credentials.
    /// A caller must atomically save rotations before discarding them, including read failures.
    pub(super) async fn read(
        &self,
        credentials: &Value,
        query: &Value,
    ) -> Result<(Value, Option<Value>)> {
        let plan = self.plan(credentials, query)?;
        let rotated = if credentials
            .get("expires_at")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            <= epoch() + 60
        {
            let refresh = credential(credentials, "refresh_token")?;
            Some(
                self.token("refresh_token", refresh, Some(credentials))
                    .await?,
            )
        } else {
            None
        };
        let active = rotated.as_ref().unwrap_or(credentials);
        let request = self.authorized_get(plan.url.clone(), active)?;
        // Read failures after a refresh must not lose one-use refresh tokens. The caller can
        // persist the rotation even when the provider reports a read error in this envelope.
        match read_json(request)
            .await
            .and_then(|response| self.project(response, &plan))
        {
            Ok(data) => Ok((data, rotated)),
            Err(error) if rotated.is_some() => Ok((
                json!({"source":self.kind.id(),"items":[],"error":{"code":error.code,"message":error.message}}),
                rotated,
            )),
            Err(error) => Err(error),
        }
    }

    fn url(&self, path: &str) -> Result<Url> {
        Url::parse(&format!("{}{path}", self.origin)).map_err(|_| invalid())
    }

    fn authorized_get(&self, url: Url, credentials: &Value) -> Result<RequestBuilder> {
        let token = credential(credentials, "access_token")?;
        let mut request = self.client.get(url.clone());
        match self.kind {
            Kind::TencentDocs => {
                request = request
                    .header("Access-Token", token)
                    .header("Client-Id", &self.client_id)
                    .header("Open-Id", credential(credentials, "open_id")?);
            }
            Kind::DingTalk => {
                request = request.header("x-acs-dingtalk-access-token", token);
            }
            _ => {
                request = request.bearer_auth(token);
            }
        }
        if self.kind == Kind::Wps {
            let date = chrono::Utc::now()
                .format("%a, %d %b %Y %H:%M:%S GMT")
                .to_string();
            let uri = match url.query() {
                Some(q) => format!("{}?{q}", url.path()),
                None => url.path().into(),
            };
            let signature = kso_signature(&self.client_secret, "GET", &uri, &date)?;
            request = request
                .header("Content-Type", "application/json")
                .header("X-Kso-Date", date)
                .header(
                    "X-Kso-Authorization",
                    format!("KSO-1 {}:{signature}", self.client_id),
                );
        }
        Ok(request)
    }

    fn plan(&self, credentials: &Value, query: &Value) -> Result<ReadPlan> {
        if !query.is_object() {
            return Err(invalid());
        }
        let action = query
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("list");
        let limit = query
            .get("limit")
            .map(|v| v.as_u64().ok_or_else(invalid))
            .transpose()?
            .unwrap_or(20);
        if !(1..=50).contains(&limit) {
            return Err(invalid());
        }
        let mut params: Vec<(&str, String)> = Vec::new();
        let path = match (self.kind, action) {
            (Kind::TencentDocs, "list") => {
                let folder = optional_id(query, "folder_id")?.unwrap_or_default();
                let start = query
                    .get("start")
                    .map(|v| v.as_u64().filter(|v| *v <= 100_000).ok_or_else(invalid))
                    .transpose()?
                    .unwrap_or(0);
                params.extend([("limit", limit.to_string()), ("start", start.to_string())]);
                format!("/openapi/drive/v2/folders/{folder}")
            }
            (Kind::Feishu, "list") => {
                params.push(("page_size", limit.to_string()));
                if let Some(folder) = optional_id(query, "folder_id")? {
                    params.push(("folder_token", folder));
                }
                page_token(query, &mut params)?;
                "/open-apis/drive/v1/files".into()
            }
            (Kind::Feishu, "content") => {
                // docx raw content requires the independently approved document scope.
                if !self.scopes.iter().any(|s| s == "docx:document:readonly") {
                    return Err(permission_required());
                }
                format!(
                    "/open-apis/docx/v1/documents/{}/raw_content",
                    required_id(query, "file_id")?
                )
            }
            (Kind::Wps, "list") => {
                let drive = required_id(query, "drive_id")?;
                let parent = optional_id(query, "folder_id")?.unwrap_or_else(|| "0".into());
                params.push(("page_size", limit.to_string()));
                page_token(query, &mut params)?;
                format!("/v7/drives/{drive}/files/{parent}/children")
            }
            (Kind::Wps, "read") => format!("/v7/files/{}/meta", required_id(query, "file_id")?),
            (Kind::Wps, "content") => {
                params.push(("format", "plain".into()));
                format!(
                    "/v7/drives/{}/files/{}/content",
                    required_id(query, "drive_id")?,
                    required_id(query, "file_id")?
                )
            }
            (Kind::DingTalk, "list") => {
                let user = credential(credentials, "union_id")?;
                validate_id(user)?;
                format!("/v1.0/calendar/users/{user}/calendars")
            }
            (Kind::DingTalk, "events") => {
                let user = credential(credentials, "union_id")?;
                validate_id(user)?;
                let calendar = required_id(query, "calendar_id")?;
                let start = query
                    .get("start_time")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
                let end = query
                    .get("end_time")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339()
                    });
                let begin = chrono::DateTime::parse_from_rfc3339(&start).map_err(|_| invalid())?;
                let finish = chrono::DateTime::parse_from_rfc3339(&end).map_err(|_| invalid())?;
                if finish <= begin || finish - begin > chrono::Duration::days(31) {
                    return Err(invalid());
                }
                params.extend([
                    (
                        "timeMin",
                        begin
                            .with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    ),
                    (
                        "timeMax",
                        finish
                            .with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    ),
                    ("maxResults", limit.to_string()),
                ]);
                if let Some(page) = optional_text(query, "page_token", 2048)? {
                    params.push(("nextToken", page));
                }
                format!("/v1.0/calendar/users/{user}/calendars/{calendar}/events")
            }
            _ => {
                return Err(ConnectorError::new(
                    StatusCode::BAD_REQUEST,
                    "unsupported_action",
                    "该连接器不支持此操作；首版仅开放只读查询",
                ));
            }
        };
        let mut url = self.url(&path)?;
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params);
        }
        Ok(ReadPlan {
            url,
            action: action.into(),
            limit: limit as usize,
        })
    }

    fn project(&self, response: Value, plan: &ReadPlan) -> Result<Value> {
        let data = response
            .get("data")
            .or_else(|| response.get("response"))
            .unwrap_or(&response);
        if plan.action == "content" {
            let content = data
                .get("content")
                .or_else(|| data.get("plain"))
                .or_else(|| data.get("text"))
                .and_then(Value::as_str)
                .ok_or_else(upstream)?;
            return Ok(
                json!({"source":self.kind.id(),"content":content.chars().take(MAX_CONTENT_CHARS).collect::<String>(),"truncated":content.chars().count()>MAX_CONTENT_CHARS}),
            );
        }
        if plan.action == "read" {
            return Ok(json!({"source":self.kind.id(),"items":[project_file(self.kind,data)]}));
        }
        let rows = match self.kind {
            Kind::TencentDocs => data.get("list"),
            Kind::Wps => data.get("items"),
            Kind::Feishu => data.get("files"),
            Kind::DingTalk if plan.action == "events" => data.get("events"),
            Kind::DingTalk => data.get("calendars"),
        }
        .and_then(Value::as_array)
        .ok_or_else(upstream)?;
        let items: Vec<Value> = rows
            .iter()
            .take(plan.limit)
            .map(|row| {
                if self.kind == Kind::DingTalk {
                    project_calendar(row, plan.action == "events")
                } else {
                    project_file(self.kind, row)
                }
            })
            .collect();
        // Provider responses are not a schema boundary. Never forward an arbitrary
        // object (or a secret-bearing nested value) as a cursor or boolean.
        let next = match self.kind {
            Kind::TencentDocs => data
                .get("next")
                .and_then(Value::as_u64)
                .filter(|value| *value <= 100_000)
                .map(|value| json!(value)),
            Kind::Feishu => cursor(data.get("next_page_token")),
            Kind::Wps => cursor(data.get("next_page_token")),
            Kind::DingTalk => cursor(data.get("nextToken")),
        }
        .unwrap_or(Value::Null);
        let has_more = data
            .get("has_more")
            .and_then(Value::as_bool)
            .map(Value::Bool)
            .unwrap_or(Value::Null);
        Ok(
            json!({"source":self.kind.id(),"items":items,"next_page_token":next,"has_more":has_more}),
        )
    }
}

struct ReadPlan {
    url: Url,
    action: String,
    limit: usize,
}

fn epoch() -> i64 {
    chrono::Utc::now().timestamp()
}
fn safe_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}
fn has_scope(value: &str, scope: &str) -> bool {
    value
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .any(|v| v == scope)
}
fn number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_request",
        "查询参数或连接配置无效，请检查只读操作和资源 ID",
    )
}
fn upstream() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "provider_error",
        "应用服务请求失败，请稍后重试；如持续失败，请重新授权",
    )
}
fn reconnect() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "connection_required",
        "应用授权已失效，请重新连接",
    )
}
fn permission_required() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "permission_required",
        "尚未获得查询此资料所需的应用权限，请核对开放平台权限并重新授权",
    )
}
fn credential<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| safe_text(v, 16384))
        .ok_or_else(reconnect)
}

fn optional_text(value: &Value, key: &str, max: usize) -> Result<Option<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) if safe_text(v, max) => Ok(Some(v.clone())),
        _ => Err(invalid()),
    }
}
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 1024
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.$~:@".contains(c))
        || matches!(id, "." | "..")
    {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn optional_id(value: &Value, key: &str) -> Result<Option<String>> {
    let id = optional_text(value, key, 1024)?;
    if let Some(v) = &id {
        validate_id(v)?;
    }
    Ok(id)
}
fn required_id(value: &Value, key: &str) -> Result<String> {
    optional_id(value, key)?.ok_or_else(|| {
        ConnectorError::new(
            StatusCode::BAD_REQUEST,
            "resource_id_required",
            "请填写文档、云盘或日历的资源 ID，再读取对应的授权资料",
        )
    })
}
fn page_token(value: &Value, params: &mut Vec<(&str, String)>) -> Result<()> {
    if let Some(page) = optional_text(value, "page_token", 2048)? {
        params.push(("page_token", page));
    }
    Ok(())
}

fn project_file(kind: Kind, value: &Value) -> Value {
    let mut out = Map::new();
    let fields: &[(&str, &str)] = match kind {
        Kind::TencentDocs => &[
            ("ID", "id"),
            ("title", "title"),
            ("type", "type"),
            ("url", "url"),
            ("lastModifyTime", "modified_at"),
        ],
        Kind::Feishu => &[
            ("token", "id"),
            ("name", "title"),
            ("type", "type"),
            ("url", "url"),
            ("modified_time", "modified_at"),
        ],
        _ => &[
            ("id", "id"),
            ("name", "title"),
            ("type", "type"),
            ("link_url", "url"),
            ("drive_id", "drive_id"),
            ("mtime", "modified_at"),
        ],
    };
    for (from, to) in fields {
        if let Some(v) = value.get(from) {
            let projected = match *to {
                "url" => v
                    .as_str()
                    .filter(|url| safe_public_link(kind, url))
                    .map(|url| json!(url)),
                "modified_at" => v
                    .as_i64()
                    .filter(|timestamp| (0..=253_402_300_799_999).contains(timestamp))
                    .map(|timestamp| json!(timestamp))
                    .or_else(|| {
                        v.as_str()
                            .filter(|timestamp| {
                                timestamp.len() <= 32
                                    && timestamp.chars().all(|ch| ch.is_ascii_digit())
                            })
                            .map(|timestamp| json!(timestamp))
                    }),
                "id" | "drive_id" => bounded_string(v, 1024),
                "type" => bounded_string(v, 64),
                "title" => bounded_string(v, 4096),
                _ => None,
            };
            if let Some(projected) = projected {
                out.insert((*to).into(), projected);
            }
        }
    }
    Value::Object(out)
}

fn project_calendar(value: &Value, event: bool) -> Value {
    let mut out = Map::new();
    let fields: &[(&str, usize)] = if event {
        &[
            ("id", 1024),
            ("summary", 1024),
            ("description", 8000),
            ("status", 64),
        ]
    } else {
        &[
            ("id", 1024),
            ("summary", 1024),
            ("description", 8000),
            ("type", 64),
            ("timeZone", 128),
        ]
    };
    copy_strings(&mut out, value, fields);
    if event {
        // The nested schema is deliberately finite: no recursive provider object
        // copying. Each child contains only documented scalars or string lists.
        for key in ["start", "end"] {
            if let Some(child) = value.get(key).filter(|child| child.is_object()) {
                let mut result = Map::new();
                if let Some(date) = child.get("date").and_then(Value::as_str).filter(|date| {
                    date.len() == 10 && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
                }) {
                    result.insert("date".into(), json!(date));
                }
                if let Some(date_time) =
                    child
                        .get("dateTime")
                        .and_then(Value::as_str)
                        .filter(|date_time| {
                            date_time.len() <= 64
                                && (chrono::DateTime::parse_from_rfc3339(date_time).is_ok()
                                    || chrono::NaiveDateTime::parse_from_str(
                                        date_time,
                                        "%Y-%m-%dT%H:%MZ",
                                    )
                                    .is_ok())
                        })
                {
                    result.insert("dateTime".into(), json!(date_time));
                }
                copy_strings(&mut result, child, &[("timeZone", 128)]);
                if !result.is_empty() {
                    out.insert(key.into(), Value::Object(result));
                }
            }
        }
        if let Some(child) = value.get("location").filter(|child| child.is_object()) {
            let mut result = Map::new();
            copy_strings(&mut result, child, &[("displayName", 2048)]);
            if let Some(rooms) = child.get("meetingRooms").and_then(Value::as_array) {
                let rooms: Vec<Value> = rooms
                    .iter()
                    .take(20)
                    .filter_map(|room| bounded_string(room, 256))
                    .collect();
                if !rooms.is_empty() {
                    result.insert("meetingRooms".into(), Value::Array(rooms));
                }
            }
            if !result.is_empty() {
                out.insert("location".into(), Value::Object(result));
            }
        }
        if let Some(child) = value.get("organizer").filter(|child| child.is_object()) {
            let mut result = Map::new();
            copy_strings(
                &mut result,
                child,
                &[("id", 1024), ("displayName", 512), ("responseStatus", 64)],
            );
            if let Some(own) = child.get("self").and_then(Value::as_bool) {
                result.insert("self".into(), Value::Bool(own));
            }
            if !result.is_empty() {
                out.insert("organizer".into(), Value::Object(result));
            }
        }
    }
    Value::Object(out)
}

fn copy_strings(out: &mut Map<String, Value>, value: &Value, fields: &[(&str, usize)]) {
    for (key, max) in fields {
        if let Some(text) = value
            .get(*key)
            .and_then(|value| bounded_string(value, *max))
        {
            out.insert((*key).into(), text);
        }
    }
}

fn bounded_string(value: &Value, max: usize) -> Option<Value> {
    value
        .as_str()
        .map(|text| json!(text.chars().take(max).collect::<String>()))
}

fn cursor(value: Option<&Value>) -> Option<Value> {
    value
        .and_then(Value::as_str)
        .filter(|text| safe_text(text, 2048))
        .map(|text| json!(text))
}

fn safe_public_link(kind: Kind, value: &str) -> bool {
    if !safe_text(value, 4096) || value.trim() != value {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        let host = url.host_str().unwrap_or_default();
        let document_host = match kind {
            Kind::TencentDocs => host == "docs.qq.com",
            Kind::Wps => host == "kdocs.cn" || host.ends_with(".kdocs.cn"),
            Kind::Feishu => host == "feishu.cn" || host.ends_with(".feishu.cn"),
            Kind::DingTalk => false,
        };
        url.scheme() == "https"
            && document_host
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            // Canonical document URLs need no auth parameters or fragments. Refuse
            // every query/fragment rather than trying to enumerate secret names.
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn kso_signature(secret: &str, method: &str, uri: &str, date: &str) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| ConnectorError::internal())?;
    mac.update(format!("KSO-1{method}{uri}application/json{date}").as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

async fn read_json(request: RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|_| upstream())?;
    if matches!(response.status(), StatusCode::UNAUTHORIZED) {
        return Err(reconnect());
    }
    if response.status() == StatusCode::FORBIDDEN {
        return Err(permission_required());
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|s| s > MAX_RESPONSE_BYTES as u64)
    {
        return Err(upstream());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| upstream())?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(upstream());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| upstream())?;
    if !value.is_object() || value.get("error").is_some_and(|v| !v.is_null()) {
        return Err(upstream());
    }
    for key in ["code", "ret", "errcode"] {
        if let Some(code) = value.get(key) {
            if number(code) != Some(0) {
                return Err(upstream());
            }
        }
    }
    Ok(value)
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
