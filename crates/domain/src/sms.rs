//! Backend-only SMS delivery. Credentials and verification codes are never returned by the API.
use crate::DomainError;
use hmac::{Hmac, Mac};
use reqwest::{header::HeaderMap, Client};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

const PNVS_ENDPOINT: &str = "https://dypnsapi.aliyuncs.com/";
const CONNECT_TIMEOUT_SECONDS: u64 = 15;
const REQUEST_TIMEOUT_SECONDS: u64 = 30;

fn pnvs_http_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS))
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        // This client is used only for the fixed Alibaba PNVS endpoint and its credential-free HEAD probe.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
}

#[derive(Serialize)]
pub struct SmsTransportProbe {
    pub http_status: Option<u16>,
    pub elapsed_ms: u64,
    pub is_timeout: bool,
    pub is_connect: bool,
    pub error_class: &'static str,
}

fn transport_probe_request(client: &Client) -> Result<reqwest::Request, reqwest::Error> {
    // No API action, query, body, credentials, phone number, or caller-controlled endpoint.
    client.head(PNVS_ENDPOINT).build()
}

async fn execute_transport_probe(
    client: &Client,
    request: reqwest::Request,
    started: Instant,
) -> SmsTransportProbe {
    match client.execute(request).await {
        Ok(response) => SmsTransportProbe {
            http_status: Some(response.status().as_u16()),
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            is_timeout: false,
            is_connect: false,
            // Any HTTP response proves transport establishment. No body is read and no redirect is followed.
            error_class: "none",
        },
        Err(error) => SmsTransportProbe {
            http_status: error.status().map(|status| status.as_u16()),
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            is_timeout: error.is_timeout(),
            is_connect: error.is_connect(),
            error_class: "transport_error",
        },
    }
}

/// A credential-free CLI diagnostic, deliberately independent of PhoneAuth/configuration/database initialization.
pub async fn probe_transport() -> SmsTransportProbe {
    let started = Instant::now();
    let prepared = pnvs_http_client()
        .and_then(|client| transport_probe_request(&client).map(|request| (client, request)));
    match prepared {
        Ok((client, request)) => execute_transport_probe(&client, request, started).await,
        Err(_) => SmsTransportProbe {
            http_status: None,
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            is_timeout: false,
            is_connect: false,
            error_class: "client_initialization_error",
        },
    }
}

pub struct SmsMessage<'a> {
    pub phone: &'a str,
    pub code: &'a str,
    pub challenge_id: &'a str,
}

pub trait SmsSender: Send + Sync {
    fn send<'a>(
        &'a self,
        message: SmsMessage<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), DomainError>> + Send + 'a>>;
}

pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts arbitrary key lengths");
    mac.update(message);
    hex(&mac.finalize().into_bytes())
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Alibaba Cloud Phone Number Verification Service, not the separate Dysms SMS product.
pub(crate) struct AliyunPnvs {
    access_key_id: String,
    access_key_secret: String,
    security_token: Option<String>,
    sign_name: String,
    template_code: String,
    client: Client,
}

impl AliyunPnvs {
    pub(crate) fn new(
        access_key_id: String,
        access_key_secret: String,
        security_token: Option<String>,
        sign_name: String,
        template_code: String,
    ) -> Result<Self, DomainError> {
        let client = pnvs_http_client()
            .map_err(|_| DomainError::Internal("短信服务连接初始化失败".into()))?;
        Ok(Self {
            access_key_id,
            access_key_secret,
            security_token,
            sign_name,
            template_code,
            client,
        })
    }

    fn signed_request(
        &self,
        message: SmsMessage<'_>,
        timestamp: &str,
        nonce: &str,
    ) -> (String, HeaderMap) {
        // The official RPC metadata declares these as query parameters, even for POST.
        let parameters = BTreeMap::from([
            ("AutoRetry", "0".to_owned()),
            ("CodeLength", "6".to_owned()),
            ("CountryCode", "86".to_owned()),
            ("DuplicatePolicy", "1".to_owned()),
            ("Interval", crate::phone::CODE_RETRY_SECONDS.to_string()),
            ("OutId", message.challenge_id.to_owned()),
            (
                "PhoneNumber",
                message.phone.trim_start_matches("+86").to_owned(),
            ),
            ("ReturnVerifyCode", "false".to_owned()),
            ("SignName", self.sign_name.clone()),
            ("TemplateCode", self.template_code.clone()),
            (
                "TemplateParam",
                json!({"code": message.code, "min": "5"}).to_string(),
            ),
            ("ValidTime", crate::phone::CODE_LIFETIME_SECONDS.to_string()),
        ]);
        let query = parameters
            .into_iter()
            .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(&value)))
            .collect::<Vec<_>>()
            .join("&");
        let headers = acs3_headers(
            "POST",
            "dypnsapi.aliyuncs.com",
            "SendSmsVerifyCode",
            "2017-05-25",
            &query,
            timestamp,
            nonce,
            &self.access_key_id,
            &self.access_key_secret,
            self.security_token.as_deref(),
        );
        (format!("{PNVS_ENDPOINT}?{query}"), headers)
    }

    async fn deliver(&self, message: SmsMessage<'_>) -> Result<(), DomainError> {
        let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let (url, headers) =
            self.signed_request(message, &timestamp, &crate::auth::generate_token());
        self.deliver_http(url, headers).await
    }

    async fn deliver_http(&self, url: String, headers: HeaderMap) -> Result<(), DomainError> {
        // No automatic retries: a timeout can mean the provider already accepted the paid SMS.
        let mut response = self
            .client
            .post(url)
            .headers(headers)
            .body("")
            .send()
            .await
            .map_err(|_| diagnostic_error(SmsErrorClass::TransportError, None))?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| diagnostic_error(SmsErrorClass::TransportError, Some(status)))?
        {
            if body.len() + chunk.len() > 65536 {
                return Err(diagnostic_error(
                    SmsErrorClass::UnexpectedResponse,
                    Some(status),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let reply: Value = serde_json::from_slice(&body)
            .map_err(|_| diagnostic_error(SmsErrorClass::UnexpectedResponse, Some(status)))?;
        classify_reply(status, &reply).map_err(|class| diagnostic_error(class, Some(status)))
    }
}

impl SmsSender for AliyunPnvs {
    fn send<'a>(
        &'a self,
        message: SmsMessage<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), DomainError>> + Send + 'a>> {
        Box::pin(self.deliver(message))
    }
}

fn delivery_error() -> DomainError {
    DomainError::External("短信暂未发送成功，请稍后重新获取验证码".into())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SmsErrorClass {
    PermissionDenied,
    CredentialError,
    ServiceNotEnabled,
    AccountSuspended,
    SignOrTemplateRejected,
    RateLimited,
    InvalidParameters,
    TransportError,
    UnexpectedResponse,
    Unknown,
}

impl SmsErrorClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::PermissionDenied => "permission_denied",
            Self::CredentialError => "credential_error",
            Self::ServiceNotEnabled => "service_not_enabled",
            Self::AccountSuspended => "account_suspended",
            Self::SignOrTemplateRejected => "sign_or_template_rejected",
            Self::RateLimited => "rate_limited",
            Self::InvalidParameters => "invalid_parameters",
            Self::TransportError => "transport_error",
            Self::UnexpectedResponse => "unexpected_response",
            Self::Unknown => "unknown",
        }
    }
}

fn diagnostic_error(class: SmsErrorClass, http_status: Option<u16>) -> DomainError {
    // Use the API target so existing tomorrow_api=info filters retain these warnings.
    // Only constants and the numeric HTTP status enter the event. Never log the response/error object.
    tracing::warn!(
        target: "tomorrow_api::sms",
        sms_error_class = class.as_str(),
        http_status = http_status.unwrap_or(0),
        "SMS provider request failed"
    );
    delivery_error()
}

fn classify_reply(status: u16, reply: &Value) -> Result<(), SmsErrorClass> {
    let Some(code) = reply.get("Code").and_then(Value::as_str) else {
        return Err(SmsErrorClass::UnexpectedResponse);
    };
    if code == "OK" {
        return if (200..300).contains(&status) && reply.get("Success") == Some(&Value::Bool(true)) {
            Ok(())
        } else {
            Err(SmsErrorClass::UnexpectedResponse)
        };
    }
    if reply
        .get("Success")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err(SmsErrorClass::UnexpectedResponse);
    }
    // Exact finite allowlist only. Do not classify by provider Message or by substring matching.
    // PNVS: https://help.aliyun.com/zh/pnvs/developer-reference/api-return-code
    // Direct API: https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
    // Generic ACS authentication codes: https://help.aliyun.com/zh/vms/developer-reference/api-error-code
    let class = match code {
        "isv.RAM_PERMISSION_DENY" | "isp.RAM_PERMISSION_DENY" | "Forbidden.NoPermission" => {
            SmsErrorClass::PermissionDenied
        }
        "InvalidAccessKeyId"
        | "InvalidAccessKeyId.NotFound"
        | "InvalidAccessKeyId.Inactive"
        | "SignatureDoesNotMatch"
        | "InvalidSecurityToken.Expired" => SmsErrorClass::CredentialError,
        "FUNCTION_NOT_OPENED" | "isv.PRODUCT_UNSUBSCRIBE" | "isv.PRODUCT_UN_SUBSCRIPT" => {
            SmsErrorClass::ServiceNotEnabled
        }
        // PNVS calls this business suspension and recommends checking balance; it is not definitive insufficient balance.
        "isv.OUT_OF_SERVICE" => SmsErrorClass::AccountSuspended,
        "InvalidParameter.SmsTemplateCode"
        | "EntityNotExist.SmsTemplateCode"
        | "EntityNotExist.SmsSignName" => SmsErrorClass::SignOrTemplateRejected,
        "BUSINESS_LIMIT_CONTROL"
        | "FREQUENCY_FAIL"
        | "biz.FREQUENCY"
        | "isv.BUSINESS_LIMIT_CONTROL"
        | "isp.QPS_LIMIT"
        | "LimitExceeded.SmsCode" => SmsErrorClass::RateLimited,
        "INVALID_PARAMETERS"
        | "isv.INVALID_PARAMETERS"
        | "MOBILE_NUMBER_ILLEGAL"
        | "isv.MOBILE_NUMBER_ILLEGAL" => SmsErrorClass::InvalidParameters,
        _ => SmsErrorClass::Unknown,
    };
    Err(class)
}

fn percent_encode(value: &str) -> String {
    let mut result = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(byte) {
            result.push(char::from(*byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn acs3_headers(
    method: &str,
    host: &str,
    action: &str,
    version: &str,
    query: &str,
    timestamp: &str,
    nonce: &str,
    access_key_id: &str,
    access_key_secret: &str,
    security_token: Option<&str>,
) -> HeaderMap {
    let payload_hash = hex(&Sha256::digest([]));
    let mut signed = BTreeMap::from([
        ("host", host),
        ("x-acs-action", action),
        ("x-acs-content-sha256", payload_hash.as_str()),
        ("x-acs-date", timestamp),
        ("x-acs-signature-nonce", nonce),
        ("x-acs-version", version),
    ]);
    if let Some(token) = security_token {
        signed.insert("x-acs-security-token", token);
    }
    let names = signed.keys().copied().collect::<Vec<_>>().join(";");
    let canonical_headers = signed
        .iter()
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical_request =
        format!("{method}\n/\n{query}\n{canonical_headers}\n{names}\n{payload_hash}");
    let to_sign = format!(
        "ACS3-HMAC-SHA256\n{}",
        hex(&Sha256::digest(canonical_request.as_bytes()))
    );
    let signature = hmac_sha256(access_key_secret.as_bytes(), to_sign.as_bytes());
    let mut headers = HeaderMap::new();
    for (name, value) in signed {
        // Configuration is validated before the sender is constructed.
        let mut header: reqwest::header::HeaderValue = value.parse().unwrap();
        header.set_sensitive(name == "x-acs-security-token");
        headers.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            header,
        );
    }
    let mut authorization: reqwest::header::HeaderValue = format!(
        "ACS3-HMAC-SHA256 Credential={access_key_id},SignedHeaders={names},Signature={signature}"
    )
    .parse()
    .unwrap();
    authorization.set_sensitive(true);
    headers.insert(reqwest::header::AUTHORIZATION, authorization);
    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    #[test]
    fn transport_probe_is_fixed_head_without_sms_action_or_credentials() {
        let client = pnvs_http_client().unwrap();
        let request = transport_probe_request(&client).unwrap();
        assert_eq!(request.method(), reqwest::Method::HEAD);
        assert_eq!(request.url().as_str(), "https://dypnsapi.aliyuncs.com/");
        assert!(request.url().query().is_none());
        assert!(request.body().is_none());
        assert!(request.headers().is_empty());
        assert_eq!(CONNECT_TIMEOUT_SECONDS, 15);
        assert_eq!(REQUEST_TIMEOUT_SECONDS, 30);
    }

    #[tokio::test]
    async fn transport_probe_local_fixture_observes_one_unauthenticated_head_without_body_read() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut wire = [0; 8192];
            let count = stream.read(&mut wire).unwrap();
            let request = String::from_utf8_lossy(&wire[..count]);
            assert!(request.starts_with("HEAD / HTTP/1.1\r\n"));
            let lower = request.to_ascii_lowercase();
            for forbidden in [
                "authorization",
                "x-acs-action",
                "phone",
                "templateparam",
                "code=",
                "accesskey",
                "?",
            ] {
                assert!(!lower.contains(forbidden));
            }
            // A HEAD response advertises a large body but sends none. The probe must finish using headers alone.
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let client = pnvs_http_client().unwrap();
        // Only the private test seam uses a local fixture; the public probe has no endpoint argument.
        let request = client.head(format!("http://{address}/")).build().unwrap();
        let result = execute_transport_probe(&client, request, Instant::now()).await;
        server.join().unwrap();
        assert_eq!(result.http_status, Some(200));
        assert_eq!(result.error_class, "none");
        assert!(!result.is_timeout && !result.is_connect);
        let reply = serde_json::to_value(&result).unwrap();
        assert_eq!(reply.as_object().unwrap().len(), 5);
        assert!(reply.get("body").is_none());
        assert!(reply.get("url").is_none());
    }

    #[test]
    fn diagnostics_only_use_exact_allowlisted_codes() {
        for (code, expected) in [
            ("isv.RAM_PERMISSION_DENY", SmsErrorClass::PermissionDenied),
            ("Forbidden.NoPermission", SmsErrorClass::PermissionDenied),
            (
                "InvalidAccessKeyId.NotFound",
                SmsErrorClass::CredentialError,
            ),
            ("SignatureDoesNotMatch", SmsErrorClass::CredentialError),
            ("FUNCTION_NOT_OPENED", SmsErrorClass::ServiceNotEnabled),
            ("isv.PRODUCT_UN_SUBSCRIPT", SmsErrorClass::ServiceNotEnabled),
            ("isv.OUT_OF_SERVICE", SmsErrorClass::AccountSuspended),
            (
                "EntityNotExist.SmsSignName",
                SmsErrorClass::SignOrTemplateRejected,
            ),
            (
                "InvalidParameter.SmsTemplateCode",
                SmsErrorClass::SignOrTemplateRejected,
            ),
            ("FREQUENCY_FAIL", SmsErrorClass::RateLimited),
            ("biz.FREQUENCY", SmsErrorClass::RateLimited),
            ("INVALID_PARAMETERS", SmsErrorClass::InvalidParameters),
            ("InvalidParameter.MissingSignName", SmsErrorClass::Unknown),
            ("FUNCTION_NOT_OPENED:secret", SmsErrorClass::Unknown),
            ("unknown-reflected-secret", SmsErrorClass::Unknown),
        ] {
            assert_eq!(
                classify_reply(400, &json!({"Code":code,"Success":false})),
                Err(expected)
            );
        }
        assert_eq!(
            classify_reply(200, &json!({"Code":"OK","Success":true})),
            Ok(())
        );
        assert_eq!(
            classify_reply(403, &json!({"Code":"arbitrary"})),
            Err(SmsErrorClass::Unknown)
        );
        for reply in [
            json!({}),
            json!([]),
            json!({"Code":123}),
            json!({"Code":"OK","Success":false}),
            json!({"Code":"FUNCTION_NOT_OPENED","Success":true}),
        ] {
            assert_eq!(
                classify_reply(400, &reply),
                Err(SmsErrorClass::UnexpectedResponse)
            );
        }
        assert_eq!(
            classify_reply(500, &json!({"Code":"OK","Success":true})),
            Err(SmsErrorClass::UnexpectedResponse)
        );
    }

    #[test]
    fn logs_and_user_error_never_reflect_secrets_or_provider_data() {
        #[derive(Clone)]
        struct Buffer(Arc<Mutex<Vec<u8>>>);
        impl Write for Buffer {
            fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer = bytes.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || Buffer(writer.clone()))
            .finish();
        let reflected = "LEAK_TEST_AK_SECRET_PHONE_13800138000_OTP_029381";
        tracing::subscriber::with_default(subscriber, || {
            for code in [reflected, "FUNCTION_NOT_OPENED"] {
                let reply = json!({"Code":code,"Success":false,"Message":reflected,"RequestId":reflected,"Model":{"VerifyCode":reflected}});
                let class = classify_reply(400, &reply).unwrap_err();
                let error = diagnostic_error(class, Some(400));
                assert_eq!(error.to_string(), "短信暂未发送成功，请稍后重新获取验证码");
            }
        });
        let logs = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
        assert!(logs.contains("sms_error_class=\"unknown\""));
        assert!(logs.contains("sms_error_class=\"service_not_enabled\""));
        assert!(logs.contains("http_status=400"));
        for forbidden in [
            reflected,
            "FUNCTION_NOT_OPENED",
            "Message",
            "RequestId",
            "VerifyCode",
            "https://",
            "authorization",
        ] {
            assert!(!logs.contains(forbidden));
        }
    }

    #[tokio::test]
    async fn provider_failure_is_one_request_with_no_retry() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let received = Arc::new(AtomicUsize::new(0));
        let server_received = received.clone();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_millis(500);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        server_received.fetch_add(1, Ordering::SeqCst);
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = [0; 8192];
                        stream.read(&mut request).unwrap();
                        let body = r#"{"Code":"FUNCTION_NOT_OPENED","Success":false,"Message":"never-log-this-reflected-secret"}"#;
                        write!(stream, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => panic!("local fixture failed"),
                }
            }
        });
        let sender = AliyunPnvs::new(
            "test-id".into(),
            "test-secret".into(),
            None,
            "test-sign".into(),
            "100001".into(),
        )
        .unwrap();
        let error = sender
            .deliver_http(format!("http://{address}/"), HeaderMap::new())
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "短信暂未发送成功，请稍后重新获取验证码");
        server.join().unwrap();
        assert_eq!(received.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn acs3_matches_official_reference_vector() {
        // Official V3 signing example: https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
        let headers = acs3_headers(
            "POST",
            "ecs.cn-shanghai.aliyuncs.com",
            "RunInstances",
            "2014-05-26",
            "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
            "2023-10-26T10:22:32Z",
            "3156853299f313e23d1673dc12e1703d",
            "YourAccessKeyId",
            "YourAccessKeySecret",
            None,
        );
        assert_eq!(headers["authorization"], "ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0");
    }

    #[test]
    fn pnvs_request_uses_custom_code_seconds_and_disables_return_and_retry() {
        let sender = AliyunPnvs::new(
            "id".into(),
            "secret".into(),
            None,
            "控制台签名".into(),
            "100001".into(),
        )
        .unwrap();
        let (url, headers) = sender.signed_request(
            SmsMessage {
                phone: "+8613800138000",
                code: "029381",
                challenge_id: "challenge",
            },
            "2026-10-27T00:00:00Z",
            "nonce",
        );
        let url = reqwest::Url::parse(&url).unwrap();
        let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["PhoneNumber"], "13800138000");
        assert_eq!(query["TemplateParam"], r#"{"code":"029381","min":"5"}"#);
        assert_eq!(query["ValidTime"], "300");
        assert_eq!(query["Interval"], "60");
        assert_eq!(query["ReturnVerifyCode"], "false");
        assert_eq!(query["AutoRetry"], "0");
        assert_eq!(query["SignName"], "控制台签名");
        assert_eq!(headers["x-acs-action"], "SendSmsVerifyCode");
        assert_eq!(percent_encode(" +*~中文"), "%20%2B%2A~%E4%B8%AD%E6%96%87");
    }
}
