//! Evidence-preserving extraction. Values are document claims, never user memories.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub(super) const PROCESSOR: &str = "photo-facts-rules-v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Fact {
    pub kind: String,
    pub value: String,
    pub evidence: String,
    pub source_kind: String,
    pub confidence: f32,
    pub needs_confirmation: bool,
}
static DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<value>(?P<y>20\d{2})[年/.-](?P<m>\d{1,2})[月/.-](?P<d>\d{1,2})日?)").unwrap()
});
static PARTIAL_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?P<value>(?P<m>\d{1,2})月(?P<d>\d{1,2})日)").unwrap());
static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?P<value>(?P<part>上午|下午|晚上|早上|中午|凌晨)?\s*(?P<h>\d{1,2})[:：](?P<m>\d{2}))",
    )
    .unwrap()
});
static ZH_CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<value>(?P<part>上午|下午|晚上|早上|中午|凌晨)?\s*(?P<h>[0-9零一二两三四五六七八九十]{1,3})[点时](?:(?P<m>[0-9零一二两三四五六七八九十]{1,3})分?|(?P<half>半))?)").unwrap()
});
static MONEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<value>(?:¥|￥|人民币|CNY|RMB|USD|\$)\s*(?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.\d{1,2})?|\d{1,9}(?:\.\d{1,2})?\s*(?:元|美元))").unwrap()
});
static PLACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:出发地|目的地|起飞地点|到达地点|会议地点|活动地点|地址|地点)\s*[:：]\s*(?P<value>[^\r\n，,；;。]{2,60})").unwrap()
});
static FLIGHT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:航班号?|Flight)\s*[:：]?\s*(?P<value>[A-Z0-9]{2}\s?[0-9]{3,4})\b").unwrap()
});

fn number(value: &str) -> Option<u32> {
    if let Ok(n) = value.parse() {
        return Some(n);
    }
    let digit = |c| match c {
        '零' => Some(0),
        '一' => Some(1),
        '二' | '两' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '七' => Some(7),
        '八' => Some(8),
        '九' => Some(9),
        _ => None,
    };
    if value == "十" {
        return Some(10);
    }
    if let Some((a, b)) = value.split_once('十') {
        Some(
            if a.is_empty() {
                1
            } else {
                digit(a.chars().next()?)?
            } * 10
                + if b.is_empty() {
                    0
                } else {
                    digit(b.chars().next()?)?
                },
        )
    } else if value.chars().count() == 1 {
        digit(value.chars().next()?)
    } else {
        None
    }
}

pub(super) fn extract(text: &str) -> Vec<Fact> {
    let mut facts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |kind: &str, value: String, evidence: &str, confidence: f32| {
        if facts.len() < 80 && seen.insert((kind.to_owned(), value.clone())) {
            facts.push(Fact {
                kind: kind.into(),
                value,
                evidence: evidence.into(),
                source_kind: "ocr".into(),
                confidence,
                needs_confirmation: true,
            });
        }
    };
    for line in text.lines().take(1000) {
        let mut dated = Vec::new();
        for c in DATE.captures_iter(line) {
            dated.push(c.get(0).unwrap().range());
            let y = c["y"].parse().unwrap_or(0);
            let m = c["m"].parse().unwrap_or(0);
            let d = c["d"].parse().unwrap_or(0);
            if let Some(date) = chrono::NaiveDate::from_ymd_opt(y, m, d) {
                add("date", date.to_string(), &c["value"], 0.98);
            }
        }
        for c in PARTIAL_DATE.captures_iter(line) {
            let span = c.get(0).unwrap().range();
            if dated
                .iter()
                .any(|r| r.start <= span.start && r.end >= span.end)
            {
                continue;
            }
            let m = c["m"].parse().unwrap_or(0);
            let d = c["d"].parse().unwrap_or(0);
            if chrono::NaiveDate::from_ymd_opt(2000, m, d).is_some() {
                add(
                    "date_without_year",
                    format!("{m:02}-{d:02}"),
                    &c["value"],
                    0.9,
                );
            }
        }
        for c in CLOCK.captures_iter(line) {
            let mut h = c["h"].parse::<u32>().unwrap_or(99);
            let m = c["m"].parse::<u32>().unwrap_or(99);
            let part = c.name("part").map(|v| v.as_str());
            if matches!(part, Some("下午" | "晚上")) && h < 12 {
                h += 12;
            }
            if part == Some("中午") && (1..=6).contains(&h) {
                h += 12;
            }
            if part == Some("凌晨") && h == 12 {
                h = 0;
            }
            if matches!(part, Some("上午" | "早上")) && h > 12 {
                continue;
            }
            if h < 24 && m < 60 {
                add("time", format!("{h:02}:{m:02}"), &c["value"], 0.96);
            }
        }
        for c in ZH_CLOCK.captures_iter(line) {
            let end = c.get(0).unwrap().end();
            if ["元", "美元", "万", "亿", "米", "公里", "%", "％", "倍"]
                .iter()
                .any(|suffix| line[end..].starts_with(suffix))
            {
                continue;
            }
            let Some(mut h) = number(&c["h"]) else {
                continue;
            };
            let m = if c.name("half").is_some() {
                Some(30)
            } else {
                c.name("m").map(|v| number(v.as_str())).unwrap_or(Some(0))
            };
            let Some(m) = m else { continue };
            let part = c.name("part").map(|v| v.as_str());
            if matches!(part, Some("下午" | "晚上")) && h < 12 {
                h += 12;
            }
            if matches!(part, Some("凌晨")) && h == 12 {
                h = 0;
            }
            if part == Some("中午") && (1..=6).contains(&h) {
                h += 12;
            }
            if matches!(part, Some("上午" | "早上")) && h > 12 {
                continue;
            }
            if h < 24 && m < 60 {
                let kind = if part.is_none() && h < 12 {
                    "time_without_period"
                } else {
                    "time"
                };
                add(kind, format!("{h:02}:{m:02}"), &c["value"], 0.9);
            }
        }
        for c in MONEY.captures_iter(line) {
            add("amount", c["value"].trim().into(), &c["value"], 0.95);
        }
        for c in PLACE.captures_iter(line) {
            add(
                "location",
                c["value"].trim().into(),
                c.get(0).unwrap().as_str(),
                0.9,
            );
        }
        for c in FLIGHT.captures_iter(line) {
            add(
                "flight_number",
                c["value"].replace(' ', ""),
                c.get(0).unwrap().as_str(),
                0.95,
            );
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_document_claims_with_exact_evidence_without_assuming_ownership_or_year() {
        let input = "朋友的机票\n2026年10月28日 下午三点半\n航班：MU5810\n出发地：上海\n目的地：昆明\n金额：￥1280.50\n收藏：11月3日 09:20";
        let facts = extract(input);
        for (kind, value) in [
            ("date", "2026-10-28"),
            ("time", "15:30"),
            ("flight_number", "MU5810"),
            ("location", "上海"),
            ("location", "昆明"),
            ("date_without_year", "11-03"),
            ("time", "09:20"),
        ] {
            assert!(
                facts.iter().any(|f| f.kind == kind && f.value == value),
                "missing {kind} {value}"
            );
        }
        assert!(facts.iter().all(|f| input.contains(&f.evidence)
            && f.needs_confirmation
            && f.source_kind == "ocr"));
        assert_eq!(
            facts
                .iter()
                .filter(|f| f.kind == "date_without_year")
                .count(),
            1
        );
        assert!(
            facts
                .iter()
                .any(|f| f.kind == "amount" && f.value == "￥1280.50")
        );
    }
    #[test]
    fn rejects_invalid_dates_times_and_does_not_turn_arbitrary_numbers_into_money() {
        let facts = extract("2026年2月30日 25:90 17380470000 123456\n三点");
        assert!(
            !facts
                .iter()
                .any(|f| ["date", "amount", "time"].contains(&f.kind.as_str()))
        );
        assert!(facts.iter().any(|f| f.kind == "time_without_period"));
    }
    #[test]
    fn normalizes_explicit_periods_without_treating_decimal_prices_as_times() {
        let facts = extract("下午3:30\n中午一点半\n价格三点五元\n上午15点");
        assert!(facts.iter().any(|f| f.kind == "time" && f.value == "15:30"));
        assert!(facts.iter().any(|f| f.kind == "time" && f.value == "13:30"));
        assert_eq!(facts.len(), 2);
    }
}
