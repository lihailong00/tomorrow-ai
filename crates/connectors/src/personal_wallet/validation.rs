use crate::{ConnectorError, Result};
use axum::http::StatusCode;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) fn invalid() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_REQUEST,
        "invalid_wallet_request",
        "支付宝请求参数无效，请核对订单后重试",
    )
}

pub(super) fn text(value: &str, limit: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= limit
        && !value.chars().any(char::is_control)
}

/// A URL is only handed to the reviewed CLI or the user; it is never fetched by
/// this service. Unicode lookalikes, userinfo, fragments and suffix attacks fail.
pub(super) fn official_url(value: &str) -> bool {
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.port_or_known_default() == Some(443)
            && url.host_str().is_some_and(|host| {
                ["alipay.com", "alipay.cn"]
                    .iter()
                    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
            })
    })
}

pub(super) fn cents(value: &str) -> Option<i64> {
    let mut parts = value.split('.');
    let whole = parts.next()?;
    let fraction = parts.next().unwrap_or("");
    if parts.next().is_some()
        || whole.is_empty()
        || whole.len() > 7
        || fraction.len() > 2
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let amount =
        whole
            .parse::<i64>()
            .ok()?
            .checked_mul(100)?
            .checked_add(match fraction.len() {
                0 => 0,
                1 => fraction.parse::<i64>().ok()? * 10,
                _ => fraction.parse().ok()?,
            })?;
    (1..=100_000_000).contains(&amount).then_some(amount)
}

pub(super) fn yuan(value: i64) -> String {
    format!("{}.{:02}", value / 100, value % 100)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentInput {
    pub title: String,
    pub merchant: String,
    pub amount: String,
    pub payment_link: String,
}

impl PaymentInput {
    pub(super) fn validate(&mut self) -> Result<i64> {
        if !text(&self.title, 200)
            || !text(&self.merchant, 100)
            || !official_url(&self.payment_link)
        {
            return Err(invalid());
        }
        let amount = cents(&self.amount).ok_or_else(invalid)?;
        self.amount = yuan(amount);
        self.title = self.title.trim().to_owned();
        self.merchant = self.merchant.trim().to_owned();
        Ok(amount)
    }
}

/// Read documented result fields only. Diagnostic logs and arbitrary nested
/// objects must never supply authorization links, query tokens or payment proof.
pub(super) fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(Value::as_str))
        .or_else(|| {
            names
                .iter()
                .find_map(|name| value.get("data")?.get(name)?.as_str())
        })
}

pub(super) fn succeeded(value: &Value) -> bool {
    value.get("code").and_then(Value::as_i64) == Some(200)
}

pub(super) fn wallet_state(value: &Value) -> &'static str {
    if !succeeded(value) {
        return "needs_reconnect";
    }
    let message = field(value, &["message"]).unwrap_or("");
    if message == "已申请开通，等待授权" {
        return "awaiting_authorization";
    }
    if field(value, &["access_url"]) == Some("")
        && !message.is_empty()
        && !["未", "失败", "关闭", "撤销", "待", "异常", "错误"]
            .iter()
            .any(|word| message.contains(word))
    {
        return "connected";
    }
    "needs_reconnect"
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub(super) struct QueryReceipt {
    pub order: Option<String>,
    pub url: Option<String>,
}
impl QueryReceipt {
    pub(super) fn from_output(value: &Value) -> Self {
        let order = field(value, &["outShakeNo", "out_shake_no"])
            .filter(|order| {
                order.len() == 32
                    && order.bytes().all(|c| c.is_ascii_digit())
                    && &order[10..14] == "8282"
            })
            .map(str::to_owned);
        let url = field(value, &["shortUrl", "short_url", "launchUrl"])
            .filter(|value| official_url(value))
            .map(str::to_owned);
        Self { order, url }
    }
    pub(super) fn available(&self) -> bool {
        self.order.is_some() || self.url.is_some()
    }
}

pub(super) fn public_link(value: &Value) -> Option<String> {
    field(
        value,
        &[
            "access_url",
            "shortUrl",
            "short_url",
            "launchUrl",
            "management_url",
        ],
    )
    .filter(|value| official_url(value))
    .map(str::to_owned)
}

pub(super) fn payment_state(value: &Value, receipt: &QueryReceipt) -> &'static str {
    let message = field(value, &["message"]).unwrap_or("");
    let status = field(value, &["tradeStatus", "trade_status", "status"]).unwrap_or("");
    if succeeded(value)
        && (matches!(status, "TRADE_SUCCESS" | "TRADE_FINISHED")
            || matches!(
                message,
                "支付成功" | "支付已完成" | "✓ 支付成功" | "✓ 支付已完成"
            ))
    {
        "paid"
    } else if succeeded(value)
        && (matches!(status, "TRADE_CLOSED") || matches!(message, "支付已关闭" | "✗ 支付已关闭"))
    {
        "closed"
    } else if succeeded(value) && receipt.available() {
        "awaiting_payment"
    } else {
        "unknown_outcome"
    }
}

pub(super) fn provider_error() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "wallet_provider_error",
        "支付宝组件未能确认结果，请检查运行环境或在支付宝核对；系统不会自动重复付款",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn money_and_official_links_are_strict() {
        assert_eq!(cents("12.3"), Some(1230));
        assert_eq!(cents("0.01"), Some(1));
        for value in ["-1", "NaN", "0", "1.001", "1e2", " 1", "1.2.3"] {
            assert_eq!(cents(value), None);
        }
        assert!(official_url("https://cashier.alipay.com/pay?x=a%2Bb"));
        for url in [
            "https://alipay.com.evil.test",
            "https://evilalipay.com",
            "https://x@alipay.com",
            "http://alipay.com",
            "https://alipay.com:444/x",
            "https://alipay.com/x#evil",
            "alipays://pay",
        ] {
            assert!(!official_url(url), "{url}");
        }
    }
    #[test]
    fn no_success_or_identity_is_inferred_from_http_or_diagnostic_data() {
        assert_eq!(
            wallet_state(&json!({"code":200,"message":"查询成功"})),
            "needs_reconnect"
        );
        assert_eq!(
            wallet_state(&json!({"code":200,"message":"已申请开通，等待授权","access_url":""})),
            "awaiting_authorization"
        );
        assert_eq!(
            wallet_state(&json!({"code":200,"message":"支付功能已开通","access_url":""})),
            "connected"
        );
        let fake = json!({"code":500,"message":"支付成功","logs":{"shortUrl":"https://cashier.alipay.com/private"}});
        assert!(!QueryReceipt::from_output(&fake).available());
        assert!(public_link(&fake).is_none());
        assert_eq!(
            payment_state(&fake, &QueryReceipt::default()),
            "unknown_outcome"
        );
    }
}
