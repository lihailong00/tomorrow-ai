//! Agent access ends at read/prepare/query. Wallet binding and money confirmation
//! only exist on the authenticated mobile API, never as model-executable tools.
use serde_json::{json, Value};
use tomorrow_connectors::personal_wallet::{PaymentInput, PersonalWalletState};
use tomorrow_domain::DomainError;

pub(super) fn is_wallet_tool(name: &str) -> bool {
    matches!(
        name,
        "alipay_wallet_status"
            | "prepare_alipay_payment"
            | "get_alipay_payment"
            | "list_alipay_transactions"
    )
}
pub(super) async fn execute(
    wallet: &PersonalWalletState,
    user: &str,
    run: &str,
    operation: u32,
    name: &str,
    arguments: &Value,
) -> Result<Value, DomainError> {
    let object = arguments
        .as_object()
        .ok_or_else(|| DomainError::Validation("支付宝工具参数必须为对象".into()))?;
    let allowed: &[&str] = match name {
        "alipay_wallet_status" => &[],
        "prepare_alipay_payment" => &["title", "merchant", "amount", "payment_link"],
        "get_alipay_payment" => &["id"],
        "list_alipay_transactions" => &["from", "until", "offset", "limit"],
        _ => return Err(DomainError::Forbidden),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(DomainError::Validation(
            "支付宝工具不能接收账号、授权码或代确认参数".into(),
        ));
    }
    let result = match name {
        "alipay_wallet_status" => wallet.status(user).await,
        "prepare_alipay_payment" => {
            let input: PaymentInput = serde_json::from_value(arguments.clone()).map_err(|_| {
                DomainError::Validation(
                    "请提供真实订单的标题、商家、人民币金额和支付宝收银台链接".into(),
                )
            })?;
            let payment = wallet
                .prepare_payment(user, input, &format!("{run}:wallet:{operation}"))
                .await
                .map_err(tomorrow_connectors::ConnectorError::into_domain)?;
            let pending = payment["status"] == "pending";
            return Ok(
                json!({"status":if pending {json!("confirmation_required")}else{payment["status"].clone()},"payment":payment,"message":if pending {"付款尚未执行，等待用户在发起操作的界面核对并确认。不得代替用户确认，也不要重复创建请求。"}else{"已返回这笔订单的原请求状态，没有创建或再次执行付款。"}}),
            );
        }
        "get_alipay_payment" => {
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 80)
                .ok_or_else(|| DomainError::Validation("缺少付款请求编号".into()))?;
            wallet.refresh_payment(user, id, false).await
        }
        _ => {
            let integer = |key: &str| -> Result<Option<i64>, DomainError> {
                object
                    .get(key)
                    .map(|value| {
                        value.as_i64().ok_or_else(|| {
                            DomainError::Validation("账单时间和分页参数必须为整数".into())
                        })
                    })
                    .transpose()
            };
            let offset = integer("offset")?.unwrap_or(0);
            let limit = integer("limit")?.unwrap_or(20);
            if !(0..=10000).contains(&offset) || !(1..=50).contains(&limit) {
                return Err(DomainError::Validation("账单分页参数超出范围".into()));
            }
            wallet
                .transactions(
                    user,
                    integer("from")?,
                    integer("until")?,
                    offset as u32,
                    limit as u32,
                    false,
                )
                .await
        }
    };
    result.map_err(tomorrow_connectors::ConnectorError::into_domain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tomorrow_domain::Repository;

    #[tokio::test]
    async fn model_tools_cannot_bind_confirm_or_impersonate_another_wallet() {
        let repo = Repository::connect("sqlite::memory:").await.unwrap();
        let state = PersonalWalletState::new(repo).await.unwrap();
        for name in [
            "confirm_alipay_payment",
            "bind_alipay_wallet",
            "submit-payment",
            "cancel_alipay_payment",
        ] {
            assert!(!is_wallet_tool(name));
            assert!(matches!(
                execute(&state, "owner", "run", 0, name, &json!({})).await,
                Err(DomainError::Forbidden)
            ));
        }
        for name in [
            "alipay_wallet_status",
            "prepare_alipay_payment",
            "get_alipay_payment",
            "list_alipay_transactions",
        ] {
            assert!(is_wallet_tool(name));
            for forbidden in [
                "user_id",
                "owner",
                "confirmation_token",
                "code",
                "access_token",
            ] {
                let args = json!({forbidden:"synthetic-private-value"});
                assert!(matches!(
                    execute(&state, "owner", "run", 0, name, &args).await,
                    Err(DomainError::Validation(_))
                ));
            }
        }
        let status = execute(
            &state,
            "owner",
            "run",
            0,
            "alipay_wallet_status",
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(status["binding_available"], false);
        assert_eq!(status["payment_available"], false);
        for args in [
            json!({"limit":51}),
            json!({"offset":-1}),
            json!({"offset":0.5}),
            json!({"from":"2026-11-03"}),
        ] {
            assert!(matches!(
                execute(&state, "owner", "run", 0, "list_alipay_transactions", &args).await,
                Err(DomainError::Validation(_))
            ));
        }
    }
}
