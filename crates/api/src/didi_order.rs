use super::{AppState, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tomorrow_connectors::ConnectorError;
use tomorrow_domain::DomainError;

pub(crate) fn requests_cancel_then_rebook(message: &str) -> bool {
    let Some((before, after)) = message.split_once("取消") else { return false; };
    !["不", "别", "不要", "不用"].iter().any(|word| before.trim_end().ends_with(word))
        && ["重新叫车", "重新打车", "重新下单", "再叫车", "再打车", "再下一单"]
            .iter().any(|phrase| after.contains(phrase))
}

pub(crate) fn is_home_trip(message: &str) -> bool {
    let trim = |character: char| character.is_whitespace() || "，,。.!！?？".contains(character);
    let mut request = message.trim_matches(trim);
    let prefixes = ["麻烦", "帮我", "给我", "我", "现在", "马上", "想要", "准备", "打算", "需要", "要", "想", "请"];
    while let Some(rest) = prefixes.iter().find_map(|prefix| request.strip_prefix(prefix)) {
        request = rest.trim_start_matches(trim);
    }
    ["打车回家", "叫车回家", "打车回我家", "叫车回我家", "回家打车", "回家叫车"]
        .iter()
        .filter_map(|phrase| request.strip_prefix(phrase))
        .any(|tail| matches!(tail.trim_matches(trim),
            "" | "了" | "吧" | "要多少钱" | "多少钱" | "大概多少钱"))
}

pub(crate) async fn request_home_destination(
    state: &AppState,
    ticket: &tomorrow_domain::agent::RunTicket,
    user: &str,
) -> Result<Value> {
    use crate::personal_autofill::{Field, PersonalField};

    crate::chat_interaction::personal_details(
        state, &ticket.id, &ticket.token, user, "滴滴出行", "查路线和报价",
        "补充这次的目的地，填好后继续查路线和预估车费。叫车还需要你确认。",
        "home",
        vec![Field {
            key: "address".into(),
            label: "家庭地址".into(),
            semantic: PersonalField::Address,
            value: String::new(),
            source: "用于这次出行".into(),
            required: true,
        }],
        serde_json::Map::new(),
        json!({
            "type": "object",
            "properties": {"address": {"type": "string", "minLength": 2, "maxLength": 200}},
            "required": ["address"],
        }),
    ).await
}

#[derive(Clone, Serialize)]
pub(crate) struct Summary {
    from: String,
    to: String,
    products: Vec<Product>,
    sandbox: bool,
    phone_suffix: Option<String>,
    #[serde(skip)]
    destination: Option<[f64; 2]>,
}

#[derive(Clone, Serialize)]
struct Product {
    #[serde(skip)]
    category: String,
    name: String,
    price: String,
}

pub(crate) struct Quote {
    trace: String,
    from: String,
    to: String,
    products: Vec<Product>,
    sandbox: bool,
    destination: Option<[f64; 2]>,
    pub generation: i64,
    pub expires: Instant,
}

fn text(value: &Value, max: usize) -> Option<&str> {
    let value = value.as_str()?.trim();
    (!value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control))
        .then_some(value)
}

fn quote_destination(arguments: &Value) -> Option<[f64; 2]> {
    let axis = |key: &str| arguments[key].as_f64()
        .or_else(|| arguments[key].as_str()?.trim().parse::<f64>().ok());
    let (lng, lat) = (axis("to_lng")?, axis("to_lat")?);
    ((-180.0..=180.0).contains(&lng) && (-90.0..=90.0).contains(&lat)
        && (lng != 0.0 || lat != 0.0)).then_some([lng, lat])
}

impl Quote {
    pub fn read(arguments: &Value, result: &Value, generation: i64, sandbox: bool) -> Option<Self> {
        if result["status"] != "completed" {
            return None;
        }
        let content = &result["result"]["structuredContent"];
        let products = content["items"]
            .as_array()?
            .iter()
            .take(64)
            .filter_map(|item| {
                Some(Product {
                    category: text(&item["productCategory"], 40)?.into(),
                    name: text(&item["productName"], 80)?.into(),
                    price: text(&item["priceText"], 80)?.into(),
                })
            })
            .collect::<Vec<_>>();
        if products.is_empty() {
            return None;
        }
        Some(Self {
            trace: text(&content["traceId"], 160)?.into(),
            from: text(&arguments["from_name"], 200)?.into(),
            to: text(&arguments["to_name"], 200)?.into(),
            products,
            sandbox,
            destination: quote_destination(arguments),
            generation,
            expires: Instant::now() + Duration::from_secs(120),
        })
    }

    pub fn summary(&self, arguments: &Value) -> Option<Summary> {
        if self.expires <= Instant::now()
            || arguments["estimate_trace_id"].as_str()? != self.trace
            || arguments.as_object()?.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "estimate_trace_id" | "product_category" | "caller_car_phone"
                )
            })
        {
            return None;
        }
        let mut products = Vec::new();
        for category in text(&arguments["product_category"], 250)?.split(',') {
            if products.len() >= 6
                || products
                    .iter()
                    .any(|item: &Product| item.category == category)
            {
                return None;
            }
            products.push(
                self.products
                    .iter()
                    .find(|item| item.category == category)?
                    .clone(),
            );
        }
        let phone_suffix = match arguments.get("caller_car_phone") {
            Some(phone) => {
                let phone = phone.as_str()?;
                if !(7..=15).contains(&phone.len())
                    || !phone.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return None;
                }
                Some(phone[phone.len() - 4..].to_owned())
            }
            None => None,
        };
        Some(Summary {
            from: self.from.clone(),
            to: self.to.clone(),
            products,
            sandbox: self.sandbox,
            phone_suffix,
            destination: self.destination,
        })
    }
}

pub(crate) async fn confirm_in_chat(
    state: &AppState,
    run: &str,
    token: &str,
    user: &str,
    arguments: Value,
    operation_key: &str,
) -> Result<Value> {
    if state.interactions.didi_cancellation_blocks_order(run, user) {
        return Ok(json!({"status":"requires_ride_cancellation",
            "message":"原滴滴订单还未核实为已取消，本轮不能继续叫车。若尚未发起取消，可在对话里发起；若已发起，只核实原单状态，不要重复提交。"}));
    }
    let Some((summary, generation, expires)) =
        state.interactions.claim_didi_order(run, user, &arguments)
    else {
        return Ok(
            json!({"status":"unavailable","message":"无法展示有效的叫车确认卡：没有匹配的本轮滴滴报价，或本轮已发起过确认。尚未下单，请勿重复提交。"}),
        );
    };
    let destination = summary.destination;
    let answer = super::chat_interaction::didi_order(state, run, token, user, summary).await?;
    if answer["status"] != "confirmed" {
        return Ok(
            json!({"status":answer["status"],"message":"用户未确认，尚未叫车；结束本次下单。"}),
        );
    }
    if expires <= Instant::now() {
        return Ok(
            json!({"status":"expired","message":"滴滴报价已过期，尚未叫车。请在用户发起新请求时重新报价。"}),
        );
    }
    let mcp = state
        .personal_mcp
        .as_ref()
        .ok_or_else(|| DomainError::Validation("个人 MCP 连接服务尚未配置".into()))?;
    let draft = mcp
        .prepare_didi_order(user, arguments, operation_key, generation, destination)
        .await
        .map_err(ConnectorError::into_domain)?;
    let id = draft["action"]["id"]
        .as_str()
        .ok_or(DomainError::NotFound)?;
    state.repository.agent_authority(run, token).await?;
    let action = mcp
        .confirm(user, id)
        .await
        .map_err(ConnectorError::into_domain)?;
    let order_id = action["result"]["structuredContent"]["orderId"]
        .as_str()
        .filter(|id| !id.is_empty());
    let status = match action["status"].as_str() {
        Some("completed") if order_id.is_none() => "unknown_outcome",
        Some("pending") | None => "unknown_outcome",
        Some(status) => status,
    };
    Ok(json!({"id":id,"status":status,"order_id":order_id,
        "message":"已处理对话中的确认。仅在 completed 且有订单号时告知已下单；执行中或结果不明时先核实，禁止重复下单。"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_requested_cancel_then_rebook_sequence() {
        assert!(requests_cancel_then_rebook("可以，那你取消，然后重新叫车吧。"));
        assert!(requests_cancel_then_rebook("先取消这单，再打车去虹桥。"));
        assert!(!requests_cancel_then_rebook("不要取消，另外重新叫车。"));
        assert!(!requests_cancel_then_rebook("麻烦取消这单。"));
    }
    #[test]
    fn recognizes_direct_home_trips_without_capturing_other_requests() {
        for message in ["我现在要打车回家了。", "请帮我叫车回家", "打车回家多少钱？"] {
            assert!(is_home_trip(message), "{message}");
        }
        for message in ["我不想打车回家", "我现在在哪点，你都没给我推卡片。",
            "我要从公司打车回家", "我想知道打车回家怎么写进小说", "打车回家是病句吗"] {
            assert!(!is_home_trip(message), "{message}");
        }
    }

    #[test]
    fn card_displays_vendor_quote_for_the_exact_order_and_masks_phone() {
        let quote = Quote::read(
            &json!({"from_name":"上车点 A","to_name":"目的地 B","to_lng":"121.17","to_lat":"31.15"}),
            &json!({"status":"completed","result":{"structuredContent":{"traceId":"trace",
                "items":[{"productCategory":"1","productName":"快车","priceText":"31.50"}]}}}),
            1,
            true,
        )
        .unwrap();
        let mut args = json!({"estimate_trace_id":"trace","product_category":"1","caller_car_phone":"13800001234"});
        let summary = quote.summary(&args).unwrap();
        assert_eq!(summary.destination, Some([121.17, 31.15]));
        let card = serde_json::to_value(summary).unwrap();
        assert_eq!(
            card,
            json!({"from":"上车点 A","to":"目的地 B","products":[{"name":"快车","price":"31.50"}],"sandbox":true,"phone_suffix":"1234"})
        );
        args["product_category"] = json!("1,2");
        assert!(quote.summary(&args).is_none());
        args["product_category"] = json!("1");
        args["estimate_trace_id"] = json!("another-trace");
        assert!(quote.summary(&args).is_none());
    }
}
