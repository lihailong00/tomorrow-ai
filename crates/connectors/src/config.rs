use std::{env, time::Duration};

use reqwest::{Client, Url, redirect::Policy};

use crate::{ConnectorError, Result, crypto::Crypto};

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) client_id: String,
    pub(crate) client_secret: String,
    pub(crate) redirect_uri: String,
    pub(crate) crypto: Crypto,
    pub(crate) endpoints: Endpoints,
}

#[derive(Clone)]
pub(crate) struct Endpoints {
    pub(crate) authorize: String,
    pub(crate) token: String,
    pub(crate) revoke: String,
    pub(crate) calendar: String,
    pub(crate) gmail: String,
    pub(crate) drive: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            calendar: "https://www.googleapis.com/calendar/v3/calendars/primary/events".into(),
            gmail: "https://gmail.googleapis.com/gmail/v1/users/me/messages".into(),
            drive: "https://www.googleapis.com/drive/v3/files".into(),
        }
    }
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
        let redirect_uri = required("GOOGLE_REDIRECT_URI")?;
        let url = Url::parse(&redirect_uri).map_err(|_| ConnectorError::unavailable())?;
        let loopback = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/v1/connectors/google/callback"
        {
            return Err(ConnectorError::unavailable());
        }
        Ok(Self {
            client_id: required("GOOGLE_CLIENT_ID")?,
            client_secret: required("GOOGLE_CLIENT_SECRET")?,
            redirect_uri,
            crypto: Crypto::from_hex(&required("CONNECTOR_ENCRYPTION_KEY")?)?,
            endpoints: Endpoints::default(),
        })
    }
}

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(ConnectorError::unavailable)
}

pub(crate) fn http_client() -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(Policy::none())
        .build()
        .map_err(|_| ConnectorError::internal())
}
