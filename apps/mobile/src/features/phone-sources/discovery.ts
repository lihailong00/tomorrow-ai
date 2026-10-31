import { ApiClient, ApiError } from '../../api/client';

/** Keep system-source setup usable independently of the current Todo screen implementation. */
export async function discoverPhoneTodos(
  api: ApiClient,
  sourceId: string,
  requestId: string,
  signal: AbortSignal,
) {
  try {
    const result = await api.request<{ created_count: number }>(
      '/todos/extract',
      'POST',
      {
        source_kind: 'integration_import',
        source_id: sourceId,
        client_request_id: requestId,
      },
      signal,
    );
    if (!Number.isInteger(result.created_count) || result.created_count < 0)
      throw new Error('服务器未确认整理结果，请重试同一次操作。');
    return result;
  } catch (failure) {
    if (failure instanceof ApiError && [404, 405, 501].includes(failure.status))
      throw new Error('当前服务器尚不支持从资料发现事项，请更新服务器后重试。');
    throw failure;
  }
}
