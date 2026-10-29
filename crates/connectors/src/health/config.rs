use super::{Provider, unavailable};
use crate::crypto::Crypto;
use reqwest::Url;
use std::collections::HashMap;

#[derive(Clone)]
pub(super) struct ProviderConfig {
    pub client_id: String,
    pub secret: String,
    pub redirect: String,
    pub fingerprint: String,
}

#[derive(Clone)]
pub(super) struct Config {
    pub crypto: Option<Crypto>,
    pub providers: HashMap<Provider, ProviderConfig>,
    pub endpoints: Endpoints,
}

#[derive(Clone)]
pub(super) struct Endpoints {
    pub xiaomi_authorize: String,
    pub xiaomi_token: String,
    pub xiaomi_refresh: String,
    pub xiaomi_data: String,
    pub huawei_authorize: String,
    pub huawei_token: String,
    pub huawei_data: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            xiaomi_authorize: "https://account.xiaomi.com/oauth2/authorize".into(),
            xiaomi_token: "https://account.xiaomi.com/oauth2/token".into(),
            xiaomi_refresh: "https://account.xiaomi.com/oauth2/refresh/token".into(),
            xiaomi_data: "https://hlthopen.io.mi.com".into(),
            huawei_authorize: "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize".into(),
            huawei_token: "https://oauth-login.cloud.huawei.com/oauth2/v3/token".into(),
            huawei_data: "https://health-api.cloud.huawei.com".into(),
        }
    }
}

impl Config {
    pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let crypto = lookup("CONNECTOR_ENCRYPTION_KEY").and_then(|key| Crypto::from_hex(&key).ok());
        let instance = lookup("INSTANCE_PUBLIC_URL")
            .and_then(|value| Url::parse(value.trim()).ok())
            .filter(|url| {
                url.scheme() == "https"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && matches!(url.path(), "" | "/")
            });
        let mut providers = HashMap::new();
        for provider in Provider::all() {
            let prefix = match provider {
                Provider::Huawei => "HUAWEI_HEALTH",
                Provider::Xiaomi => "XIAOMI_HEALTH",
            };
            let client_id = lookup(&format!("{prefix}_CLIENT_ID"))
                .unwrap_or_default()
                .trim()
                .to_owned();
            let secret = lookup(&format!("{prefix}_CLIENT_SECRET")).unwrap_or_default();
            let mut redirect = lookup(&format!("{prefix}_REDIRECT_URI"))
                .unwrap_or_default()
                .trim()
                .to_owned();
            if redirect.is_empty() {
                if let Some(origin) = &instance {
                    redirect = format!(
                        "{}/v1/health/oauth/{}/callback",
                        origin.as_str().trim_end_matches('/'),
                        provider.id()
                    )
                }
            }
            if crypto.is_some()
                && valid_id(&client_id)
                && !secret.trim().is_empty()
                && secret.len() <= 4096
                && valid_redirect(&redirect, provider)
            {
                // An OAuth flow belongs to the exact application settings that started it.
                let fingerprint = crate::crypto::digest(&format!(
                    "{}:{}:{}:{}",
                    provider.id(),
                    client_id,
                    secret,
                    redirect
                ));
                providers.insert(
                    provider,
                    ProviderConfig {
                        client_id,
                        secret,
                        redirect,
                        fingerprint,
                    },
                );
            }
        }
        Self {
            crypto,
            providers,
            endpoints: Endpoints::default(),
        }
    }

    pub fn provider(&self, provider: Provider) -> crate::Result<&ProviderConfig> {
        self.providers.get(&provider).ok_or_else(unavailable)
    }
    pub fn crypto(&self) -> crate::Result<&Crypto> {
        self.crypto.as_ref().ok_or_else(unavailable)
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub(super) fn valid_redirect(value: &str, provider: Provider) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    (url.scheme() == "https" || (url.scheme() == "http" && loopback))
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some()
        && url.path() == format!("/v1/health/oauth/{}/callback", provider.id())
}
