import { positiveInteger, resolveModel, rustServiceUrl, type ModelSettings } from './config.js';
import { resolveWebSettings, type WebSettings } from './web.js';
import { DEFAULT_LIMITS } from './limits.js';

export type SettingsErrorCode = 'model_not_configured' | 'model_configuration_invalid' |
  'web_configuration_invalid' | 'runtime_configuration_invalid' | 'runtime_config_unavailable';

export class RuntimeSettingsError extends Error {
  constructor(readonly code: SettingsErrorCode) {
    super(code === 'model_not_configured' ? '尚未配置模型，请在管理后台完成配置' :
      code === 'runtime_config_unavailable' ? '暂时无法读取服务器配置，请稍后重试' : '服务器 AI 配置无效，请联系管理员');
  }
}

export type RuntimeSettings = {
  revision: string | null;
  model?: ModelSettings;
  web?: WebSettings;
  limits: { turns: number; tools: number; timeoutMs: number; maxConcurrent: number };
  error?: Exclude<SettingsErrorCode, 'runtime_config_unavailable'>;
};

// Do not merge process.env into a remotely resolved configuration. A cleared
// dashboard credential must remain cleared, including on a server that used an
// older .env file before adopting runtime settings.
const runtimeKeys = new Set([
  'MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL',
  'DEEPSEEK_SEARCH_API_KEY', 'DEEPSEEK_WEB_ENABLED', 'AGENT_MAX_WEB_SEARCHES', 'AGENT_MAX_WEB_FETCHES',
  'AGENT_MAX_TURNS', 'AGENT_MAX_TOOLS', 'AGENT_TIMEOUT_MS', 'AGENT_MAX_CONCURRENT',
]);

function settingsFromEnv(env: NodeJS.ProcessEnv, revision: string | null): RuntimeSettings {
  let limits = { ...DEFAULT_LIMITS, maxConcurrent: 4 };
  try {
    limits = { turns: positiveInteger(env.AGENT_MAX_TURNS, DEFAULT_LIMITS.turns, DEFAULT_LIMITS.turns),
      tools: positiveInteger(env.AGENT_MAX_TOOLS, DEFAULT_LIMITS.tools, DEFAULT_LIMITS.tools),
      timeoutMs: positiveInteger(env.AGENT_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, DEFAULT_LIMITS.timeoutMs),
      maxConcurrent: positiveInteger(env.AGENT_MAX_CONCURRENT, 4, 32) };
  } catch { return { revision, limits, error: 'runtime_configuration_invalid' }; }
  let model: ModelSettings;
  try { model = resolveModel(env); }
  catch {
    // A missing key is expected on a fresh self-hosted install; this is not a
    // startup failure. Invalid values remain distinguishable without exposing
    // addresses, secrets, provider responses or parser excerpts.
    const custom = ['MODEL_BASE_URL', 'MODEL_API_KEY', 'MODEL_NAME'].some(key => env[key]?.trim());
    const key = env[custom ? 'MODEL_API_KEY' : 'DEEPSEEK_API_KEY']?.trim();
    return { revision, limits, error: key ? 'model_configuration_invalid' : 'model_not_configured' };
  }
  try { return { revision, limits, model, web: resolveWebSettings(env) }; }
  catch { return { revision, limits, model, error: 'web_configuration_invalid' }; }
}

async function boundedSnapshot(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new RuntimeSettingsError('runtime_config_unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) {
        await reader.cancel();
        throw new RuntimeSettingsError('runtime_config_unavailable');
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

function validateSnapshot(input: unknown): { revision: string; values: NodeJS.ProcessEnv } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeSettingsError('runtime_config_unavailable');
  const data = input as Record<string, unknown>;
  const revision = typeof data.revision === 'number' && Number.isSafeInteger(data.revision) && data.revision >= 0 ? String(data.revision) :
    typeof data.revision === 'string' && /^\d{1,20}$/.test(data.revision) ? data.revision : undefined;
  if (!revision || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
    throw new RuntimeSettingsError('runtime_config_unavailable');
  }
  const values: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(data.values)) {
    if (!runtimeKeys.has(key)) continue;
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000\r\n]/.test(value)) {
      throw new RuntimeSettingsError('runtime_config_unavailable');
    }
    values[key] = value;
  }
  return { revision, values };
}

export function createRuntimeSettingsProvider(
  env: NodeJS.ProcessEnv,
  apiUrl: string,
  serviceToken: string,
  transport: typeof fetch = fetch,
): { mode: 'environment' | 'runtime'; snapshot(signal?: AbortSignal): Promise<RuntimeSettings> } {
  const mode = env.TADA_RUNTIME_CONFIG?.trim();
  if (mode && !['enabled', 'disabled'].includes(mode)) throw new Error('TADA_RUNTIME_CONFIG 须为 enabled 或 disabled');
  if (mode !== 'enabled') {
    // Pin the process environment once, matching the legacy deployment model.
    const initial = settingsFromEnv({ ...env }, null);
    return { mode: 'environment', snapshot: async () => initial };
  }
  const endpoint = `${rustServiceUrl(apiUrl, true)}/internal/config/runtime`;
  if (serviceToken.length < 32 || /[\r\n]/.test(serviceToken)) throw new Error('内部配置认证无效');
  return { mode: 'runtime', async snapshot(signal) {
    try {
      const response = await transport(endpoint, {
        method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { 'X-Agent-Service': serviceToken, Accept: 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
      });
      const { revision, values } = validateSnapshot(await boundedSnapshot(response));
      return settingsFromEnv(values, revision);
    } catch {
      // No last-known-good fallback: deleted credentials or failed reads must
      // not silently continue routing user data to an old external provider.
      throw new RuntimeSettingsError('runtime_config_unavailable');
    }
  } };
}
