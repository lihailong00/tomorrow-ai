use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Auth, ConnectorError, ConnectorState, Result, Service};

#[derive(Deserialize, Default)]
pub(crate) struct PageQuery {
    page_size: Option<u32>,
    page_token: Option<String>,
}

impl PageQuery {
    fn validate(self) -> Result<(u32, Option<String>)> {
        let size = self.page_size.unwrap_or(20);
        if !(1..=100).contains(&size)
            || self
                .page_token
                .as_ref()
                .is_some_and(|token| token.len() > 8192 || token.chars().any(char::is_control))
        {
            return Err(ConnectorError::invalid());
        }
        Ok((size, self.page_token.filter(|token| !token.is_empty())))
    }
}

#[derive(Serialize)]
struct ReadItem {
    id: String,
    title: String,
    preview: String,
    date: Option<String>,
    link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
}

fn query(
    value: std::result::Result<Query<PageQuery>, QueryRejection>,
) -> Result<(u32, Option<String>)> {
    value.map_err(|_| ConnectorError::invalid())?.0.validate()
}

#[derive(Serialize, Deserialize)]
struct CalendarCursor {
    token: String,
    time_min: String,
    size: u32,
}

fn calendar_query(size: u32, page: Option<String>) -> Result<(String, Option<String>)> {
    let Some(page) = page else {
        return Ok((chrono::Utc::now().to_rfc3339(), None));
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(page)
        .map_err(|_| ConnectorError::invalid())?;
    let cursor: CalendarCursor =
        serde_json::from_slice(&decoded).map_err(|_| ConnectorError::invalid())?;
    if cursor.size != size
        || cursor.token.len() > 4096
        || chrono::DateTime::parse_from_rfc3339(&cursor.time_min).is_err()
    {
        return Err(ConnectorError::invalid());
    }
    Ok((cursor.time_min, Some(cursor.token)))
}

pub(crate) async fn calendar_events(
    State(state): State<ConnectorState>,
    auth: Auth,
    page: std::result::Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let (size, page) = query(page)?;
    // Google page tokens require stable query parameters; preserve the initial
    // timeMin across pages instead of recomputing it on each HTTP request.
    let (time_min, page) = calendar_query(size, page)?;
    let mut params = vec![
        ("maxResults".into(), size.to_string()),
        ("singleEvents".into(), "true".into()),
        ("orderBy".into(), "startTime".into()),
        ("timeMin".into(), time_min.clone()),
        (
            "fields".into(),
            "nextPageToken,items(id,summary,description,start,end,htmlLink,status)".into(),
        ),
    ];
    if let Some(page) = page {
        params.push(("pageToken".into(), page));
    }
    let response = state
        .google_get(
            &auth.user_id,
            Service::Calendar,
            &state.config()?.endpoints.calendar,
            &params,
        )
        .await?;
    let items = response
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .take(size as usize)
        .filter(|item| item["status"] != "cancelled")
        .filter_map(|item| {
            let id = string(item, "id")?;
            Some(ReadItem {
                id: id.into(),
                title: text(string(item, "summary").unwrap_or("（无标题日程）"), 300),
                preview: text(string(item, "description").unwrap_or(""), 500),
                date: item["start"]
                    .get("dateTime")
                    .or_else(|| item["start"].get("date"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                link: safe_link(
                    string(item, "htmlLink"),
                    &["www.google.com", "calendar.google.com"],
                ),
                mime_type: None,
            })
        })
        .collect::<Vec<_>>();
    let next = response
        .get("nextPageToken")
        .and_then(Value::as_str)
        .map(|token| {
            serde_json::to_vec(&CalendarCursor {
                token: token.into(),
                time_min,
                size,
            })
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            .map_err(|_| ConnectorError::internal())
        })
        .transpose()?;
    Ok(Json(json!({"items":items,"next_page_token":next})))
}

pub(crate) async fn drive_files(
    State(state): State<ConnectorState>,
    auth: Auth,
    page: std::result::Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let (size, page) = query(page)?;
    let mut params = vec![
        ("pageSize".into(), size.to_string()),
        ("q".into(), "trashed = false".into()),
        ("orderBy".into(), "modifiedTime desc".into()),
        (
            "fields".into(),
            "nextPageToken,files(id,name,mimeType,description,modifiedTime,webViewLink)".into(),
        ),
    ];
    if let Some(page) = page {
        params.push(("pageToken".into(), page));
    }
    let response = state
        .google_get(
            &auth.user_id,
            Service::Drive,
            &state.config()?.endpoints.drive,
            &params,
        )
        .await?;
    let items = response
        .get("files")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .take(size as usize)
        .filter_map(|item| {
            Some(ReadItem {
                id: string(item, "id")?.into(),
                title: text(string(item, "name").unwrap_or("（未命名文件）"), 300),
                preview: text(string(item, "description").unwrap_or(""), 500),
                date: string(item, "modifiedTime").map(str::to_owned),
                link: safe_link(
                    string(item, "webViewLink"),
                    &["drive.google.com", "docs.google.com"],
                ),
                mime_type: string(item, "mimeType").map(str::to_owned),
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(
        json!({"items":items,"next_page_token":response.get("nextPageToken").and_then(Value::as_str)}),
    ))
}

pub(crate) async fn gmail_messages(
    State(state): State<ConnectorState>,
    auth: Auth,
    page: std::result::Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let (size, page) = query(page)?;
    let mut params = vec![
        ("maxResults".into(), size.to_string()),
        ("includeSpamTrash".into(), "false".into()),
        ("fields".into(), "messages/id,nextPageToken".into()),
    ];
    if let Some(page) = page {
        params.push(("pageToken".into(), page));
    }
    let base = state.config()?.endpoints.gmail.clone();
    let response = state
        .google_get(&auth.user_id, Service::Gmail, &base, &params)
        .await?;
    let ids = response
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .take(size as usize)
        .filter_map(|item| string(item, "id"))
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 200
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let items = stream::iter(ids)
        .map(|id| {
            let state = state.clone();
            let user = auth.user_id.clone();
            let base = base.clone();
            async move {
                let params = vec![
                    ("format".into(), "metadata".into()),
                    ("metadataHeaders".into(), "Subject".into()),
                    ("metadataHeaders".into(), "From".into()),
                    (
                        "fields".into(),
                        "id,snippet,internalDate,payload/headers".into(),
                    ),
                ];
                let item = state
                    .google_get(&user, Service::Gmail, &format!("{base}/{id}"), &params)
                    .await?;
                let headers = item["payload"]
                    .get("headers")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                let find_header = |name: &str| {
                    headers
                        .iter()
                        .find(|header| {
                            string(header, "name").is_some_and(|key| key.eq_ignore_ascii_case(name))
                        })
                        .and_then(|header| string(header, "value"))
                };
                let from = find_header("From").unwrap_or("");
                let snippet = string(&item, "snippet").unwrap_or("");
                let date = string(&item, "internalDate")
                    .and_then(|date| date.parse::<i64>().ok())
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .map(|date| date.to_rfc3339());
                Ok::<ReadItem, ConnectorError>(ReadItem {
                    title: text(find_header("Subject").unwrap_or("（无主题邮件）"), 300),
                    preview: text(&format!("{from}\n{snippet}"), 500),
                    date,
                    link: Some(format!("https://mail.google.com/mail/#all/{id}")),
                    id,
                    mime_type: None,
                })
            }
        })
        .buffered(5)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(Json(
        json!({"items":items,"next_page_token":response.get("nextPageToken").and_then(Value::as_str)}),
    ))
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(limit)
        .collect()
}
fn safe_link(value: Option<&str>, hosts: &[&str]) -> Option<String> {
    let url = reqwest::Url::parse(value?).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| hosts.contains(&host)))
    .then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_cursor_preserves_the_same_query_time_and_page_size() {
        let original = "2026-10-26T00:00:00+00:00";
        let encoded = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&CalendarCursor {
                token: "google-page-token".into(),
                time_min: original.into(),
                size: 20,
            })
            .unwrap(),
        );
        let (time, token) = calendar_query(20, Some(encoded.clone())).unwrap();
        assert_eq!(time, original);
        assert_eq!(token.as_deref(), Some("google-page-token"));
        assert!(calendar_query(100, Some(encoded)).is_err());
        assert!(calendar_query(20, Some("invalid-cursor".into())).is_err());
    }
}
