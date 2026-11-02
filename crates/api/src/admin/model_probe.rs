use super::*;
use tomorrow_domain::model::LlmProvider;

pub(super) async fn test_model(
    State(state): State<AdminState>,
    session: AdminSession,
    Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    let keys = ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_API_KEY"];
    if input.changes.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(invalid());
    }
    let _permit = state.model_probe_jobs.clone().try_acquire_owned().map_err(|_| busy())?;
    rate_limit(&state, &format!("provider-probe:{}", session.user_id), 5).await?;
    let (revision, saved) = state.settings.effective_snapshot().await?;
    if revision != input.expected_revision { return Err(ConfigError::Conflict.into()); }
    let values = state.settings.preview_effective_values(input.expected_revision, &input.changes).await?;
    protect_saved_key(&saved, &values, &input.changes)?;
    let provider = LlmProvider::from_lookup(|name| values.get(name).cloned())
        .with_usage(tomorrow_domain::model::UsageContext::new(state.repository.clone(), &session.user_id, "other", format!("probe-model:{}", tomorrow_domain::new_id())));
    let result = provider.probe_connection().await;
    Ok(Json(serde_json::to_value(result).map_err(|_| internal())?))
}

pub(super) async fn test_speech(
    State(state): State<AdminState>, session: AdminSession, Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    require_owner(&session)?;
    let keys = ["ASR_BASE_URL", "ASR_MODEL", "ASR_API_KEY", "ASR_PROTOCOL", "ASR_USER_DAILY_LIMIT", "ASR_GLOBAL_DAILY_LIMIT"];
    if input.changes.keys().any(|key| !keys.contains(&key.as_str())) { return Err(invalid()); }
    let _permit = state.model_probe_jobs.clone().try_acquire_owned().map_err(|_| busy())?;
    rate_limit(&state, &format!("provider-probe:{}", session.user_id), 5).await?;
    let (revision, saved) = state.settings.effective_snapshot().await?;
    if revision != input.expected_revision { return Err(ConfigError::Conflict.into()); }
    let values = state.settings.preview_effective_values(input.expected_revision, &input.changes).await?;
    protect_key_scope(&saved, &values, &input.changes, "ASR_BASE_URL", "ASR_API_KEY", "")?;
    let result = tomorrow_attachments::asr_probe::probe_with_usage(|name| values.get(name).cloned(), &state.repository, &session.user_id).await;
    Ok(Json(serde_json::to_value(result).map_err(|_| internal())?))
}

pub(super) async fn test_vision(
    State(state): State<AdminState>, session: AdminSession, Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    test_auxiliary(state, session, input, true).await
}

pub(super) async fn test_embedding(
    State(state): State<AdminState>, session: AdminSession, Json(input): Json<ConfigInput>,
) -> Result<Json<Value>> {
    test_auxiliary(state, session, input, false).await
}

async fn test_auxiliary(state: AdminState, session: AdminSession, input: ConfigInput, vision: bool) -> Result<Json<Value>> {
    require_owner(&session)?;
    let prefix = if vision { "PHOTO_VISION" } else { "PHOTO_EMBEDDING" };
    let base = format!("{prefix}_BASE_URL");
    let key = format!("{prefix}_API_KEY");
    let keys = [base.clone(), key.clone(), format!("{prefix}_MODEL"), format!("{prefix}_ENABLED"),
        "ASR_BASE_URL".into(), "ASR_API_KEY".into(), "ASR_PROTOCOL".into()];
    if input.changes.keys().any(|key| !keys.contains(key)) { return Err(invalid()); }
    let _permit = state.model_probe_jobs.clone().try_acquire_owned().map_err(|_| busy())?;
    rate_limit(&state, &format!("provider-probe:{}", session.user_id), 5).await?;
    let (revision, saved) = state.settings.effective_snapshot().await?;
    if revision != input.expected_revision { return Err(ConfigError::Conflict.into()); }
    let values = state.settings.preview_effective_values(input.expected_revision, &input.changes).await?;
    protect_key_scope(&saved, &values, &input.changes, &base, &key, "")?;
    if values.get(&base).is_none_or(|base| base.trim().is_empty()) {
        protect_key_scope(&saved, &values, &input.changes, "ASR_BASE_URL", "ASR_API_KEY", "")?;
    }
    let get = |name: &str| values.get(name).cloned();
    let result = if vision { tomorrow_attachments::service_probe::vision_with_usage(get, &state.repository, &session.user_id).await }
        else { tomorrow_attachments::service_probe::embedding_with_usage(get, &state.repository, &session.user_id).await };
    Ok(Json(serde_json::to_value(result).map_err(|_| internal())?))
}

fn protect_saved_key(
    saved: &HashMap<String, String>, draft: &HashMap<String, String>, changes: &HashMap<String, Option<String>>,
) -> Result<()> {
    let generic = ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"].iter()
        .any(|key| draft.get(*key).is_some_and(|value| !value.trim().is_empty()));
    let (base, key, fallback) = if generic {
        ("MODEL_BASE_URL", "MODEL_API_KEY", "https://api.openai.com/v1")
    } else { ("DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY", "https://api.deepseek.com") };
    protect_key_scope(saved, draft, changes, base, key, fallback)
}

fn protect_key_scope(
    saved: &HashMap<String, String>, draft: &HashMap<String, String>, changes: &HashMap<String, Option<String>>,
    base: &str, key: &str, fallback: &str,
) -> Result<()> {
    let explicit_key = changes.get(key).and_then(|value| value.as_deref()).is_some_and(|value| !value.trim().is_empty());
    let scope = |values: &HashMap<String, String>| {
        let address = values.get(base).map(String::as_str).filter(|value| !value.trim().is_empty()).unwrap_or(fallback);
        url::Url::parse(address).ok().map(|mut url| {
            let path = url.path().trim_end_matches('/').trim_end_matches("/chat/completions").to_owned();
            url.set_path(&path); url
        })
    };
    if !explicit_key && draft.get(key).is_some_and(|value| !value.is_empty()) && scope(saved) != scope(draft) {
        return Err(AdminError(StatusCode::BAD_REQUEST, "new_provider_key_required", "服务地址已改变，请填写该服务商的 API Key 后测试。"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draft_endpoint_change_cannot_forward_the_saved_key_to_another_provider() {
        let saved = HashMap::from([
            ("MODEL_BASE_URL".into(), "https://original.example/v1".into()),
            ("MODEL_API_KEY".into(), "private-original-key".into()), ("MODEL_NAME".into(), "model".into()),
        ]);
        let mut draft = saved.clone();
        draft.insert("MODEL_BASE_URL".into(), "https://new.example/v1".into());
        assert!(protect_saved_key(&saved, &draft, &HashMap::new()).is_err());
        let changes = HashMap::from([("MODEL_API_KEY".into(), Some("explicit-new-key".into()))]);
        draft.insert("MODEL_API_KEY".into(), "explicit-new-key".into());
        assert!(protect_saved_key(&saved, &draft, &changes).is_ok());
    }
    #[test]
    fn same_endpoint_and_specific_deepseek_key_remain_usable() {
        let values = HashMap::from([("DEEPSEEK_API_KEY".into(), "private-key".into())]);
        let draft = HashMap::from([
            ("DEEPSEEK_API_KEY".into(), "private-key".into()),
            ("DEEPSEEK_BASE_URL".into(), "https://api.deepseek.com/".into()),
        ]);
        assert!(protect_saved_key(&values, &draft, &HashMap::new()).is_ok());
    }
}
