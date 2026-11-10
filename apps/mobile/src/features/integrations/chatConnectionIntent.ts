import type { PersonalMcpConnection } from '../personal-mcp/types';
import { providerLabels, type HealthConnection } from '../health/types';
import type { Integration } from './types';

export type ConnectionIntent = 'connect' | 'private-query';

const connectionVerb = '(?:连接|接入|绑定|授权|对接|连一下|连上)';
const requestPrefixes = new RegExp(
  '(?:能不能|能否|能|可以|可不可以|是否|支持|怎么|如何|想|要)\\s*(?:(?:帮我|直接|在这里|在聊天里)\\s*)*' +
    connectionVerb,
);
const commands = new RegExp(
  '(?:^|[，,。！？!?；;])\\s*(?:(?:请|麻烦|帮我|给我|替我|直接)\\s*)*' + connectionVerb +
    '|(?:帮我|请|我想|我要)把.{0,32}' + connectionVerb +
    '|' + connectionVerb + '(?:一下|吧)?\\s*[？?！!。]?$',
);

export function chatConnectionIntent(text: string): ConnectionIntent | null {
  if (/(?:不要|不用|不想|无需|取消|断开|解除|撤销)\s*(?:连接|接入|授权|绑定|对接|连一下|连上)|\b(?:don't|do not|without)\s+(?:connect|link|authorize)|\bdisconnect\b/i.test(text))
    return null;
  if (/\bgithub\b/i.test(text) &&
      /私有(?:的)?(?:仓库|项目)|(?:我的|我们(?:的)?)\s*(?:GitHub\s*)?(?:仓库|代码库)|\b(?:private|my|our)\s+(?:github\s+)?repositor(?:y|ies)\b/i.test(text))
    return 'private-query';
  if (/怎么实现|如何实现|协议|连接原理|实现.{0,6}(?:连接|接入)|连接\s*(?:不上|不了|失败|超时|出错)/.test(text))
    return null;
  const englishRequest = /(?:^|\b(?:please|can you|could you|how (?:do i|to))\s+)(?:connect|link|authorize)\s+\S+/i;
  return requestPrefixes.test(text) || commands.test(text) || englishRequest.test(text)
    ? 'connect' : null;
}

export type ConnectionChoice =
  | { kind: 'mcp'; id: string; name: string; item: PersonalMcpConnection }
  | { kind: 'cloud'; id: string; name: string; item: Integration }
  | { kind: 'health'; id: HealthConnection['id']; name: string }
  | { kind: 'wallet'; id: string; name: string }
  | { kind: 'unavailable'; id: string; name: string };

const aliases: Record<string, string[]> = {
  dida365: ['滴答', 'TickTick'],
  fliggy: ['飞猪旅行'],
  baidu_maps: ['百度地图'],
  baidu_netdisk: ['百度云', '百度网盘'],
  weiyun: ['微云'],
  qq_music: ['QQ音乐'],
  mcdonalds: ['麦麦', '麦当劳'],
  didi: ['滴滴', 'DiDi'],
  liepin: ['猎聘'],
  amap: ['高德', 'Amap'],
  qq_mail: ['QQ邮箱', 'QQ邮件', 'Foxmail'],
  netease163: ['163邮箱', '网易163', '网易邮箱'],
  netease126: ['126邮箱', '网易126'],
  wps: ['WPS', '金山文档'],
  alipay: ['Alipay'],
  huawei: ['华为健康'],
  xiaomi: ['小米健康'],
};

function names(choice: ConnectionChoice) {
  const display = choice.name.replace(/[（(].*?[）)]/g, '');
  return [...display.split(/\s*[/／]\s*/), ...(choice.kind === 'health' ? [] : [choice.id]), ...(aliases[choice.id] ?? [])];
}

function rank(choice: ConnectionChoice) {
  if (choice.kind === 'wallet' || choice.kind === 'health') return 3;
  if (choice.kind === 'unavailable') return 0;
  if (choice.kind === 'cloud' && choice.item.mode === 'import') return 0;
  const supported = choice.item.status !== 'not_configured' &&
    !(choice.kind === 'cloud' && choice.item.mode === 'map' && choice.item.credential_scope !== 'user');
  return (choice.item.status === 'connected' && supported ? 4 : supported ? 2 : 0) +
    (choice.kind === 'mcp' ? 1 : 0);
}

export function matchingConnections(
  text: string,
  intent: ConnectionIntent,
  mcp: readonly PersonalMcpConnection[],
  integrations: readonly Integration[],
): ConnectionChoice[] {
  const choices: ConnectionChoice[] = [
    ...mcp.map(item => ({ kind: 'mcp' as const, id: item.id, name: item.name, item })),
    ...integrations.map(item => ({ kind: 'cloud' as const, id: item.id, name: item.name, item })),
    { kind: 'wallet', id: 'alipay', name: '支付宝' },
    { kind: 'health', id: 'huawei', name: providerLabels.huawei },
    { kind: 'health', id: 'xiaomi', name: providerLabels.xiaomi },
    ...(mcp.some(item => item.id === 'github')
      ? [] : [{ kind: 'unavailable' as const, id: 'github', name: 'GitHub' }]),
  ];
  const input = text.replace(/https?:\/\/[^\s，。？！、；]+/gi, '');
  const hits = choices.flatMap(choice => {
    if (intent === 'private-query' && choice.id !== 'github') return [];
    return names(choice).flatMap(name => {
      const trimmed = name.trim();
      if (!trimmed) return [];
      const escaped = trimmed.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
      const prefix = /^[\w]/.test(trimmed) ? '\\b' : '';
      const suffix = /[\w]$/.test(trimmed) ? '(?![\\w.\\-/])' : '';
      return Array.from(input.matchAll(new RegExp(prefix + escaped + suffix, 'gi')), match =>
        ({ choice, start: match.index!, end: match.index! + match[0].length }));
    });
  });
  const unique = new Map<string, ConnectionChoice>();
  for (const { choice, start, end } of hits) {
    // “企业微信”和“QQ 邮箱”不应同时触发更短的“微信”和“QQ”。
    if (hits.some(other => other.start <= start && other.end >= end &&
        (other.start < start || other.end > end))) continue;
    const existing = unique.get(choice.id);
    if (!existing || rank(choice) > rank(existing)) unique.set(choice.id, choice);
  }
  return [...unique.values()];
}
