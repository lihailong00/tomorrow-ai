use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub struct Integration {
    pub id: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub mode: &'static str,
    pub detail: &'static str,
    pub import_supported: bool,
    pub notification_supported: bool,
}

pub const CATALOG: &[Integration] = &[
    Integration { id: "wechat", name: "微信", category: "聊天", mode: "import", detail: "选定通知、手工粘贴和分享导入；不能读取完整聊天记录", import_supported: true, notification_supported: true },
    Integration { id: "qq", name: "QQ", category: "聊天", mode: "import", detail: "选定通知、手工粘贴和分享导入；回复由你在原应用发送", import_supported: true, notification_supported: true },
    Integration { id: "qq_mail", name: "QQ 邮箱", category: "邮件", mode: "mail", detail: "查找邮件，梳理重点；写好邮件后由你确认发送", import_supported: true, notification_supported: false },
    Integration { id: "netease163", name: "163 邮箱", category: "邮件", mode: "mail", detail: "查找邮件，梳理重点；写好邮件后由你确认发送", import_supported: true, notification_supported: false },
    Integration { id: "netease126", name: "126 邮箱", category: "邮件", mode: "mail", detail: "查找邮件，梳理重点；写好邮件后由你确认发送", import_supported: true, notification_supported: false },
    Integration { id: "tencent_docs", name: "腾讯文档", category: "办公", mode: "oauth", detail: "授权范围内读取文件；也可导入导出的文件与分享文字", import_supported: true, notification_supported: true },
    Integration { id: "wps", name: "WPS / 金山文档", category: "办公", mode: "oauth", detail: "授权范围内读取文件；支持选取本机文档导入", import_supported: true, notification_supported: true },
    Integration { id: "amap", name: "高德地图", category: "出行", mode: "map", detail: "地点搜索、路线查询，并在你点击后打开导航；不读取私人搜索记录", import_supported: true, notification_supported: false },
    Integration { id: "xiaohongshu", name: "小红书", category: "内容", mode: "import", detail: "导入你分享的文字、链接和截图；链接本身不代表已读取正文", import_supported: true, notification_supported: true },
    Integration { id: "bilibili", name: "哔哩哔哩", category: "内容", mode: "import", detail: "导入分享的链接、文字与资料；不自动同步观看记录", import_supported: true, notification_supported: true },
    Integration { id: "douyin", name: "抖音", category: "内容", mode: "import", detail: "导入分享的链接与文字；视频音画不会自动解析", import_supported: true, notification_supported: true },
    Integration { id: "zhihu", name: "知乎", category: "内容", mode: "token", detail: "官方开发者内容检索；个人收藏可手动分享导入，不自动同步私密收藏", import_supported: true, notification_supported: true },
    Integration { id: "feishu", name: "飞书", category: "办公", mode: "oauth", detail: "用户和组织授权范围内的日程与文档；可用范围由应用权限决定", import_supported: true, notification_supported: true },
    Integration { id: "dingtalk", name: "钉钉", category: "办公", mode: "oauth", detail: "用户和组织授权范围内读取资料，不读取全部聊天记录", import_supported: true, notification_supported: true },
    Integration { id: "yuque", name: "语雀", category: "知识", mode: "token", detail: "使用个人访问令牌读取可访问的知识库与文档", import_supported: true, notification_supported: false },
    Integration { id: "wecom", name: "企业微信", category: "办公", mode: "token", detail: "企业应用授权范围内读取组织资料；不包含个人微信聊天记录", import_supported: true, notification_supported: true },
    Integration { id: "taobao", name: "淘宝", category: "生活", mode: "import", detail: "导入订单通知、账单文字或订单截图，不连接商家接口冒充个人订单同步", import_supported: true, notification_supported: true },
    Integration { id: "jd", name: "京东", category: "生活", mode: "import", detail: "选定订单通知与手动资料导入，不自动购买或支付", import_supported: true, notification_supported: true },
    Integration { id: "meituan", name: "美团", category: "生活", mode: "import", detail: "选定订单通知与行程资料导入，不自动下单", import_supported: true, notification_supported: true },
    Integration { id: "alipay", name: "支付宝", category: "生活", mode: "import", detail: "仅导入你选定的账单文字或文件，不读取支付密码、不自动支付", import_supported: true, notification_supported: true },
    Integration { id: "didi", name: "滴滴出行", category: "出行", mode: "import", detail: "选定行程通知、发票与行程文件导入，不自动叫车", import_supported: true, notification_supported: true },
];

pub fn find(id: &str) -> crate::Result<&'static Integration> {
    CATALOG.iter().find(|item| item.id == id).ok_or_else(|| crate::ConnectorError::new(
        axum::http::StatusCode::NOT_FOUND, "not_found", "找不到这个应用连接"))
}
