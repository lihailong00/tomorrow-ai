//! Personal Alipay wallet entry, deliberately unavailable until the official
//! mobile Agent Pay integration has been provisioned for this application.
//!
//! The public office CLI is not a multi-user mobile-wallet SDK. In particular,
//! changing HOME does not establish an isolated, officially supported identity.
//! This module never invokes that CLI, stores a binding code, or initiates a
//! payment. A future provider implementation must replace this availability
//! adapter only after its per-user authorization contract is verified.

use axum::{
    Json, Router,
    extract::{FromRequestParts, State},
    http::{StatusCode, header, request::Parts},
    response::Response,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use tomorrow_domain::Repository;

use crate::{ConnectorError, Result};

const UNAVAILABLE_REASON: &str = "支付宝移动端 Agent Pay 需获邀开通；本服务尚未配置正式接入通道。";

/// User sessions still determine ownership even while the provider is disabled.
/// No process-global wallet or merchant credential is substituted for a user.
#[derive(Clone)]
pub struct PersonalWalletState {
    repository: Repository,
}

impl PersonalWalletState {
    pub async fn new(repository: Repository) -> Result<Self> {
        Ok(Self { repository })
    }

    pub fn reconfigured(&self, _values: &HashMap<String, String>) -> Self {
        // Arbitrary settings cannot silently enable an unverified adapter.
        self.clone()
    }

    pub async fn status(&self, _user: &str) -> Result<Value> {
        Ok(availability())
    }

    pub async fn disconnect(&self, _user: &str) -> Result<Value> {
        let mut value = availability();
        value["remote_revoked"] = json!(false);
        value["local_credentials_removed"] = json!(false);
        value["message"] = json!(
            "本服务尚未绑定支付宝账号，没有已保存的绑定可解除；此操作未撤销支付宝侧的其他授权。"
        );
        Ok(value)
    }
}

fn availability() -> Value {
    json!({
        "id":"alipay",
        "name":"支付宝",
        "kind":"wallet",
        "status":"not_configured",
        "description":"连接你本人的支付宝账号；本版仅提供个人钱包绑定入口，不执行付款。",
        "reason":UNAVAILABLE_REASON,
        "help_url":"https://aipay.alipay.com/wallet-guide",
        "qualification_url":"https://aipay.alipay.com/products/mobile-agent-pay",
        "binding_available":false,
        "payment_available":false
    })
}

fn not_configured() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "wallet_not_configured",
        UNAVAILABLE_REASON,
    )
}

struct User(String);

impl FromRequestParts<PersonalWalletState> for User {
    type Rejection = ConnectorError;

    async fn from_request_parts(parts: &mut Parts, state: &PersonalWalletState) -> Result<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|header| header.to_str().ok())
            .and_then(tomorrow_domain::auth::bearer_token)
            .ok_or_else(ConnectorError::unauthorized)?;
        let user = state
            .repository
            .authenticate(token)
            .await
            .map_err(|_| ConnectorError::unauthorized())?;
        Ok(Self(user))
    }
}

pub fn router(state: PersonalWalletState) -> Router {
    Router::new()
        .route("/v1/personal-wallet/alipay", get(status).delete(disconnect))
        .route("/v1/personal-wallet/alipay/authorize", post(unavailable))
        .route("/v1/personal-wallet/alipay/bind", post(unavailable))
        .route("/v1/personal-wallet/alipay/test", post(unavailable))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(2048))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

async fn status(State(state): State<PersonalWalletState>, User(user): User) -> Result<Json<Value>> {
    Ok(Json(state.status(&user).await?))
}

async fn disconnect(
    State(state): State<PersonalWalletState>,
    User(user): User,
) -> Result<Json<Value>> {
    Ok(Json(state.disconnect(&user).await?))
}

async fn unavailable(User(_user): User) -> Result<Json<Value>> {
    // Do not deserialize or retain an auth code while there is no eligible
    // official integration to receive it. Session auth is checked first.
    Err(not_configured())
}

#[cfg(test)]
mod tests;
