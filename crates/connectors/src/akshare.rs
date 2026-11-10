//! Operator-managed, read-only AKTools MCP access to public market data.
use std::{net::IpAddr, time::Duration};

use axum::http::StatusCode;
use chrono::{NaiveDate, Utc};
use reqwest::{
    Client, Url,
    header::{AUTHORIZATION, HeaderMap, HeaderValue},
    redirect::Policy,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{ConnectorError, Result, personal_mcp::transport::call_managed_http};

const CALENDAR: &str = "tool_trade_date_hist_sina";
const DAILY: &str = "stock_zh_a_hist";
const CALENDAR_LIMIT: usize = 1000;
const DAILY_LIMIT: usize = 366;

#[derive(Clone)]
pub struct Akshare {
    client: Client,
    url: Url,
    headers: HeaderMap,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    dataset: Dataset,
    start_date: String,
    end_date: String,
    symbol: Option<String>,
    adjust: Option<Adjustment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Dataset {
    TradingCalendar,
    AShareDaily,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Adjustment {
    #[default]
    None,
    Qfq,
    Hfq,
}

impl Adjustment {
    fn value(&self) -> &'static str {
        match self {
            Self::None => "",
            Self::Qfq => "qfq",
            Self::Hfq => "hfq",
        }
    }
}

fn private_host(host: &str) -> bool {
    if matches!(host, "localhost" | "aktools") {
        return true;
    }
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        Err(_) => false,
    }
}

fn invalid(message: &'static str) -> ConnectorError {
    ConnectorError::new(StatusCode::BAD_REQUEST, "akshare_invalid_query", message)
}

fn unavailable() -> ConnectorError {
    ConnectorError::new(
        StatusCode::BAD_GATEWAY,
        "akshare_unavailable",
        "AKShare 暂时无法返回数据，请稍后重试",
    )
}

fn date(value: &str) -> Option<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    (value.len() == 10 && parsed.format("%Y-%m-%d").to_string() == value).then_some(parsed)
}

fn row_date(value: &Value) -> Option<NaiveDate> {
    let text = value.as_str()?;
    date(text).or_else(|| {
        chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
            .ok()
            .map(|time| time.date())
    })
}

fn result_rows(result: &Value) -> Result<Vec<Value>> {
    if result["isError"] == true {
        return Err(unavailable());
    }
    let legacy;
    let data = if result["structuredContent"].is_object() {
        &result["structuredContent"]
    } else {
        // Older FastMCP releases serialize the object in a single text block.
        let block = result["content"]
            .as_array()
            .filter(|items| items.len() == 1)
            .and_then(|items| items.first())
            .filter(|block| block["type"] == "text")
            .and_then(|block| block["text"].as_str())
            .ok_or_else(unavailable)?;
        legacy = serde_json::from_str::<Value>(block).map_err(|_| unavailable())?;
        &legacy
    };
    // AKTools 0.1.4's FastMCP server wraps a dictionary return in result.
    data.get("rows")
        .or_else(|| data.pointer("/result/rows"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(unavailable)
}

impl Akshare {
    pub fn from_env() -> Result<Option<Self>> {
        let address = std::env::var("AKSHARE_MCP_URL").unwrap_or_default();
        if address.trim().is_empty() {
            return Ok(None);
        }
        let token = std::env::var("AKSHARE_MCP_TOKEN").unwrap_or_default();
        Self::new(address.trim(), token.trim()).map(Some)
    }

    pub fn new(address: &str, token: &str) -> Result<Self> {
        let invalid_url =
            || invalid("AKSHARE_MCP_URL 须为可信的 /mcp 地址，使用 HTTPS 或内网 HTTP");
        let url = Url::parse(address).map_err(|_| invalid_url())?;
        if !(url.scheme() == "https"
            || (url.scheme() == "http" && url.host_str().is_some_and(private_host)))
            || url.path() != "/mcp"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid_url());
        }
        let mut headers = HeaderMap::new();
        if !token.is_empty() {
            if token.len() > 4096 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
                return Err(invalid("AKSHARE_MCP_TOKEN 格式无效"));
            }
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| invalid("AKSHARE_MCP_TOKEN 格式无效"))?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|_| unavailable())?;
        Ok(Self {
            client,
            url,
            headers,
        })
    }

    pub async fn query(&self, arguments: Value) -> Result<Value> {
        let query: Query =
            serde_json::from_value(arguments).map_err(|_| invalid("AKShare 查询参数无效"))?;
        let start = date(&query.start_date).ok_or_else(|| invalid("开始日期须为 YYYY-MM-DD"))?;
        let end = date(&query.end_date).ok_or_else(|| invalid("结束日期须为 YYYY-MM-DD"))?;
        if !(0..=365).contains(&(end - start).num_days()) {
            return Err(invalid("查询日期须按先后排列，每次最多查询 366 天"));
        }
        let (source, params, date_key, limit) = match query.dataset {
            Dataset::TradingCalendar if query.symbol.is_none() && query.adjust.is_none() => (
                "新浪财经",
                json!({"name": CALENDAR, "max_rows": CALENDAR_LIMIT, "offset": -(CALENDAR_LIMIT as i32)}),
                "trade_date",
                CALENDAR_LIMIT,
            ),
            Dataset::TradingCalendar => return Err(invalid("交易日历无需股票代码或复权方式")),
            Dataset::AShareDaily => {
                let symbol = query
                    .symbol
                    .as_deref()
                    .filter(|value| {
                        value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    .ok_or_else(|| invalid("A 股股票代码须为 6 位数字"))?;
                let adjust = query
                    .adjust
                    .as_ref()
                    .map(Adjustment::value)
                    .unwrap_or_default();
                (
                    "东方财富",
                    json!({"name": DAILY, "max_rows": DAILY_LIMIT, "params":{
                        "symbol":symbol, "period":"daily", "adjust":adjust,
                        "start_date":start.format("%Y%m%d").to_string(), "end_date":end.format("%Y%m%d").to_string(),
                    }}),
                    "日期",
                    DAILY_LIMIT,
                )
            }
        };
        let result = call_managed_http(
            self.client.clone(),
            self.url.clone(),
            self.headers.clone(),
            "get_data",
            params,
        )
        .await
        .map_err(|_| unavailable())?;
        let raw = result_rows(&result)?;
        if raw.len() > limit {
            return Err(unavailable());
        }
        let mut dated = raw
            .iter()
            .map(|row| {
                row_date(&row[date_key])
                    .map(|day| (day, row))
                    .ok_or_else(unavailable)
            })
            .collect::<Result<Vec<_>>>()?;
        dated.sort_by_key(|(day, _)| *day);
        let coverage_start = dated.first().map(|(day, _)| *day);
        let coverage_end = dated.last().map(|(day, _)| *day);
        let rows: Vec<_> = dated
            .into_iter()
            .filter(|(day, _)| (start..=end).contains(day))
            .map(|(day, row)| match query.dataset {
                Dataset::TradingCalendar => json!({"date":day.to_string()}),
                Dataset::AShareDaily => {
                    let number = |key: &str| row.get(key).filter(|value| value.is_number());
                    json!({"date":day.to_string(), "open":number("开盘"), "close":number("收盘"),
                        "high":number("最高"), "low":number("最低"), "volume_lots":number("成交量"),
                        "amount_cny":number("成交额")})
                }
            })
            .collect();
        let mut response = json!({"provider":"AKShare", "source":source, "dataset":params_name(&query.dataset),
            "start_date":query.start_date, "end_date":query.end_date, "fetched_at":Utc::now().to_rfc3339(),
            "rows":rows});
        match query.dataset {
            Dataset::TradingCalendar => {
                response["available_from"] = json!(coverage_start.map(|day| day.to_string()));
                response["available_to"] = json!(coverage_end.map(|day| day.to_string()));
                response["coverage_complete"] = json!(
                    coverage_start.is_some_and(|day| start >= day)
                        && coverage_end.is_some_and(|day| end <= day)
                );
            }
            Dataset::AShareDaily => {
                response["symbol"] = json!(query.symbol);
                response["adjust"] = json!(
                    query
                        .adjust
                        .as_ref()
                        .map(Adjustment::value)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("none")
                );
            }
        }
        Ok(response)
    }
}

fn params_name(dataset: &Dataset) -> &'static str {
    match dataset {
        Dataset::TradingCalendar => CALENDAR,
        Dataset::AShareDaily => DAILY,
    }
}
