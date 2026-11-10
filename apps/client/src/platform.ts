import {createDesktopTransport, createFetchTransport, normalizeServerUrl, type ClientTransport, type DesktopStreamEvent, type InstanceManifest} from '@tada/client-core';
import {browserLocationBridge, desktopLocationBridge, type LocationBridge} from './location/bridge';

export type Platform = {
  desktop: boolean;
  location?: LocationBridge;
  transport: ClientTransport;
  readSession(serverUrl: string, instanceId: string): Promise<string | null>;
  writeSession(serverUrl: string, instanceId: string, token: string | null): Promise<void>;
};

export async function createPlatform(): Promise<Platform> {
  if ('__TAURI_INTERNALS__' in window) {
    const {invoke, Channel} = await import('@tauri-apps/api/core');
    const writes = new Map<string, Promise<void>>();
    return {
      desktop: true,
      location: navigator.userAgent.includes('Windows') ? desktopLocationBridge(invoke) : browserLocationBridge(),
      transport: createDesktopTransport({invoke, createChannel(handler: (event: DesktopStreamEvent) => void) {
        return new Channel<DesktopStreamEvent>(handler);
      }}),
      readSession: async (serverUrl, instanceId) => {await writes.get(`${serverUrl}:${instanceId}`)?.catch(() => {}); return invoke<string | null>('desktop_session_read', {serverUrl, instanceId});},
      writeSession: (serverUrl, instanceId, token) => {
        const key = `${serverUrl}:${instanceId}`;
        const previous = writes.get(key) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(() => invoke<void>('desktop_session_write', {serverUrl, instanceId, token}));
        writes.set(key, operation);
        void operation.finally(() => {if (writes.get(key) === operation) writes.delete(key);}).catch(() => {});
        return operation;
      },
    };
  }
  return {desktop: false, location: browserLocationBridge(), transport: createFetchTransport(), readSession: async () => null, writeSession: async () => {}};
}

export async function openExternal(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
  if ('__TAURI_INTERNALS__' in window) {
    const {invoke} = await import('@tauri-apps/api/core');
    await invoke('desktop_open_url', {url: url.href});
  } else {
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }
}

export const OFFICIAL_SERVER = 'https://api.example.invalid';
/** A custom server cannot confer official status through its own manifest. */
export function serviceLabel(serverUrl: string, manifest: InstanceManifest | null): '官方服务' | '自建服务' | '自定义服务' | '正在验证服务' {
  if (!manifest) return '正在验证服务';
  try {if (normalizeServerUrl(serverUrl, true) === OFFICIAL_SERVER) return '官方服务';} catch {return '正在验证服务';}
  return manifest.deployment_mode === 'self_hosted' ? '自建服务' : '自定义服务';
}
export type ServerChoice = {url: string; instanceId?: string; allowInsecureLan?: boolean; autoRestore?: boolean};
const preferenceKey = 'tada.client.server.v1';
export function readServerChoice(): ServerChoice {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
    if (value && typeof value.url === 'string') return {url: value.url, instanceId: typeof value.instanceId === 'string' ? value.instanceId : undefined, allowInsecureLan: value.allowInsecureLan === true, autoRestore: value.autoRestore === true};
  } catch { /* Storage may be unavailable; official remains explicit default. */ }
  return {url: OFFICIAL_SERVER};
}
export function saveServerChoice(choice: ServerChoice) {
  try { localStorage.setItem(preferenceKey, JSON.stringify(choice)); } catch { /* Preference failure must not break the session. */ }
}

export function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请稍后重试。'; }
