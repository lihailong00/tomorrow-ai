//! User-owned Alipay wallet sessions and payment confirmations. The official
//! office CLI is an opt-in single-owner adapter, not a multi-user mobile SDK.
mod runtime;
mod store;
mod validation;
use crate::{crypto::Crypto, ConnectorError, Result};
use axum::{
    extract::{FromRequestParts, Path, Query, State},
    http::{header, request::Parts, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use runtime::{Operation, WalletRuntime};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Semaphore;
use tomorrow_domain::Repository;
pub use validation::PaymentInput;
const UNAVAILABLE_REASON: &str = "当前服务尚未启用支付宝个人钱包。启用后由你本人在支付宝完成授权，无需填写商户密钥。";

#[derive(Clone)]
pub struct PersonalWalletState {
    inner: Arc<Inner>,
}
struct Inner {
    repository: Repository,
    crypto: Option<Crypto>,
    owner: Option<String>,
    runtime: Option<Arc<dyn WalletRuntime>>,
    operations: Semaphore,
}
impl PersonalWalletState {
    pub async fn new(repository: Repository) -> Result<Self> {
        Self::with_configuration(repository, &std::env::vars().collect()).await
    }
    pub async fn with_configuration(
        repository: Repository,
        values: &HashMap<String, String>,
    ) -> Result<Self> {
        let crypto = values.get("CONNECTOR_ENCRYPTION_KEY")
            .and_then(|key| Crypto::from_hex(key).ok());
        let provisioned = crypto
            .as_ref()
            .and_then(|_| runtime::CliRuntime::configured());
        Self::initialize(repository, crypto, provisioned).await
    }
    async fn initialize(
        repository: Repository,
        crypto: Option<Crypto>,
        provisioned: Option<(String, Arc<dyn WalletRuntime>)>,
    ) -> Result<Self> {
        let (owner, runtime) = match provisioned {
            Some((owner, runtime)) => (Some(owner), Some(runtime)),
            None => (None, None),
        };
        let state = Self {
            inner: Arc::new(Inner {
                repository,
                crypto,
                owner,
                runtime,
                operations: Semaphore::new(1),
            }),
        };
        if state.inner.runtime.is_some() {
            state.initialize_store().await?;
        }
        Ok(state)
    }
    pub fn reconfigured(&self, _values: &HashMap<String, String>) -> Self {
        // Process identity, owner and executable are deployment-only settings.
        self.clone()
    }
    fn runtime(&self, user: &str) -> Result<&Arc<dyn WalletRuntime>> {
        if self.inner.owner.as_deref() != Some(user) {
            return Err(not_configured());
        }
        self.inner.runtime.as_ref().ok_or_else(not_configured)
    }
    pub async fn status(&self, user: &str) -> Result<Value> {
        if self.runtime(user).is_err() {
            return Ok(availability());
        }
        let mut value = availability();
        value["status"] = json!(self.cached_status(user).await?);
        value["binding_available"] = json!(true);
        value["payment_available"] = json!(true);
        value["runtime_mode"] = json!("dedicated_single_user");
        value["description"] =
            json!("连接你本人的支付宝，在核对订单后付款，并查看通过妥啦发起的交易记录。");
        value["reason"] =
            json!("当前为独立钱包实例，仅指定账号可使用；不提供支付宝全部历史账单读取权限。");
        Ok(value)
    }
    pub async fn test(&self, user: &str) -> Result<Value> {
        let runtime = self.runtime(user)?;
        let _permit = self.inner.operations.try_acquire().map_err(|_| busy())?;
        let result = runtime.execute(Operation::Check).await.map_err(validation::authorization_error)?;
        let status = validation::wallet_state(&result);
        if status == "not_connected" {
            // The provider can report unbound until the user enters the
            // binding code. Keep an existing challenge's original expiry.
            if let Some(value) = self.saved_authorization(user).await? {
                return Ok(value);
            }
        }
        self.save_status(user, status, None).await?;
        let mut value = self.status(user).await?;
        if let Some(link) = validation::public_link(&result) {
            value["authorization_url"] = json!(link);
        }
        if status == "needs_reconnect" {
            value["message"] = json!("官方组件未确认钱包已绑定，请检查运行环境或重新授权。");
        }
        Ok(value)
    }
    pub async fn authorize(&self, user: &str) -> Result<Value> {
        let runtime = self.runtime(user)?;
        let _permit = self.inner.operations.try_acquire().map_err(|_| busy())?;
        if self.cached_status(user).await? == "binding" {
            return Err(busy());
        }
        let current = runtime.execute(Operation::Check).await.map_err(validation::authorization_error)?;
        let state = validation::wallet_state(&current);
        if state == "connected" {
            self.save_status(user, "connected", None).await?;
            return self.status(user).await;
        }
        // Do not turn a network/security failure into repeated applications.
        if state != "not_connected" && !validation::succeeded(&current) {
            let reason = validation::field(&current, &["message"]).unwrap_or("");
            let detail = current.get("reason").and_then(Value::as_str).unwrap_or("");
            if ![reason, detail].iter().any(|text| {
                text.contains("未开通")
                    || text.contains("尚未提交")
                    || text.contains("WALLET_NOT_EXISTS")
            }) {
                return Err(validation::authorization_error(validation::provider_error()));
            }
        }
        if let Some(value) = self.saved_authorization(user).await? {
            return Ok(value);
        }
        let result = runtime.execute(Operation::Apply).await.map_err(validation::authorization_error)?;
        let link = validation::public_link(&result)
            .filter(|_| validation::succeeded(&result))
            .ok_or_else(|| validation::authorization_error(validation::provider_error()))?;
        self.save_status(user, "awaiting_authorization", Some(&link))
            .await?;
        let mut value = self.status(user).await?;
        value["authorization_url"] = json!(link);
        value["expires_in"] = json!(300);
        Ok(value)
    }
    pub async fn bind(&self, user: &str, code: String) -> Result<Value> {
        let runtime = self.runtime(user)?;
        if !validation::text(&code, 200) {
            return Err(validation::invalid());
        }
        let _permit = self.inner.operations.try_acquire().map_err(|_| busy())?;
        self.claim_binding(user).await?;
        // Ephemeral code: never persist, echo, journal or send to a model.
        let result = runtime.execute(Operation::Bind(code)).await;
        let status = match &result {
            Ok(value)
                if validation::succeeded(value)
                    && validation::field(value, &["message"]).is_some_and(|message| {
                        message.contains("开启成功")
                            || message.contains("绑定成功")
                            || message.contains("授权成功")
                    }) =>
            {
                "connected"
            }
            _ => "needs_reconnect",
        };
        self.save_status(user, status, None).await?;
        if result.is_err() || status != "connected" {
            return Err(validation::provider_error());
        }
        self.status(user).await
    }
    pub async fn disconnect(&self, user: &str) -> Result<Value> {
        if self.runtime(user).is_err() {
            let mut value = availability();
            value["remote_revoked"] = json!(false);
            value["local_credentials_removed"] = json!(false);
            value["message"]=json!("本服务尚未绑定支付宝账号，没有已保存的绑定可解除；此操作未撤销支付宝侧的其他授权。");
            return Ok(value);
        }
        let _permit = self.inner.operations.try_acquire().map_err(|_| busy())?;
        let result = self.runtime(user)?.execute(Operation::Manage).await?;
        let link = validation::public_link(&result)
            .filter(|_| validation::succeeded(&result))
            .ok_or_else(validation::provider_error)?;
        self.cancel_pending(user).await?;
        let mut value = self.status(user).await?;
        value["management_url"] = json!(link);
        value["remote_revoked"] = json!(false);
        value["message"] =
            json!("请前往支付宝管理授权；返回后点刷新核实，当前尚未确认已解除授权。");
        Ok(value)
    }
}
fn availability() -> Value {
    json!({"id":"alipay","name":"支付宝","kind":"wallet","status":"not_configured","description":"连接本人支付宝，授权后处理支持的订单付款，并核对妥啦交易记录。","reason":UNAVAILABLE_REASON,"help_url":"https://aipay.alipay.com/wallet-guide","qualification_url":"https://aipay.alipay.com/wallet-guide","binding_available":false,"payment_available":false,"protocol_version":1,"history_scope":"tada_transactions_only","integration_type":"official_personal_wallet","requires_merchant_keys":false})
}
fn not_configured() -> ConnectorError {
    ConnectorError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "wallet_not_configured",
        UNAVAILABLE_REASON,
    )
}
fn busy() -> ConnectorError {
    ConnectorError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "wallet_busy",
        "支付宝操作正在处理中，请稍后刷新，不要重复提交",
    )
}
struct User(String);
impl FromRequestParts<PersonalWalletState> for User {
    type Rejection = ConnectorError;
    async fn from_request_parts(parts: &mut Parts, state: &PersonalWalletState) -> Result<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(tomorrow_domain::auth::bearer_token)
            .ok_or_else(ConnectorError::unauthorized)?;
        Ok(Self(
            state
                .inner
                .repository
                .authenticate(token)
                .await
                .map_err(|_| ConnectorError::unauthorized())?,
        ))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BindInput {
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmInput {
    confirmation_token: String,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct TransactionsQuery {
    from: Option<i64>,
    until: Option<i64>,
    offset: Option<u32>,
    limit: Option<u32>,
}
pub fn router(state: PersonalWalletState) -> Router {
    Router::new()
        .route("/v1/personal-wallet/alipay", get(status).delete(disconnect))
        .route("/v1/personal-wallet/alipay/authorize", post(authorize))
        .route("/v1/personal-wallet/alipay/bind", post(bind))
        .route("/v1/personal-wallet/alipay/test", post(test))
        .route("/v1/personal-wallet/alipay/transactions", get(transactions))
        .route("/v1/personal-wallet/alipay/payments/{id}", get(payment))
        .route(
            "/v1/personal-wallet/alipay/payments/{id}/confirm",
            post(confirm),
        )
        .route(
            "/v1/personal-wallet/alipay/payments/{id}/refresh",
            post(refresh_payment),
        )
        .route(
            "/v1/personal-wallet/alipay/payments/{id}/cancel",
            post(cancel_payment),
        )
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
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
async fn authorize(
    State(state): State<PersonalWalletState>,
    User(user): User,
) -> Result<Json<Value>> {
    Ok(Json(state.authorize(&user).await?))
}
async fn test(State(state): State<PersonalWalletState>, User(user): User) -> Result<Json<Value>> {
    Ok(Json(state.test(&user).await?))
}
async fn bind(
    State(state): State<PersonalWalletState>,
    User(user): User,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    state.runtime(&user)?;
    let input: BindInput = serde_json::from_slice(&body).map_err(|_| validation::invalid())?;
    Ok(Json(state.bind(&user, input.code).await?))
}
async fn transactions(
    State(state): State<PersonalWalletState>,
    User(user): User,
    Query(query): Query<TransactionsQuery>,
) -> Result<Json<Value>> {
    Ok(Json(
        state
            .transactions(
                &user,
                query.from,
                query.until,
                query.offset.unwrap_or(0),
                query.limit.unwrap_or(20),
                true,
            )
            .await?,
    ))
}
async fn payment(
    State(state): State<PersonalWalletState>,
    User(user): User,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(state.payment(&user, &id, true).await?))
}
async fn confirm(
    State(state): State<PersonalWalletState>,
    User(user): User,
    Path(id): Path<String>,
    Json(input): Json<ConfirmInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        state
            .confirm_payment(&user, &id, &input.confirmation_token)
            .await?,
    ))
}
async fn refresh_payment(
    State(state): State<PersonalWalletState>,
    User(user): User,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(state.refresh_payment(&user, &id, true).await?))
}
async fn cancel_payment(
    State(state): State<PersonalWalletState>,
    User(user): User,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(state.cancel_payment(&user, &id).await?))
}
#[cfg(test)]
mod payment_tests;
#[cfg(test)]
mod tests;
