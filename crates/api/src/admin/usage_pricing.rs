//! Owner-managed estimates. Effective provider settings are read only to derive opaque identities.
use super::*;
use serde::Serialize;
use std::collections::BTreeMap;
use tomorrow_domain::usage::{
    validate_pricebook_json, UsageIdentity, UsageRates, MAX_SAFE_INTEGER,
};

#[derive(Serialize)]
struct ConfiguredModel {
    model_key: String,
    model: String,
    model_name: String,
    provider: String,
    capabilities: Vec<String>,
    rates: UsageRates,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pricebook {
    version: String,
    models: BTreeMap<String, UsageRates>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PriceInput {
    expected_revision: i64,
    expected_config_revision: i64,
    changes: BTreeMap<String, UsageRates>,
}

fn domain_error(error: DomainError) -> AdminError {
    match error {
        DomainError::Validation(_) => invalid(),
        DomainError::Conflict(_) => ConfigError::Conflict.into(),
        _ => internal(),
    }
}

fn parse_pricebook(value: &str) -> Result<Pricebook> {
    validate_pricebook_json(value).map_err(domain_error)?;
    if value.trim().is_empty() {
        Ok(Pricebook::default())
    } else {
        serde_json::from_str(value).map_err(|_| internal())
    }
}

pub(super) async fn read(
    State(state): State<AdminState>,
    session: AdminSession,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    snapshot(&state).await
}

async fn snapshot(state: &AdminState) -> Result<Json<Value>> {
    let (config_revision, values) = state.settings.effective_snapshot().await?;
    let (revision, effective, source) = state
        .repository
        .get_usage_pricebook_snapshot()
        .await
        .map_err(domain_error)?;
    let prices = parse_pricebook(&effective)?;
    let mut models = configured_models(&values);
    for model in &mut models {
        model.rates = prices
            .models
            .get(&model.model_key)
            .cloned()
            .unwrap_or_default();
    }
    Ok(Json(
        json!({"revision":revision,"config_revision":config_revision,
        "currency":"CNY","source":source,"models":models}),
    ))
}

pub(super) async fn save(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<PriceInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    if !(0..=MAX_SAFE_INTEGER).contains(&input.expected_revision)
        || !(0..=MAX_SAFE_INTEGER).contains(&input.expected_config_revision)
        || input.changes.is_empty()
        || input.changes.len() > 4
    {
        return Err(invalid());
    }
    let (config_revision, values) = state.settings.effective_snapshot().await?;
    if config_revision != input.expected_config_revision {
        return Err(ConfigError::Conflict.into());
    }
    let configured = configured_models(&values);
    if input
        .changes
        .keys()
        .any(|key| !configured.iter().any(|model| &model.model_key == key))
    {
        return Err(AdminError(
            StatusCode::CONFLICT,
            "model_configuration_changed",
            "模型配置已变化，请重新加载单价后再保存",
        ));
    }
    let (revision, effective) = state
        .repository
        .get_usage_pricebook()
        .await
        .map_err(domain_error)?;
    if revision != input.expected_revision {
        return Err(ConfigError::Conflict.into());
    }
    let serialized = merge_prices(&effective, input.changes)?;
    // Config updates and the pricebook have independent CAS revisions. A concurrent provider
    // switch can only leave a price attached to its old opaque key, never to the new deployment.
    if state.settings.revision().await? != config_revision {
        return Err(ConfigError::Conflict.into());
    }
    state
        .repository
        .compare_set_usage_pricebook(revision, &serialized)
        .await
        .map_err(domain_error)?;
    snapshot(&state).await
}

fn merge_prices(effective: &str, changes: BTreeMap<String, UsageRates>) -> Result<String> {
    // Merge the entire effective pricebook, including environment prices for inactive models.
    // The first database save becomes an explicit override, so dropping these would silently
    // remove valid deployment prices as soon as one configured model is edited.
    let mut prices = parse_pricebook(effective)?;
    prices.models.extend(changes);
    prices.version = uuid::Uuid::new_v4().to_string();
    let serialized = serde_json::to_string(&prices).map_err(|_| internal())?;
    validate_pricebook_json(&serialized).map_err(domain_error)?;
    Ok(serialized)
}

fn get<'a>(values: &'a HashMap<String, String>, key: &str) -> &'a str {
    values
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .unwrap_or_default()
}
fn safe_service(base: &str) -> bool {
    url::Url::parse(base).is_ok_and(|url| {
        url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "https"
                || url.scheme() == "http"
                    && url
                        .host_str()
                        .is_some_and(tomorrow_domain::model::private_service_host))
    })
}
fn official_qwen(base: &str) -> bool {
    safe_service(base)
        && url::Url::parse(base).is_ok_and(|url| {
            url.scheme() == "https"
                && url.path().trim_end_matches('/') == "/compatible-mode/v1"
                && url.host_str().is_some_and(|host| {
                    ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].contains(&host)
                        || host.ends_with(".cn-beijing.maas.aliyuncs.com")
                        || host.ends_with(".ap-southeast-1.maas.aliyuncs.com")
                })
        })
}
fn provider_label(base: &str) -> &'static str {
    let host = url::Url::parse(base)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    match host.as_str() {
        "api.deepseek.com" => "DeepSeek",
        "api.openai.com" => "OpenAI",
        "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" => "阿里云百炼",
        "api.moonshot.cn" | "api.moonshot.ai" => "Kimi",
        "open.bigmodel.cn" => "智谱 GLM",
        "api.minimax.cn" | "api.minimaxi.com" => "MiniMax",
        "api.siliconflow.cn" => "硅基流动",
        _ if host.ends_with(".maas.aliyuncs.com") => "阿里云百炼",
        _ => "已配置服务",
    }
}

// Mirror the existing runtime's provider precedence and official-ASR inheritance. No endpoint,
// credential or plaintext settings map is included in the serialized response.
fn configured_models(values: &HashMap<String, String>) -> Vec<ConfiguredModel> {
    let mut models = Vec::<ConfiguredModel>::new();
    let mut add = |base: &str, model: &str, capability: &str| {
        if !safe_service(base) || model.is_empty() {
            return;
        }
        let identity = UsageIdentity::new(base, model, model, provider_label(base));
        if let Some(existing) = models
            .iter_mut()
            .find(|item| item.model_key == identity.model_key)
        {
            if !existing.capabilities.iter().any(|item| item == capability) {
                existing.capabilities.push(capability.into());
            }
        } else {
            models.push(ConfiguredModel {
                model_key: identity.model_key,
                model: identity.model,
                model_name: identity.model_name,
                provider: identity.provider,
                capabilities: vec![capability.into()],
                rates: UsageRates::default(),
            });
        }
    };
    let generic = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME"]
        .iter()
        .any(|key| !get(values, key).is_empty());
    let provider = tomorrow_domain::model::LlmProvider::from_lookup(|key| values.get(key).cloned());
    if provider.is_configured() {
        let base = get(
            values,
            if generic {
                "MODEL_BASE_URL"
            } else {
                "DEEPSEEK_BASE_URL"
            },
        );
        let base = if base.is_empty() {
            if generic {
                "https://api.openai.com/v1"
            } else {
                "https://api.deepseek.com"
            }
        } else {
            base
        };
        add(base, provider.model_name().unwrap_or_default(), "llm");
    }
    let asr_base = get(values, "ASR_BASE_URL");
    let asr_model = get(values, "ASR_MODEL");
    if !asr_base.is_empty() && !asr_model.is_empty() {
        add(asr_base, asr_model, "asr");
    }
    for (prefix, capability, fallback) in [
        ("PHOTO_VISION", "vision", "qwen3.7-flash"),
        ("PHOTO_EMBEDDING", "embedding", "text-embedding-v4"),
    ] {
        if matches!(
            get(values, &format!("{prefix}_ENABLED"))
                .to_ascii_lowercase()
                .as_str(),
            "false" | "0" | "disabled"
        ) {
            continue;
        }
        let mut base = get(values, &format!("{prefix}_BASE_URL"));
        let mut key = get(values, &format!("{prefix}_API_KEY"));
        if base.is_empty() && get(values, "ASR_PROTOCOL") == "qwen_asr" && official_qwen(asr_base) {
            base = asr_base;
            if key.is_empty() {
                key = get(values, "ASR_API_KEY");
            }
        }
        let setting = format!("{prefix}_MODEL");
        let model = get(values, &setting);
        let model = if model.is_empty() { fallback } else { model };
        if !key.is_empty() {
            add(base, model, capability);
        }
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use tomorrow_domain::usage::model_key;
    use tomorrow_settings::ConfigOptions;
    use tower::ServiceExt;

    #[test]
    fn inventories_exact_provider_precedence_and_safe_official_inheritance() {
        let mut values = HashMap::from([
            ("DEEPSEEK_API_KEY".into(), "private-deepseek-key".into()),
            ("MODEL_BASE_URL".into(), "https://other.example/v1".into()),
            ("MODEL_API_KEY".into(), "private-generic-key".into()),
            ("MODEL_NAME".into(), "shared-model".into()),
            (
                "ASR_BASE_URL".into(),
                "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            ),
            ("ASR_MODEL".into(), "qwen3-asr-flash".into()),
            ("ASR_PROTOCOL".into(), "qwen_asr".into()),
            ("ASR_API_KEY".into(), "private-asr-key".into()),
            ("PHOTO_VISION_MODEL".into(), "shared-model".into()),
        ]);
        let models = configured_models(&values);
        assert_eq!(models.len(), 4);
        assert_eq!(
            models[0].model_key,
            model_key("https://other.example/v1", "shared-model")
        );
        assert_ne!(models[0].model_key, models[2].model_key);
        let response = serde_json::to_string(&models).unwrap();
        for forbidden in ["private-", "other.example", "https://", "API_KEY"] {
            assert!(!response.contains(forbidden));
        }
        values.insert(
            "ASR_BASE_URL".into(),
            "https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1".into(),
        );
        assert_eq!(configured_models(&values).len(), 2);
        values.insert("PHOTO_VISION_ENABLED".into(), "false".into());
        values.insert("MODEL_API_KEY".into(), "".into());
        assert!(configured_models(&values)
            .iter()
            .all(|model| !model.capabilities.iter().any(|cap| cap == "llm")));
    }

    #[test]
    fn price_validation_preserves_null_zero_and_rejects_unsafe_values() {
        let key = model_key("https://example.test/v1", "actual-model");
        let mut rates = UsageRates {
            input_cny_micros_per_million: Some(0),
            ..Default::default()
        };
        let book = |rates: &UsageRates| {
            serde_json::to_string(&Pricebook {
                version: "test".into(),
                models: BTreeMap::from([(key.clone(), rates.clone())]),
            })
            .unwrap()
        };
        let parsed = parse_pricebook(&book(&rates)).unwrap();
        assert_eq!(parsed.models[&key].input_cny_micros_per_million, Some(0));
        assert_eq!(parsed.models[&key].output_cny_micros_per_million, None);
        for invalid_rate in [-1, MAX_SAFE_INTEGER + 1] {
            rates.input_cny_micros_per_million = Some(invalid_rate);
            assert!(parse_pricebook(&book(&rates)).is_err());
        }
        assert!(serde_json::from_value::<PriceInput>(
            json!({"expected_revision":0,"expected_config_revision":0,
            "changes":{key:{"input_cny_micros_per_million":0.5}}})
        )
        .is_err());
    }

    #[test]
    fn first_environment_override_preserves_unchanged_and_inactive_model_prices() {
        let active = model_key("https://active.example/v1", "actual-model");
        let unchanged = model_key("https://voice.example/v1", "voice-model");
        let inactive = model_key("https://previous.example/v1", "previous-model");
        let environment = Pricebook {
            version: "deployment-prices".into(),
            models: BTreeMap::from([
                (
                    active.clone(),
                    UsageRates {
                        input_cny_micros_per_million: Some(2_000_000),
                        ..Default::default()
                    },
                ),
                (
                    unchanged.clone(),
                    UsageRates {
                        audio_cny_micros_per_minute: Some(120_000),
                        ..Default::default()
                    },
                ),
                (
                    inactive.clone(),
                    UsageRates {
                        input_cny_micros_per_million: Some(0),
                        ..Default::default()
                    },
                ),
            ]),
        };
        let effective = serde_json::to_string(&environment).unwrap();
        let merged = merge_prices(
            &effective,
            BTreeMap::from([(
                active.clone(),
                UsageRates {
                    input_cny_micros_per_million: None,
                    output_cny_micros_per_million: Some(0),
                    ..Default::default()
                },
            )]),
        )
        .unwrap();
        let stored = parse_pricebook(&merged).unwrap();
        assert_ne!(stored.version, environment.version);
        assert_eq!(stored.models.len(), 3);
        assert_eq!(stored.models[&unchanged], environment.models[&unchanged]);
        assert_eq!(stored.models[&inactive], environment.models[&inactive]);
        assert_eq!(stored.models[&active].input_cny_micros_per_million, None);
        assert_eq!(
            stored.models[&active].output_cny_micros_per_million,
            Some(0)
        );
    }

    #[tokio::test]
    async fn pricing_is_owner_only_csrf_protected_and_compare_and_set_without_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let repository = Repository::connect(&format!(
            "sqlite:{}",
            directory
                .path()
                .join("pricing.db")
                .to_string_lossy()
                .replace('\\', "/")
        ))
        .await
        .unwrap();
        let settings = ConfigStore::with_options(
            repository.pool(),
            ConfigOptions {
                environment: HashMap::from([
                    (
                        "MODEL_BASE_URL".into(),
                        "https://private-deployment.example/v1".into(),
                    ),
                    ("MODEL_NAME".into(), "actual-model".into()),
                    ("MODEL_API_KEY".into(), "private-price-test-key".into()),
                ]),
                config_dir: directory.path().join("config"),
                master_key: None,
            },
        )
        .await
        .unwrap();
        let state = AdminState::new(repository, settings).await.unwrap();
        let owner = state
            .repository
            .create_phone_user("13800138888", "Pricing owner", "Asia/Shanghai")
            .await
            .unwrap();
        let token = auth::generate_token();
        let cookie = format!("{COOKIE}={token}");
        let csrf_token = csrf(&token);
        sqlx::query("INSERT INTO admin_roles(user_id,role,created_at) VALUES($1,'owner',$2)")
            .bind(&owner.id)
            .bind(now())
            .execute(&state.repository.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)")
            .bind(auth::hash_token(&token)).bind(&owner.id).bind(now()+3600).bind(now())
            .execute(&state.repository.pool()).await.unwrap();
        async fn call(
            state: &AdminState,
            cookie: Option<&str>,
            csrf: Option<&str>,
            body: Option<Value>,
        ) -> (StatusCode, Value) {
            let mut builder = axum::http::Request::builder()
                .uri("/admin/api/usage-pricing")
                .method(if body.is_some() {
                    Method::PATCH
                } else {
                    Method::GET
                })
                .header(header::HOST, "unit.test")
                .header(header::ORIGIN, "https://unit.test");
            if let Some(cookie) = cookie {
                builder = builder.header(header::COOKIE, cookie);
            }
            if let Some(csrf) = csrf {
                builder = builder.header("x-csrf-token", csrf);
            }
            let request = builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(
                    body.map(|value| Body::from(serde_json::to_vec(&value).unwrap()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap();
            let response = router(state.clone()).oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
            (
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            )
        }
        assert_eq!(
            call(&state, None, None, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        let (status, first) = call(&state, Some(&cookie), None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(matches!(
            first["source"].as_str(),
            Some("unconfigured") | Some("environment")
        ));
        let exposed = first.to_string();
        assert!(!exposed.contains("private-price-test-key"));
        assert!(!exposed.contains("private-deployment.example"));
        assert_eq!(
            first["models"][0]["rates"]["input_cny_micros_per_million"],
            Value::Null
        );
        let key = first["models"][0]["model_key"].as_str().unwrap();
        let input = json!({"expected_revision":first["revision"],"expected_config_revision":first["config_revision"],
            "changes":{key:{"input_cny_micros_per_million":0,"output_cny_micros_per_million":1200000}}});
        assert_eq!(
            call(&state, Some(&cookie), None, Some(input.clone()))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, saved) = call(
            &state,
            Some(&cookie),
            Some(&csrf_token),
            Some(input.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        assert_eq!(saved["source"], "database");
        assert_eq!(saved["revision"], first["revision"].as_i64().unwrap() + 1);
        assert_eq!(
            saved["models"][0]["rates"]["input_cny_micros_per_million"],
            0
        );
        assert_eq!(
            saved["models"][0]["rates"]["cache_read_cny_micros_per_million"],
            Value::Null
        );
        assert_eq!(
            call(&state, Some(&cookie), Some(&csrf_token), Some(input))
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut invalid = json!({"expected_revision":saved["revision"],"expected_config_revision":saved["config_revision"],
            "changes":{key:{"input_cny_micros_per_million":-1}}});
        assert_eq!(
            call(
                &state,
                Some(&cookie),
                Some(&csrf_token),
                Some(invalid.clone())
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        invalid["changes"][key]["input_cny_micros_per_million"] = json!(MAX_SAFE_INTEGER + 1);
        assert_eq!(
            call(
                &state,
                Some(&cookie),
                Some(&csrf_token),
                Some(invalid.clone())
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        invalid["changes"][key]["input_cny_micros_per_million"] = json!(1);
        invalid["expected_config_revision"] = json!(saved["config_revision"].as_i64().unwrap() + 1);
        assert_eq!(
            call(&state, Some(&cookie), Some(&csrf_token), Some(invalid))
                .await
                .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            state.settings.effective_values().await.unwrap()["MODEL_API_KEY"],
            "private-price-test-key"
        );
        let (revision, persisted) = state.repository.get_usage_pricebook().await.unwrap();
        assert_eq!(revision, saved["revision"].as_i64().unwrap());
        assert_eq!(
            parse_pricebook(&persisted).unwrap().models[key].input_cny_micros_per_million,
            Some(0)
        );
        sqlx::query("UPDATE admin_roles SET role='admin' WHERE user_id=$1")
            .bind(&owner.id)
            .execute(&state.repository.pool())
            .await
            .unwrap();
        assert_eq!(
            call(&state, Some(&cookie), None, None).await.0,
            StatusCode::FORBIDDEN
        );
    }
}
