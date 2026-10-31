import type { ApiClient } from '../../api/client';
import {
  parseHealthConnections,
  parseHealthRead,
  type HealthConnection,
  type HealthMetric,
} from './types';

export function healthApi(api: ApiClient, signal: () => AbortSignal) {
  const request = <T>(path: string, method = 'GET', body?: unknown) =>
    api.request<T>('/health' + path, method, body, signal());
  const connection = (id: HealthConnection['id']) => '/connections/' + id;
  return {
    list: async () =>
      parseHealthConnections(await request<unknown>('/connections')),
    authorize: (id: HealthConnection['id'], metrics: HealthMetric[]) =>
      request<{ authorization_url: string }>(
        connection(id) + '/authorize',
        'POST',
        { metrics },
      ),
    finalize: (id: HealthConnection['id'], receipt: string) =>
      request<{
        connected: boolean;
        provider: HealthConnection['id'];
        granted_metrics: HealthMetric[];
      }>(connection(id) + '/finalize', 'POST', { receipt }),
    sync: async (id: HealthConnection['id'], metrics: HealthMetric[]) =>
      parseHealthRead(
        await request<unknown>(connection(id) + '/sync', 'POST', {
          metrics,
          days: 7,
        }),
      ),
    disconnect: (id: HealthConnection['id']) =>
      request<{
        local_credentials_removed: boolean;
        remote_revoked: boolean;
        message: string;
      }>(connection(id), 'DELETE'),
  };
}

/** OAuth can only open the provider's exact official login host and path. */
export function healthAuthorizationUrl(
  provider: HealthConnection['id'],
  input: unknown,
): string {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\]/.test(input))
    throw new Error('授权地址不安全，已停止打开。');
  const expected =
    provider === 'xiaomi'
      ? /^https:\/\/account\.xiaomi\.com\/oauth2\/authorize\?[^#]+$/
      : /^https:\/\/oauth-login\.cloud\.huawei\.com\/oauth2\/v3\/authorize\?[^#]+$/;
  if (!expected.test(input))
    throw new Error('授权地址不是该厂商的官方登录页面，已停止打开。');
  return input;
}
