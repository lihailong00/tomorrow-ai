export const QQ_MAIL_HELP = 'https://help.mail.qq.com/detail/0/1087';

// NetEase's shared guide covers both 163 and 126 mailboxes.
const NETEASE_MAIL_HELP =
  'https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b';

export type ConnectionGuide = {
  before: string;
  linkText: string;
  url: string;
  after: string;
};

const guides: Readonly<Record<string, ConnectionGuide>> = {
  qq_mail: {
    before: '请先在 QQ 邮箱设置中',
    linkText: '开启 IMAP',
    url: QQ_MAIL_HELP,
    after: '，然后填写完整邮箱地址和客户端授权码。',
  },
  netease163: {
    before: '请先在 163 邮箱设置中',
    linkText: '开启 IMAP 并获取授权码',
    url: NETEASE_MAIL_HELP,
    after:
      '，然后填写完整邮箱地址和客户端授权码。请使用授权码，不是邮箱登录密码。',
  },
  netease126: {
    before: '请先在 126 邮箱设置中',
    linkText: '开启 IMAP 并获取授权码',
    url: NETEASE_MAIL_HELP,
    after:
      '，然后填写完整邮箱地址和客户端授权码。请使用授权码，不是邮箱登录密码。',
  },
  tencent_docs: {
    before: '请先前往',
    linkText: '腾讯文档 MCP 授权页',
    url: 'https://docs.qq.com/open/auth/mcp.html',
    after: '，使用 QQ 或微信登录并开通授权，获取你本人的 MCP Token 后填写。',
  },
  tencent_meeting: {
    before: '请先前往',
    linkText: '腾讯会议 AI Skill 专区',
    url: 'https://meeting.tencent.com/ai-skill.html',
    after:
      '，用个人账号登录并复制 Token。若进入了企业账号，请先切换为个人账号。',
  },
  didi: {
    before: '请先在',
    linkText: '滴滴 MCP 官网',
    url: 'https://mcp.didichuxing.com/',
    after:
      '登录自己的滴滴账号，在控制台激活个人 MCP Key 后填写。新手机号请先在滴滴 App 或小程序注册。',
  },
  mcdonalds: {
    before: '请先在',
    linkText: '麦当劳 MCP 开放平台',
    url: 'https://open.mcd.cn/mcp',
    after:
      '用手机号登录，进入「控制台 → 激活」，阅读并同意服务协议后，复制个人 MCP Token。',
  },
  notion: {
    before: '请参考',
    linkText: 'Notion 官方授权教程',
    url: 'https://www.notion.com/help/create-integrations-with-the-notion-api',
    after:
      '，在设置中创建个人连接并获取 Token，同时授权需要访问的页面，然后填写 Token。',
  },
  memos: {
    before: '请参考',
    linkText: 'Memos 访问令牌教程',
    url: 'https://usememos.com/docs/integrations/api-access',
    after:
      '，在你自己的 Memos 实例设置中创建个人 Token，然后填写实例地址和 Token。',
  },
};

export function connectionGuide(id: string): ConnectionGuide | undefined {
  return Object.prototype.hasOwnProperty.call(guides, id)
    ? guides[id]
    : undefined;
}
