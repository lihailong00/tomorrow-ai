//! Personal-account MCP providers and official API adapters. Developer keys do not
//! belong here, and provider claims alone never grant a tool write permission.
use serde::Serialize;

use crate::{ConnectorError, Result};

#[derive(Clone, Copy, Serialize)]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub help_url: &'static str,
    pub credential_label: &'static str,
    pub transport: &'static str,
    pub supported: bool,
    pub unsupported_reason: Option<&'static str>,
}

const PROVIDERS: &[Provider] = &[
    Provider {
        id: "mcdonalds",
        name: "麦当劳",
        description: "连接你自己的麦当劳账号，查询活动、营养与账号开放的服务；点餐、兑换等操作需单独确认。",
        help_url: "https://open.mcd.cn/mcp",
        credential_label: "个人 MCP Token",
        transport: "streamable_http",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "didi",
        name: "滴滴出行",
        description: "使用自己的 MCP Key 查询路线、预估车费与行程；叫车和取消订单需单独确认。",
        help_url: "https://mcp.didichuxing.com/api",
        credential_label: "个人 MCP Key",
        transport: "streamable_http",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "tencent_docs",
        name: "腾讯文档",
        description: "在个人授权范围内读取、创建和编辑腾讯文档；修改内容需单独确认。",
        help_url: "https://docs.qq.com/open/auth/mcp.html",
        credential_label: "个人 MCP Token",
        transport: "streamable_http",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "yuque",
        name: "语雀",
        description: "使用语雀超级会员的个人访问令牌连接官方 MCP，读取知识库、文档与小记；创建和修改需单独确认。普通账号不能生成此 Token。",
        help_url: "https://www.yuque.com/settings/tokens",
        credential_label: "个人访问令牌",
        transport: "stdio",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "notion",
        name: "Notion",
        description: "使用本人 Notion 连接 Token 或个人访问令牌访问授权页面。免费版可使用基础 API；支持标题检索、读取正文、新建、修改及移入回收站，写入需本人确认。请先在 Notion 中授权目标页面和读写能力。",
        help_url: "https://www.notion.com/help/create-integrations-with-the-notion-api",
        credential_label: "Notion Token",
        transport: "official_api",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "memos",
        name: "Memos",
        description: "连接本人使用的 Memos 实例，支持搜索、读取、新建、修改和删除笔记；写入需本人确认。Memos 软件和 API 无需会员，实例需提供服务地址和个人 Token。",
        help_url: "https://usememos.com/docs/integrations/api-access",
        credential_label: "Memos 个人 Token",
        transport: "streamable_http",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "tencent_meeting",
        name: "腾讯会议",
        description: "查询你有权访问的会议、录制、转写与纪要；预约、变更会议等操作需单独确认。",
        help_url: "https://meeting.tencent.com/ai-skill.html",
        credential_label: "个人 Token",
        transport: "http_jsonrpc",
        supported: true,
        unsupported_reason: None,
    },
    Provider {
        id: "feishu",
        name: "飞书",
        description: "飞书个人托管 MCP 正在调整服务方式；已接入的应用授权仍可在原账号连接中使用。",
        help_url: "https://open.feishu.cn/page/mcp",
        credential_label: "个人授权",
        transport: "streamable_http",
        supported: false,
        unsupported_reason: Some(
            "官方个人托管服务处于调整阶段，新链接有有效期限制。请使用已有飞书应用授权连接。",
        ),
    },
    Provider {
        id: "baidu_netdisk",
        name: "百度网盘（个人体验）",
        description: "百度官方仅提供限时个人测试体验，不可用于正式环境；请先阅读官方说明并授权获取自己的 Access Token。可以读取授权网盘资料，文件修改仍需单独确认。",
        help_url: "https://github.com/baidu-netdisk/mcp#二个人用户限时体验",
        credential_label: "个人体验 Access Token",
        transport: "sse",
        supported: true,
        unsupported_reason: Some(
            "管理员尚未开启百度网盘个人测试体验。官方体验凭证会变更，不可用于正式环境；正式接入需企业开发者资质。",
        ),
    },
    Provider {
        id: "yinxiang",
        name: "印象笔记",
        description: "通过印象笔记官方 Skill 连接个人笔记，需要印象笔记会员及个人 AuthToken；读取授权笔记和笔记本，创建、修改需单独确认，本版不支持删除。此连接使用官方 Skill 接口。",
        help_url: "https://app.yinxiang.com/third/skills-oauth/",
        credential_label: "个人 AuthToken",
        transport: "official_skill",
        supported: true,
        unsupported_reason: None,
    },
];

pub fn providers() -> &'static [Provider] {
    PROVIDERS
}

pub fn find(id: &str) -> Result<&'static Provider> {
    PROVIDERS
        .iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| {
            ConnectorError::new(
                axum::http::StatusCode::NOT_FOUND,
                "not_found",
                "找不到这个个人连接",
            )
        })
}

pub fn runtime_available(id: &str) -> bool {
    find(id).is_ok_and(|provider| {
        provider.supported && (id != "yuque" || super::transport::yuque_script().is_some())
    })
}

/// Conservative, reviewed exact IDs. Unknown tools, even if their names or MCP
/// annotations claim to be read-only, require an explicit user confirmation.
pub fn is_read_only(provider: &str, tool: &str) -> bool {
    match provider {
        "mcdonalds" => matches!(
            tool,
            "list-nutrition-foods"
                | "campaign-calendar"
                | "available-coupons"
                | "query-my-coupons"
                | "query-my-account"
                | "query-order"
                | "order-list"
                | "delivery-query-addresses"
                | "delivery-query-stores"
                | "query-nearby-stores"
                | "query-store-coupons"
                | "query-meals"
                | "query-meal-detail"
                | "calculate-price"
                | "mall-points-products"
                | "mall-product-detail"
                | "mall-order-list"
                | "mall-order-detail"
                | "now-time-info"
                | "query-lottery-info"
                | "query-my-prizes"
                | "query-party-city"
                | "query-party-store"
                | "query-partystore-date"
                | "query-partystore-session"
        ),
        "didi" => matches!(
            tool,
            "taxi_estimate"
                | "taxi_query_order"
                | "taxi_get_driver_location"
                | "maps_textsearch"
                | "maps_regeocode"
                | "maps_place_around"
                | "maps_direction_driving"
                | "maps_direction_transit"
                | "maps_direction_walking"
                | "maps_direction_bicycling"
        ),
        "notion" => super::notion::is_read_only(tool),
        "memos" => super::memos::is_read_only(tool),
        "yuque" => matches!(
            tool,
            "yuque_get_user"
                | "yuque_search"
                | "yuque_list_books"
                | "yuque_get_book"
                | "yuque_list_docs"
                | "yuque_get_doc"
                | "yuque_get_toc"
                | "yuque_list_notes"
                | "yuque_get_note"
                | "yuque_get_resource"
        ),
        "tencent_meeting" => matches!(
            tool,
            "get_meeting"
                | "get_meeting_by_code"
                | "get_meeting_participants"
                | "get_meeting_invitees"
                | "get_waiting_room"
                | "get_user_meetings"
                | "get_user_ended_meetings"
                | "search_meetings"
                | "get_job_result"
                | "get_records_list"
                | "search_records"
                | "get_record_addresses"
                | "get_transcripts_details"
                | "get_transcripts_paragraphs"
                | "search_transcripts"
                | "get_smart_minutes"
                | "search_minutes"
                | "get_minutes"
                | "convert_timestamp"
                | "check_skill_version"
        ),
        "baidu_netdisk" => matches!(
            tool,
            "user_info"
                | "get_quota"
                | "file_list"
                | "file_doc_list"
                | "file_image_list"
                | "file_video_list"
                | "file_meta"
                | "file_keyword_search"
                | "file_semantics_search"
        ),
        "yinxiang" => matches!(
            tool,
            "yinxiang_list_notebooks"
                | "yinxiang_search_notes"
                | "yinxiang_list_notes"
                | "yinxiang_get_note"
                | "yinxiang_list_tags"
        ),
        // The other official services publish account-dependent tool catalogs.
        // No unsupported guess about a tool's side effects is made here.
        _ => false,
    }
}
