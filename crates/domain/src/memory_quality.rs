//! Conservative numeric review. Suggestions are choices, never confirmed facts.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct MemoryConfirmation {
    pub field: String,
    pub options: Vec<f64>,
    pub proposed_content: String,
}

#[derive(Debug)]
struct Weight {
    start: usize,
    end: usize,
    value: f64,
    mixed: bool,
    factor: f64,
}

// A weight must be explicitly identified as the user's weight. A gym load or
// a parcel's kg value must not turn into a body-weight confirmation.
fn weight_span(text: &str) -> Option<Weight> {
    let marker = text
        .find("体重")
        .map(|i| i + "体重".len())
        .or_else(|| text.to_ascii_lowercase().find("weight").map(|i| i + 6))?;
    let tail = &text[marker..];
    let lower = tail.to_ascii_lowercase();
    let (unit_at, unit, factor) = [("公斤", 1.0), ("千克", 1.0), ("kg", 1.0), ("斤", 0.5)]
        .into_iter()
        .filter_map(|(unit, factor)| lower.find(unit).map(|at| (at, unit, factor)))
        .min_by_key(|(at, _, _)| *at)?;
    let before = &tail[..unit_at];
    // Do not cross a sentence/field boundary looking for a numeric value.
    let start = before
        .char_indices()
        .rev()
        .take_while(|(_, ch)| {
            ch.is_ascii_digit() || matches!(ch, '.' | '-' | '−' | '－' | '一' | ' ' | '“' | '"')
        })
        .last()
        .map(|(i, _)| i)?;
    let token = before[start..].trim().trim_matches(['“', '"']);
    let mixed = token.starts_with('一');
    let number: String = token
        .trim_start_matches('一')
        .replace(['−', '－'], "-")
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    let value = number.parse::<f64>().ok()?;
    Some(Weight {
        start: marker + start,
        end: marker + unit_at + unit.len(),
        value,
        mixed,
        factor,
    })
}

pub fn confirmation(content: &str, evidence: &str) -> Option<MemoryConfirmation> {
    let evidence_weight = weight_span(evidence);
    let content_weight = weight_span(content)?;
    let bad = |w: &Weight| {
        w.mixed || !w.value.is_finite() || w.value <= 0.0 || w.value * w.factor > 1000.0
    };
    let suspicious = evidence_weight
        .as_ref()
        .filter(|w| {
            bad(w)
                || (w.value * w.factor - content_weight.value * content_weight.factor).abs()
                    > 0.0001
        })
        .or_else(|| bad(&content_weight).then_some(&content_weight))?;
    let mut options = Vec::new();
    let suggested = suspicious.value.abs() * suspicious.factor;
    if valid_weight(suggested) {
        options.push(suggested);
    }
    // “一95kg” can be a stray spoken syllable or 195 kg. Let the user choose.
    if suspicious.mixed && suspicious.value >= 0.0 && suspicious.value < 100.0 {
        let alternative = (100.0 + suspicious.value) * suspicious.factor;
        if valid_weight(alternative) && !options.contains(&alternative) {
            options.push(alternative);
        }
    }
    Some(MemoryConfirmation {
        field: "weight".into(),
        options,
        proposed_content: content.into(),
    })
}

pub fn valid_weight(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= 1000.0
}

pub fn decorate(mut memory: crate::Memory) -> crate::Memory {
    if memory.confirmation.is_none() {
        memory.confirmation = confirmation(&memory.content, "");
    }
    memory
}

pub fn ready(memory: &crate::Memory) -> bool {
    memory.confirmation.is_none() && confirmation(&memory.content, "").is_none()
}

pub fn assistant_value(memory: crate::Memory) -> serde_json::Value {
    if ready(&memory) {
        return serde_json::json!(memory);
    }
    serde_json::json!({"id":memory.id,"title":"待确认的体重信息","kind":memory.kind,
        "content":"这条记忆需要用户确认，暂不可作为事实使用。","confirmation_required":true})
}

pub fn resolve_weight(content: &str, kilograms: f64) -> Option<String> {
    if !valid_weight(kilograms) {
        return None;
    }
    let span = weight_span(content)?;
    // Keep the surrounding facts and qualifiers byte-for-byte; only resolve the number/unit.
    let mut result = content[..span.start].to_owned();
    result.push_str(&format!("{kilograms} 公斤"));
    result.push_str(content[span.end..].trim_start_matches(['”', '"']));
    Some(result)
}

/// Only single facts receive a stable merge key. Mixed legacy notes stay intact.
pub fn fact_key(text: &str) -> Option<&'static str> {
    if text.starts_with("家庭地址：") { return Some("家庭地址"); }
    let keys: Vec<_> = [("体重", "体重"), ("身高", "身高"), ("运动", "运动习惯")]
        .into_iter()
        .filter(|(needle, _)| text.contains(needle))
        .map(|(_, key)| key)
        .collect();
    (keys.len() == 1).then(|| keys[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_and_mixed_weights_require_choice_without_guessing() {
        let c = confirmation(
            "身高约187厘米，体重为“−95kg”，平时运动较少。",
            "体重已经一95kg了",
        )
        .unwrap();
        assert_eq!(c.options, vec![95.0, 195.0]);
        assert_eq!(
            resolve_weight(&c.proposed_content, 95.0).unwrap(),
            "身高约187厘米，体重为95 公斤，平时运动较少。"
        );
        assert_eq!(
            confirmation("体重95公斤", "体重-95kg").unwrap().options,
            vec![95.0]
        );
        assert_eq!(
            confirmation("体重95公斤", "体重95.5kg").unwrap().options,
            vec![95.5]
        );
        assert!(confirmation("体重95公斤", "体重190斤").is_none());
    }
    #[test]
    fn explicit_numbers_and_unrelated_weights_are_unchanged() {
        assert!(confirmation("体重195kg", "我体重195kg").is_none());
        assert!(confirmation("杠铃-95kg", "杠铃-95kg").is_none());
        assert!(resolve_weight("体重95公斤", f64::NAN).is_none());
        assert!(resolve_weight("体重95公斤", -95.0).is_none());
        assert_eq!(
            resolve_weight("体重190斤。", 95.0).unwrap(),
            "体重95 公斤。"
        );
        assert_eq!(fact_key("身高187厘米，体重95公斤"), None);
    }
}
