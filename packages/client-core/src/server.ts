import { ApiError } from './errors';
import type { InstanceManifest } from './types';

export const OFFICIAL_SERVER_URL = 'https://api.example.invalid';
/** Origin only. An old /v1 suffix is tolerated, never arbitrary path/query/auth. */
export function normalizeServerUrl(input: string, allowInsecureLan = false): string {
  const raw = input.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) throw new ApiError('invalid_server', '请输入完整的 HTTPS 服务地址。');
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError('invalid_server', '服务地址无效。'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/') || !url.hostname) {
    throw new ApiError('invalid_server', '服务地址不能包含账号、路径、参数或片段。');
  }
  const host = url.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const ipv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  const loopback = host === 'localhost' || host === '[::1]' || (ipv4 && octets[0] === 127);
  const lan = (ipv4 && (octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) || host.endsWith('.local') || /^\[f[cd][0-9a-f:]+\]$/.test(host);
  if (url.protocol === 'http:' && !loopback && !(allowInsecureLan && lan)) {
    throw new ApiError('insecure_server', '公网服务需要 HTTPS；局域网 HTTP 需要明确启用高级选项。');
  }
  return url.origin;
}
export function readInstanceManifest(value: unknown): InstanceManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('incompatible_server', '服务器没有返回有效身份信息。');
  const v = value as Record<string, unknown>;
  if (v.api_version !== 1 || typeof v.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.id) ||
      typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120 ||
      !['official', 'self_hosted'].includes(String(v.deployment_mode)) ||
      !['open', 'invite_only', 'closed'].includes(String(v.registration_policy)) ||
      !Array.isArray(v.auth_methods) || !v.auth_methods.length || v.auth_methods.some(m => !['phone_password', 'email_password'].includes(m)) ||
      (v.public_url != null && typeof v.public_url !== 'string') || !v.dataflow || typeof v.dataflow !== 'object' || Array.isArray(v.dataflow)) {
    throw new ApiError('incompatible_server', '此服务器版本不兼容，或尚未完成初始化。');
  }
  return { ...v, public_url: v.public_url ?? '' } as unknown as InstanceManifest;
}
export function normalizePhoneNumber(value: string): string {
  const phone = value.replace(/[\s-]/g, '').replace(/^(\+86|0086)/, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new ApiError('invalid_phone', '请输入有效的中国大陆手机号。');
  return `+86${phone}`;
}
export function newRequestId(): string {
  if (!globalThis.crypto?.randomUUID) throw new ApiError('secure_context_required', '当前环境缺少安全随机数，请使用 HTTPS 或本机客户端。');
  return `desktop-${globalThis.crypto.randomUUID()}`;
}
