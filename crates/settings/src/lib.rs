//! Durable, revisioned server configuration. Secret values never belong in an
//! administration response; only trusted server adapters use `effective_values`.
mod definitions;
mod readiness;

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use serde::Serialize;
use sqlx::{AnyPool, Row};

pub use definitions::{DEFINITIONS, SettingDefinition, definition};
pub use readiness::{ConfigReadiness, GroupReadiness};

pub type Result<T> = std::result::Result<T, ConfigError>;
const CHECK_VALUE: &[u8] = b"tada:instance-config-key:v1";
const MANAGED_KEYS: &[&str] = &["CONNECTOR_ENCRYPTION_KEY", "SMS_CODE_HASH_KEY"];
const CONTEXT_KEYS: &[&str] = &["APP_ENV", "API_BIND", "AGENT_MODE"];

/// Errors are deliberately fixed strings. Database or cryptography diagnostics
/// must not expose a key, ciphertext, connection string, or provider response.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("配置已更新，请刷新后重试")]
    Conflict,
    #[error("该项目由部署配置或系统管理，不能在网页修改")]
    Locked,
    #[error("配置项目或内容无效")]
    Validation,
    #[error("配置解密密钥缺失，请恢复原密钥文件或环境变量")]
    KeyMissing,
    #[error("配置存储暂时不可用")]
    Storage,
    #[error("配置无法解密，请检查是否使用了原始密钥")]
    Crypto,
}

impl From<sqlx::Error> for ConfigError {
    fn from(_: sqlx::Error) -> Self {
        Self::Storage
    }
}

/// No Debug/Serialize: this structure can contain plaintext credentials.
pub struct ConfigOptions {
    pub environment: HashMap<String, String>,
    pub config_dir: PathBuf,
    pub master_key: Option<String>,
}

impl ConfigOptions {
    pub fn from_environment() -> Self {
        let mut environment = std::env::vars()
            .filter(|(key, value)| {
                !value.trim().is_empty()
                    && (definition(key).is_some() || CONTEXT_KEYS.contains(&key.as_str()))
            })
            .collect::<HashMap<_, _>>();
        if let Some(mode) = std::env::var("TADA_INSTANCE_MODE")
            .ok()
            .filter(|s| !s.trim().is_empty())
        {
            environment.entry("INSTANCE_MODE".into()).or_insert(mode);
        }
        let default_dir = if cfg!(unix)
            && environment
                .get("APP_ENV")
                .is_some_and(|v| v == "production")
        {
            PathBuf::from("/var/lib/tomorrow/config")
        } else {
            PathBuf::from("data/config")
        };
        Self {
            config_dir: std::env::var_os("TADA_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or(default_dir),
            master_key: std::env::var("TADA_CONFIG_MASTER_KEY")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            environment,
        }
    }
}

#[derive(Clone)]
pub struct ConfigStore(Arc<Inner>);

// Intentionally does not implement Debug: environment includes secret overrides.
struct Inner {
    pool: AnyPool,
    config_dir: PathBuf,
    instance_id: String,
    cipher: Aes256Gcm,
    environment: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct SettingView {
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub kind: &'static str,
    pub options: &'static [&'static str],
    pub restart_required: bool,
    pub locked: bool,
    /// `environment`, `stored`, `default`, or `managed`.
    pub source: &'static str,
    /// Secret values are always None, even when empty or environment-managed.
    pub value: Option<String>,
    pub configured: bool,
}

#[derive(Clone, Serialize)]
pub struct SettingsSnapshot {
    pub revision: i64,
    pub settings: Vec<SettingView>,
}

#[derive(Clone, Serialize)]
pub struct InstanceMetadata {
    pub instance_id: String,
    pub name: String,
    pub public_url: Option<String>,
    pub mode: String,
    pub registration_policy: String,
    pub auth: InstanceAuth,
    pub configuration_revision: i64,
}

#[derive(Clone, Serialize)]
pub struct InstanceAuth {
    pub email_password: bool,
    pub phone_password: bool,
}

impl ConfigStore {
    pub async fn new(pool: AnyPool) -> Result<Self> {
        Self::with_options(pool, ConfigOptions::from_environment()).await
    }

    pub async fn with_options(pool: AnyPool, mut options: ConfigOptions) -> Result<Self> {
        options.environment.retain(|key, value| {
            !value.trim().is_empty()
                && (definition(key).is_some() || CONTEXT_KEYS.contains(&key.as_str()))
        });
        for value in options.environment.values_mut() {
            *value = value.trim().to_owned();
        }
        for key in [
            "INSTANCE_MODE",
            "REGISTRATION_POLICY",
            "EMAIL_PASSWORD_ENABLED",
            "PHONE_PASSWORD_ENABLED",
        ] {
            if let Some(value) = options.environment.get(key) {
                validate(key, value)?;
            }
        }
        for item in DEFINITIONS.iter().filter(|item| item.kind == "url") {
            if let Some(value) = options.environment.get(item.key) {
                validate(item.key, value)?;
            }
        }
        for sql in [
            "CREATE TABLE IF NOT EXISTS instance_config_meta(id BIGINT PRIMARY KEY,instance_id TEXT NOT NULL,revision BIGINT NOT NULL,key_check TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS instance_config_values(name TEXT PRIMARY KEY,ciphertext TEXT NOT NULL)",
        ] {
            sqlx::query(sql).execute(&pool).await?;
        }
        sqlx::query("INSERT INTO instance_config_meta(id,instance_id,revision,key_check)VALUES(1,$1,0,'')ON CONFLICT(id)DO NOTHING")
            .bind(uuid::Uuid::new_v4().to_string()).execute(&pool).await?;
        let row = sqlx::query("SELECT instance_id,key_check FROM instance_config_meta WHERE id=1")
            .fetch_one(&pool)
            .await?;
        let instance_id: String = row.try_get("instance_id")?;
        let existing_check: String = row.try_get("key_check")?;
        let stored_count: i64 = sqlx::query_scalar("SELECT count(*) FROM instance_config_values")
            .fetch_one(&pool)
            .await?;
        let key = load_key(&options, !existing_check.is_empty() || stored_count > 0)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| ConfigError::Crypto)?;
        let store = Self(Arc::new(Inner {
            pool,
            config_dir: options.config_dir,
            instance_id,
            cipher,
            environment: options.environment,
        }));
        if existing_check.is_empty() {
            let check = store.encrypt("__key_check", CHECK_VALUE)?;
            sqlx::query("UPDATE instance_config_meta SET key_check=$1 WHERE id=1 AND key_check=''")
                .bind(check)
                .execute(store.pool())
                .await?;
        }
        let check: String =
            sqlx::query_scalar("SELECT key_check FROM instance_config_meta WHERE id=1")
                .fetch_one(store.pool())
                .await?;
        if store.decrypt("__key_check", &check)? != CHECK_VALUE {
            return Err(ConfigError::Crypto);
        }
        // Keys generated here are only for server-internal protection and are
        // immutable through the web editor. Legacy values can be imported by a
        // trusted one-time migration before opening the service to traffic.
        for name in MANAGED_KEYS {
            if store.0.environment.contains_key(*name) {
                continue;
            }
            let random = random_hex();
            let ciphertext = store.encrypt(name, random.as_bytes())?;
            sqlx::query("INSERT INTO instance_config_values(name,ciphertext)VALUES($1,$2)ON CONFLICT(name)DO NOTHING")
                .bind(*name).bind(ciphertext).execute(store.pool()).await?;
        }
        // Fail closed at startup if any persisted value cannot be decrypted.
        store.effective_values().await?;
        Ok(store)
    }

    pub fn pool(&self) -> &AnyPool {
        &self.0.pool
    }
    pub fn config_dir(&self) -> &Path {
        &self.0.config_dir
    }
    pub fn instance_id(&self) -> &str {
        &self.0.instance_id
    }

    pub async fn revision(&self) -> Result<i64> {
        Ok(
            sqlx::query_scalar("SELECT revision FROM instance_config_meta WHERE id=1")
                .fetch_one(self.pool())
                .await?,
        )
    }

    async fn read(&self) -> Result<(i64, HashMap<String, String>)> {
        // A single statement gives a consistent revision/value snapshot on both
        // SQLite and PostgreSQL's default READ COMMITTED isolation.
        let rows = sqlx::query("SELECT m.revision,v.name,v.ciphertext FROM instance_config_meta m LEFT JOIN instance_config_values v ON 1=1 WHERE m.id=1 ORDER BY v.name")
            .fetch_all(self.pool()).await?;
        let revision = rows
            .first()
            .ok_or(ConfigError::Storage)?
            .try_get("revision")?;
        let mut values = HashMap::new();
        for row in rows {
            let Some(key) = row.try_get::<Option<String>, _>("name")? else {
                continue;
            };
            if definition(&key).is_none() {
                return Err(ConfigError::Storage);
            }
            let ciphertext: String = row.try_get("ciphertext")?;
            let plaintext = String::from_utf8(self.decrypt(&key, &ciphertext)?)
                .map_err(|_| ConfigError::Crypto)?;
            values.insert(key, plaintext);
        }
        Ok((revision, values))
    }

    fn effective(&self, stored: &HashMap<String, String>) -> HashMap<String, String> {
        let mut values = DEFINITIONS
            .iter()
            .filter(|item| !item.default_value.is_empty())
            .map(|item| (item.key.to_owned(), item.default_value.to_owned()))
            .collect::<HashMap<_, _>>();
        let official = self
            .0
            .environment
            .get("INSTANCE_MODE")
            .or_else(|| stored.get("INSTANCE_MODE"))
            .is_some_and(|v| v == "official");
        if official {
            values.insert("REGISTRATION_POLICY".into(), "open".into());
            values.insert("PHONE_PASSWORD_ENABLED".into(), "true".into());
            values.insert("DEEPSEEK_WEB_ENABLED".into(), "true".into());
        }
        values.extend(stored.iter().map(|(k, v)| (k.clone(), v.clone())));
        values.extend(
            self.0
                .environment
                .iter()
                .map(|(k, v)| (k.clone(), v.clone())),
        );
        values
    }

    /// Trusted server-side only. Never serialize or expose this map over an API.
    pub async fn effective_values(&self) -> Result<HashMap<String, String>> {
        let (_, stored) = self.read().await?;
        Ok(self.effective(&stored))
    }

    /// Revision and plaintext values from the same database statement. Runtime
    /// caches must use this method rather than reading the revision separately.
    pub async fn effective_snapshot(&self) -> Result<(i64, HashMap<String, String>)> {
        let (revision, stored) = self.read().await?;
        Ok((revision, self.effective(&stored)))
    }

    pub async fn readiness(&self) -> Result<ConfigReadiness> {
        let (revision, values) = self.effective_snapshot().await?;
        Ok(readiness::evaluate(revision, &values))
    }

    pub async fn preview_readiness(
        &self,
        expected_revision: i64,
        changes: &HashMap<String, Option<String>>,
    ) -> Result<ConfigReadiness> {
        self.validate_changes(changes)?;
        let (revision, mut stored) = self.read().await?;
        if revision != expected_revision {
            return Err(ConfigError::Conflict);
        }
        for (key, value) in changes {
            match value {
                Some(value) => {
                    stored.insert(key.clone(), value.trim().to_owned());
                }
                None => {
                    stored.remove(key);
                }
            }
        }
        Ok(readiness::evaluate(revision, &self.effective(&stored)))
    }

    pub async fn snapshot(&self) -> Result<SettingsSnapshot> {
        let (revision, stored) = self.read().await?;
        Ok(self.masked_snapshot(revision, &stored))
    }

    fn masked_snapshot(&self, revision: i64, stored: &HashMap<String, String>) -> SettingsSnapshot {
        let values = self.effective(&stored);
        let settings = DEFINITIONS
            .iter()
            .map(|item| {
                let environment = self.0.environment.contains_key(item.key);
                let managed = MANAGED_KEYS.contains(&item.key);
                let value = values.get(item.key).cloned().unwrap_or_default();
                SettingView {
                    key: item.key,
                    group: item.group,
                    label: item.label,
                    secret: item.secret,
                    kind: item.kind,
                    options: item.options,
                    restart_required: item.restart_required,
                    locked: environment || managed,
                    source: if environment {
                        "environment"
                    } else if managed {
                        "managed"
                    } else if stored.contains_key(item.key) {
                        "stored"
                    } else {
                        "default"
                    },
                    configured: !value.is_empty(),
                    value: (!item.secret).then_some(value),
                }
            })
            .collect();
        SettingsSnapshot { revision, settings }
    }

    pub async fn instance_metadata(&self) -> Result<InstanceMetadata> {
        let (configuration_revision, stored) = self.read().await?;
        let values = self.effective(&stored);
        let get = |name: &str| values.get(name).cloned().unwrap_or_default();
        let public_url = get("INSTANCE_PUBLIC_URL");
        Ok(InstanceMetadata {
            instance_id: self.0.instance_id.clone(),
            name: get("INSTANCE_NAME"),
            public_url: (!public_url.is_empty()).then_some(public_url),
            mode: get("INSTANCE_MODE"),
            registration_policy: get("REGISTRATION_POLICY"),
            auth: InstanceAuth {
                email_password: get("EMAIL_PASSWORD_ENABLED") == "true",
                phone_password: get("PHONE_PASSWORD_ENABLED") == "true",
            },
            configuration_revision,
        })
    }

    /// Save all changes atomically against the revision reviewed by the admin.
    /// Missing keys are untouched; `None` removes a stored override. Empty values
    /// are explicit stored blanks (for disabling optional configurations).
    pub async fn update(
        &self,
        expected_revision: i64,
        changes: HashMap<String, Option<String>>,
    ) -> Result<SettingsSnapshot> {
        self.write(expected_revision, changes, false).await?;
        self.snapshot().await
    }

    /// The same non-mutating allowlist, environment lock, and input checks used
    /// by save. This does not contact a model provider or incur API charges.
    pub fn validate_changes(&self, changes: &HashMap<String, Option<String>>) -> Result<()> {
        self.validate_write(changes, false)
    }

    pub async fn validate_update(
        &self,
        expected_revision: i64,
        changes: &HashMap<String, Option<String>>,
    ) -> Result<()> {
        if expected_revision < 0 {
            return Err(ConfigError::Validation);
        }
        self.validate_changes(changes)?;
        if self.revision().await? != expected_revision {
            return Err(ConfigError::Conflict);
        }
        Ok(())
    }

    /// Preview a proposed masked configuration without saving credentials.
    pub async fn preview(
        &self,
        expected_revision: i64,
        changes: &HashMap<String, Option<String>>,
    ) -> Result<SettingsSnapshot> {
        self.validate_changes(changes)?;
        let (revision, mut stored) = self.read().await?;
        if revision != expected_revision {
            return Err(ConfigError::Conflict);
        }
        for (key, value) in changes {
            match value {
                Some(value) => {
                    stored.insert(key.clone(), value.trim().to_owned());
                }
                None => {
                    stored.remove(key);
                }
            }
        }
        Ok(self.masked_snapshot(revision, &stored))
    }

    /// Trusted deployment/CLI migration. Persists explicit legacy values even
    /// while environment overrides remain active; never returns their values.
    pub async fn import_values(
        &self,
        expected_revision: i64,
        values: HashMap<String, String>,
    ) -> Result<SettingsSnapshot> {
        self.write(
            expected_revision,
            values.into_iter().map(|(k, v)| (k, Some(v))).collect(),
            true,
        )
        .await?;
        self.snapshot().await
    }

    /// Controlled server migration helper. This must never be an HTTP route.
    /// A deployment can call it once, verify only the returned masked status,
    /// then remove selected overrides from its private environment file.
    pub async fn import_environment(&self, expected_revision: i64) -> Result<SettingsSnapshot> {
        let values = self
            .0
            .environment
            .iter()
            .filter(|(key, _)| definition(key).is_some())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        self.import_values(expected_revision, values).await
    }

    /// Return only editable configuration environment names, without values.
    pub fn configured_environment_keys(&self) -> Vec<String> {
        let mut keys = self
            .0
            .environment
            .keys()
            .filter(|k| definition(k).is_some())
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    async fn write(
        &self,
        expected_revision: i64,
        changes: HashMap<String, Option<String>>,
        trusted_import: bool,
    ) -> Result<()> {
        if expected_revision < 0 {
            return Err(ConfigError::Validation);
        }
        self.validate_write(&changes, trusted_import)?;
        if changes.is_empty() {
            return if self.revision().await? == expected_revision {
                Ok(())
            } else {
                Err(ConfigError::Conflict)
            };
        }
        let mut tx = self.pool().begin().await?;
        let updated = sqlx::query("UPDATE instance_config_meta SET revision=revision+1 WHERE id=1 AND revision=$1 AND revision<9223372036854775807")
            .bind(expected_revision).execute(&mut *tx).await?.rows_affected();
        if updated != 1 {
            return Err(ConfigError::Conflict);
        }
        for (name, value) in changes {
            if let Some(value) = value {
                let ciphertext = self.encrypt(&name, value.trim().as_bytes())?;
                sqlx::query("INSERT INTO instance_config_values(name,ciphertext)VALUES($1,$2)ON CONFLICT(name)DO UPDATE SET ciphertext=EXCLUDED.ciphertext")
                    .bind(name).bind(ciphertext).execute(&mut *tx).await?;
            } else {
                sqlx::query("DELETE FROM instance_config_values WHERE name=$1")
                    .bind(name)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    fn validate_write(
        &self,
        changes: &HashMap<String, Option<String>>,
        trusted_import: bool,
    ) -> Result<()> {
        if changes.len() > DEFINITIONS.len() {
            return Err(ConfigError::Validation);
        }
        for (name, value) in changes {
            if definition(name).is_none() {
                return Err(ConfigError::Validation);
            }
            if !trusted_import
                && (self.0.environment.contains_key(name) || MANAGED_KEYS.contains(&name.as_str()))
            {
                return Err(ConfigError::Locked);
            }
            if let Some(value) = value {
                validate(name, value)?;
            }
        }
        Ok(())
    }

    fn encrypt(&self, name: &str, plaintext: &[u8]) -> Result<String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("tada:config:v1\0{}\0{name}", self.0.instance_id);
        let ciphertext = self
            .0
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ConfigError::Crypto)?;
        let mut bytes = Vec::with_capacity(12 + ciphertext.len());
        bytes.extend_from_slice(&nonce);
        bytes.extend(ciphertext);
        Ok(format!("v1:{}", STANDARD.encode(bytes)))
    }

    fn decrypt(&self, name: &str, value: &str) -> Result<Vec<u8>> {
        let bytes = value
            .strip_prefix("v1:")
            .ok_or(ConfigError::Crypto)
            .and_then(|s| STANDARD.decode(s).map_err(|_| ConfigError::Crypto))?;
        if bytes.len() < 28 {
            return Err(ConfigError::Crypto);
        }
        let aad = format!("tada:config:v1\0{}\0{name}", self.0.instance_id);
        self.0
            .cipher
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &bytes[12..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ConfigError::Crypto)
    }
}

fn validate(name: &str, value: &str) -> Result<()> {
    let item = definition(name).ok_or(ConfigError::Validation)?;
    let value = value.trim();
    let max = if item.secret { 8192 } else { 2048 };
    if value.len() > max || value.chars().any(|c| c.is_control()) {
        return Err(ConfigError::Validation);
    }
    if value.is_empty() {
        return if [
            "INSTANCE_NAME",
            "INSTANCE_MODE",
            "REGISTRATION_POLICY",
            "EMAIL_PASSWORD_ENABLED",
            "PHONE_PASSWORD_ENABLED",
        ]
        .contains(&name)
        {
            Err(ConfigError::Validation)
        } else {
            Ok(())
        };
    }
    match item.kind {
        "boolean" if value != "true" && value != "false" => return Err(ConfigError::Validation),
        "select" if !item.options.contains(&value) => return Err(ConfigError::Validation),
        "number" => {
            let value = value.parse::<i64>().map_err(|_| ConfigError::Validation)?;
            let (min, max) = match name {
                "SMS_DAILY_LIMIT" => (1, 10000),
                "AGENT_MAX_WEB_SEARCHES" | "AGENT_MAX_WEB_FETCHES" => (1, 8),
                "AGENT_MAX_CONCURRENT" => (1, 32),
                "AGENT_MAX_TURNS" => (1, 20),
                "AGENT_MAX_TOOLS" => (1, 40),
                "AGENT_TIMEOUT_MS" => (1000, 105000),
                _ => return Err(ConfigError::Validation),
            };
            if !(min..=max).contains(&value) {
                return Err(ConfigError::Validation);
            }
        }
        "url" => {
            let url = reqwest::Url::parse(value).map_err(|_| ConfigError::Validation)?;
            if !["http", "https"].contains(&url.scheme())
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(ConfigError::Validation);
            }
            if url.scheme() == "http" && !private_http_host(url.host_str().unwrap_or_default()) {
                return Err(ConfigError::Validation);
            }
            if name == "INSTANCE_PUBLIC_URL" && url.path().trim_end_matches('/') != "" {
                return Err(ConfigError::Validation);
            }
        }
        _ => {}
    }
    if name == "INSTANCE_NAME" && value.chars().count() > 80 {
        return Err(ConfigError::Validation);
    }
    if name == "SMS_CODE_HASH_KEY" && value.len() < 32 {
        return Err(ConfigError::Validation);
    }
    if name == "CONNECTOR_ENCRYPTION_KEY" {
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ConfigError::Validation);
        }
    }
    Ok(())
}

fn private_http_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if [
        "localhost",
        "api",
        "backend",
        "tomorrow-api",
        "host.docker.internal",
        "ollama",
        "vllm",
        "lmstudio",
    ]
    .contains(&host.as_str())
    {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => false,
    }
}

fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_key(value: &str) -> Result<[u8; 32]> {
    let text = value.trim();
    let bytes = if text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        (0..32)
            .map(|i| {
                u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| ConfigError::Crypto)
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        STANDARD.decode(text).map_err(|_| ConfigError::Crypto)?
    };
    bytes.try_into().map_err(|_| ConfigError::Crypto)
}

fn read_key(path: &Path) -> Result<[u8; 32]> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ConfigError::KeyMissing)?;
    if !metadata.file_type().is_file() || metadata.len() > 256 {
        return Err(ConfigError::Crypto);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(ConfigError::Crypto);
        }
    }
    let mut text = String::new();
    fs::File::open(path)
        .and_then(|mut f| f.read_to_string(&mut text))
        .map_err(|_| ConfigError::KeyMissing)?;
    parse_key(&text)
}

fn load_key(options: &ConfigOptions, database_has_ciphertext: bool) -> Result<[u8; 32]> {
    if let Some(key) = options.master_key.as_deref() {
        return parse_key(key);
    }
    let path = options.config_dir.join("master.key");
    if path.try_exists().map_err(|_| ConfigError::Storage)? {
        let directory =
            fs::symlink_metadata(&options.config_dir).map_err(|_| ConfigError::Storage)?;
        if !directory.file_type().is_dir() {
            return Err(ConfigError::Crypto);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if directory.permissions().mode() & 0o077 != 0 {
                return Err(ConfigError::Crypto);
            }
        }
        return read_key(&path);
    }
    if database_has_ciphertext {
        return Err(ConfigError::KeyMissing);
    }
    fs::create_dir_all(&options.config_dir).map_err(|_| ConfigError::Storage)?;
    if fs::symlink_metadata(&options.config_dir)
        .map_err(|_| ConfigError::Storage)?
        .file_type()
        .is_symlink()
    {
        return Err(ConfigError::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&options.config_dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| ConfigError::Storage)?;
    }
    // Write to a private temporary inode, fsync it, then link it into place.
    // create_new alone exposes a partially written master.key to a second API
    // process. hard_link is atomic and cannot overwrite a winner's key file.
    let temporary = options
        .config_dir
        .join(format!(".master-{}.tmp", uuid::Uuid::new_v4()));
    let mut open = OpenOptions::new();
    open.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let generated = random_hex();
    let result = (|| {
        let mut file = open.open(&temporary).map_err(|_| ConfigError::Storage)?;
        file.write_all(generated.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| ConfigError::Storage)?;
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ConfigError::Storage),
        }
        #[cfg(unix)]
        {
            fs::File::open(&options.config_dir)
                .and_then(|f| f.sync_all())
                .map_err(|_| ConfigError::Storage)?;
        }
        read_key(&path)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests;
