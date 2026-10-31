//! Small, real provider requests using built-in fixtures and no user data.
use crate::photo_index::{semantic, vision};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tomorrow_domain::model::ModelProbe;

const IMAGE: &[u8] = include_bytes!("service_probe/red-circle.png");
const TEXT: &str = "明天上午九点提醒我开会。";

#[derive(Clone, Copy)]
enum Service { Vision, Embedding }

pub async fn vision(get: impl Fn(&str) -> Option<String>) -> ModelProbe {
    // A connection test does not enable the feature or change its consent rules.
    let config = vision::config_from(|key| if key == "PHOTO_VISION_ENABLED" {
        Some("true".into())
    } else { get(key) });
    probe(config.ok().flatten(), Service::Vision).await
}

pub async fn embedding(get: impl Fn(&str) -> Option<String>) -> ModelProbe {
    let config = semantic::config_from(|key| if key == "PHOTO_EMBEDDING_ENABLED" {
        Some("true".into())
    } else { get(key) });
    probe(config.ok().flatten(), Service::Embedding).await
}

async fn probe(config: Option<semantic::Config>, service: Service) -> ModelProbe {
    let start = Instant::now();
    let mut result = ModelProbe {
        ok: false, code: "not_configured", message: "请先选择服务商并配置对应 API Key，或配置可沿用的百炼语音服务。",
        elapsed_ms: 0, upstream_status: None, model: None, input_tokens: None, output_tokens: None,
    };
    let Some(config) = config else { return result; };
    result.model = Some(config.model.clone());
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(7)).timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if reqwest::Url::parse(&config.endpoint).ok().and_then(|url| url.host_str().map(str::to_owned)).is_some_and(|host| {
        host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com" ||
        host.ends_with(".cn-beijing.maas.aliyuncs.com") || host.ends_with(".ap-southeast-1.maas.aliyuncs.com")
    }) {
        builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    let Ok(client) = builder.build() else { return result; };
    let mut payload = match service {
        Service::Vision => json!({
            "model":config.model,"stream":false,"max_tokens":128,
            "messages":[{"role":"user","content":[
                {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}", STANDARD.encode(IMAGE))}},
                {"type":"text","text":"What are the color and shape of the object in this image? Reply in English with only its color and shape."}
            ]}]
        }),
        Service::Embedding => json!({"model":config.model,"input":[TEXT],"dimensions":config.dimension,"encoding_format":"float"}),
    };
    if matches!(service, Service::Vision) && config.model.starts_with("qwen") {
        payload["enable_thinking"] = json!(false);
    }
    let response = client.post(&config.endpoint).bearer_auth(&config.key).json(&payload).send().await;
    match response {
        Err(error) => {
            result.code = if error.is_timeout() { "timeout" } else { "connection_failed" };
            result.message = if error.is_timeout() { "模型服务响应超时，请稍后重试。" } else { "无法连接模型服务，请检查网络、地址或证书。" };
        }
        Ok(mut response) => {
            let status = response.status().as_u16();
            result.upstream_status = Some(status);
            if !response.status().is_success() {
                (result.code, result.message) = match status {
                    300..=399 => ("redirect_blocked", "模型服务返回重定向，已停止测试以保护密钥。"),
                    401 | 403 => ("authentication_failed", "密钥无效或权限不足，请检查服务地域及模型开通状态。"),
                    402 => ("quota_exhausted", "模型服务账户余额或可用额度不足。"),
                    404 => ("model_not_found", "模型或接口不存在，请检查所选服务和模型。"),
                    429 => ("upstream_rate_limited", "模型服务限流或额度不足，请稍后重试。"),
                    400 | 422 => ("request_rejected", "模型未接受测试请求，请确认支持对应的图片或文本向量接口。"),
                    _ => ("upstream_error", "模型服务暂时不可用，请稍后重试。"),
                };
            } else {
                result.code = "invalid_response";
                result.message = "接口可访问，但没有返回可校验的模型结果。";
                let mut bytes = Vec::new();
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) if bytes.len() + chunk.len() <= 128 * 1024 => bytes.extend_from_slice(&chunk),
                        Ok(None) => {
                            if let Ok(body) = serde_json::from_slice::<Value>(&bytes) {
                                validate(&body, service, config.dimension, &mut result);
                            }
                            break;
                        }
                        Err(error) => {
                            if error.is_timeout() { result.code = "timeout"; result.message = "读取模型结果超时，请稍后重试。"; }
                            break;
                        }
                        _ => break,
                    }
                }
            }
        }
    }
    result.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
    result
}

fn validate(body: &Value, service: Service, dimension: usize, result: &mut ModelProbe) {
    match service {
        Service::Vision => {
            let Some(text) = body.pointer("/choices/0/message/content").and_then(Value::as_str) else { return; };
            let words = text.split(|c: char| !c.is_ascii_alphabetic()).map(str::to_ascii_lowercase).collect::<Vec<_>>();
            if words.iter().any(|word| word == "red") && words.iter().any(|word| word == "circle" || word == "circular") {
                result.ok = true; result.code = "image_verified";
                result.message = "图片理解连接成功，测试图片识别校验通过。";
            } else {
                result.code = "image_mismatch";
                result.message = "模型已响应，但未正确识别测试图片中的颜色和形状。";
            }
        }
        Service::Embedding => {
            let Some(data) = body["data"].as_array().filter(|data| data.len() == 1 && data[0]["index"] == 0) else { return; };
            let Ok(vector) = serde_json::from_value::<Vec<f64>>(data[0]["embedding"].clone()) else { return; };
            if vector.len() != dimension {
                result.code = "dimension_mismatch";
                result.message = "模型已响应，但向量维度不匹配；当前检索需要 1024 维。";
            } else if semantic::valid_vector(vector, dimension).is_ok() {
                result.ok = true; result.code = "embedding_verified";
                result.message = "向量模型连接成功，1024 维文本向量校验通过。";
            }
        }
    }
    result.input_tokens = body.pointer("/usage/prompt_tokens").or_else(|| body.pointer("/usage/input_tokens")).and_then(Value::as_u64);
    result.output_tokens = body.pointer("/usage/completion_tokens").and_then(Value::as_u64);
    // Never echo descriptions, vectors or provider error payloads, which may
    // contain reflected authentication headers from a misconfigured endpoint.
}

#[cfg(test)]
mod tests;
