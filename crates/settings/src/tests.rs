use super::*;
use sqlx::any::AnyPoolOptions;

struct Fixture {
    dir: tempfile::TempDir,
    pool: AnyPool,
}

impl Fixture {
    async fn new() -> Self {
        sqlx::any::install_default_drivers();
        Self {
            dir: tempfile::tempdir().unwrap(),
            pool: AnyPoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
        }
    }
    fn options(&self, pairs: &[(&str, &str)]) -> ConfigOptions {
        ConfigOptions {
            config_dir: self.dir.path().join("config"),
            master_key: None,
            environment: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }
    async fn store(&self) -> ConfigStore {
        ConfigStore::with_options(self.pool.clone(), self.options(&[]))
            .await
            .unwrap()
    }
}

fn changes(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.map(str::to_owned)))
        .collect()
}

#[tokio::test]
async fn first_boot_is_private_with_stable_identity_and_managed_keys() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let metadata = store.instance_metadata().await.unwrap();
    assert!(uuid::Uuid::parse_str(&metadata.instance_id).is_ok());
    assert_eq!(metadata.mode, "self_hosted");
    assert_eq!(metadata.registration_policy, "closed");
    assert!(metadata.auth.email_password);
    assert!(!metadata.auth.phone_password);
    assert_eq!(metadata.configuration_revision, 0);
    assert!(metadata.public_url.is_none());
    let effective = store.effective_values().await.unwrap();
    assert_eq!(effective["CONNECTOR_ENCRYPTION_KEY"].len(), 64);
    assert_eq!(effective["SMS_CODE_HASH_KEY"].len(), 64);
    assert!(!effective.contains_key("MODEL_API_KEY"));
    let reloaded = fixture.store().await;
    assert_eq!(reloaded.instance_id(), store.instance_id());
    assert_eq!(
        reloaded.effective_values().await.unwrap()["CONNECTOR_ENCRYPTION_KEY"],
        effective["CONNECTOR_ENCRYPTION_KEY"]
    );
    assert_eq!(
        fs::read_to_string(store.config_dir().join("master.key"))
            .unwrap()
            .len(),
        64
    );
}

#[tokio::test]
async fn official_defaults_and_explicit_policy_are_respected() {
    let fixture = Fixture::new().await;
    let store = ConfigStore::with_options(
        fixture.pool.clone(),
        fixture.options(&[("INSTANCE_MODE", "official")]),
    )
    .await
    .unwrap();
    let metadata = store.instance_metadata().await.unwrap();
    assert_eq!(metadata.mode, "official");
    assert_eq!(metadata.registration_policy, "open");
    assert!(metadata.auth.phone_password);
    store
        .update(0, changes(&[("REGISTRATION_POLICY", Some("invite_only"))]))
        .await
        .unwrap();
    assert_eq!(
        store.instance_metadata().await.unwrap().registration_policy,
        "invite_only"
    );
}

#[tokio::test]
async fn environment_policy_whitespace_is_normalized_and_unsafe_urls_fail_before_publication() {
    let fixture = Fixture::new().await;
    let store = ConfigStore::with_options(
        fixture.pool.clone(),
        fixture.options(&[
            ("REGISTRATION_POLICY", " closed "),
            ("EMAIL_PASSWORD_ENABLED", " true "),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(
        store.effective_values().await.unwrap()["REGISTRATION_POLICY"],
        "closed"
    );
    assert!(store.instance_metadata().await.unwrap().auth.email_password);
    for key in ["MODEL_BASE_URL", "ASR_BASE_URL", "INSTANCE_PUBLIC_URL"] {
        let options = fixture.options(&[(key, "https://user:fixture-url-secret@example.test/v1")]);
        assert!(matches!(
            ConfigStore::with_options(fixture.pool.clone(), options).await,
            Err(ConfigError::Validation)
        ));
    }
}

#[tokio::test]
async fn secrets_are_encrypted_bound_to_name_and_never_returned_in_metadata() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let secret = "fixture-super-secret-never-reflected";
    let snapshot = store
        .update(
            0,
            changes(&[
                ("MODEL_API_KEY", Some(secret)),
                ("INSTANCE_NAME", Some("我的妥啦")),
            ]),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.revision, 1);
    let raw = serde_json::to_string(&snapshot).unwrap();
    assert!(!raw.contains(secret));
    assert!(
        !serde_json::to_string(&store.instance_metadata().await.unwrap())
            .unwrap()
            .contains(secret)
    );
    let field = snapshot
        .settings
        .iter()
        .find(|v| v.key == "MODEL_API_KEY")
        .unwrap();
    assert!(field.secret && field.configured);
    assert!(field.value.is_none());
    let ciphertext: String = sqlx::query_scalar(
        "SELECT ciphertext FROM instance_config_values WHERE name='MODEL_API_KEY'",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert!(ciphertext.starts_with("v1:"));
    assert!(!ciphertext.contains(secret));
    assert_eq!(
        store.effective_values().await.unwrap()["MODEL_API_KEY"],
        secret
    );
    sqlx::query("INSERT INTO instance_config_values(name,ciphertext)VALUES('ASR_API_KEY',$1)")
        .bind(ciphertext)
        .execute(&fixture.pool)
        .await
        .unwrap();
    assert!(matches!(
        store.effective_values().await,
        Err(ConfigError::Crypto)
    ));
}

#[tokio::test]
async fn environment_overrides_are_masked_and_locked_without_leaking_arbitrary_env() {
    let fixture = Fixture::new().await;
    let env = [
        ("MODEL_API_KEY", "fixture-env-secret"),
        ("MODEL_NAME", "configured-model"),
        ("UNRELATED_PASSWORD", "not-retained"),
        ("APP_ENV", "production"),
    ];
    let store = ConfigStore::with_options(fixture.pool.clone(), fixture.options(&env))
        .await
        .unwrap();
    let field = store
        .snapshot()
        .await
        .unwrap()
        .settings
        .into_iter()
        .find(|v| v.key == "MODEL_API_KEY")
        .unwrap();
    assert!(field.value.is_none() && field.configured && field.locked);
    assert_eq!(field.source, "environment");
    assert!(matches!(
        store.update(0, changes(&[("MODEL_API_KEY", None)])).await,
        Err(ConfigError::Locked)
    ));
    let effective = store.effective_values().await.unwrap();
    assert_eq!(effective["MODEL_API_KEY"], "fixture-env-secret");
    assert_eq!(effective["APP_ENV"], "production");
    assert!(!effective.contains_key("UNRELATED_PASSWORD"));
    assert!(
        !store
            .configured_environment_keys()
            .contains(&"APP_ENV".to_string())
    );
    assert_eq!(store.revision().await.unwrap(), 0);
}

#[tokio::test]
async fn optimistic_update_is_atomic_and_only_one_competing_revision_wins() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let first = store.update(
        0,
        changes(&[
            ("INSTANCE_NAME", Some("first")),
            ("MODEL_NAME", Some("first-model")),
        ]),
    );
    let second = store.update(
        0,
        changes(&[
            ("INSTANCE_NAME", Some("second")),
            ("MODEL_NAME", Some("second-model")),
        ]),
    );
    let (first, second) = tokio::join!(first, second);
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(
        matches!(first, Err(ConfigError::Conflict)) || matches!(second, Err(ConfigError::Conflict))
    );
    let effective = store.effective_values().await.unwrap();
    assert_eq!(
        format!("{}-model", effective["INSTANCE_NAME"]),
        effective["MODEL_NAME"]
    );
    assert_eq!(store.revision().await.unwrap(), 1);
    let before = effective["INSTANCE_NAME"].clone();
    assert!(matches!(
        store
            .update(
                1,
                changes(&[
                    ("INSTANCE_NAME", Some("should-not-save")),
                    ("UNKNOWN", Some("x"))
                ])
            )
            .await,
        Err(ConfigError::Validation)
    ));
    assert_eq!(
        store.effective_values().await.unwrap()["INSTANCE_NAME"],
        before
    );
    assert_eq!(store.revision().await.unwrap(), 1);
}

#[tokio::test]
async fn missing_master_file_fails_closed_and_does_not_generate_replacement() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    store
        .update(0, changes(&[("MODEL_API_KEY", Some("fixture-secret"))]))
        .await
        .unwrap();
    let path = store.config_dir().join("master.key");
    fs::remove_file(&path).unwrap();
    assert!(matches!(
        ConfigStore::with_options(fixture.pool.clone(), fixture.options(&[])).await,
        Err(ConfigError::KeyMissing)
    ));
    assert!(!path.exists());
    assert_eq!(
        store.effective_values().await.unwrap()["MODEL_API_KEY"],
        "fixture-secret"
    );
}

#[tokio::test]
async fn missing_master_with_empty_value_table_still_fails_due_to_key_check() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    sqlx::query("DELETE FROM instance_config_values")
        .execute(&fixture.pool)
        .await
        .unwrap();
    fs::remove_file(store.config_dir().join("master.key")).unwrap();
    assert!(matches!(
        ConfigStore::with_options(fixture.pool.clone(), fixture.options(&[])).await,
        Err(ConfigError::KeyMissing)
    ));
}

#[tokio::test]
async fn wrong_master_is_rejected_and_explicit_master_needs_no_disk_copy() {
    let fixture = Fixture::new().await;
    let original = "34".repeat(32);
    let mut options = fixture.options(&[]);
    options.master_key = Some(original.clone());
    let store = ConfigStore::with_options(fixture.pool.clone(), options)
        .await
        .unwrap();
    assert!(!store.config_dir().join("master.key").exists());
    let mut bad = fixture.options(&[]);
    bad.master_key = Some("56".repeat(32));
    assert!(matches!(
        ConfigStore::with_options(fixture.pool.clone(), bad).await,
        Err(ConfigError::Crypto)
    ));
    let mut restored = fixture.options(&[]);
    restored.master_key = Some(original);
    assert!(
        ConfigStore::with_options(fixture.pool.clone(), restored)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn trusted_env_migration_survives_environment_removal_and_masks_result() {
    let fixture = Fixture::new().await;
    let env = [
        ("MODEL_API_KEY", "fixture-migrated-secret"),
        (
            "CONNECTOR_ENCRYPTION_KEY",
            "1234567890123456789012345678901234567890123456789012345678901234",
        ),
    ];
    let store = ConfigStore::with_options(fixture.pool.clone(), fixture.options(&env))
        .await
        .unwrap();
    let snapshot = store.import_environment(0).await.unwrap();
    assert_eq!(snapshot.revision, 1);
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("fixture-migrated-secret")
    );
    let without_env = fixture.store().await;
    let effective = without_env.effective_values().await.unwrap();
    assert_eq!(effective["MODEL_API_KEY"], "fixture-migrated-secret");
    assert_eq!(effective["CONNECTOR_ENCRYPTION_KEY"], env[1].1);
    let field = without_env
        .snapshot()
        .await
        .unwrap()
        .settings
        .into_iter()
        .find(|x| x.key == "MODEL_API_KEY")
        .unwrap();
    assert!(!field.locked && field.configured && field.value.is_none());
}

#[tokio::test]
async fn preview_and_validation_never_write_but_enforce_revision_and_locks() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let proposal = changes(&[
        ("MODEL_API_KEY", Some("fixture-proposed-key")),
        ("INSTANCE_NAME", Some("预览")),
    ]);
    store.validate_update(0, &proposal).await.unwrap();
    let preview = store.preview(0, &proposal).await.unwrap();
    assert_eq!(preview.revision, 0);
    assert!(
        preview
            .settings
            .iter()
            .find(|x| x.key == "MODEL_API_KEY")
            .unwrap()
            .configured
    );
    assert!(
        !serde_json::to_string(&preview)
            .unwrap()
            .contains("fixture-proposed-key")
    );
    assert!(
        !store
            .effective_values()
            .await
            .unwrap()
            .contains_key("MODEL_API_KEY")
    );
    assert_eq!(store.instance_metadata().await.unwrap().name, "妥啦");
    assert!(matches!(
        store.validate_update(1, &proposal).await,
        Err(ConfigError::Conflict)
    ));
    assert!(matches!(
        store.validate_changes(&changes(&[("CONNECTOR_ENCRYPTION_KEY", None)])),
        Err(ConfigError::Locked)
    ));
}

#[tokio::test]
async fn deletion_restores_default_and_empty_explicitly_clears_optional_value() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    store
        .update(
            0,
            changes(&[
                ("INSTANCE_NAME", Some("custom")),
                ("ASR_API_KEY", Some("fixture-asr")),
            ]),
        )
        .await
        .unwrap();
    store
        .update(
            1,
            changes(&[("INSTANCE_NAME", None), ("ASR_API_KEY", Some(""))]),
        )
        .await
        .unwrap();
    assert_eq!(store.instance_metadata().await.unwrap().name, "妥啦");
    let field = store
        .snapshot()
        .await
        .unwrap()
        .settings
        .into_iter()
        .find(|x| x.key == "ASR_API_KEY")
        .unwrap();
    assert_eq!(field.source, "stored");
    assert!(!field.configured && field.value.is_none());
    assert!(matches!(
        store
            .update(2, changes(&[("INSTANCE_NAME", Some(""))]))
            .await,
        Err(ConfigError::Validation)
    ));
}

#[test]
fn validators_bound_inputs_and_disallow_credentials_in_urls() {
    for (key, value) in [
        ("MODEL_BASE_URL", "https://user:password@example.test/v1"),
        ("MODEL_BASE_URL", "https://example.test/v1?api_key=secret"),
        ("INSTANCE_PUBLIC_URL", "https://example.test/nested"),
        ("ASR_BASE_URL", "file:///tmp/token"),
        ("MODEL_BASE_URL", "http://public-model.example.test/v1"),
        ("MODEL_BASE_URL", "http://169.254.169.254/latest"),
        ("REGISTRATION_POLICY", "surprise"),
        ("PHONE_PASSWORD_ENABLED", "yes"),
        ("PHONE_AUTH_MODE", "local_test"),
        ("AGENT_MAX_WEB_SEARCHES", "9"),
        ("SMS_DAILY_LIMIT", "0"),
        ("MODEL_API_KEY", "secret\nheader"),
    ] {
        assert!(validate(key, value).is_err(), "{key}");
    }
    assert!(validate("MODEL_BASE_URL", "http://ollama:11434/v1").is_ok());
    assert!(validate("MODEL_BASE_URL", "http://host.docker.internal:11434/v1").is_ok());
    assert!(validate("MODEL_BASE_URL", "http://192.168.1.10:8080/v1").is_ok());
    assert!(validate("MODEL_BASE_URL", "http://[::1]:11434/v1").is_ok());
    assert!(validate("INSTANCE_PUBLIC_URL", "https://example.test/").is_ok());
    assert!(validate("MODEL_API_KEY", &"x".repeat(8193)).is_err());
    assert!(validate("INSTANCE_NAME", &"名".repeat(81)).is_err());
}

#[tokio::test]
async fn readiness_distinguishes_missing_disabled_and_unverified_complete_groups() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let readiness = store.readiness().await.unwrap();
    assert_eq!(readiness.revision, 0);
    assert!(readiness.groups.iter().all(|g| !g.verified));
    assert_eq!(
        readiness
            .groups
            .iter()
            .find(|g| g.id == "model")
            .unwrap()
            .status,
        "not_configured"
    );
    assert_eq!(
        readiness
            .groups
            .iter()
            .find(|g| g.id == "vision")
            .unwrap()
            .status,
        "disabled"
    );
    assert_eq!(
        readiness
            .groups
            .iter()
            .find(|g| g.id == "sms")
            .unwrap()
            .status,
        "disabled"
    );
    store
        .update(
            0,
            changes(&[("DEEPSEEK_API_KEY", Some("fixture-ready-key"))]),
        )
        .await
        .unwrap();
    let readiness = store.readiness().await.unwrap();
    let group = readiness.groups.iter().find(|g| g.id == "model").unwrap();
    assert_eq!(group.status, "configured");
    assert!(group.missing.is_empty());
    assert!(!group.verified);
    assert!(
        !serde_json::to_string(&readiness)
            .unwrap()
            .contains("fixture-ready-key")
    );
}

#[tokio::test]
async fn incomplete_drafts_are_visible_and_never_borrow_another_models_key() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    store
        .update(
            0,
            changes(&[("DEEPSEEK_API_KEY", Some("fixture-existing-key"))]),
        )
        .await
        .unwrap();
    let proposal = changes(&[
        ("MODEL_NAME", Some("a-different-provider")),
        ("ASR_BASE_URL", Some("https://asr.example.test/v1")),
    ]);
    let readiness = store.preview_readiness(1, &proposal).await.unwrap();
    let model = readiness.groups.iter().find(|g| g.id == "model").unwrap();
    assert_eq!(model.status, "incomplete");
    assert_eq!(model.missing, vec!["MODEL_API_KEY"]);
    let speech = readiness.groups.iter().find(|g| g.id == "speech").unwrap();
    assert_eq!(speech.status, "incomplete");
    assert_eq!(speech.missing, vec!["ASR_MODEL"]);
    assert!(
        !store
            .effective_values()
            .await
            .unwrap()
            .contains_key("MODEL_NAME")
    );
    store.update(1, proposal).await.unwrap();
    assert_eq!(store.readiness().await.unwrap().revision, 2);
    assert_eq!(
        store
            .readiness()
            .await
            .unwrap()
            .groups
            .iter()
            .find(|g| g.id == "model")
            .unwrap()
            .status,
        "incomplete"
    );
}

#[tokio::test]
async fn photo_readiness_only_reuses_an_official_asr_origin() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let proposal = changes(&[
        ("PHOTO_VISION_ENABLED", Some("true")),
        ("PHOTO_EMBEDDING_ENABLED", Some("true")),
        ("ASR_PROTOCOL", Some("qwen_asr")),
        (
            "ASR_BASE_URL",
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ),
        ("ASR_API_KEY", Some("fixture-qwen-key")),
    ]);
    let readiness = store.preview_readiness(0, &proposal).await.unwrap();
    for id in ["vision", "embedding"] {
        assert_eq!(
            readiness.groups.iter().find(|g| g.id == id).unwrap().status,
            "configured"
        );
    }
    let mut hostile = proposal.clone();
    hostile.insert(
        "ASR_BASE_URL".into(),
        Some("https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1".into()),
    );
    let readiness = store.preview_readiness(0, &hostile).await.unwrap();
    let vision = readiness.groups.iter().find(|g| g.id == "vision").unwrap();
    assert_eq!(vision.status, "incomplete");
    assert_eq!(
        vision.missing,
        vec!["PHOTO_VISION_BASE_URL", "PHOTO_VISION_API_KEY"]
    );
    assert!(
        !serde_json::to_string(&readiness)
            .unwrap()
            .contains("fixture-qwen-key")
    );
}

#[tokio::test]
async fn effective_snapshot_pairs_values_with_their_committed_revision() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    store
        .update(0, changes(&[("INSTANCE_NAME", Some("revision-one"))]))
        .await
        .unwrap();
    let (revision, values) = store.effective_snapshot().await.unwrap();
    assert_eq!(revision, 1);
    assert_eq!(values["INSTANCE_NAME"], "revision-one");
    assert!(matches!(
        store.preview_readiness(0, &HashMap::new()).await,
        Err(ConfigError::Conflict)
    ));
}

#[tokio::test]
async fn readiness_recognizes_explicit_private_keyless_models_but_never_public_keyless_models() {
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let proposal = changes(&[
        (
            "MODEL_BASE_URL",
            Some("http://host.docker.internal:11434/v1"),
        ),
        ("MODEL_NAME", Some("local-model")),
    ]);
    let readiness = store.preview_readiness(0, &proposal).await.unwrap();
    assert_eq!(
        readiness
            .groups
            .iter()
            .find(|g| g.id == "model")
            .unwrap()
            .status,
        "configured"
    );
    let mut public = proposal;
    public.insert(
        "MODEL_BASE_URL".into(),
        Some("https://public-model.example.test/v1".into()),
    );
    let readiness = store.preview_readiness(0, &public).await.unwrap();
    assert_eq!(
        readiness
            .groups
            .iter()
            .find(|g| g.id == "model")
            .unwrap()
            .missing,
        vec!["MODEL_API_KEY"]
    );
}

#[test]
fn startup_limits_match_pi_caps_and_are_marked_as_requiring_restart() {
    for (key, max) in [
        ("AGENT_MAX_TURNS", 20),
        ("AGENT_MAX_TOOLS", 40),
        ("AGENT_TIMEOUT_MS", 105000),
        ("AGENT_MAX_CONCURRENT", 32),
    ] {
        assert!(validate(key, &max.to_string()).is_ok());
        assert!(validate(key, &(max + 1).to_string()).is_err());
        assert!(definition(key).unwrap().restart_required);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn generated_key_permissions_are_private_and_open_permissions_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new().await;
    let store = fixture.store().await;
    let path = store.config_dir().join("master.key");
    assert_eq!(
        fs::metadata(store.config_dir())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        ConfigStore::with_options(fixture.pool.clone(), fixture.options(&[])).await,
        Err(ConfigError::Crypto)
    ));
}
