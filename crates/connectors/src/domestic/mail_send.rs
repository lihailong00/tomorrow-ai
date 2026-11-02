//! Explicit, user-confirmed SMTP delivery. Retries never submit the same intent twice.
use super::*;
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::header::ContentType,
    transport::smtp::authentication::Credentials,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SendMail {
    pub client_request_id: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub confirmed: bool,
}

fn smtp(id: &str, email: &str, code: &str) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let host = match id {
        "qq_mail" => "smtp.qq.com",
        "netease163" => "smtp.163.com",
        "netease126" => "smtp.126.com",
        _ => return Err(ConnectorError::invalid()),
    };
    // relay() uses certificate-verified implicit TLS on port 465. No input host/port.
    Ok(AsyncSmtpTransport::<Tokio1Executor>::relay(host)
        .map_err(|_| ConnectorError::internal())?
        .credentials(Credentials::new(email.to_owned(), code.to_owned()))
        .timeout(Some(Duration::from_secs(25)))
        .build())
}

pub(super) async fn verify(id: &str, email: &str, code: &str) -> Result<()> {
    let transport = smtp(id, email, code)?;
    match timeout(Duration::from_secs(28), transport.test_connection()).await {
        Ok(Ok(true)) => Ok(()),
        _ => Err(ConnectorError::new(
            StatusCode::BAD_GATEWAY,
            "mail_smtp_unavailable",
            "收信服务已验证，但发信服务无法连接。请确认已开启 SMTP 并使用客户端授权码。",
        )),
    }
}

fn validate_input(input: &SendMail) -> Result<()> {
    if !input.confirmed
        || input.client_request_id.len() < 8
        || input.client_request_id.len() > 80
        || !input
            .client_request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || input.to.len() > 254
        || input
            .to
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
        || input.subject.trim().is_empty()
        || input.subject.len() > 600
        || input.subject.chars().any(char::is_control)
        || input.body.trim().is_empty()
        || input.body.len() > 64_000
        || input.body.contains('\0')
    {
        return Err(ConnectorError::new(
            StatusCode::BAD_REQUEST,
            "invalid_mail",
            "请确认收件人、主题和正文，确认后才能发送邮件。",
        ));
    }
    Ok(())
}

fn prepare(from: &str, input: &SendMail, message_id: &str) -> Result<Message> {
    validate_input(input)?;
    let to: lettre::Address = input.to.parse().map_err(|_| ConnectorError::invalid())?;
    let from: lettre::Address = from.parse().map_err(|_| ConnectorError::invalid())?;
    Message::builder()
        .from(from.into())
        .to(to.into())
        .message_id(Some(message_id.to_owned()))
        .subject(input.subject.trim())
        .header(ContentType::TEXT_PLAIN)
        .body(input.body.clone())
        .map_err(|_| ConnectorError::invalid())
}

fn receipt(status: &str, request: &str) -> Value {
    json!({"status":status,"client_request_id":request,"detail":match status {
        "sent" => "邮件已提交到邮箱发信服务器。",
        "sending" => "邮件正在发送，请勿重复提交。",
        "failed" => "邮箱服务拒绝了这次发信。请检查收件人、发信权限或重新连接邮箱后再试。",
        _ => "发送结果暂未确认，请先检查邮箱已发送和收件情况，避免重复发送。",
    }})
}

fn intent_fingerprint(input: &SendMail) -> Result<String> {
    // The durable owner/provider/request key fixes the original sender at acceptance.
    // Compare submitted content independently of the current connection so disconnect
    // or replacement can still replay that receipt, never send the intent again.
    Ok(digest(
        &serde_json::to_string(&json!([
            "mail-intent-v2",
            input.to,
            input.subject,
            input.body
        ]))
        .map_err(|_| ConnectorError::internal())?,
    ))
}

fn checked_receipt(row: &sqlx::any::AnyRow, hash: &str, request: &str) -> Result<Value> {
    if row.get::<String, _>("content_hash") != hash {
        return Err(ConnectorError::new(
            StatusCode::CONFLICT,
            "mail_intent_changed",
            "邮件内容已变化，请重新预览确认。",
        ));
    }
    let status: String = row.get("status");
    let status = if status == "sending" && row.get::<i64, _>("created_at") < now() - 60 {
        "unknown"
    } else {
        &status
    };
    Ok(receipt(status, request))
}

impl IntegrationState {
    pub(super) async fn send_mail(&self, user: &str, id: &str, input: SendMail) -> Result<Value> {
        if catalog::find(id)?.mode != "mail" {
            return Err(ConnectorError::invalid());
        }
        validate_input(&input)?;
        let hash = intent_fingerprint(&input)?;
        if let Some(row) = sqlx::query("SELECT content_hash,status,created_at FROM integration_mail_sends WHERE user_id=$1 AND provider=$2 AND request_id=$3")
            .bind(user).bind(id).bind(&input.client_request_id).fetch_optional(&self.0.pool).await? {
            return checked_receipt(&row, &hash, &input.client_request_id);
        }
        let binding = self
            .account(user, id)
            .await?
            .filter(|(_, secret)| !secret.is_empty())
            .ok_or_else(connection_required)?;
        self.send_mail_with_binding(user, id, input, binding).await
    }

    // A captured connection is only a snapshot. New intent acceptance below must fence it
    // against disconnect/replacement in the same transaction that commits the intent.
    async fn send_mail_with_binding(
        &self,
        user: &str,
        id: &str,
        input: SendMail,
        (generation, encrypted): (i64, String),
    ) -> Result<Value> {
        let credentials = self.decode(user, id, &encrypted)?;
        let email = credentials["email"]
            .as_str()
            .ok_or_else(connection_required)?;
        let code = credentials["authorization_code"]
            .as_str()
            .ok_or_else(connection_required)?;
        let request = &input.client_request_id;
        let hash = intent_fingerprint(&input)?;
        let message_id = format!(
            "<{}.{}.{}@tada.invalid>",
            digest(user),
            digest(id),
            digest(request)
        );
        let message = prepare(email, &input, &message_id)?;
        let transport = smtp(id, email, code)?;
        #[cfg(test)]
        let transport = self.0.mail_test_transport.clone().unwrap_or(transport);
        self.admit(user).await?;
        let _permit = self
            .0
            .requests
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let mut tx = self.0.pool.begin().await?;
        let inserted = sqlx::query("INSERT INTO integration_mail_sends(user_id,provider,request_id,content_hash,status,created_at) VALUES($1,$2,$3,$4,'sending',$5) ON CONFLICT(user_id,provider,request_id) DO NOTHING")
            .bind(user).bind(id).bind(request).bind(&hash).bind(now()).execute(&mut *tx).await?.rows_affected();
        if inserted == 0 {
            let row = sqlx::query("SELECT content_hash,status,created_at FROM integration_mail_sends WHERE user_id=$1 AND provider=$2 AND request_id=$3")
                .bind(user).bind(id).bind(request).fetch_one(&mut *tx).await?;
            return checked_receipt(&row, &hash, request);
        }
        // The no-op write takes the same account row lock as disconnect/reserve/save.
        // A concurrent revocation either wins before this check (and rolls back this
        // new intent), or waits until the intent is accepted. Existing committed
        // intents above only replay their receipt; they never submit SMTP again.
        let current = sqlx::query("UPDATE integration_accounts SET generation=generation WHERE user_id=$1 AND provider=$2 AND generation=$3 AND encrypted_credentials=$4")
            .bind(user).bind(id).bind(generation).bind(&encrypted)
            .execute(&mut *tx).await?.rows_affected();
        if current != 1 {
            return Err(connection_required());
        }
        tx.commit().await?;
        // Once committed, never submit this intent again, including after a process crash.
        // A cancelled HTTP request does not cancel this bounded delivery task.
        let state = self.clone();
        let user = user.to_owned();
        let id = id.to_owned();
        let request = request.clone();
        let task = tokio::spawn(async move {
            let _permit = _permit;
            let status = match timeout(Duration::from_secs(28), transport.send(message)).await {
                Ok(Ok(_)) => "sent",
                Ok(Err(error)) if error.is_permanent() || error.is_transient() => "failed",
                _ => "unknown", // DATA may have been accepted before a transport failure.
            };
            sqlx::query("UPDATE integration_mail_sends SET status=$1 WHERE user_id=$2 AND provider=$3 AND request_id=$4")
                .bind(status).bind(&user).bind(&id).bind(&request).execute(&state.0.pool).await?;
            Ok::<_, ConnectorError>(receipt(status, &request))
        });
        task.await.map_err(|_| ConnectorError::internal())?
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, request};
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };
    fn input() -> SendMail {
        SendMail {
            client_request_id: "test-mail-001".into(),
            to: "friend@example.com".into(),
            subject: "项目进展".into(),
            body: "你好，\n明天一起确认方案。".into(),
            confirmed: true,
        }
    }
    #[test]
    fn builds_utf8_mime_and_rejects_injection_or_unconfirmed_sends() {
        let good = input();
        let message = prepare("owner@qq.com", &good, "<unit@tada.invalid>").unwrap();
        let formatted = String::from_utf8(message.formatted()).unwrap();
        assert!(formatted.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(formatted.contains("Message-ID: <unit@tada.invalid>"));
        for bad in [
            SendMail {
                confirmed: false,
                ..input()
            },
            SendMail {
                to: "a@example.com\r\nBcc: victim@example.com".into(),
                ..input()
            },
            SendMail {
                subject: "ok\r\nBcc: victim@example.com".into(),
                ..input()
            },
            SendMail {
                body: " ".into(),
                ..input()
            },
        ] {
            assert!(prepare("owner@qq.com", &bad, "<unit@tada.invalid>").is_err());
        }
        assert!(smtp("custom", "a@qq.com", "code").is_err());
    }

    async fn seeded() -> (IntegrationState, String, String, String, String) {
        let (state, a, b, ta, tb) = fixture().await;
        let generation = state.reserve(&a, "qq_mail").await.unwrap();
        state
            .save(
                &a,
                "qq_mail",
                generation,
                &json!({"email":"owner@qq.com","authorization_code":"Abcd1234567890ef"}),
            )
            .await
            .unwrap();
        (state, a, b, ta, tb)
    }
    fn payload() -> Value {
        json!({"client_request_id":"test-mail-001","to":"friend@example.com","subject":"项目进展","body":"你好，\n明天一起确认方案。","confirmed":true})
    }
    async fn local_smtp(
        state: &mut IntegrationState,
        acknowledge: Option<bool>,
    ) -> tokio::task::JoinHandle<String> {
        local_smtp_before_ack(state, acknowledge, None).await
    }
    async fn local_smtp_before_ack(
        state: &mut IntegrationState,
        acknowledge: Option<bool>,
        mut before_ack: Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
    ) -> tokio::task::JoinHandle<String> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        Arc::make_mut(&mut state.0).mail_test_transport = Some(
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(port)
                .credentials(Credentials::new("test-user".into(), "test-code".into()))
                .build(),
        );
        tokio::spawn(async move {
            timeout(Duration::from_secs(10), async move {
                let (socket, _) = listener.accept().await.unwrap();
                let (read, mut write) = socket.into_split();
                let mut lines = BufReader::new(read).lines();
                write.write_all(b"220 localhost ESMTP\r\n").await.unwrap();
                let mut data = String::new();
                let mut in_data = false;
                while let Some(line) = lines.next_line().await.unwrap() {
                    if in_data {
                        if line == "." {
                            if let Some((started, release)) = before_ack.take() {
                                started.send(()).unwrap();
                                release.await.unwrap();
                            }
                            if let Some(accepted) = acknowledge {
                                write
                                    .write_all(if accepted {
                                        b"250 queued\r\n"
                                    } else {
                                        b"550 rejected\r\n"
                                    })
                                    .await
                                    .unwrap();
                            }
                            break;
                        }
                        data.push_str(&line);
                        data.push('\n');
                    } else if line.starts_with("EHLO") {
                        write
                            .write_all(b"250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n")
                            .await
                            .unwrap();
                    } else if line.starts_with("AUTH") {
                        write.write_all(b"235 authenticated\r\n").await.unwrap();
                    } else if line.starts_with("MAIL FROM:") || line.starts_with("RCPT TO:") {
                        write.write_all(b"250 OK\r\n").await.unwrap();
                    } else if line == "DATA" {
                        in_data = true;
                        write.write_all(b"354 send message\r\n").await.unwrap();
                    } else {
                        panic!("unexpected SMTP command: {line}");
                    }
                }
                data
            })
            .await
            .unwrap()
        })
    }

    // Pause after the production entrypoint's account lookup but before admission,
    // reproducing the old credential-snapshot/revocation window deterministically.
    async fn paused_binding_send(
        state: &IntegrationState,
        user: &str,
    ) -> (
        tokio::task::JoinHandle<Result<Value>>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (captured_tx, captured_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let worker = state.clone();
        let user = user.to_owned();
        let pending = tokio::spawn(async move {
            let binding = worker.account(&user, "qq_mail").await?.unwrap();
            captured_tx.send(()).unwrap();
            release_rx.await.unwrap();
            worker
                .send_mail_with_binding(&user, "qq_mail", input(), binding)
                .await
        });
        captured_rx.await.unwrap();
        (pending, release_tx)
    }

    #[tokio::test]
    async fn disconnect_or_replacement_before_acceptance_blocks_stale_smtp_and_rolls_back_intent() {
        for replace in [false, true] {
            let (mut state, a, _, _, _) = seeded().await;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            Arc::make_mut(&mut state.0).mail_test_transport = Some(
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                    .port(listener.local_addr().unwrap().port())
                    .build(),
            );
            let (pending, release) = paused_binding_send(&state, &a).await;
            if replace {
                let generation = state.reserve(&a, "qq_mail").await.unwrap();
                state.save(&a, "qq_mail", generation,
                    &json!({"email":"replacement@qq.com","authorization_code":"replacement-code"}))
                    .await.unwrap();
            } else {
                state.disconnect(&a, "qq_mail").await.unwrap();
            }
            release.send(()).unwrap();
            let error = timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(error.status, StatusCode::CONFLICT);
            assert_eq!(error.code, "connection_required");
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM integration_mail_sends WHERE user_id=$1")
                    .bind(&a)
                    .fetch_one(&state.0.pool)
                    .await
                    .unwrap();
            assert_eq!(
                count, 0,
                "A stale binding must not commit a new send intent"
            );
            assert!(
                timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err(),
                "A stale binding must not contact SMTP"
            );
            if replace {
                let server = local_smtp(&mut state, Some(true)).await;
                let result = state.send_mail(&a, "qq_mail", input()).await.unwrap();
                assert_eq!(result["status"], "sent");
                assert!(server.await.unwrap().contains("From: replacement@qq.com"));
            }
        }
    }

    #[tokio::test]
    async fn committed_intent_replays_after_binding_revocation_without_new_smtp() {
        let (mut state, a, _, _, _) = seeded().await;
        let first_smtp = local_smtp(&mut state, Some(true)).await;
        let accepted = state.send_mail(&a, "qq_mail", input()).await.unwrap();
        assert_eq!(accepted["status"], "sent");
        assert!(!first_smtp.await.unwrap().is_empty());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::make_mut(&mut state.0).mail_test_transport = Some(
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(listener.local_addr().unwrap().port())
                .build(),
        );
        let (replay, release) = paused_binding_send(&state, &a).await;
        state.disconnect(&a, "qq_mail").await.unwrap();
        let public_replay = state.send_mail(&a, "qq_mail", input()).await.unwrap();
        assert_eq!(
            public_replay, accepted,
            "The public entrypoint must replay without live credentials"
        );
        let changed = SendMail {
            body: "changed after disconnect".into(),
            ..input()
        };
        assert_eq!(
            state
                .send_mail(&a, "qq_mail", changed)
                .await
                .unwrap_err()
                .code,
            "mail_intent_changed"
        );
        release.send(()).unwrap();
        let result = timeout(Duration::from_secs(2), replay)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result, accepted);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM integration_mail_sends WHERE user_id=$1")
                .bind(&a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        assert!(
            timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "Replaying an accepted intent must not contact SMTP again"
        );
    }

    #[tokio::test]
    async fn accepted_delivery_continues_after_http_cancellation_and_is_not_resent() {
        let (mut state, a, _, ta, _) = seeded().await;
        let (submitted_tx, submitted_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let smtp =
            local_smtp_before_ack(&mut state, Some(true), Some((submitted_tx, release_rx))).await;
        let worker = state.clone();
        let http = tokio::spawn(async move {
            request(
                &worker,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                payload(),
            )
            .await
        });
        timeout(Duration::from_secs(2), submitted_rx)
            .await
            .unwrap()
            .unwrap();
        let stored: String =
            sqlx::query_scalar("SELECT status FROM integration_mail_sends WHERE user_id=$1")
                .bind(&a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
        assert_eq!(
            stored, "sending",
            "SMTP is only reached after durable intent acceptance"
        );
        http.abort();
        assert!(http.await.unwrap_err().is_cancelled());
        release_tx.send(()).unwrap();
        assert!(!smtp.await.unwrap().is_empty());
        timeout(Duration::from_secs(2), async {
            loop {
                let status: String = sqlx::query_scalar(
                    "SELECT status FROM integration_mail_sends WHERE user_id=$1",
                )
                .bind(&a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
                if status == "sent" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let replay = state.send_mail(&a, "qq_mail", input()).await.unwrap();
        assert_eq!(replay["status"], "sent");
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM integration_mail_sends WHERE user_id=$1")
                .bind(&a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
    #[tokio::test]
    async fn sends_real_mime_to_local_smtp_once_and_replays_receipt() {
        let (mut state, a, _, ta, tb) = seeded().await;
        let server = local_smtp(&mut state, Some(true)).await;
        let (status, sent) = request(
            &state,
            "POST",
            "/v1/integrations/qq_mail/send",
            Some(&ta),
            payload(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sent["status"], "sent");
        let data = server.await.unwrap();
        assert!(data.contains("To: friend@example.com"));
        assert!(data.contains("From: owner@qq.com"));
        let normalized = data.replace('\n', "\r\n");
        let parsed = mailparse::parse_mail(normalized.as_bytes()).unwrap();
        assert_eq!(
            parsed.get_body().unwrap().replace("\r\n", "\n").trim_end(),
            input().body
        );
        let repeated = request(
            &state,
            "POST",
            "/v1/integrations/qq_mail/send",
            Some(&ta),
            payload(),
        )
        .await;
        assert_eq!(repeated.1, sent);
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM integration_mail_sends WHERE user_id=$1")
                .bind(&a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
        let mut changed = payload();
        changed["body"] = json!("changed");
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                changed
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&tb),
                payload()
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        state.disconnect(&a, "qq_mail").await.unwrap();
        let disconnected_replay = request(
            &state,
            "POST",
            "/v1/integrations/qq_mail/send",
            Some(&ta),
            payload(),
        )
        .await;
        assert_eq!(disconnected_replay.0, StatusCode::OK);
        assert_eq!(disconnected_replay.1, sent);
    }
    #[tokio::test]
    async fn ambiguous_delivery_is_retained_and_never_automatically_resent() {
        let (mut state, a, _, ta, _) = seeded().await;
        let server = local_smtp(&mut state, None).await;
        let result = request(
            &state,
            "POST",
            "/v1/integrations/qq_mail/send",
            Some(&ta),
            payload(),
        )
        .await;
        assert_eq!(result.1["status"], "unknown");
        assert!(!server.await.unwrap().is_empty());
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                payload()
            )
            .await
            .1,
            result.1
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM integration_mail_sends WHERE user_id=$1")
                .bind(a)
                .fetch_one(&state.0.pool)
                .await
                .unwrap();
        assert_eq!(status, "unknown");
    }
    #[tokio::test]
    async fn a_definite_smtp_rejection_is_not_reported_as_delivery_or_ambiguity() {
        let (mut state, _, _, ta, _) = seeded().await;
        let server = local_smtp(&mut state, Some(false)).await;
        let result = request(
            &state,
            "POST",
            "/v1/integrations/qq_mail/send",
            Some(&ta),
            payload(),
        )
        .await;
        assert_eq!(result.1["status"], "failed");
        assert!(!server.await.unwrap().is_empty());
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                payload()
            )
            .await
            .1,
            result.1
        );
    }
    #[tokio::test]
    async fn requires_confirmation_and_honors_existing_request_admission() {
        let (state, a, _, ta, _) = seeded().await;
        let mut unconfirmed = payload();
        unconfirmed["confirmed"] = json!(false);
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                unconfirmed
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        sqlx::query(
            "INSERT INTO integration_rate_limits(user_id,bucket,attempts) VALUES($1,$2,30)",
        )
        .bind(&a)
        .bind(now() / 60)
        .execute(&state.0.pool)
        .await
        .unwrap();
        assert_eq!(
            request(
                &state,
                "POST",
                "/v1/integrations/qq_mail/send",
                Some(&ta),
                payload()
            )
            .await
            .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM integration_mail_sends")
            .fetch_one(&state.0.pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "Rejected sends must roll back the intent reservation"
        );
    }
}
