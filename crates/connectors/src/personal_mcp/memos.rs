//! User-selected Memos instances. Public HTTPS is allowed; private origins need
//! an exact server-admin allowlist. Resolve and pin DNS before sending tokens.
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::http::StatusCode;
use reqwest::{Client, Url, redirect::Policy};
use serde_json::Value;

use super::transport::Credentials;
use crate::{ConnectorError, Result};

fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_memos_url",
        "请填写有效的 Memos HTTPS 服务地址；私有网络地址需由服务器管理员显式允许",
    )
}

fn allowed_origins() -> String {
    std::env::var("MEMOS_ALLOWED_PRIVATE_ORIGINS").unwrap_or_default()
}

fn parse_url(raw: &str, allowed: &str) -> Result<(Url, bool)> {
    if raw.len() > 2048 || raw.trim() != raw {
        return Err(invalid());
    }
    let mut base = Url::parse(raw).map_err(|_| invalid())?;
    if base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !matches!(base.scheme(), "http" | "https")
        || base.path().contains('%')
        || base.path().contains('\\')
    {
        return Err(invalid());
    }
    let origin = base.origin().ascii_serialization();
    let private_allowed = allowed
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .any(|value| value.trim_end_matches('/') == origin);
    if base.scheme() != "https" && !private_allowed {
        return Err(invalid());
    }
    let path = format!("{}/", base.path().trim_end_matches('/'));
    base.set_path(&path);
    Ok((base, private_allowed))
}

pub fn default_server_url() -> Option<String> {
    std::env::var("MEMOS_DEFAULT_SERVER_URL")
        .ok()
        .and_then(|value| {
            parse_url(&value, &allowed_origins())
                .ok()
                .map(|(url, _)| url.to_string())
        })
}

fn base_url(credentials: &Credentials) -> Result<(Url, bool)> {
    let default = default_server_url();
    let raw = credentials
        .server_url
        .as_deref()
        .or(default.as_deref())
        .ok_or_else(invalid)?;
    parse_url(raw, &allowed_origins())
}

pub fn validate(credentials: &Credentials) -> Result<()> {
    base_url(credentials).map(|_| ())
}

pub async fn endpoint(credentials: &Credentials) -> Result<(Url, Client)> {
    let (base, allow_private) = base_url(credentials)?;
    pinned_endpoint(base, allow_private).await
}

async fn pinned_endpoint(base: Url, allow_private: bool) -> Result<(Url, Client)> {
    let host = base
        .host_str()
        .ok_or_else(invalid)?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let port = base.port_or_known_default().ok_or_else(invalid)?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| invalid())?
    .map_err(|_| invalid())?
    .take(33)
    .collect();
    if addresses.is_empty()
        || addresses.len() > 32
        || (!allow_private && addresses.iter().any(|address| !public_ip(address.ip())))
    {
        return Err(invalid());
    }
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .resolve_to_addrs(host, &addresses)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| invalid())?;
    let endpoint = base.join("mcp").map_err(|_| invalid())?;
    Ok((endpoint, client))
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && matches!(b, 18 | 19))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && !matches!(s[0], 0x2002 | 0x3ffe | 0x3fff)
        }
    }
}

pub fn validate_identity(value: &Value) -> Result<()> {
    let failed = || {
        ConnectorError::new(
            StatusCode::CONFLICT,
            "connection_required",
            "Memos 身份校验未通过，请检查服务地址、版本及个人 Token",
        )
    };
    if value["isError"] == true {
        return Err(failed());
    }
    let parsed = value
        .get("structuredContent")
        .filter(|v| v.is_object())
        .cloned()
        .or_else(|| {
            value["content"]
                .as_array()?
                .iter()
                .filter_map(|item| item["text"].as_str())
                .find_map(|text| serde_json::from_str::<Value>(text).ok())
        })
        .ok_or_else(failed)?;
    let name = parsed
        .pointer("/user/name")
        .or_else(|| parsed.get("name"))
        .and_then(Value::as_str);
    if !name.is_some_and(|name| name.starts_with("users/") && name.len() > 6) {
        return Err(failed());
    }
    Ok(())
}

pub fn is_read_only(tool: &str) -> bool {
    matches!(
        tool,
        "auth_get_current_user"
            | "memo_list_memos"
            | "memo_get_memo"
            | "memo_list_memo_comments"
            | "memo_list_memo_attachments"
            | "memo_list_memo_reactions"
            | "memo_list_memo_relations"
            | "attachment_list_attachments"
            | "attachment_get_attachment"
            | "user_list_memo_views"
    )
}

pub fn enabled_tool(tool: &str) -> bool {
    matches!(
        tool,
        "auth_get_current_user"
            | "memo_list_memos"
            | "memo_get_memo"
            | "memo_create_memo"
            | "memo_update_memo"
            | "memo_delete_memo"
    )
}

pub fn prepare_arguments(tool: &str, mut arguments: Value) -> Result<Value> {
    let bad_arguments = || {
        ConnectorError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Memos 笔记参数无效，请按实际工具说明填写正文和笔记 ID",
        )
    };
    if !enabled_tool(tool) {
        return Err(bad_arguments());
    }
    if tool == "memo_create_memo" {
        let body = arguments
            .get_mut("body")
            .and_then(Value::as_object_mut)
            .ok_or_else(bad_arguments)?;
        if !body
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
        {
            return Err(bad_arguments());
        }
        // A connected instance may have a public default. The confirmation and
        // actual request must both show PRIVATE unless the user chose otherwise.
        body.entry("visibility")
            .or_insert_with(|| Value::String("PRIVATE".into()));
    }
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_origin_allowlist_and_clean_base_urls() {
        for raw in [
            "http://example.com",
            "https://name:secret@example.com",
            "https://example.com?token=secret",
            "https://example.com/#secret",
            "file:///tmp/test",
            "https://example.com/a%2fb",
        ] {
            assert!(parse_url(raw, "").is_err(), "{raw}");
        }
        assert!(parse_url("http://127.0.0.1:18511", "http://127.0.0.1:18512").is_err());
        let (url, allowed) = parse_url("http://127.0.0.1:18511", "http://127.0.0.1:18511").unwrap();
        assert!(allowed);
        assert_eq!(
            url.join("mcp").unwrap().as_str(),
            "http://127.0.0.1:18511/mcp"
        );
        assert_eq!(
            parse_url("https://notes.example.com/prefix", "")
                .unwrap()
                .0
                .join("mcp")
                .unwrap()
                .path(),
            "/prefix/mcp"
        );
    }

    #[test]
    fn deny_non_public_addresses_including_mapped_and_shared_ranges() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "0.1.2.3",
            "224.1.2.3",
            "240.0.0.1",
            "192.0.2.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn private_resolution_is_rejected_before_http() {
        assert!(
            pinned_endpoint(Url::parse("https://127.0.0.1/").unwrap(), false)
                .await
                .is_err()
        );
        assert!(
            pinned_endpoint(Url::parse("https://localhost/").unwrap(), false)
                .await
                .is_err()
        );
    }

    #[test]
    fn identity_requires_a_real_authenticated_user() {
        assert!(
            validate_identity(
                &json!({"content":[{"type":"text","text":"{\"user\":{\"name\":\"users/1\"}}"}]})
            )
            .is_ok()
        );
        assert!(
            validate_identity(&json!({"structuredContent":{"user":{"name":"users/test"}}})).is_ok()
        );
        for value in [
            json!({}),
            json!({"content":[{"type":"text","text":"ok"}]}),
            json!({"structuredContent":{"name":""}}),
            json!({"isError":true,"structuredContent":{"user":{"name":"users/1"}}}),
        ] {
            assert!(validate_identity(&value).is_err());
        }
        assert!(!is_read_only("memo_delete_memo"));
        assert!(!is_read_only("memo_update_memo"));
        assert!(!enabled_tool("user_create_personal_access_token"));
        assert_eq!(
            prepare_arguments("memo_create_memo", json!({"body":{"content":"日记"}})).unwrap()["body"]
                ["visibility"],
            "PRIVATE"
        );
        assert!(prepare_arguments("memo_create_memo", json!({"body":{}})).is_err());
    }
}
