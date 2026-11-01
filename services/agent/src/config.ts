import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Model } from '@earendil-works/pi-ai';

export type ModelSettings = { model: Model<'openai-completions'>; apiKey: string };

function internalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (['localhost', '[::1]', 'api', 'backend', 'tomorrow-api', 'host.docker.internal'].includes(host)) return true;
  const address = host.replace(/^\[|\]$/g, '');
  if (isIP(address) === 6) return /^f[cd][0-9a-f]{2}:/.test(address);
  if (isIP(host) !== 4) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function privateModelHost(hostname: string): boolean {
  return internalHost(hostname) || ['ollama', 'vllm', 'lmstudio'].includes(hostname.toLowerCase());
}

function modelServiceUrl(value: string): string {
  const url = new URL(value);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && privateModelHost(url.hostname))) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('模型地址须使用 HTTPS 或私有网络 HTTP，不能含凭据');
  }
  return value.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

// Runtime configuration carries server credentials. It is retrieved only from
// the configured private Rust service, never a URL in a request or model output.
export function rustServiceUrl(value: string, runtimeConfig = false): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || (runtimeConfig && !internalHost(url.hostname)) ||
      (url.protocol === 'http:' && !internalHost(url.hostname))) {
    throw new Error('Rust 服务地址须为可信服务根地址；运行配置仅允许内网服务');
  }
  return url.origin;
}

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
  let apiKey = get(custom ? 'MODEL_API_KEY' : 'DEEPSEEK_API_KEY');
  const id = custom ? get('MODEL_NAME') : get('DEEPSEEK_MODEL') ?? 'deepseek-flash';
  const base = custom ? get('MODEL_BASE_URL') ?? 'https://api.openai.com/v1' :
    get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com';
  // Local compatible servers often do not use authentication. The SDK still
  // requires a nonempty value; this fixed non-secret is never used for a public
  // endpoint, and never borrows the operator's other provider credential.
  if (custom && !apiKey && get('MODEL_BASE_URL') && privateModelHost(new URL(base).hostname)) apiKey = 'local-no-auth';
  if (!apiKey || !id || /[\r\n]/.test(apiKey) || /[\u0000-\u001f\u007f]/.test(id) || id.length > 128) {
    throw new Error('模型配置不完整或无效；MODEL_* 与 DEEPSEEK_* 不混用');
  }
  const baseUrl = modelServiceUrl(base);
  const endpoint = new URL(baseUrl);
  // Verify the official endpoint even when it was selected via generic MODEL_*
  // settings. Pro shares the reasoning protocol; its context remains conservative.
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  // https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
  const officialFlash = id === 'deepseek-flash' &&
    endpoint.origin === 'https://api.deepseek.com' && ['/', '/v1'].includes(endpoint.pathname);
  const officialThinking = ['deepseek-flash', 'deepseek-v4-pro'].includes(id) &&
    endpoint.origin === 'https://api.deepseek.com' && ['/', '/v1'].includes(endpoint.pathname);
  return {
    apiKey,
    model: {
      id, name: id, api: 'openai-completions', provider: custom ? 'tomorrow-compatible' : 'deepseek',
      // reasoning describes a capability: Pi's thinkingLevel='off' then emits
      // thinking.type='disabled', overriding DeepSeek's default enabled mode.
      baseUrl, reasoning: officialThinking, input: ['text'], contextWindow: officialFlash ? 1000000 : 131072, maxTokens: officialThinking ? 32768 : 4096,
      ...(officialThinking ? { compat: { thinkingFormat: 'deepseek' as const, supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true }, thinkingLevelMap: { low: 'low', high: 'high', max: 'max' } } : {}),
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
