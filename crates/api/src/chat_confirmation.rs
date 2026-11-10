use super::{chat_interaction, AppState, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tomorrow_connectors::{
    personal_mcp::PersonalMcpState, personal_wallet::PersonalWalletState, ConnectorError,
};
use tomorrow_domain::DomainError;

#[derive(Clone, Serialize)]
pub(crate) struct Review {
    title: String,
    details: String,
    button: &'static str,
}

fn mcp_review(action: &Value) -> Option<Review> {
    let arguments = action["arguments"].as_object()?;
    let details = serde_json::to_string_pretty(arguments).ok()?;
    if details.encode_utf16().count() > 12_000 {
        return None;
    }
    let tool = action["tool"].as_str()?;
    if action["provider"] == "didi" && tool == "taxi_cancel_order" {
        let order = arguments.get("order_id")?.as_str()?;
        return Some(Review {
            title: "取消滴滴行程".into(),
            details: if arguments.len() == 1 {
                format!("订单号 · {order}")
            } else {
                details
            },
            button: "确认取消",
        });
    }
    Some(Review {
        title: format!("{} · 核对操作", action["provider_name"].as_str()?),
        details: format!("{tool}\n{details}"),
        button: "确认执行",
    })
}

fn didi_cancel_result(action: Value) -> Value {
    let status = match (
        action["status"].as_str(),
        action
            .pointer("/result/structuredContent/success")
            .and_then(Value::as_bool),
    ) {
        (Some("completed"), Some(true)) => "completed",
        (Some("completed"), Some(false)) | (Some("failed"), _) => "failed",
        (Some("expired"), _) => "expired",
        (Some("cancelled"), _) => "cancelled",
        (Some("executing"), _) => "executing",
        _ => "unknown_outcome",
    };
    let message = if status == "completed" {
        "滴滴已确认原订单取消。若用户同时要求重新叫车，在本轮重新查价并展示新订单确认卡。"
    } else {
        "未确认原订单已取消。停止重新叫车；结果不明时只查询原订单，禁止重复取消或下单。"
    };
    json!({"id":action["id"],"status":status,"message":message})
}

fn stopped(answer: &Value) -> Value {
    let message = match answer["status"].as_str() {
        Some("cancelled") => "用户已取消此次确认，操作未执行。",
        Some("timed_out") => "对话确认已超时，操作未执行。",
        _ => "本次对话无法完成确认，操作未执行。",
    };
    json!({"status":answer["status"],"message":message})
}

pub(crate) async fn mcp_action(
    state: &AppState,
    run: &str,
    token: &str,
    user: &str,
    mcp: &PersonalMcpState,
    draft: Value,
    didi_cancel: bool,
) -> Result<Value> {
    if draft["status"] != "confirmation_required" {
        return Ok(if didi_cancel {
            didi_cancel_result(draft["action"].clone())
        } else {
            draft
        });
    }
    if draft["replayed"] == true {
        return Ok(
            json!({"status":"confirmation_required","message":"本轮已发起过这项操作，请等待原确认结果。"}),
        );
    }
    let action = &draft["action"];
    let id = action["id"].as_str().ok_or(DomainError::NotFound)?;
    let Some(review) = mcp_review(action) else {
        mcp.cancel(user, id)
            .await
            .map_err(ConnectorError::into_domain)?;
        return Ok(
            json!({"status":"unavailable","message":"无法完整展示本次操作，请缩小操作范围后重新发起。本次操作未执行。"}),
        );
    };
    let answer = chat_interaction::confirm_action(state, run, token, user, review).await;
    if !answer
        .as_ref()
        .is_ok_and(|value| value["status"] == "confirmed")
    {
        mcp.cancel(user, id)
            .await
            .map_err(ConnectorError::into_domain)?;
        return Ok(stopped(&answer?));
    }
    let action = mcp
        .confirm(user, id)
        .await
        .map_err(ConnectorError::into_domain)?;
    if didi_cancel {
        return Ok(didi_cancel_result(action));
    }
    // Return the recorded outcome without repeating private arguments in the model context.
    let status = action["status"]
        .as_str()
        .filter(|status| *status != "pending")
        .unwrap_or("unknown_outcome");
    let result = &action["result"];
    if result.to_string().len() > 8_000 {
        return Ok(
            json!({"id":id,"status":status,"message":"操作结果较长，可用 get_mcp_action 按编号分页读取。"}),
        );
    }
    Ok(json!({"id":id,"status":status,"result":result}))
}

pub(crate) async fn wallet_payment(
    state: &AppState,
    run: &str,
    token: &str,
    user: &str,
    wallet: &PersonalWalletState,
    draft: Value,
) -> Result<Value> {
    if draft["status"] != "confirmation_required" {
        return Ok(draft);
    }
    let payment = &draft["payment"];
    let id = payment["id"].as_str().ok_or(DomainError::NotFound)?;
    let review = Review {
        title: "核对支付宝付款".into(),
        details: format!(
            "{}\n收款方 · {}\n金额 · ¥{}",
            payment["title"].as_str().ok_or(DomainError::NotFound)?,
            payment["merchant"].as_str().ok_or(DomainError::NotFound)?,
            payment["amount"].as_str().ok_or(DomainError::NotFound)?
        ),
        button: "确认付款",
    };
    let answer = chat_interaction::confirm_action(state, run, token, user, review).await;
    if !answer
        .as_ref()
        .is_ok_and(|value| value["status"] == "confirmed")
    {
        wallet
            .cancel_payment(user, id)
            .await
            .map_err(ConnectorError::into_domain)?;
        return Ok(stopped(&answer?));
    }
    let current = wallet
        .payment(user, id, true)
        .await
        .map_err(ConnectorError::into_domain)?;
    if let Some(confirmation) = current["confirmation_token"].as_str() {
        state.repository.agent_authority(run, token).await?;
        let result = wallet
            .confirm_payment(user, id, confirmation)
            .await
            .map_err(ConnectorError::into_domain)?;
        if result["status"] == "awaiting_payment" {
            if let Some(url) = result["payment_url"].as_str() {
                let answer =
                    chat_interaction::alipay_checkout(state, run, token, user, url.into()).await?;
                if answer["status"] == "check_payment" {
                    wallet
                        .refresh_payment(user, id, false)
                        .await
                        .map_err(ConnectorError::into_domain)?;
                }
            }
        }
    }
    let payment = wallet
        .payment(user, id, false)
        .await
        .map_err(ConnectorError::into_domain)?;
    Ok(json!({"id":id,"status":payment["status"],"payment":payment}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_didi_success_allows_rebooking() {
        let action = |result| json!({"status":"completed","result":{"structuredContent":result}});
        assert_eq!(
            didi_cancel_result(action(json!({"success":true})))["status"],
            "completed"
        );
        assert_eq!(
            didi_cancel_result(action(json!({"success":false})))["status"],
            "failed"
        );
        assert_eq!(
            didi_cancel_result(action(json!({"success":"true"})))["status"],
            "unknown_outcome"
        );
        assert_eq!(
            didi_cancel_result(action(json!({})))["status"],
            "unknown_outcome"
        );
    }

    #[test]
    fn review_displays_the_exact_order_and_rejects_unreviewable_parameters() {
        let mut action = json!({"provider":"didi","tool":"taxi_cancel_order","arguments":{"order_id":"ride-123"}});
        let review = mcp_review(&action).unwrap();
        assert_eq!(review.details, "订单号 · ride-123");
        assert_eq!(review.button, "确认取消");
        action["arguments"]["note"] = json!("x".repeat(12_001));
        assert!(mcp_review(&action).is_none());
    }
}
