//! Slack OAuth and real-time public-channel search. Message bodies are projected
//! for a single response and are never sent through the durable chat pipeline.

use super::{
    ConnectorError, Kind, OAuthProvider, RequestBuilder, Result, StatusCode, Url, Value,
    credential, epoch, has_scope, json, number, permission_required, reconnect, safe_text,
    upstream,
};
use futures_util::StreamExt;

const MAX_BYTES: usize = 512 * 1024;
const PAGE_SIZE: usize = 10;

fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::CONFLICT,
        "slack_search_unavailable",
        "当前 Slack 工作区未开放实时搜索，请联系工作区管理员",
    )
}

fn rate_limited() -> ConnectorError {
    ConnectorError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "slack_rate_limited",
        "Slack 搜索过于频繁，请稍后重试",
    )
}

pub(super) fn error_for(code: &str) -> ConnectorError {
    match code {
        "invalid_auth"
        | "invalid_refresh_token"
        | "token_revoked"
        | "token_expired"
        | "not_authed"
        | "account_inactive"
        | "connection_required" => reconnect(),
        "missing_scope" | "access_denied" | "not_allowed_token_type" | "permission_required" => {
            permission_required()
        }
        "feature_not_enabled" | "enterprise_is_restricted" | "slack_search_unavailable" => {
            unavailable()
        }
        "ratelimited" | "rate_limited" | "slack_rate_limited" => rate_limited(),
        "invalid_cursor" => ConnectorError::new(
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
            "这页 Slack 搜索结果已失效，请重新搜索",
        ),
        _ => upstream(),
    }
}

pub(super) async fn response(request: RequestBuilder) -> Result<Value> {
    let response = request.send().await.map_err(|_| upstream())?;
    match response.status() {
        StatusCode::TOO_MANY_REQUESTS => return Err(rate_limited()),
        StatusCode::UNAUTHORIZED => return Err(reconnect()),
        StatusCode::FORBIDDEN => return Err(permission_required()),
        status if !status.is_success() => return Err(upstream()),
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err(upstream());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| upstream())?;
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(upstream());
        }
        body.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&body).map_err(|_| upstream())?;
    if body["ok"].as_bool() != Some(true) {
        return Err(error_for(body["error"].as_str().unwrap_or_default()));
    }
    Ok(body)
}

fn slack_id<'a>(value: &'a Value, prefixes: &[u8]) -> Option<&'a str> {
    value.as_str().filter(|id| {
        (2..=32).contains(&id.len())
            && prefixes.contains(&id.as_bytes()[0])
            && id
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    })
}

pub(super) fn parse_token(body: Value, previous: Option<&Value>) -> Result<Value> {
    if body["is_enterprise_install"].as_bool() == Some(true) {
        return Err(unavailable());
    }
    let old_team = previous.and_then(|old| slack_id(&old["team_id"], b"T"));
    let new_team = slack_id(&body["team"]["id"], b"T");
    if matches!((old_team, new_team), (Some(old), Some(new)) if old != new) {
        return Err(reconnect());
    }
    let team = new_team.or(old_team).ok_or_else(unavailable)?;
    let token = if previous.is_some() && body.get("authed_user").is_none() {
        &body
    } else {
        &body["authed_user"]
    };
    let old_user = previous.and_then(|old| slack_id(&old["slack_user_id"], b"UW"));
    let new_user = slack_id(&token["id"], b"UW");
    if matches!((old_user, new_user), (Some(old), Some(new)) if old != new) {
        return Err(reconnect());
    }
    let user = new_user.or(old_user).ok_or_else(upstream)?;
    let scope = token["scope"].as_str().ok_or_else(permission_required)?;
    if !has_scope(scope, Kind::Slack.required_scope()) {
        return Err(permission_required());
    }
    let access = token["access_token"]
        .as_str()
        .filter(|access| {
            token["token_type"].as_str() == Some("user")
                && (access.starts_with("xoxp-") || access.starts_with("xoxe.xoxp-"))
                && safe_text(access, 16384)
        })
        .ok_or_else(upstream)?;
    let refresh = token["refresh_token"]
        .as_str()
        .filter(|value| safe_text(value, 16384));
    let expires_at = match (token.get("expires_in"), refresh, previous) {
        (Some(expiry), Some(_), _) => {
            epoch()
                + number(expiry)
                    .filter(|n| (1..=86400).contains(n))
                    .ok_or_else(upstream)?
        }
        (None, None, None) if access.starts_with("xoxp-") => i64::MAX,
        _ => return Err(upstream()),
    };
    let mut result = json!({
        "access_token": access, "expires_at": expires_at, "team_id": team, "slack_user_id": user,
    });
    if let Some(refresh) = refresh {
        result["refresh_token"] = json!(refresh);
    }
    if let Some(name) = body["team"]["name"]
        .as_str()
        .filter(|name| safe_text(name, 256))
        .or_else(|| previous.and_then(|old| old["team_name"].as_str()))
    {
        result["team_name"] = json!(name);
    }
    Ok(result)
}

struct Search<'a> {
    query: &'a str,
    cursor: Option<&'a str>,
}
impl<'a> Search<'a> {
    fn parse(input: &'a Value) -> Result<Self> {
        let query = input["query"]
            .as_str()
            .map(str::trim)
            .filter(|q| q.chars().count() <= 250 && safe_text(q, 1000))
            .ok_or_else(|| {
                ConnectorError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "请输入 1 到 250 个字的 Slack 搜索词",
                )
            })?;
        let cursor = match input.get("cursor") {
            None => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|c| safe_text(c, 2048))
                    .ok_or_else(super::invalid)?,
            ),
        };
        Ok(Self { query, cursor })
    }
}

fn permalink<'a>(value: &'a Value, channel: &str) -> Option<&'a str> {
    let link = value.as_str().filter(|link| safe_text(link, 2048))?;
    let url = Url::parse(link).ok()?;
    let host = url.host_str()?;
    if url.scheme() != "https"
        || !(host == "slack.com" || host.ends_with(".slack.com"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut path = url.path_segments()?;
    if path.next()? != "archives" || path.next()? != channel {
        return None;
    }
    let id = path.next()?.strip_prefix('p')?;
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) || path.next().is_some() {
        return None;
    }
    // Slack adds a parent timestamp and channel to thread reply links.
    let mut thread = false;
    let mut channel_param = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "thread_ts"
                if !thread
                    && value.split_once('.').is_some_and(|(seconds, fraction)| {
                        !seconds.is_empty()
                            && !fraction.is_empty()
                            && value.len() <= 32
                            && seconds
                                .bytes()
                                .chain(fraction.bytes())
                                .all(|c| c.is_ascii_digit())
                    }) =>
            {
                thread = true
            }
            "cid" if !channel_param && value == channel => channel_param = true,
            _ => return None,
        }
    }
    Some(link)
}

fn project(value: &Value, team: &str) -> Result<Value> {
    let results = value["results"].as_object().ok_or_else(upstream)?;
    let messages = match results.get("messages") {
        None => &[][..],
        Some(messages) => messages
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(upstream)?,
    };
    let items: Vec<Value> = messages.iter().filter_map(|message| {
        if slack_id(&message["team_id"], b"T")? != team {
            return None;
        }
        let channel = slack_id(&message["channel_id"], b"C")?;
        let ts = message["message_ts"].as_str()
            .filter(|ts| !ts.is_empty() && ts.len() <= 32 && ts.bytes().all(|c| c.is_ascii_digit() || c == b'.'))?;
        let url = permalink(&message["permalink"], channel)?;
        let name = message["channel_name"].as_str().filter(|name| safe_text(name, 256)).unwrap_or(channel);
        let raw = message["content"].as_str()?.trim();
        if raw.is_empty() {
            return None;
        }
        let mut chars = raw.chars();
        let mut text: String = chars.by_ref().take(420).collect();
        if chars.next().is_some() {
            text.push('…');
        }
        Some(json!({"id":format!("{channel}:{ts}"),"title":format!("#{name}"),"text":text,"url":url}))
    }).take(PAGE_SIZE).collect();
    let cursor = value["response_metadata"]["next_cursor"]
        .as_str()
        .filter(|c| safe_text(c, 2048));
    Ok(json!({"items":items,"next_cursor":cursor}))
}

impl OAuthProvider {
    pub(in crate::domestic) async fn prepare_slack_read(
        &self,
        credentials: &Value,
        query: &Value,
    ) -> Result<Option<Value>> {
        Search::parse(query)?;
        if credentials["expires_at"].as_i64().unwrap_or(0) > epoch() + 60 {
            return Ok(None);
        }
        let refresh = credential(credentials, "refresh_token")?;
        self.token("refresh_token", refresh, Some(credentials))
            .await
            .map(Some)
    }

    pub(in crate::domestic) async fn read_slack(
        &self,
        active: &Value,
        query: &Value,
    ) -> Result<Value> {
        let search = Search::parse(query)?;
        let mut body = json!({
            "query": search.query,
            "channel_types": ["public_channel"],
            "content_types": ["messages"],
            "include_context_messages": false,
            "include_message_blocks": false,
            "disable_semantic_search": true,
            "limit": PAGE_SIZE,
        });
        if let Some(cursor) = search.cursor {
            body["cursor"] = json!(cursor);
        }
        let team = credential(active, "team_id")?;
        let data = response(
            self.client
                .post(self.url("/api/assistant.search.context")?)
                .bearer_auth(credential(active, "access_token")?)
                .json(&body),
        )
        .await?;
        project(&data, team)
    }
}
