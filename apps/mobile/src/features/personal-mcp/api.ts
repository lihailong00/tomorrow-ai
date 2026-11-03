import type { ApiClient } from '../../api/client';
import type {
  McpEnvironment,
  PersonalMcpAction,
  PersonalMcpConnection,
  PersonalMcpTool,
} from './types';

export function personalMcpApi(api: ApiClient, signal: () => AbortSignal) {
  const request = <T>(path: string, method = 'GET', body?: unknown) =>
    api.request<T>('/personal-mcp' + path, method, body, signal());
  const provider = (id: string) => '/' + encodeURIComponent(id);
  return {
    list: () => request<{ items: PersonalMcpConnection[] }>(''),
    connect: (
      id: string,
      token: string,
      environment: McpEnvironment,
      serverUrl?: string,
      identity?: { account?: string; client_id?: string },
    ) =>
      request<PersonalMcpConnection>(provider(id) + '/connect', 'POST', {
        token,
        environment,
        ...(serverUrl ? { server_url: serverUrl } : {}),
        ...(identity?.account ? { account: identity.account } : {}),
        ...(identity?.client_id ? { client_id: identity.client_id } : {}),
      }),
    test: (id: string) =>
      request<PersonalMcpConnection>(provider(id) + '/test', 'POST', {}),
    tools: (id: string) =>
      request<{ items: PersonalMcpTool[] }>(provider(id) + '/tools'),
    disconnect: (id: string) =>
      request<{ ok: boolean }>(provider(id), 'DELETE'),
    actions: () => request<{ items: PersonalMcpAction[] }>('/actions'),
    confirm: (id: string) =>
      request<PersonalMcpAction>(
        '/actions/' + encodeURIComponent(id) + '/confirm',
        'POST',
        {},
      ),
    cancel: (id: string) =>
      request<PersonalMcpAction>(
        '/actions/' + encodeURIComponent(id) + '/cancel',
        'POST',
        {},
      ),
  };
}
