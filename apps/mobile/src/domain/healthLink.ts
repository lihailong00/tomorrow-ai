import { normalizeServerUrl } from '../api/client';

export type HealthReceipt = { provider: 'huawei' | 'xiaomi'; receipt: string };

/** A link only prefills confirmation on the already selected server. */
export function healthReceiptFromLink(input: string, currentServer: string): HealthReceipt | null {
  if (!input.startsWith('tada://health/')) return null;
  const match = /^tada:\/\/health\/complete\?([^#\s\\]{1,3500})$/.exec(input);
  if (!match) throw new Error('无法识别健康连接确认链接。');
  const values: Record<string, string> = Object.create(null);
  for (const pair of match[1].split('&')) {
    const index = pair.indexOf('=');
    if (index < 0) throw new Error('健康确认链接不完整。');
    const key = decodeURIComponent(pair.slice(0, index));
    const value = decodeURIComponent(pair.slice(index + 1));
    if (!['provider', 'receipt', 'server'].includes(key) || key in values)
      throw new Error('健康确认链接包含不支持的参数。');
    values[key] = value;
  }
  if (!['huawei', 'xiaomi'].includes(values.provider) || !/^[A-Za-z0-9_-]{43}$/.test(values.receipt ?? ''))
    throw new Error('健康确认码无效。');
  if (!values.server || normalizeServerUrl(values.server) !== normalizeServerUrl(currentServer))
    throw new Error('健康连接来自不同服务器，请在原服务器完成连接。');
  return { provider: values.provider as HealthReceipt['provider'], receipt: values.receipt };
}
