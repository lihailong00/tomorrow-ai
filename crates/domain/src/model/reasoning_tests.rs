use super::*;

fn provider(base: &str, model: &str) -> LlmProvider {
    LlmProvider {
        client: None,
        base_url: base.into(),
        api_key: None,
        model: Some(model.into()),
        remote_intent: true,
        kind: ProviderKind::Compatible,
        usage: None,
    }
}

#[test]
fn reasoning_fields_match_deepseek_wire_contract_on_both_direct_transports() {
    for model in ["deepseek-flash", "deepseek-v4-pro"] {
        for base in ["https://api.deepseek.com", "https://api.deepseek.com/v1"] {
            for effort in [
                ReasoningEffort::Off,
                ReasoningEffort::Low,
                ReasoningEffort::High,
                ReasoningEffort::Max,
            ] {
                let (thinking, reasoning_effort, max_tokens) = provider(base, model)
                    .reasoning_fields(Some(effort))
                    .unwrap();
                for stream in [false, true] {
                    let body = serde_json::to_value(CompletionRequest {
                        stream_options: None,
                        model,
                        messages: vec![],
                        stream,
                        thinking: thinking.clone(),
                        reasoning_effort,
                        max_tokens,
                    })
                    .unwrap();
                    assert_eq!(
                        body["thinking"]["type"],
                        if effort.is_off() {
                            "disabled"
                        } else {
                            "enabled"
                        }
                    );
                    assert_eq!(body["reasoning_effort"].as_str(), effort.provider_value());
                    assert_eq!(body["max_tokens"], effort.max_tokens());
                    assert_eq!(body["stream"], stream);
                }
            }
        }
    }
}

#[test]
fn unrelated_models_preserve_legacy_calls_and_do_not_silently_ignore_explicit_thinking() {
    for (base, model) in [
        ("https://api.openai.com/v1", "fixture"),
        ("https://api.deepseek.com.evil.test", "deepseek-flash"),
        ("https://api.deepseek.com/unverified", "deepseek-flash"),
        ("https://api.deepseek.com", "unverified"),
    ] {
        let model = provider(base, model);
        assert_eq!(model.reasoning_fields(None).unwrap(), (None, None, None));
        assert_eq!(
            model.reasoning_fields(Some(ReasoningEffort::Off)).unwrap(),
            (None, None, None)
        );
        assert!(model.reasoning_fields(Some(ReasoningEffort::Max)).is_err());
    }
    assert!(serde_json::from_str::<ReasoningEffort>(r#""auto""#).is_err());
    assert_eq!(ReasoningEffort::default(), ReasoningEffort::Off);
}
