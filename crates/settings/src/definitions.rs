//! Only these server-owned settings can be edited through the administration UI.
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub struct SettingDefinition {
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub kind: &'static str,
    pub options: &'static [&'static str],
    pub restart_required: bool,
    #[serde(skip)]
    pub default_value: &'static str,
}

macro_rules! item {
    ($key:literal,$group:literal,$label:literal,$kind:literal,$default:literal) => {
        SettingDefinition{key:$key,group:$group,label:$label,secret:false,kind:$kind,options:&[],restart_required:false,default_value:$default}
    };
    (secret $key:literal,$group:literal,$label:literal) => {
        SettingDefinition{key:$key,group:$group,label:$label,secret:true,kind:"password",options:&[],restart_required:false,default_value:""}
    };
    (select $key:literal,$group:literal,$label:literal,$default:literal,$($option:literal),+) => {
        SettingDefinition{key:$key,group:$group,label:$label,secret:false,kind:"select",options:&[$($option),+],restart_required:false,default_value:$default}
    };

}

pub static DEFINITIONS: &[SettingDefinition] = &[
    item!("INSTANCE_NAME", "instance", "服务器名称", "text", "妥啦"),
    item!("INSTANCE_PUBLIC_URL", "instance", "公开访问地址", "url", ""),
    item!(select "INSTANCE_MODE","instance","部署方式","self_hosted","self_hosted","official"),
    item!(select "REGISTRATION_POLICY","access","注册方式","closed","open","invite_only","closed"),
    item!(
        "EMAIL_PASSWORD_ENABLED",
        "access",
        "邮箱与密码登录",
        "boolean",
        "true"
    ),
    item!(
        "PHONE_PASSWORD_ENABLED",
        "access",
        "手机号与密码登录",
        "boolean",
        "false"
    ),
    item!("MODEL_BASE_URL", "model", "模型 API 地址", "url", ""),
    item!("MODEL_NAME", "model", "模型名称", "text", ""),
    item!(secret "MODEL_API_KEY","model","模型 API Key"),
    item!("DEEPSEEK_BASE_URL", "model", "DeepSeek API 地址", "url", ""),
    item!("DEEPSEEK_MODEL", "model", "DeepSeek 模型名称", "text", ""),
    item!(secret "DEEPSEEK_API_KEY","model","DeepSeek API Key"),
    item!(select "ASR_PROTOCOL","speech","语音识别协议","openai_transcriptions","openai_transcriptions","qwen_asr"),
    item!("ASR_BASE_URL", "speech", "语音识别 API 地址", "url", ""),
    item!("ASR_MODEL", "speech", "语音识别模型", "text", ""),
    item!(secret "ASR_API_KEY","speech","语音识别 API Key"),
    item!(
        "PHOTO_VISION_ENABLED",
        "vision",
        "启用云端图片理解",
        "boolean",
        "false"
    ),
    item!(
        "PHOTO_VISION_BASE_URL",
        "vision",
        "图片理解 API 地址",
        "url",
        ""
    ),
    item!(
        "PHOTO_VISION_MODEL",
        "vision",
        "图片理解模型",
        "text",
        "qwen3.7-flash"
    ),
    item!(secret "PHOTO_VISION_API_KEY","vision","图片理解 API Key"),
    item!(
        "PHOTO_EMBEDDING_ENABLED",
        "embedding",
        "启用相册语义检索",
        "boolean",
        "false"
    ),
    item!(
        "PHOTO_EMBEDDING_BASE_URL",
        "embedding",
        "向量模型 API 地址",
        "url",
        ""
    ),
    item!(
        "PHOTO_EMBEDDING_MODEL",
        "embedding",
        "向量模型名称",
        "text",
        "text-embedding-v4"
    ),
    item!(secret "PHOTO_EMBEDDING_API_KEY","embedding","向量模型 API Key"),
    item!(secret "DEEPSEEK_SEARCH_API_KEY","search","DeepSeek 搜索 API Key"),
    item!(
        "DEEPSEEK_WEB_ENABLED",
        "search",
        "启用联网搜索与网页读取",
        "boolean",
        "false"
    ),
    item!(
        "AGENT_MAX_WEB_SEARCHES",
        "search",
        "每次任务最多搜索次数",
        "number",
        "100"
    ),
    item!(
        "AGENT_MAX_WEB_FETCHES",
        "search",
        "每次任务最多网页读取次数",
        "number",
        "100"
    ),
    item!(select "PHONE_AUTH_MODE","sms","短信验证码服务","disabled","disabled","aliyun_pnvs"),
    item!(secret "ALIBABA_CLOUD_ACCESS_KEY_ID","sms","阿里云 AccessKey ID"),
    item!(secret "ALIBABA_CLOUD_ACCESS_KEY_SECRET","sms","阿里云 AccessKey Secret"),
    item!(secret "ALIBABA_CLOUD_SECURITY_TOKEN","sms","阿里云临时 Security Token"),
    item!("ALIYUN_PNVS_SIGN_NAME", "sms", "短信签名", "text", ""),
    item!(
        "ALIYUN_PNVS_TEMPLATE_CODE",
        "sms",
        "短信模板编号",
        "text",
        ""
    ),
    item!(secret "SMS_CODE_HASH_KEY","sms","验证码保护密钥"),
    item!(
        "SMS_DAILY_LIMIT",
        "sms",
        "每日短信总量上限",
        "number",
        "100"
    ),
    item!(secret "SMS_ALLOWED_PHONES","sms","内测手机号白名单"),
    item!(secret "CONNECTOR_ENCRYPTION_KEY","connections","用户授权凭证加密密钥"),
    item!(
        "GOOGLE_CLIENT_ID",
        "connections",
        "Google 客户端 ID",
        "text",
        ""
    ),
    item!(secret "GOOGLE_CLIENT_SECRET","connections","Google 客户端 Secret"),
    item!(
        "GOOGLE_REDIRECT_URI",
        "connections",
        "Google 回调地址",
        "url",
        ""
    ),
    item!(secret "AMAP_WEB_API_KEY","connections","高德 Web API Key"),
    item!("BAIDU_NETDISK_EXPERIENCE_ENABLED", "connections", "百度网盘个人体验（仅限测试，非正式环境）", "boolean", "false"),
    item!("HUAWEI_HEALTH_CLIENT_ID", "connections", "华为运动健康应用 ID", "text", ""),
    item!(secret "HUAWEI_HEALTH_CLIENT_SECRET", "connections", "华为运动健康应用 Secret"),
    item!("HUAWEI_HEALTH_REDIRECT_URI", "connections", "华为授权回调（可留空使用服务器公开地址）", "url", ""),
    item!("XIAOMI_HEALTH_CLIENT_ID", "connections", "小米运动健康应用 ID", "text", ""),
    item!(secret "XIAOMI_HEALTH_CLIENT_SECRET", "connections", "小米运动健康应用 Secret"),
    item!("XIAOMI_HEALTH_REDIRECT_URI", "connections", "小米授权回调（可留空使用服务器公开地址）", "url", ""),
    item!(
        "TENCENT_DOCS_CLIENT_ID",
        "connections",
        "腾讯文档应用 ID",
        "text",
        ""
    ),
    item!(secret "TENCENT_DOCS_CLIENT_SECRET","connections","腾讯文档应用 Secret"),
    item!(
        "TENCENT_DOCS_REDIRECT_URI",
        "connections",
        "腾讯文档回调地址",
        "url",
        ""
    ),
    item!(
        "TENCENT_DOCS_SCOPES",
        "connections",
        "腾讯文档权限",
        "text",
        "scope.drive.readonly"
    ),
    item!("WPS_CLIENT_ID", "connections", "WPS 应用 ID", "text", ""),
    item!(secret "WPS_CLIENT_SECRET","connections","WPS 应用 Secret"),
    item!("WPS_REDIRECT_URI", "connections", "WPS 回调地址", "url", ""),
    item!(
        "WPS_SCOPES",
        "connections",
        "WPS 权限",
        "text",
        "kso.file.read"
    ),
    item!("FEISHU_CLIENT_ID", "connections", "飞书应用 ID", "text", ""),
    item!(secret "FEISHU_CLIENT_SECRET","connections","飞书应用 Secret"),
    item!(
        "FEISHU_REDIRECT_URI",
        "connections",
        "飞书回调地址",
        "url",
        ""
    ),
    item!(
        "FEISHU_SCOPES",
        "connections",
        "飞书权限",
        "text",
        "drive:drive.metadata:readonly offline_access"
    ),
    item!(
        "DINGTALK_CLIENT_ID",
        "connections",
        "钉钉应用 ID",
        "text",
        ""
    ),
    item!(secret "DINGTALK_CLIENT_SECRET","connections","钉钉应用 Secret"),
    item!(
        "DINGTALK_REDIRECT_URI",
        "connections",
        "钉钉回调地址",
        "url",
        ""
    ),
    item!(
        "DINGTALK_SCOPES",
        "connections",
        "钉钉权限",
        "text",
        "openid"
    ),
    item!(
        "AGENT_MAX_TURNS",
        "limits",
        "每次任务最多模型轮次",
        "number",
        "256"
    ),
    item!(
        "AGENT_MAX_TOOLS",
        "limits",
        "每次任务最多工具调用",
        "number",
        "240"
    ),
    item!(
        "AGENT_TIMEOUT_MS",
        "limits",
        "任务最长执行时间（毫秒）",
        "number",
        "1200000"
    ),
    item!(
        "AGENT_MAX_CONCURRENT",
        "limits",
        "模型任务并发数",
        "number",
        "4"
    ),
];

pub fn definition(key: &str) -> Option<&'static SettingDefinition> {
    DEFINITIONS.iter().find(|item| item.key == key)
}
