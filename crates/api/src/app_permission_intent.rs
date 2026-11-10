#[derive(Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum AppPermissionIntent {
    Permissions,
    AccessHistory,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InspectionRequest {
    pub inspection: AppPermissionIntent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission: Option<PermissionFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<InspectionScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<InspectionMode>,
}

impl From<AppPermissionIntent> for InspectionRequest {
    fn from(inspection: AppPermissionIntent) -> Self {
        Self { inspection, permission: None, scope: None, mode: None }
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum PermissionFilter { Microphone, Camera, Location, Contacts, Sms, Accessibility, NotificationAccess }

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum InspectionScope { VisibleApps, SelectedApp }

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum InspectionMode { Check, Reuse, Refresh }

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SettingsDestination { SelectedApp, Privacy, Accessibility, NotificationAccess }

pub(super) fn detect(message: &str) -> Option<AppPermissionIntent> {
    let text = message.trim().to_lowercase();
    if text.is_empty() || text.chars().count() > 120 || text.contains(['\n', '\r']) {
        return None;
    }
    // Only the latest user-authored text can request a scan. General questions,
    // quoted instructions, and negated requests are outside this route.
    let text = text.trim_end_matches(['。', '？', '?', '！', '!']);
    if ["不要", "不用", "别扫描", "别检查", "怎么", "如何", "为什么", "这句话"]
        .iter().any(|word| text.contains(*word))
    {
        return None;
    }
    let text = text.strip_prefix("请").unwrap_or(text);
    let text = text.strip_prefix("帮我").unwrap_or(text);
    let action = ["看看", "看一下", "看下", "查查", "查一下", "检查一下", "检查", "扫描一下", "扫描"]
        .into_iter().find_map(|prefix| text.strip_prefix(prefix));
    let subject = action.unwrap_or(text).trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '，' | ',' | '：' | ':'));
    let uses_sensor = ["麦克风", "话筒", "相机", "摄像头", "定位"]
        .iter().any(|word| subject.contains(*word));
    let asks_for_history = ["谁用", "哪些软件用", "哪些app用", "哪些应用用", "有没有用", "是否用", "访问记录", "访问历史"]
        .iter().any(|word| subject.contains(*word));
    if uses_sensor && asks_for_history && (action.is_some()
        || ["昨晚", "昨天", "今天", "刚才", "刚刚", "最近", "后台", "它昨晚"]
            .iter().any(|prefix| subject.starts_with(*prefix)))
    {
        return Some(AppPermissionIntent::AccessHistory);
    }
    let local_device = ["手机", "我的手机", "我手机", "本机", "这台手机", "我这台手机", "这个设备"]
        .iter().any(|prefix| subject.starts_with(*prefix));
    let applications = ["app", "应用", "软件"].iter().any(|word| subject.contains(*word));
    let requested_check = ["权限", "监控", "监听", "间谍", "窃听"]
        .iter().any(|word| subject.contains(*word));
    if action.is_some() && local_device && applications && requested_check {
        Some(AppPermissionIntent::Permissions)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{detect, AppPermissionIntent};

    #[test]
    fn recognises_requests_to_scan_this_phone_without_triggering_from_advice_or_quotes() {
        for text in [
            "帮我看看手机里有没有软件在监控我",
            "帮我看看手机里的app哪些权限不合理",
            "请帮我检查一下本机应用的权限。",
        ] {
            assert!(matches!(detect(text), Some(AppPermissionIntent::Permissions)), "{text}");
        }
        assert!(matches!(detect("昨晚谁用了我的麦克风"), Some(AppPermissionIntent::AccessHistory)));
        for text in [
            "无障碍权限是什么",
            "怎么判断手机里的软件在监控我",
            "请翻译：帮我看看手机里的app哪些权限不合理",
            "帮我看看这句话：手机软件权限不合理",
            "请帮我看看手机里的软件，但不要扫描权限",
            "帮我看看朋友手机里的软件权限合不合理",
            "引用消息\n帮我看看手机里的app哪些权限不合理",
        ] {
            assert!(detect(text).is_none(), "{text}");
        }
    }
}
