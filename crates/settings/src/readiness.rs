//! Structural configuration readiness. No provider call is made, so a complete
//! form must never be presented as a verified upstream connection.
use serde::Serialize;
use std::collections::HashMap;

#[derive(Clone, Serialize)]
pub struct ConfigReadiness {
    pub revision: i64,
    pub groups: Vec<GroupReadiness>,
}

#[derive(Clone, Serialize)]
pub struct GroupReadiness {
    pub id: &'static str,
    pub label: &'static str,
    /// `not_configured`, `disabled`, `incomplete`, or `configured`.
    pub status: &'static str,
    /// Environment names only, never values or provider error bodies.
    pub missing: Vec<&'static str>,
    pub verified: bool,
    pub message: &'static str,
}

fn group(
    id: &'static str,
    label: &'static str,
    present: bool,
    missing: Vec<&'static str>,
) -> GroupReadiness {
    let status = if !present {
        "not_configured"
    } else if missing.is_empty() {
        "configured"
    } else {
        "incomplete"
    };
    GroupReadiness {
        id,
        label,
        status,
        missing,
        verified: false,
        message: match status {
            "not_configured" => "尚未配置，该功能暂不可用",
            "incomplete" => "配置已保存，但内容尚不完整；该功能暂不可用",
            _ => "配置项已完整，尚未验证供应商连接",
        },
    }
}

fn disabled(id: &'static str, label: &'static str) -> GroupReadiness {
    GroupReadiness {
        id,
        label,
        status: "disabled",
        missing: vec![],
        verified: false,
        message: "该功能已关闭",
    }
}

pub(crate) fn evaluate(revision: i64, values: &HashMap<String, String>) -> ConfigReadiness {
    let get = |key: &str| values.get(key).map(|s| s.trim()).filter(|s| !s.is_empty());
    let has = |key: &str| get(key).is_some();
    let missing = |keys: &[&'static str]| {
        keys.iter()
            .filter(|key| !has(key))
            .copied()
            .collect::<Vec<_>>()
    };
    let mut groups = vec![];
    let custom_model = ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"]
        .iter()
        .any(|key| has(key));
    let model_present = custom_model
        || ["DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_API_KEY"]
            .iter()
            .any(|key| has(key));
    groups.push(group(
        "model",
        "对话模型",
        model_present,
        if custom_model {
            let keyless_local = get("MODEL_BASE_URL").is_some_and(|base| {
                reqwest::Url::parse(base).is_ok_and(|url| {
                    ["http", "https"].contains(&url.scheme())
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.query().is_none()
                        && url.fragment().is_none()
                        && url.host_str().is_some_and(super::private_http_host)
                })
            }) && has("MODEL_NAME");
            if keyless_local {
                missing(&["MODEL_NAME"])
            } else {
                missing(&["MODEL_NAME", "MODEL_API_KEY"])
            }
        } else {
            missing(&["DEEPSEEK_API_KEY"])
        },
    ));

    let asr_present = ["ASR_BASE_URL", "ASR_MODEL", "ASR_API_KEY"]
        .iter()
        .any(|key| has(key));
    groups.push(group(
        "speech",
        "语音转文字",
        asr_present,
        missing(&["ASR_BASE_URL", "ASR_MODEL"]),
    ));
    for (id, label, enabled, base, key, model) in [
        (
            "vision",
            "云端图片理解",
            "PHOTO_VISION_ENABLED",
            "PHOTO_VISION_BASE_URL",
            "PHOTO_VISION_API_KEY",
            "PHOTO_VISION_MODEL",
        ),
        (
            "embedding",
            "相册语义检索",
            "PHOTO_EMBEDDING_ENABLED",
            "PHOTO_EMBEDDING_BASE_URL",
            "PHOTO_EMBEDDING_API_KEY",
            "PHOTO_EMBEDDING_MODEL",
        ),
    ] {
        if get(enabled) != Some("true") {
            groups.push(disabled(id, label));
            continue;
        }
        let fallback = get(base).is_none() && official_qwen_asr(values);
        let mut fields = vec![];
        if !has(base) && !fallback {
            fields.push(base);
        }
        if !has(key) && !(fallback && has("ASR_API_KEY")) {
            fields.push(key);
        }
        if !has(model) {
            fields.push(model);
        }
        groups.push(group(id, label, true, fields));
    }

    if get("DEEPSEEK_WEB_ENABLED") == Some("false") {
        groups.push(disabled("search", "网页搜索"));
    } else {
        let configured = has("DEEPSEEK_SEARCH_API_KEY") || has("DEEPSEEK_API_KEY");
        groups.push(group(
            "search",
            "网页搜索",
            get("DEEPSEEK_WEB_ENABLED") == Some("true") || configured,
            if configured {
                vec![]
            } else {
                vec!["DEEPSEEK_SEARCH_API_KEY"]
            },
        ));
    }
    if get("PHONE_AUTH_MODE") == Some("aliyun_pnvs") {
        groups.push(group(
            "sms",
            "短信验证码",
            true,
            missing(&[
                "ALIBABA_CLOUD_ACCESS_KEY_ID",
                "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
                "ALIYUN_PNVS_SIGN_NAME",
                "ALIYUN_PNVS_TEMPLATE_CODE",
                "SMS_CODE_HASH_KEY",
            ]),
        ));
    } else {
        groups.push(disabled("sms", "短信验证码"));
    }
    for (id, label, prefix) in [
        ("tencent_docs", "腾讯文档云端授权", "TENCENT_DOCS"),
        ("wps", "WPS 云端授权", "WPS"),
        ("feishu", "飞书云端授权", "FEISHU"),
        ("dingtalk", "钉钉云端授权", "DINGTALK"),
    ] {
        // Static names keep missing-field metadata and serialization independent
        // of the actual credential values.
        let keys: &[&'static str] = match prefix {
            "TENCENT_DOCS" => &[
                "TENCENT_DOCS_CLIENT_ID",
                "TENCENT_DOCS_CLIENT_SECRET",
                "TENCENT_DOCS_REDIRECT_URI",
            ],
            "WPS" => &["WPS_CLIENT_ID", "WPS_CLIENT_SECRET", "WPS_REDIRECT_URI"],
            "FEISHU" => &[
                "FEISHU_CLIENT_ID",
                "FEISHU_CLIENT_SECRET",
                "FEISHU_REDIRECT_URI",
            ],
            _ => &[
                "DINGTALK_CLIENT_ID",
                "DINGTALK_CLIENT_SECRET",
                "DINGTALK_REDIRECT_URI",
            ],
        };
        let present = keys.iter().any(|key| has(key));
        let mut fields = missing(keys);
        if !has("CONNECTOR_ENCRYPTION_KEY") {
            fields.push("CONNECTOR_ENCRYPTION_KEY");
        }
        groups.push(group(id, label, present, fields));
    }
    let google = &[
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GOOGLE_REDIRECT_URI",
    ];
    groups.push(group(
        "google",
        "Google 云端授权",
        google.iter().any(|key| has(key)),
        missing(google),
    ));
    groups.push(group("amap", "高德用户 Key 加密存储", has("CONNECTOR_ENCRYPTION_KEY"), vec![]));
    for (id, label, keys) in [
        ("huawei_health", "华为运动健康", ["HUAWEI_HEALTH_CLIENT_ID", "HUAWEI_HEALTH_CLIENT_SECRET", "HUAWEI_HEALTH_REDIRECT_URI"]),
        ("xiaomi_health", "小米运动健康", ["XIAOMI_HEALTH_CLIENT_ID", "XIAOMI_HEALTH_CLIENT_SECRET", "XIAOMI_HEALTH_REDIRECT_URI"]),
    ] {
        let mut fields = missing(&keys[..2]);
        if !has(keys[2]) && !get("INSTANCE_PUBLIC_URL").is_some_and(|value| {
            reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "https"
                && url.host_str().is_some() && url.username().is_empty()
                && url.password().is_none() && url.query().is_none()
                && url.fragment().is_none() && url.path().trim_end_matches('/').is_empty())
        }) {
            fields.push(keys[2]);
        }
        if !has("CONNECTOR_ENCRYPTION_KEY") {
            fields.push("CONNECTOR_ENCRYPTION_KEY");
        }
        groups.push(group(id, label, keys.iter().any(|key| has(key)), fields));
    }
    ConfigReadiness { revision, groups }
}

fn official_qwen_asr(values: &HashMap<String, String>) -> bool {
    if values.get("ASR_PROTOCOL").map(String::as_str) != Some("qwen_asr") {
        return false;
    }
    let Some(base) = values.get("ASR_BASE_URL") else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(base.trim()) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().trim_end_matches('/') == "/compatible-mode/v1"
        && url.host_str().is_some_and(|host| {
            ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].contains(&host)
                || host.ends_with(".cn-beijing.maas.aliyuncs.com")
                || host.ends_with(".ap-southeast-1.maas.aliyuncs.com")
        })
}
