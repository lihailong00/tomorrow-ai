use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Clone)]
struct Request {
    line: String,
    headers: String,
    body: String,
}

fn provider(id: &str) -> OAuthProvider {
    let kind = Kind::parse(id).unwrap();
    let mut provider = OAuthProvider::configured(
        id,
        "test-client".into(),
        "test-client-secret".into(),
        format!("https://app.example/v1/integrations/{id}/callback"),
        kind.required_scope(),
    )
    .unwrap();
    provider.client = Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .unwrap();
    provider
}

fn mock(
    id: &str,
    replies: Vec<(u16, Value)>,
) -> (
    OAuthProvider,
    Arc<Mutex<Vec<Request>>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut provider = provider(id);
    provider.origin = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(Vec::new()));
    let requests = captured.clone();
    let task = thread::spawn(move || {
        for (status, value) in replies {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let head_end = loop {
                let mut chunk = [0u8; 4096];
                let n = socket.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..head_end]).to_string();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < head_end + length {
                let mut chunk = [0u8; 4096];
                let n = socket.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            requests.lock().unwrap().push(Request {
                line: headers.lines().next().unwrap().into(),
                headers,
                body: String::from_utf8_lossy(&bytes[head_end..head_end + length]).to_string(),
            });
            let body = serde_json::to_vec(&value).unwrap();
            write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    (provider, captured, task)
}

fn current() -> Value {
    json!({"access_token":"test-user-token","refresh_token":"test-refresh-token","expires_at":epoch()+7200,"open_id":"test-open","union_id":"test-union"})
}

#[test]
fn configurations_require_https_fixed_callback_and_substantive_scopes() {
    for id in ["tencent_docs", "wps", "feishu", "dingtalk"] {
        let p = provider(id);
        let url = Url::parse(&p.authorize_url("csrf-example&safe").unwrap()).unwrap();
        let args: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(args["state"], "csrf-example&safe");
        assert_eq!(args["response_type"], "code");
        assert!(!args.contains_key("client_secret"));
        assert_eq!(
            args["scope"],
            if id == "tencent_docs" {
                "all"
            } else {
                p.kind.required_scope()
            }
        );
        assert!(
            OAuthProvider::configured(
                id,
                "c".into(),
                "s".into(),
                format!("http://app.example/v1/integrations/{id}/callback"),
                p.kind.required_scope()
            )
            .is_err()
        );
        assert!(
            OAuthProvider::configured(
                id,
                "c".into(),
                "s".into(),
                format!("https://app.example/v1/integrations/{id}/callback?attacker=1"),
                p.kind.required_scope()
            )
            .is_err()
        );
        assert!(
            OAuthProvider::configured(
                id,
                "c".into(),
                "s".into(),
                format!("https://app.example/v1/integrations/{id}/callback"),
                "unrelated"
            )
            .is_err()
        );
        assert!(p.authorize_url("bad\nstate").is_err());
    }
    assert!(required_configuration("unsupported").is_empty());
}

#[tokio::test]
async fn tencent_exchange_and_document_list_use_official_headers_and_project_data() {
    let (p, requests, server) = mock(
        "tencent_docs",
        vec![
            (
                200,
                json!({"access_token":"test-access","refresh_token":"test-refresh","expires_in":7200,"user_id":"test-open","scope":"scope.drive.readonly"}),
            ),
            (
                200,
                json!({"ret":0,"data":{"next":20,"list":[{"ID":"folder-1","title":"工作计划","type":"folder","url":"https://docs.qq.com/desktop/mydoc/folder/folder-1","access_token":"unexpected-secret"}]}}),
            ),
        ],
    );
    let credentials = p.exchange("test-code").await.unwrap();
    let (data, rotation) = p
        .read(&credentials, &json!({"action":"list","limit":20}))
        .await
        .unwrap();
    assert!(rotation.is_none());
    assert_eq!(data["items"][0]["title"], "工作计划");
    assert!(!data.to_string().contains("secret"));
    assert!(!data.to_string().contains("access_token"));
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[0].line.starts_with("GET /oauth/v2/token?"));
    assert!(requests[0].line.contains("grant_type=authorization_code"));
    assert!(
        requests[1]
            .line
            .starts_with("GET /openapi/drive/v2/folders/?")
    );
    let headers = requests[1].headers.to_lowercase();
    assert!(headers.contains("access-token: test-access"));
    assert!(headers.contains("open-id: test-open"));
    assert!(headers.contains("client-id: test-client"));
}

#[tokio::test]
async fn tencent_refresh_preserves_refresh_token_and_open_id_when_vendor_omits_them() {
    let (p, _, server) = mock(
        "tencent_docs",
        vec![
            (
                200,
                json!({"access_token":"rotated-access","expires_in":7200,"scope":"scope.drive.readonly"}),
            ),
            (200, json!({"ret":0,"data":{"next":0,"list":[]}})),
        ],
    );
    let mut old = current();
    old["expires_at"] = json!(epoch() - 10);
    let (_, rotation) = p.read(&old, &json!({})).await.unwrap();
    let rotation = rotation.unwrap();
    assert_eq!(rotation["refresh_token"], "test-refresh-token");
    assert_eq!(rotation["open_id"], "test-open");
    server.join().unwrap();
}

#[test]
fn wps_kso_signature_matches_official_empty_body_vector() {
    // Vendor's public documentation test key, not an application credential.
    let signature = kso_signature(
        "sk098765",
        "GET",
        "/v7/test?key=value",
        "Mon, 02 Jan 2006 15:04:05 GMT",
    )
    .unwrap();
    assert_eq!(
        signature,
        "ce8df66877175e5198c8ea1362ffddf82e4941c6f25a4ca205a1ad09d0faaf03"
    );
}

#[tokio::test]
async fn wps_form_exchange_signed_content_read_and_plain_projection() {
    let (p, requests, server) = mock(
        "wps",
        vec![
            (
                200,
                json!({"access_token":"wps-access","refresh_token":"wps-refresh","expires_in":7200,"scope":"kso.file.read"}),
            ),
            (
                200,
                json!({"code":0,"data":{"plain":"会议记录：周五交付","dst_format":"plain","medias":[{"url":"https://private.example/unused"}]}}),
            ),
        ],
    );
    let creds = p.exchange("wps-code").await.unwrap();
    let (result, _) = p
        .read(
            &creds,
            &json!({"action":"content","drive_id":"drive1","file_id":"file1"}),
        )
        .await
        .unwrap();
    assert_eq!(result["content"], "会议记录：周五交付");
    assert!(result.get("medias").is_none());
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].line, "POST /oauth2/token HTTP/1.1");
    assert!(
        requests[0]
            .headers
            .contains("application/x-www-form-urlencoded")
    );
    assert!(requests[0].body.contains("grant_type=authorization_code"));
    assert!(
        requests[1]
            .line
            .starts_with("GET /v7/drives/drive1/files/file1/content?format=plain")
    );
    let headers = requests[1].headers.to_lowercase();
    assert!(headers.contains("x-kso-authorization: kso-1 test-client:"));
    assert!(headers.contains("authorization: bearer wps-access"));
}

#[tokio::test]
async fn feishu_json_exchange_and_bounded_metadata_list() {
    let (p, requests, server) = mock(
        "feishu",
        vec![
            (
                200,
                json!({"code":0,"access_token":"feishu-access","refresh_token":"feishu-refresh","expires_in":7200,"scope":"drive:drive.metadata:readonly offline_access"}),
            ),
            (
                200,
                json!({"code":0,"data":{"files":[{"token":"doc-token","name":"设计稿","type":"docx","url":"https://example.feishu.cn/docx/doc-token"}],"next_page_token":"page-two","has_more":true}}),
            ),
        ],
    );
    let creds = p.exchange("feishu-code").await.unwrap();
    let (result, _) = p
        .read(&creds, &json!({"folder_id":"folder1","limit":10}))
        .await
        .unwrap();
    assert_eq!(result["items"][0]["id"], "doc-token");
    assert_eq!(result["next_page_token"], "page-two");
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests[0].line,
        "POST /open-apis/authen/v2/oauth/token HTTP/1.1"
    );
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(body["redirect_uri"], p.redirect_uri);
    assert!(requests[1].line.contains("folder_token=folder1"));
    assert!(
        requests[1]
            .headers
            .to_lowercase()
            .contains("authorization: bearer feishu-access")
    );
}

#[tokio::test]
async fn one_use_refresh_rotation_survives_read_permission_and_projection_failures() {
    for response in [
        (403, json!({"error":"secret-provider-message"})),
        (
            200,
            json!({"code":0,"data":{"unexpected":"secret-provider-message"}}),
        ),
    ] {
        let (p, _, server) = mock(
            "feishu",
            vec![
                (
                    200,
                    json!({"code":0,"access_token":"new-access","refresh_token":"new-refresh","expires_in":7200}),
                ),
                response,
            ],
        );
        let mut old = current();
        old["expires_at"] = json!(epoch() - 10);
        let (data, rotation) = p.read(&old, &json!({})).await.unwrap();
        assert_eq!(rotation.unwrap()["refresh_token"], "new-refresh");
        assert!(data.get("error").is_some());
        assert!(!data.to_string().contains("secret-provider-message"));
        server.join().unwrap();
    }
}

#[tokio::test]
async fn dingtalk_resolves_own_union_id_then_reads_calendars() {
    let (p, requests, server) = mock(
        "dingtalk",
        vec![
            (
                200,
                json!({"accessToken":"ding-access","refreshToken":"ding-refresh","expireIn":7200}),
            ),
            (
                200,
                json!({"unionId":"own-union","nick":"测试用户","mobile":"not-returned"}),
            ),
            (
                200,
                json!({"response":{"calendars":[{"id":"primary","summary":"我的日历","description":"日程"}]}}),
            ),
        ],
    );
    let creds = p.exchange("ding-code").await.unwrap();
    let (result, _) = p
        .read(&creds, &json!({"user_id":"attacker-user"}))
        .await
        .unwrap();
    assert_eq!(result["items"][0]["summary"], "我的日历");
    assert_eq!(creds["union_id"], "own-union");
    server.join().unwrap();
    let requests = requests.lock().unwrap();
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    assert_eq!(body["grantType"], "authorization_code");
    assert_eq!(body["clientId"], "test-client");
    assert!(requests[2].line.contains("/users/own-union/calendars"));
    assert!(!requests[2].line.contains("attacker-user"));
    assert!(
        requests[2]
            .headers
            .to_lowercase()
            .contains("x-acs-dingtalk-access-token: ding-access")
    );
}

#[test]
fn query_validation_rejects_writes_path_injection_and_excessive_ranges() {
    for id in ["tencent_docs", "wps", "feishu", "dingtalk"] {
        let p = provider(id);
        assert!(
            p.plan(&current(), &json!({"action":"delete","file_id":"valid"}))
                .is_err()
        );
        if id != "dingtalk" {
            assert!(
                p.plan(
                    &current(),
                    &json!({"folder_id":"../escape","drive_id":"drive"})
                )
                .is_err()
            );
        }
        assert!(p.plan(&current(), &json!({"limit":51})).is_err());
    }
    let p = provider("wps");
    assert_eq!(
        p.plan(&current(), &json!({"action":"read"}))
            .err()
            .unwrap()
            .code,
        "resource_id_required"
    );
    let p = provider("dingtalk");
    assert!(p.plan(&current(),&json!({"action":"events","calendar_id":"primary","start_time":"2026-10-01T00:00:00+08:00","end_time":"2026-12-01T00:00:00+08:00"})).is_err());
}

#[tokio::test]
async fn provider_error_is_sanitized_and_overly_large_responses_are_rejected() {
    for reply in [
        (
            200,
            json!({"ret":10313,"msg":"test-refresh-token secret-details"}),
        ),
        (200, json!({"data":"x".repeat(MAX_RESPONSE_BYTES+10)})),
        (302, json!({"access_token":"redirect-must-not-be-followed"})),
    ] {
        let (p, _, server) = mock("tencent_docs", vec![reply]);
        let error = p.read(&current(), &json!({})).await.err().unwrap();
        assert!(!error.to_string().contains("secret"));
        assert!(!error.to_string().contains("token"));
        server.join().unwrap();
    }
}

#[tokio::test]
async fn token_grant_without_required_document_permission_is_not_accepted() {
    let (p, _, server) = mock(
        "tencent_docs",
        vec![(
            200,
            json!({"access_token":"test-access","refresh_token":"test-refresh","expires_in":7200,"user_id":"test-open","scope":"scope.user.info.base"}),
        )],
    );
    assert_eq!(
        p.exchange("code").await.err().unwrap().code,
        "permission_required"
    );
    server.join().unwrap();
}

#[test]
fn document_links_allow_only_canonical_provider_hosts_without_credentials() {
    let allowed = [
        (Kind::TencentDocs, "https://docs.qq.com/doc/document-id"),
        (Kind::Wps, "https://www.kdocs.cn/l/document-id"),
        (Kind::Feishu, "https://tenant.feishu.cn/docx/document-id"),
    ];
    for (kind, url) in allowed {
        assert!(safe_public_link(kind, url));
        for suffix in [
            "?access_token=private-value",
            "?client_secret=private-value",
            "?%61ccess_token=private-value",
            "?innocent_name=private-value",
            "#access_token=private-value",
            "#private-value",
            "?",
        ] {
            assert!(!safe_public_link(kind, &format!("{url}{suffix}")));
        }
    }
    for kind in [Kind::TencentDocs, Kind::Wps, Kind::Feishu] {
        for url in [
            "https://127.0.0.1/private",
            "https://localhost/private",
            "https://[::1]/private",
            "https://10.0.0.1/private",
            "https://evil.example/document",
            "https://docs.qq.com.evil.example/document",
            "https://evil-feishu.cn/document",
            "https://feishu.cn.evil.example/document",
            "https://kdocs.cn.evil.example/document",
            "https://docs.qq.com:8443/doc/document",
            "https://tenant.feishu.cn:8443/docx/document",
            "https://www.kdocs.cn:8443/l/document",
            "https://user:password@docs.qq.com/doc/document",
            " https://docs.qq.com/doc/document",
        ] {
            assert!(!safe_public_link(kind, url), "unexpectedly allowed {url}");
        }
    }
    assert!(!safe_public_link(
        Kind::TencentDocs,
        "https://tenant.feishu.cn/docx/document"
    ));
    assert!(!safe_public_link(
        Kind::Feishu,
        "https://docs.qq.com/doc/document"
    ));
    assert!(!safe_public_link(
        Kind::Wps,
        "https://tenant.feishu.cn/docx/document"
    ));
}

#[tokio::test]
async fn document_list_drops_malicious_url_and_nested_cursor_values() {
    let (p, _, server) = mock(
        "feishu",
        vec![(
            200,
            json!({"code":0,"data":{
                "files":[
                    {"token":"safe-id","name":"文档","url":"https://127.0.0.1/private?access_token=URL-SECRET"},
                    {"token":"safe-id-2","name":"文档2","url":"https://tenant.feishu.cn/docx/id?client_secret=URL-SECRET"},
                    {"token":"safe-id-3","name":{"client_secret":"NESTED-SECRET"},"url":"https://tenant.feishu.cn/docx/id"}
                ],
                "next_page_token":{"access_token":"CURSOR-SECRET"},
                "has_more":{"client_secret":"BOOLEAN-SECRET"}
            }}),
        )],
    );
    let (result, _) = p.read(&current(), &json!({})).await.unwrap();
    assert!(result["items"][0].get("url").is_none());
    assert!(result["items"][1].get("url").is_none());
    assert_eq!(
        result["items"][2]["url"],
        "https://tenant.feishu.cn/docx/id"
    );
    assert!(result["items"][2].get("title").is_none());
    assert!(result["next_page_token"].is_null());
    assert!(result["has_more"].is_null());
    assert!(!result.to_string().contains("SECRET"));
    server.join().unwrap();
}

#[tokio::test]
async fn calendar_projection_copies_only_typed_documented_fields() {
    let (p, _, server) = mock(
        "dingtalk",
        vec![(
            200,
            json!({"events":[{
        "id":"event-id","summary":"项目会议","description":"讨论交付",
        "start":{"dateTime":"2026-10-27T10:00:00Z","timeZone":"Asia/Shanghai","access_token":"START-SECRET","nested":{"client_secret":"NESTED-SECRET"}},
        "end":{"dateTime":"2026-10-27T11:00Z","timeZone":{"access_token":"ZONE-SECRET"}},
        "location":{"displayName":"会议室A","meetingRooms":["room-a",{"client_secret":"ROOM-SECRET"}],"access_token":"LOCATION-SECRET"},
        "organizer":{"displayName":"王同事","id":"organizer-id","responseStatus":"accepted","self":true,"client_secret":"ORGANIZER-SECRET","nested":{"access_token":"NESTED-SECRET"}},
        "status":{"access_token":"STATUS-SECRET"},
        "access_token":"TOP-SECRET"
    }],"nextToken":{"access_token":"CURSOR-SECRET"},"has_more":{"access_token":"BOOLEAN-SECRET"}}),
        )],
    );
    let (result, _) = p
        .read(
            &current(),
            &json!({"action":"events","calendar_id":"primary"}),
        )
        .await
        .unwrap();
    let item = &result["items"][0];
    assert_eq!(
        item["start"],
        json!({"dateTime":"2026-10-27T10:00:00Z","timeZone":"Asia/Shanghai"})
    );
    assert_eq!(item["end"], json!({"dateTime":"2026-10-27T11:00Z"}));
    assert_eq!(
        item["location"],
        json!({"displayName":"会议室A","meetingRooms":["room-a"]})
    );
    assert_eq!(
        item["organizer"],
        json!({"displayName":"王同事","id":"organizer-id","responseStatus":"accepted","self":true})
    );
    assert!(item.get("status").is_none());
    assert!(result["next_page_token"].is_null());
    assert!(result["has_more"].is_null());
    assert!(!result.to_string().contains("SECRET"));
    assert!(!result.to_string().contains("access_token"));
    assert!(!result.to_string().contains("client_secret"));
    server.join().unwrap();
}

#[test]
fn pagination_is_typed_bounded_and_never_truncates_an_unusable_cursor() {
    let p = provider("feishu");
    let plan = p.plan(&current(), &json!({})).unwrap();
    for token in [
        json!(["private"]),
        json!(true),
        json!(123),
        json!("x".repeat(2049)),
        json!("bad\nvalue"),
    ] {
        let result = p
            .project(
                json!({"data":{"files":[],"next_page_token":token,"has_more":"private-value"}}),
                &plan,
            )
            .unwrap();
        assert!(result["next_page_token"].is_null());
        assert!(result["has_more"].is_null());
    }
    let p = provider("tencent_docs");
    let plan = p.plan(&current(), &json!({})).unwrap();
    for next in [
        json!("private-value"),
        json!({"access_token":"private-value"}),
        json!(-1),
        json!(100_001),
    ] {
        let result = p
            .project(
                json!({"data":{"list":[],"next":next,"has_more":true}}),
                &plan,
            )
            .unwrap();
        assert!(result["next_page_token"].is_null());
        assert_eq!(result["has_more"], true);
    }
}
