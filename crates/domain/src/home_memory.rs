//! Recognize only user-owned, explicitly attributed home addresses.
//! No geocoding, model inference, assistant text or device location is evidence.
pub(crate) fn candidate(current: &str, previous: &[&str]) -> Option<String> {
    let text = current.trim();
    let excluded = ["不要记", "别记", "不用记", "不保存", "忘记", "不是我家", "以前", "曾经", "原来", "临时", "酒店", "旅馆", "公司", "办公室", "朋友", "同事", "客户", "父母", "爸妈", "他家", "她家", "假设", "假如", "比如", "例如", "引用", "角色扮演", "帮我写", "验证码", "密码", "身份证", "银行卡"];
    if text.chars().count() > 220 || excluded.iter().any(|s| text.contains(s)) || text.ends_with(['?', '？']) { return None; }
    let explicit = ["我的家庭地址是", "我的家庭地址", "我家的地址是", "我家的地址", "我家地址是", "我家地址", "我的住址是", "我的住址", "我现在住在", "我家住在", "我住在", "我家在", "我的新家在", "我搬家到", "我已经搬到"]
        .iter().filter_map(|marker| text.find(marker).map(|at| at + marker.len())).max();
    let address = if let Some(at) = explicit {
        text[at..].trim_start_matches([' ', '：', ':', '是', '在'])
    } else {
        // A bare follow-up address is attributable only to a recent user request
        // to go home. A later destination change invalidates that relationship.
        let mut home = false;
        for prior in previous {
            if excluded.iter().any(|s| prior.contains(s)) || ["去公司", "换个地方", "改去", "不回家"].iter().any(|s| prior.contains(s)) { home = false; }
            else if ["回家", "回我家", "到我家", "去我家", "目的地是我家", "我家地址", "我的家庭地址", "我的住址"].iter().any(|s| prior.contains(s)) { home = true; }
        }
        if !home || ["去", "到", "查询", "查一下", "多少钱", "打车", "帮我", "地址是"].iter().any(|s| text.starts_with(s)) { return None; }
        text
    };
    let address = address.split(['。', '！', '!', '？', '?', '；', ';', '\n']).next()?.trim().trim_matches(['“', '”', '"']);
    let units = ["市", "区", "县", "路", "街", "弄", "号", "栋", "幢", "室", "单元", "花园", "小区", "公寓", "村", "镇"].iter().filter(|s| address.contains(**s)).count();
    if !(6..=160).contains(&address.chars().count()) || units < 2 || address.contains(['?', '？']) { return None; }
    Some(address.to_owned())
}

pub(crate) fn is_home_fact(text: &str) -> bool {
    ["家庭地址", "住址", "居住地址", "我家在", "住在", "家住"].iter().any(|s| text.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    const ADDRESS: &str = "示例市测试区星河示例花园2栋301室";
    #[test]
    fn keeps_exact_address_and_requires_user_attribution() {
        assert_eq!(candidate(&format!("我家在{ADDRESS}"), &[]).as_deref(), Some(ADDRESS));
        assert_eq!(candidate(ADDRESS, &["从地铁站打车回家，普通车就好"]).as_deref(), Some(ADDRESS));
        assert!(candidate(ADDRESS, &[]).is_none());
        assert!(candidate(ADDRESS, &["从地铁站打车回家", "改去公司"]).is_none());
        for text in [format!("去{ADDRESS}"), format!("朋友住在{ADDRESS}"), format!("我以前住在{ADDRESS}"), format!("假如我家在{ADDRESS}"), format!("不要记住，我家在{ADDRESS}"), format!("我家在{ADDRESS}吗？")] {
            assert!(candidate(&text, &["回家"]).is_none());
        }
    }
}
