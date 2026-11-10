//! Synthetic provider responses only. No wallet opening or real payment.
use super::runtime::{RuntimeFuture, WalletRuntime};
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use sqlx::Row;
use std::{collections::VecDeque, sync::Mutex};
use tower::ServiceExt;

#[derive(Default)]
struct Fixture {
    outputs: Mutex<VecDeque<Result<Value>>>,
    calls: Mutex<Vec<String>>,
}
impl Fixture {
    fn push(&self, value: Value) {
        self.outputs.lock().unwrap().push_back(Ok(value));
    }
    fn fail(&self) {
        self.outputs
            .lock()
            .unwrap()
            .push_back(Err(validation::provider_error()));
    }
}
impl WalletRuntime for Fixture {
    fn execute(&self, operation: Operation) -> RuntimeFuture<'_> {
        Box::pin(async move {
            let name = match operation {
                Operation::Check => "check",
                Operation::Apply => "apply",
                Operation::Bind(_) => "bind",
                Operation::Manage => "manage",
                Operation::Pay { .. } => "pay",
                Operation::Query(_) => "query",
            };
            self.calls.lock().unwrap().push(name.into());
            self.outputs
                .lock()
                .unwrap()
                .pop_front()
                .expect("Unexpected provider command")
        })
    }
}
async fn fixture() -> (
    PersonalWalletState,
    Repository,
    String,
    String,
    Arc<Fixture>,
) {
    let repo = Repository::connect("sqlite::memory:").await.unwrap();
    let owner = repo
        .create_user(
            "wallet-real-one@example.test",
            "unused",
            "One",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let other = repo
        .create_user(
            "wallet-real-two@example.test",
            "unused",
            "Two",
            "Asia/Shanghai",
        )
        .await
        .unwrap()
        .id;
    let provider = Arc::new(Fixture::default());
    let state = PersonalWalletState::initialize(
        repo.clone(),
        Some(Crypto::from_hex(&"42".repeat(32)).unwrap()),
        Some((owner.clone(), provider.clone())),
    )
    .await
    .unwrap();
    state.save_status(&owner, "connected", None).await.unwrap();
    (state, repo, owner, other, provider)
}
fn order() -> PaymentInput {
    PaymentInput {
        title: "fixture coffee".into(),
        merchant: "fixture merchant".into(),
        amount: "12.30".into(),
        payment_link: "https://cashier.alipay.com/pay?fixture=one".into(),
    }
}
fn pending() -> Value {
    json!({"code":200,"message":"支付待确认","shortUrl":"https://cashier.alipay.com/confirm?fixture=private","outShakeNo":"20260810008282150358840000078279"})
}
fn paid(amount: &str) -> Value {
    json!({"code":200,"message":"支付已完成","totalAmount":amount,"outShakeNo":"20260810008282150358840000078279"})
}
async fn client_record(state: &PersonalWalletState, user: &str, key: &str) -> Value {
    let payment = state.prepare_payment(user, order(), key).await.unwrap();
    assert!(payment.get("confirmation_token").is_none());
    state
        .payment(user, payment["id"].as_str().unwrap(), true)
        .await
        .unwrap()
}

#[tokio::test]
async fn model_preparation_cannot_spend_and_client_confirmation_executes_once() {
    let (state, _, owner, _, provider) = fixture().await;
    let record = client_record(&state, &owner, "run-one:0").await;
    let id = record["id"].as_str().unwrap();
    let token = record["confirmation_token"].as_str().unwrap();
    assert!(provider.calls.lock().unwrap().is_empty());
    assert!(state
        .confirm_payment(&owner, id, &"x".repeat(43))
        .await
        .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
    provider.push(pending());
    let first = state.confirm_payment(&owner, id, token).await.unwrap();
    assert_eq!(first["status"], "awaiting_payment");
    assert!(first.get("confirmation_token").is_none());
    assert_eq!(
        state.confirm_payment(&owner, id, token).await.unwrap()["status"],
        "awaiting_payment"
    );
    assert_eq!(&*provider.calls.lock().unwrap(), &["pay"]);
    provider.push(paid("12.30"));
    let response = state.refresh_payment(&owner, id, false).await.unwrap();
    assert_eq!(response["status"], "paid");
    assert!(response.get("payment_url").is_none());
    let ledger = state
        .transactions(&owner, None, None, 0, 20, false)
        .await
        .unwrap();
    assert_eq!(ledger["summary"]["paid_amount"], "12.30");
    assert_eq!(ledger["summary"]["paid_count"], 1);
    assert_eq!(&*provider.calls.lock().unwrap(), &["pay", "query"]);
}

#[tokio::test]
async fn lost_response_restart_and_new_operation_never_repeat_money_command() {
    let (state, repo, owner, _, provider) = fixture().await;
    let record = client_record(&state, &owner, "first").await;
    let id = record["id"].as_str().unwrap();
    let token = record["confirmation_token"].as_str().unwrap();
    provider.fail();
    assert_eq!(
        state.confirm_payment(&owner, id, token).await.unwrap()["status"],
        "unknown_outcome"
    );
    let restarted = PersonalWalletState::initialize(
        repo,
        Some(Crypto::from_hex(&"42".repeat(32)).unwrap()),
        Some((owner.clone(), provider.clone())),
    )
    .await
    .unwrap();
    assert_eq!(
        restarted
            .prepare_payment(&owner, order(), "retry-different-slot")
            .await
            .unwrap()["id"],
        id
    );
    assert_eq!(
        restarted.confirm_payment(&owner, id, token).await.unwrap()["status"],
        "unknown_outcome"
    );
    assert_eq!(
        restarted.refresh_payment(&owner, id, true).await.unwrap()["status"],
        "unknown_outcome"
    );
    let mut changed = order();
    changed.amount = "13.00".into();
    assert!(restarted
        .prepare_payment(&owner, changed, "different-amount")
        .await
        .is_err());
    assert_eq!(&*provider.calls.lock().unwrap(), &["pay"]);
}

#[tokio::test]
async fn mismatched_amount_does_not_create_a_paid_ledger_entry() {
    let (state, _, owner, _, provider) = fixture().await;
    let record = client_record(&state, &owner, "amount").await;
    provider.push(paid("99.00"));
    let result = state
        .confirm_payment(
            &owner,
            record["id"].as_str().unwrap(),
            record["confirmation_token"].as_str().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "unknown_outcome");
    assert_eq!(
        state
            .transactions(&owner, None, None, 0, 20, false)
            .await
            .unwrap()["summary"]["paid_count"],
        0
    );
}

#[tokio::test]
async fn credentials_records_and_authorization_remain_owner_scoped_and_encrypted() {
    let (state, repo, owner, other, provider) = fixture().await;
    assert_eq!(
        state.status(&other).await.unwrap()["binding_available"],
        false
    );
    let record = client_record(&state, &owner, "secrets").await;
    let id = record["id"].as_str().unwrap();
    assert!(state.payment(&other, id, true).await.is_err());
    assert!(state
        .confirm_payment(&other, id, record["confirmation_token"].as_str().unwrap())
        .await
        .is_err());
    assert!(state
        .prepare_payment(&other, order(), "other")
        .await
        .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
    let encrypted: String =
        sqlx::query_scalar("SELECT encrypted_payload FROM personal_wallet_payments WHERE id=$1")
            .bind(id)
            .fetch_one(&repo.pool())
            .await
            .unwrap();
    for value in [
        "fixture coffee",
        "fixture merchant",
        "cashier.alipay.com",
        record["confirmation_token"].as_str().unwrap(),
    ] {
        assert!(!encrypted.contains(value));
    }
    let unopened = json!({"code":500,"message":"未开通","status":"unbound","neverCreated":true});
    provider.push(unopened.clone());
    assert_eq!(state.test(&owner).await.unwrap()["status"], "not_connected");
    provider.push(unopened.clone());
    provider.push(json!({"code":200,"message":"已申请开通，等待授权","access_url":"https://render.alipay.com/wallet?fixture=auth"}));
    let auth = state.authorize(&owner).await.unwrap();
    assert_eq!(auth["status"], "awaiting_authorization");
    provider.push(unopened);
    let checked = state.test(&owner).await.unwrap();
    assert_eq!(checked["status"], "awaiting_authorization");
    assert_eq!(checked["authorization_url"], auth["authorization_url"]);
    provider.push(json!({"code":200,"message":"开启成功"}));
    assert_eq!(
        state.bind(&owner, "654321".into()).await.unwrap()["status"],
        "connected"
    );
    let profile = sqlx::query("SELECT authorization,status FROM personal_wallet_profile")
        .fetch_one(&repo.pool())
        .await
        .unwrap();
    assert_eq!(profile.try_get::<String, _>("authorization").unwrap(), "");
    assert!(!serde_json::to_string(&state.status(&owner).await.unwrap())
        .unwrap()
        .contains("654321"));
    assert_eq!(
        &*provider.calls.lock().unwrap(),
        &["check", "check", "apply", "check", "bind"]
    );
}

#[tokio::test]
async fn expiry_cancellation_and_owner_reconfiguration_cannot_spend() {
    let (state, repo, owner, other, provider) = fixture().await;
    let record = client_record(&state, &owner, "expired").await;
    let id = record["id"].as_str().unwrap();
    sqlx::query("UPDATE personal_wallet_payments SET expires_at=0 WHERE id=$1")
        .bind(id)
        .execute(&repo.pool())
        .await
        .unwrap();
    assert_eq!(
        state
            .confirm_payment(&owner, id, record["confirmation_token"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "expired"
    );
    assert!(PersonalWalletState::initialize(
        repo,
        Some(Crypto::from_hex(&"42".repeat(32)).unwrap()),
        Some((other, provider.clone()))
    )
    .await
    .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn management_link_does_not_falsely_claim_remote_revocation() {
    let (state, _, owner, _, provider) = fixture().await;
    let record = client_record(&state, &owner, "cancel-on-manage").await;
    provider.push(
        json!({"code":200,"management_url":"https://render.alipay.com/manage?fixture=private"}),
    );
    let result = state.disconnect(&owner).await.unwrap();
    assert_eq!(result["remote_revoked"], false);
    assert_eq!(
        state
            .payment(&owner, record["id"].as_str().unwrap(), false)
            .await
            .unwrap()["status"],
        "cancelled"
    );
    assert_eq!(&*provider.calls.lock().unwrap(), &["manage"]);
}

#[tokio::test]
async fn actual_http_router_requires_session_and_one_time_confirmation_secret() {
    let (state, repo, owner, _, provider) = fixture().await;
    let record = client_record(&state, &owner, "http").await;
    let session = repo.create_session(&owner).await.unwrap();
    let app = router(state);
    let path = format!(
        "/v1/personal-wallet/alipay/payments/{}/confirm",
        record["id"].as_str().unwrap()
    );
    let unauthorized = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&path)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"confirmation_token":"forged"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    let forged = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&path)
                .header("authorization", format!("Bearer {session}"))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"confirmation_token":"forged"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::CONFLICT);
    assert!(provider.calls.lock().unwrap().is_empty());
    provider.push(pending());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&path)
                .header("authorization", format!("Bearer {session}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"confirmation_token":record["confirmation_token"]}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(value["status"], "awaiting_payment");
    assert_eq!(&*provider.calls.lock().unwrap(), &["pay"]);
}

#[tokio::test]
async fn concurrent_api_processes_claim_the_same_order_and_funds_command_only_once() {
    let (state, repo, owner, _, provider) = fixture().await;
    let second = PersonalWalletState::initialize(
        repo,
        Some(Crypto::from_hex(&"42".repeat(32)).unwrap()),
        Some((owner.clone(), provider.clone())),
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        state.prepare_payment(&owner, order(), "parallel-a"),
        second.prepare_payment(&owner, order(), "parallel-b")
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a["id"], b["id"]);
    let record = state
        .payment(&owner, a["id"].as_str().unwrap(), true)
        .await
        .unwrap();
    let id = record["id"].as_str().unwrap();
    let token = record["confirmation_token"].as_str().unwrap();
    provider.push(pending());
    let (a, b) = tokio::join!(
        state.confirm_payment(&owner, id, token),
        second.confirm_payment(&owner, id, token)
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(&*provider.calls.lock().unwrap(), &["pay"]);
}

#[tokio::test]
async fn an_unbound_wallet_and_an_uncertain_environment_cannot_spend_or_apply() {
    let (state, _, owner, _, provider) = fixture().await;
    state
        .save_status(&owner, "not_connected", None)
        .await
        .unwrap();
    let record = client_record(&state, &owner, "unbound").await;
    assert!(state
        .confirm_payment(
            &owner,
            record["id"].as_str().unwrap(),
            record["confirmation_token"].as_str().unwrap()
        )
        .await
        .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
    provider.push(json!({"code":500,"message":"查询失败","reason":"当前安全环境存在问题"}));
    assert!(state.authorize(&owner).await.is_err());
    assert_eq!(&*provider.calls.lock().unwrap(), &["check"]);
}
