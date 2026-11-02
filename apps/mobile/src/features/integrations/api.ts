import type { ApiClient } from '../../api/client';
import type {
  ImportContentInput,
  ImportedContent,
  Integration,
  IntegrationResult,
  MailDraft,
  MailReceipt,
} from './types';

export function integrationsApi(
  api: ApiClient,
  signal?: AbortSignal | (() => AbortSignal),
) {
  const request: ApiClient['request'] = (path, method, body) =>
    api.request(
      path,
      method,
      body,
      typeof signal === 'function' ? signal() : signal,
    );
  const path = (id: string) => '/integrations/' + encodeURIComponent(id);
  return {
    list: () => request<{ items: Integration[] }>('/integrations'),
    connect: (id: string, credentials: Record<string, string>) =>
      request<Integration>(path(id) + '/connect', 'POST', credentials),
    authorize: (id: string) =>
      request<{ authorization_url: string }>(
        path(id) + '/authorize',
        'POST',
        {},
      ),
    disconnect: (id: string) => request<{ ok: boolean }>(path(id), 'DELETE'),
    sendMail: (id: string, draft: MailDraft) =>
      request<MailReceipt>(path(id) + '/send', 'POST', {
        ...draft,
        confirmed: true,
      }),
    read: async (id: string, query: Record<string, string>) => {
      const result = await request<{
        items?: IntegrationResult[];
        content?: string;
        error?: { message?: string };
      }>(path(id) + '/read', 'POST', query);
      if (result.error) {
        throw new Error(
          result.error.message || '这次读取没有成功，请稍后重试。',
        );
      }
      if (Array.isArray(result.items)) {
        return { items: result.items };
      }
      if (typeof result.content === 'string') {
        return {
          items: [
            {
              id: query.file_id || 'content',
              title: '文档正文',
              text: result.content,
            },
          ],
        };
      }
      throw new Error('暂时无法识别这份资料，请更新服务后重试。');
    },
    imports: (query = '', sourceApp = '') => {
      const params = [
        query && 'q=' + encodeURIComponent(query),
        sourceApp && 'source_app=' + encodeURIComponent(sourceApp),
      ]
        .filter(Boolean)
        .join('&');
      return request<{ items: ImportedContent[] }>(
        '/integrations/imports' + (params ? '?' + params : ''),
      );
    },
    importContent: (input: ImportContentInput) =>
      request<ImportedContent>('/integrations/imports', 'POST', input),
    removeImport: (id: string) =>
      request<{ ok: boolean }>(
        '/integrations/imports/' + encodeURIComponent(id),
        'DELETE',
      ),
  };
}

export function importDraft(
  sourceApp: string,
  title: string,
  text: string,
  url = '',
): ImportContentInput {
  const cleanText = text.trim();
  const cleanUrl = url.trim();
  if (!cleanText && !cleanUrl) {
    throw new Error('请先填写想交给妥啦的文字或链接。');
  }
  if (cleanUrl && !/^https?:\/\/[^\s]+$/i.test(cleanUrl)) {
    throw new Error('请输入以 https:// 或 http:// 开头的完整链接。');
  }
  if (cleanText.length > 16000 || cleanUrl.length > 2048) {
    throw new Error('这份内容太长，请分成几份再导入。');
  }
  return {
    source_app: sourceApp,
    title:
      Array.from(title.trim()).slice(0, 120).join('') ||
      Array.from(cleanText).slice(0, 40).join('') ||
      '分享的链接',
    text: cleanText || cleanUrl,
    ...(cleanUrl ? { url: cleanUrl } : {}),
  };
}
