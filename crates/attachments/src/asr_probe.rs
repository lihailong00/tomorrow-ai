//! Owner-only connection tests use synthetic speech, never user recordings.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use tomorrow_domain::model::ModelProbe;

const AUDIO: &[u8] = include_bytes!("asr_probe/fixture.wav");

pub async fn probe(get: impl Fn(&str) -> Option<String>) -> ModelProbe {
    run(get, None).await
}

pub async fn probe_with_usage(get: impl Fn(&str) -> Option<String>, repository: &Repository, user: &str) -> ModelProbe {
    run(get, Some((repository, user))).await
}

async fn run(get: impl Fn(&str) -> Option<String>, owner: Option<(&Repository, &str)>) -> ModelProbe {
    let start = std::time::Instant::now();
    let mut result = ModelProbe {
        ok: false, code: "not_configured", message: "请先配置千问语音识别模型和 API Key。",
        elapsed_ms: 0, upstream_status: None, model: get("ASR_MODEL"), input_tokens: None, output_tokens: None,
    };
    let Ok(Some(config)) = asr_from_lookup(get) else { return result; };
    if !matches!(config.protocol, asr::Protocol::Qwen) ||
        !(config.model == "qwen3-asr-flash" || config.model.starts_with("qwen3-asr-flash-")) {
        result.code = "unsupported_model"; result.message = "首版语音测试支持当前使用的千问 ASR Flash 模型。"; return result;
    }
    let Some(key) = config.api_key.as_deref() else { return result; };
    let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(7))
        .timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none());
    if reqwest::Url::parse(&config.endpoint).ok().and_then(|url| url.host_str().map(str::to_owned)).is_some_and(|host| {
        host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com" ||
            host.ends_with(".cn-beijing.maas.aliyuncs.com") || host.ends_with(".ap-southeast-1.maas.aliyuncs.com")
    }) {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    let Ok(client) = builder.build() else { return result; };
    let Ok(request) = client.post(&config.endpoint).bearer_auth(key).json(&serde_json::json!({
        "model":config.model,
        "messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":format!("data:audio/wav;base64,{}",STANDARD.encode(AUDIO))}}]}],
        "stream":false,"asr_options":{"enable_itn":true}
    })).build() else { return result; };
    let usage = if let Some((repository, user)) = owner {
        match crate::metering::MediaUsage::begin(repository, user, &config.endpoint, &config.model,
            "asr", "other", crate::metering::wav_duration_ms(AUDIO), None).await {
            Ok(usage) => Some(usage),
            Err(_) => {
                result.code = "usage_unavailable";
                result.message = "用量记录暂时不可用，未调用语音服务。";
                return result;
            }
        }
    } else { None };
    let response = client.execute(request).await;
    match response {
        Err(error) => {
            if let Some(usage) = &usage { let _ = usage.transport_failure(&error).await; }
            result.code = if error.is_timeout() { "timeout" } else { "connection_failed" };
            result.message = if error.is_timeout() { "语音服务响应超时，请稍后重试。" } else { "无法连接语音服务，请检查网络、地址或证书。" };
        }
        Ok(mut response) => {
            let status = response.status().as_u16();
            result.upstream_status = Some(status);
            if !response.status().is_success() {
                if let Some(usage) = &usage { usage.rejected_response(response).await; }
                (result.code, result.message) = match status {
                    300..=399 => ("redirect_blocked", "语音服务返回重定向，已停止测试以保护密钥。"),
                    401 | 403 => ("authentication_failed", "语音密钥无效或权限不足，请检查地域及模型开通状态。"),
                    402 => ("quota_exhausted", "语音服务账户余额或可用额度不足。"),
                    404 => ("model_not_found", "语音模型或接口不存在，请检查所选服务和地域。"),
                    429 => ("upstream_rate_limited", "语音服务限流或额度不足，请稍后重试。"),
                    400 | 422 => ("request_rejected", "语音服务未接受测试音频，请检查模型与接入方式。"),
                    _ => ("upstream_error", "语音服务暂时不可用，请稍后重试。"),
                };
            } else {
                result.code = "invalid_response"; result.message = "语音接口可访问，但未返回有效转写结果。";
                let mut bytes = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) if bytes.len() + chunk.len() <= 64 * 1024 => bytes.extend_from_slice(&chunk),
                        Ok(None) => {
                            if let Ok(body) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                                if let Some(usage) = &usage { let _ = usage.finish("succeeded", Some(&body)).await; }
                                if let Some(text) = body.pointer("/choices/0/message/content").and_then(|value| value.as_str()) {
                                    if ["明天", "提醒", "开会"].iter().all(|word| text.contains(word)) {
                                        result.ok = true; result.code = "transcribed";
                                        result.message = "语音连接成功，测试音频转写校验通过。";
                                    } else {
                                        result.code = "transcription_mismatch";
                                        result.message = "语音服务已响应，但测试音频识别结果与预期不符。";
                                    }
                                }
                            } else if let Some(usage) = &usage {
                                let _ = usage.finish("failed", None).await;
                            }
                            break;
                        }
                        Err(error) => {
                            if let Some(usage) = &usage { let _ = usage.transport_failure(&error).await; }
                            if error.is_timeout() { result.code = "timeout"; result.message = "读取语音识别结果超时，请稍后重试。"; }
                            break;
                        }
                        _ => {
                            if let Some(usage) = &usage { let _ = usage.finish("failed", None).await; }
                            break;
                        }
                    }
                }
            }
        }
    }
    // Do not echo even synthetic transcripts: malformed providers may reflect
    // authentication headers. Return only the deterministic phrase check.
    result.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
    #[tokio::test]
    async fn asr_probe_transcribes_only_builtin_speech_and_returns_no_provider_payload() {
        assert_eq!(&AUDIO[..4], b"RIFF");
        assert!(AUDIO.len() < 160000);
        for (text, ok) in [("明天上午9点提醒我开会。", true), ("fixture-private-key", false)] {
            let repository = Repository::connect("sqlite::memory:").await.unwrap();
            let user = repository.create_user("asr-probe@example.test", "hash", "admin", "Asia/Shanghai").await.unwrap();
            let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", server.local_addr().unwrap());
            let content = serde_json::json!({"choices":[{"message":{"content":text}}]}).to_string();
            let task = tokio::spawn(async move {
                let (mut stream, _) = server.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut part = [0; 8192];
                    let read = stream.read(&mut part).await.unwrap(); assert!(read > 0);
                    request.extend_from_slice(&part[..read]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let size = headers.lines().find_map(|line| line.strip_prefix("content-length:").map(|size| size.trim().parse::<usize>().unwrap())).unwrap();
                        if request.len() >= end + 4 + size { break; }
                    }
                    assert!(request.len() < 200000);
                }
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", content.len(), content);
                stream.write_all(response.as_bytes()).await.unwrap();
                let request = String::from_utf8(request).unwrap();
                assert!(request.contains("data:audio/wav;base64,"));
                assert!(!request.contains("user-upload"));
            });
            let result = probe_with_usage(|name| match name {
                "ASR_PROTOCOL" => Some("qwen_asr".into()), "ASR_BASE_URL" => Some(base.clone()),
                "ASR_MODEL" => Some("qwen3-asr-flash".into()), "ASR_API_KEY" => Some("fixture-private-key".into()), _ => None,
            }, &repository, &user.id).await;
            task.await.unwrap();
            assert_eq!(result.ok, ok);
            assert!(!serde_json::to_string(&result).unwrap().contains("fixture-private-key"));
            let pool = repository.pool();
            let row: (String,String,String,String) = sqlx::query_as("SELECT user_id,capability,purpose,outcome_json FROM usage_requests")
                .fetch_one(&pool).await.unwrap();
            assert_eq!((row.0.as_str(),row.1.as_str(),row.2.as_str()), (user.id.as_str(),"asr","other"));
            let measured: serde_json::Value = serde_json::from_str(&row.3).unwrap();
            assert!(measured["measurements"]["audio_ms"].as_i64().unwrap() > 0);
            pool.close().await;
        }
    }
}
