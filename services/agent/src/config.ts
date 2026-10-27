import { createHash, timingSafeEqual } from 'node:crypto';
import type { Model } from '@earendil-works/pi-ai';

export type ModelSettings = { model: Model<'openai-completions'>; apiKey: string };

export function serviceUrl(value: string, label: string): string {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} 须使用 HTTPS 或本机 HTTP，不能含凭据`);
  }
  return value.replace(/\/+$/, '');
}

export function resolveModel(env: NodeJS.ProcessEnv): ModelSettings {
  const get = (key: string) => env[key]?.trim() || undefined;
  const custom = ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME'].some(key => get(key));
  const apiKey = get(custom ? 'MODEL_API_KEY' : 'DEEPSEEK_API_KEY');
  const id = custom ? get('MODEL_NAME') : get('DEEPSEEK_MODEL') ?? 'deepseek-flash';
  const base = custom ? get('MODEL_BASE_URL') ?? 'https://api.openai.com/v1' :
    get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com';
  if (!apiKey || !id || /[\r\n]/.test(apiKey)) {
    throw new Error('模型配置不完整或无效；MODEL_* 与 DEEPSEEK_* 不混用');
  }
  const baseUrl = serviceUrl(base, '模型地址').replace(/\/chat\/completions$/, '');
  const endpoint = new URL(baseUrl);
  // Verified model capabilities apply only to the official Flash endpoint.
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  // https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
  const officialFlash = !custom && id === 'deepseek-flash' &&
    endpoint.origin === 'https://api.deepseek.com' && ['/', '/v1'].includes(endpoint.pathname);
  return {
    apiKey,
    model: {
      id, name: id, api: 'openai-completions', provider: custom ? 'tomorrow-compatible' : 'deepseek',
      // reasoning describes a capability: Pi's thinkingLevel='off' then emits
      // thinking.type='disabled', overriding DeepSeek's default enabled mode.
      baseUrl, reasoning: officialFlash, input: ['text'], contextWindow: officialFlash ? 1000000 : 131072, maxTokens: 4096,
      // Pricing is deliberately unknown; reports expose token usage, not a fictitious bill.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

export function authenticate(actual: string | undefined, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual ?? ''), digest(expected));
}

export function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error('Agent 运行限制配置无效');
  return number;
}
