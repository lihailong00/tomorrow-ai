//! Bounded, read-only IMAP adapters; outgoing mail is handled by mail_send.
//! Credentials are supplied by the encrypted per-user connection store.

use std::{
    collections::HashSet,
    fmt::Debug,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use axum::http::StatusCode;
use futures_util::{StreamExt, pin_mut};
use mailparse::MailHeaderMap;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::Semaphore,
    time::timeout,
};
use tokio_rustls::{TlsConnector, client::TlsStream, rustls};

use crate::{ConnectorError, Result};

const MAX_MESSAGES: u32 = 20;
const MESSAGE_PREFIX_BYTES: usize = 16 * 1024;
const MAX_WIRE_BYTES: usize = 1024 * 1024;
const MAX_TEXT_CHARS: usize = 2_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const FETCH_QUERY: &str = "(UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.16384>)";
static MAIL_SLOTS: Semaphore = Semaphore::const_new(4);

#[derive(Clone, Copy)]
struct Provider {
    host: &'static str,
    domains: &'static [&'static str],
    webmail: &'static str,
    identify: bool,
}

fn provider(id: &str) -> Result<Provider> {
    match id {
        "qq_mail" => Ok(Provider {
            host: "imap.qq.com",
            domains: &["qq.com", "foxmail.com"],
            webmail: "https://mail.qq.com/",
            identify: false,
        }),
        "netease163" => Ok(Provider {
            host: "imap.163.com",
            domains: &["163.com"],
            webmail: "https://mail.163.com/",
            identify: true,
        }),
        "netease126" => Ok(Provider {
            host: "imap.126.com",
            domains: &["126.com"],
            webmail: "https://mail.126.com/",
            identify: true,
        }),
        _ => Err(ConnectorError::invalid()),
    }
}

fn checked_credentials<'a>(
    config: Provider,
    email: &'a str,
    code: &'a str,
) -> Result<(&'a str, &'a str)> {
    let email = email.trim();
    // Only provider domains are accepted; neither hosts nor IMAP expressions come from input.
    let Some((local, domain)) = email.rsplit_once('@') else {
        return Err(ConnectorError::invalid());
    };
    if local.is_empty()
        || local.len() > 128
        || local.contains('@')
        || !config
            .domains
            .iter()
            .any(|known| domain.eq_ignore_ascii_case(known))
        || email.len() > 254
        || email.chars().any(|c| c.is_control() || c.is_whitespace())
        || code.len() < 8
        || code.len() > 128
        || !code.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        return Err(ConnectorError::invalid());
    }
    Ok((email, code))
}

fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "mail_provider_error",
        "邮箱连接失败，请检查 IMAP 服务和客户端授权码，或稍后重试",
    )
}

fn busy() -> ConnectorError {
    ConnectorError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "mail_busy",
        "邮箱读取请求较多，请稍后重试",
    )
}

type MailSession = async_imap::Session<ReadBudget<TlsStream<TcpStream>>>;

async fn connect(config: Provider, email: &str, code: &str) -> Result<MailSession> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| ConnectorError::internal())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let tcp = TcpStream::connect((config.host, 993))
        .await
        .map_err(|_| unavailable())?;
    let name = rustls::pki_types::ServerName::try_from(config.host)
        .map_err(|_| ConnectorError::internal())?;
    let stream = TlsConnector::from(Arc::new(tls))
        .connect(name, tcp)
        .await
        .map_err(|_| unavailable())?;
    let mut client = async_imap::Client::new(ReadBudget::new(stream, MAX_WIRE_BYTES));
    if client
        .read_response()
        .await
        .map_err(|_| unavailable())?
        .is_none()
    {
        return Err(unavailable());
    }
    let mut session = client.login(email, code).await.map_err(|_| unavailable())?;
    if config.identify {
        // NetEase requires client identification for third-party IMAP access.
        session
            .id([("name", Some("Tada")), ("version", Some("1.0"))])
            .await
            .map_err(|_| unavailable())?;
    }
    Ok(session)
}

pub async fn verify(provider_id: &str, email: &str, authorization_code: &str) -> Result<()> {
    let config = provider(provider_id)?;
    let (email, code) = checked_credentials(config, email, authorization_code)?;
    let _slot = MAIL_SLOTS.try_acquire().map_err(|_| busy())?;
    timeout(REQUEST_TIMEOUT, async {
        let mut session = connect(config, email, code).await?;
        session.examine("INBOX").await.map_err(|_| unavailable())?;
        // LOGOUT does not expunge messages; do not use CLOSE or SELECT.
        let _ = timeout(Duration::from_secs(2), session.logout()).await;
        super::mail_send::verify(provider_id, email, code).await?;
        Ok(())
    })
    .await
    .map_err(|_| unavailable())?
}

pub async fn read(provider_id: &str, credentials: &Value, query: &Value) -> Result<Value> {
    let config = provider(provider_id)?;
    let email = credentials
        .get("email")
        .and_then(Value::as_str)
        .ok_or_else(ConnectorError::invalid)?;
    let code = credentials
        .get("authorization_code")
        .and_then(Value::as_str)
        .ok_or_else(ConnectorError::invalid)?;
    let (email, code) = checked_credentials(config, email, code)?;
    let keyword = query
        .get("query")
        .or_else(|| query.get("q"))
        .or_else(|| query.get("keyword"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if keyword.chars().count() > 200 || keyword.chars().any(char::is_control) {
        return Err(ConnectorError::invalid());
    }
    let limit = query
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(MAX_MESSAGES))
        .clamp(1, u64::from(MAX_MESSAGES)) as u32;
    let _slot = MAIL_SLOTS.try_acquire().map_err(|_| busy())?;
    timeout(REQUEST_TIMEOUT, async {
        let mut session = connect(config, email, code).await?;
        let result = read_session(&mut session, config, keyword, limit).await;
        let _ = timeout(Duration::from_secs(2), session.logout()).await;
        result
    })
    .await
    .map_err(|_| unavailable())?
}

async fn read_session<T>(
    session: &mut async_imap::Session<T>,
    config: Provider,
    keyword: &str,
    limit: u32,
) -> Result<Value>
where
    T: AsyncRead + AsyncWrite + Unpin + Debug + Send,
{
    let inbox = session.examine("INBOX").await.map_err(|_| unavailable())?;
    let mut items = Vec::new();
    let first = inbox.exists.saturating_sub(MAX_MESSAGES - 1).max(1);
    let search = keyword.to_lowercase();
    if inbox.exists > 0 {
        let stream = session
            .fetch(format!("{}:{}", first, inbox.exists), FETCH_QUERY)
            .await
            .map_err(|_| unavailable())?;
        pin_mut!(stream);
        let mut seen = HashSet::new();
        while let Some(fetch) = stream.next().await {
            let fetch = fetch.map_err(|_| unavailable())?;
            // Servers may emit unrelated unsolicited FETCH responses.
            if fetch.message < first || fetch.message > inbox.exists {
                continue;
            }
            if !seen.insert(fetch.message) || items.len() >= MAX_MESSAGES as usize {
                continue;
            }
            let Some(body) = fetch.body() else {
                continue;
            };
            let parsed = summarize(&body[..body.len().min(MESSAGE_PREFIX_BYTES)]);
            if !search.is_empty()
                && !format!("{} {} {}", parsed.title, parsed.sender, parsed.text)
                    .to_lowercase()
                    .contains(&search)
            {
                continue;
            }
            let snippet_limited = parsed.text.chars().count() >= MAX_TEXT_CHARS;
            let text = if parsed.sender.is_empty() {
                parsed.text
            } else {
                format!("发件人：{}\n{}", parsed.sender, parsed.text)
            };
            let id = match fetch.uid {
                Some(uid) => format!("inbox:{}:{}", inbox.uid_validity.unwrap_or_default(), uid),
                None => format!("inbox:sequence:{}", fetch.message),
            };
            items.push((fetch.message, json!({
                "id": id,
                "title": parsed.title,
                "text": text,
                "url": config.webmail,
                "timestamp": fetch.internal_date().map(|date| date.to_rfc3339()),
                "truncated": snippet_limited || fetch.size.map(|size| size as usize > MESSAGE_PREFIX_BYTES).unwrap_or(true),
                "snippet": true,
            })));
        }
    }
    items.sort_by(|left, right| right.0.cmp(&left.0));
    items.truncate(limit as usize);
    Ok(json!({
        "items": items.into_iter().map(|(_, item)| item).collect::<Vec<_>>(),
        "read_only": true,
        "mailbox": "INBOX",
        "total_messages": inbox.exists,
        "searched_latest": inbox.exists.min(MAX_MESSAGES),
        "search_scope": "latest_20_snippets",
        "detail": "只读最近 20 封收件箱邮件的有限摘要；关键词仅在这些摘要内匹配，不下载附件，也不更改已读状态",
    }))
}

struct Summary {
    title: String,
    sender: String,
    text: String,
}

fn summarize(raw: &[u8]) -> Summary {
    let headers = mailparse::parse_headers(raw)
        .ok()
        .map(|(headers, _)| headers)
        .unwrap_or_default();
    let title = compact(
        &headers
            .get_first_value("Subject")
            .unwrap_or_else(|| "（无主题）".to_string()),
        300,
    );
    let sender = compact(&headers.get_first_value("From").unwrap_or_default(), 300);
    let text = text_part(raw).unwrap_or_else(|| "正文摘要暂不可用，可在原邮箱查看".to_string());
    Summary {
        title,
        sender,
        text,
    }
}

fn text_part(raw: &[u8]) -> Option<String> {
    // Parse MIME iteratively with explicit depth and part limits. Full recursive
    // parse_mail on an untrusted nested multipart can exhaust the stack.
    let mut pending = vec![(raw, 0usize)];
    let mut visited = 0;
    let mut html_fallback = None;
    while let Some((raw, depth)) = pending.pop() {
        visited += 1;
        if visited > 32 || depth > 6 {
            continue;
        }
        let Ok((headers, body_start)) = mailparse::parse_headers(raw) else {
            continue;
        };
        let content_type = mailparse::parse_content_type(
            &headers
                .get_first_value("Content-Type")
                .unwrap_or_else(|| "text/plain".into()),
        );
        let disposition = headers
            .get_first_value("Content-Disposition")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if disposition.starts_with("attachment") {
            continue;
        }
        if content_type.mimetype.starts_with("multipart/") {
            let Some(boundary) = content_type.params.get("boundary") else {
                continue;
            };
            if boundary.is_empty() || boundary.len() > 200 || !boundary.is_ascii() {
                continue;
            }
            let marker = format!("--{}", boundary);
            let body = &raw[body_start..];
            let mut cuts = Vec::new();
            for (index, window) in body.windows(marker.len()).enumerate() {
                if window == marker.as_bytes() && (index == 0 || body[index - 1] == b'\n') {
                    cuts.push(index);
                    if cuts.len() >= 33 {
                        break;
                    }
                }
            }
            let mut parts = Vec::new();
            for (part, start) in cuts.iter().copied().enumerate() {
                let after_marker = start + marker.len();
                if body[after_marker..].starts_with(b"--") {
                    break;
                }
                let start = if body[after_marker..].starts_with(b"\r\n") {
                    after_marker + 2
                } else if body[after_marker..].starts_with(b"\n") {
                    after_marker + 1
                } else {
                    continue;
                };
                let end = cuts.get(part + 1).copied().unwrap_or(body.len());
                parts.push((&body[start..end], depth + 1));
            }
            pending.extend(parts.into_iter().rev());
        } else if content_type.mimetype == "text/plain" || content_type.mimetype == "text/html" {
            let Ok(parsed) = mailparse::parse_mail(raw) else {
                continue;
            };
            let Ok(text) = parsed.get_body() else {
                continue;
            };
            let text = if content_type.mimetype == "text/html" {
                compact(&strip_html(&text), MAX_TEXT_CHARS)
            } else {
                compact(&text, MAX_TEXT_CHARS)
            };
            if text.is_empty() {
                continue;
            }
            if content_type.mimetype == "text/plain" {
                return Some(text);
            }
            if html_fallback.is_none() {
                html_fallback = Some(text);
            }
        }
    }
    html_fallback
}

fn compact(value: &str, limit: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

fn strip_html(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(open) = rest.find('<') {
        output.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag_end = open + close + 1;
        let tag = rest[open + 1..tag_end - 1].trim().to_ascii_lowercase();
        rest = &rest[tag_end..];
        let name = tag.split_whitespace().next().unwrap_or("");
        if name == "script" || name == "style" {
            let closing = format!("</{}", name);
            if let Some(index) = rest.to_ascii_lowercase().find(&closing) {
                rest = &rest[index..];
            } else {
                rest = "";
            }
        }
        output.push(' ');
    }
    output.push_str(rest);
    output
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Limit plaintext bytes consumed by the protocol parser, including oversized
/// server literals and unsolicited messages. Budget exhaustion is an error.
#[derive(Debug)]
struct ReadBudget<T> {
    inner: T,
    remaining: usize,
    line_tail: Vec<u8>,
    literal_remaining: usize,
}

impl<T> ReadBudget<T> {
    fn new(inner: T, remaining: usize) -> Self {
        Self {
            inner,
            remaining,
            line_tail: Vec::with_capacity(64),
            literal_remaining: 0,
        }
    }

    fn check_literals(&mut self, bytes: &[u8]) -> io::Result<()> {
        // async-imap reserves memory from a declared literal size before reading
        // its bytes. Reject an oversized declaration before exposing it to the
        // parser, even when the marker is split across transport reads.
        for byte in bytes {
            if self.literal_remaining > 0 {
                self.literal_remaining -= 1;
                continue;
            }
            if self.line_tail.len() == 64 {
                self.line_tail.remove(0);
            }
            self.line_tail.push(*byte);
            if *byte != b'\n' {
                continue;
            }
            if self.line_tail.ends_with(b"}\r\n") {
                let end = self.line_tail.len() - 3;
                if let Some(start) = self.line_tail[..end].iter().rposition(|byte| *byte == b'{') {
                    let digits = &self.line_tail[start + 1..end];
                    if !digits.is_empty() && digits.iter().all(u8::is_ascii_digit) {
                        let count = std::str::from_utf8(digits)
                            .ok()
                            .and_then(|text| text.parse::<usize>().ok())
                            .ok_or_else(|| io::Error::other("mail literal limit"))?;
                        if count > MESSAGE_PREFIX_BYTES {
                            return Err(io::Error::other("mail literal limit"));
                        }
                        self.literal_remaining = count;
                    }
                }
            }
            self.line_tail.clear();
        }
        Ok(())
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for ReadBudget<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        target: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if target.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.remaining == 0 {
            return Poll::Ready(Err(io::Error::other("mail response limit")));
        }
        let capacity = target.remaining().min(this.remaining);
        let mut limited = ReadBuf::new(&mut target.initialize_unfilled()[..capacity]);
        match Pin::new(&mut this.inner).poll_read(cx, &mut limited) {
            Poll::Ready(Ok(())) => {
                let count = limited.filled().len();
                if let Err(error) = this.check_literals(limited.filled()) {
                    return Poll::Ready(Err(error));
                }
                target.advance(count);
                this.remaining -= count;
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for ReadBudget<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn credentials_allow_only_fixed_provider_domains_and_app_codes() {
        assert!(
            checked_credentials(
                provider("qq_mail").unwrap(),
                "123@qq.com",
                "Abcd1234567890ef"
            )
            .is_ok()
        );
        assert!(
            checked_credentials(
                provider("qq_mail").unwrap(),
                "a@foxmail.com",
                "Abcd1234567890ef"
            )
            .is_ok()
        );
        for email in [
            "a@qq.com.evil.invalid",
            "a@127.0.0.1",
            "a\r\n@163.com",
            "a@163.com",
            "a@@qq.com",
        ] {
            assert!(
                checked_credentials(provider("qq_mail").unwrap(), email, "Abcd1234567890ef")
                    .is_err()
            );
        }
        assert!(
            checked_credentials(
                provider("netease163").unwrap(),
                "a@163.com",
                "pass\r\nLOGOUT"
            )
            .is_err()
        );
        assert!(provider("custom").is_err());
    }

    #[test]
    fn mime_decodes_chinese_and_skips_binary_attachments() {
        let mail = b"Subject: =?UTF-8?B?5Lya6K6u?=\r\nFrom: team@example.com\r\nContent-Type: multipart/mixed; boundary=tada\r\n\r\n--tada\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment\r\n\r\nSECRET BINARY\r\n--tada\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n5piO5aSp5byA5Lya\r\n--tada--\r\n";
        let summary = summarize(mail);
        assert_eq!(summary.title, "会议");
        assert_eq!(summary.text, "明天开会");
        assert!(!summary.text.contains("BINARY"));
    }

    #[test]
    fn html_is_text_only_and_plain_alternative_wins() {
        assert_eq!(
            compact(
                &strip_html(
                    "<p>hello</p><script>secret()</script><style>.x{}</style><p>world &amp; team</p>"
                ),
                200
            ),
            "hello world & team"
        );
        let raw = b"Content-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>HTML</b>\r\n--x\r\nContent-Type: text/plain\r\n\r\nPLAIN\r\n--x--\r\n";
        assert_eq!(text_part(raw).as_deref(), Some("PLAIN"));
    }

    #[tokio::test]
    async fn transport_budget_rejects_oversized_literals() {
        let (client, mut server) = tokio::io::duplex(64);
        server.write_all(b"0123456789").await.unwrap();
        drop(server);
        let mut limited = ReadBudget::new(client, 4);
        let mut data = Vec::new();
        assert!(limited.read_to_end(&mut data).await.is_err());
        assert_eq!(data, b"0123");
    }

    #[test]
    fn oversized_literal_declarations_are_blocked_before_parser_allocation() {
        let mut guarded = ReadBudget::new((), MAX_WIRE_BYTES);
        guarded
            .check_literals(b"* 1 FETCH (BODY[] {500000")
            .unwrap();
        assert!(guarded.check_literals(b"000}\r\n").is_err());
        let mut guarded = ReadBudget::new((), MAX_WIRE_BYTES);
        guarded
            .check_literals(b"* 1 FETCH (BODY[] {15}\r\n{500000000}\r\nxx")
            .unwrap();
        assert_eq!(guarded.literal_remaining, 0);
    }

    #[tokio::test]
    async fn protocol_examines_and_peeks_latest_window_without_mutating_mail() {
        let (client, server) = tokio::io::duplex(16 * 1024);
        let task = tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(server);
            let mut lines = BufReader::new(reader).lines();
            writer.write_all(b"* OK test mailbox\r\n").await.unwrap();
            let login = lines.next_line().await.unwrap().unwrap();
            let tag = login.split_whitespace().next().unwrap();
            assert!(login.contains(" LOGIN "));
            writer
                .write_all(format!("{tag} OK authenticated\r\n").as_bytes())
                .await
                .unwrap();
            let examine = lines.next_line().await.unwrap().unwrap();
            let tag = examine.split_whitespace().next().unwrap();
            assert!(examine.contains(" EXAMINE \"INBOX\""));
            writer.write_all(format!("* 100 EXISTS\r\n* OK [UIDVALIDITY 77] stable\r\n{tag} OK [READ-ONLY] examined\r\n").as_bytes()).await.unwrap();
            let fetch = lines.next_line().await.unwrap().unwrap();
            let tag = fetch.split_whitespace().next().unwrap();
            assert!(fetch.contains(" FETCH 81:100 "));
            assert!(fetch.contains("BODY.PEEK[]<0.16384>"));
            assert!(!fetch.contains("STORE"));
            let body = "Subject: Meeting\r\nFrom: friend@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTomorrow 9am";
            writer.write_all(format!("* 100 FETCH (UID 123 INTERNALDATE \"27-Oct-2026 09:00:00 +0800\" RFC822.SIZE {} BODY[]<0> {{{}}}\r\n{})\r\n{tag} OK fetched\r\n", body.len(), body.len(), body).as_bytes()).await.unwrap();
        });
        let mut client = async_imap::Client::new(ReadBudget::new(client, MAX_WIRE_BYTES));
        client.read_response().await.unwrap();
        let mut session = client.login("test@qq.com", "test-app-code").await.unwrap();
        let result = read_session(&mut session, provider("qq_mail").unwrap(), "tomorrow", 20)
            .await
            .unwrap();
        assert_eq!(result["items"][0]["id"], "inbox:77:123");
        assert_eq!(result["items"][0]["title"], "Meeting");
        assert_eq!(result["searched_latest"], 20);
        assert_eq!(result["read_only"], true);
        task.await.unwrap();
    }
}
