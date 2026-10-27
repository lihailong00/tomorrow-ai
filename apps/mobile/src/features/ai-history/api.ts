import type { ApiClient } from '../../api/client';
import type { LocalFile } from '../../platform/ports';

export type Provider = 'chatgpt' | 'claude' | 'deepseek';
export const providers: { id: Provider; name: string; guide: string }[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    guide: '设置 → 数据控制 → 导出数据，下载导出 ZIP。',
  },
  {
    id: 'claude',
    name: 'Claude',
    guide:
      '在网页版或桌面端打开 Settings → Privacy → Export data，下载邮件中的文件。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    guide: '头像 → 设置 → 数据管理 → 导出所有历史对话。',
  },
];
export type PreviewItem = {
  key: string;
  title: string;
  message_count: number;
  preview: string;
  created_at?: string;
  updated_at?: string;
  warnings: string[];
};
export type Preview = {
  id: string;
  provider: Provider;
  expires_at: number;
  conversation_count: number;
  message_count: number;
  skipped_conversations: number;
  skipped_blocks: number;
  warnings: string[];
  items: PreviewItem[];
  offset: number;
  has_more: boolean;
};
export type HistoryItem = {
  id: string;
  provider: Provider;
  title: string;
  preview: string;
  message_count: number;
  imported_at: number;
};
export type HistoryMessage = {
  id: string;
  parent_id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  on_current_branch: boolean | null;
};
export type HistoryDetail = {
  id?: string;
  title: string;
  provider?: Provider;
  warnings: string[];
  messages: HistoryMessage[];
  message_count: number;
  offset?: number;
  next_offset?: number;
  has_more: boolean;
};
export type CommitResult = {
  imported: number;
  updated: number;
  skipped: number;
  provider: Provider;
};

export function aiHistoryApi(api: ApiClient, signal?: AbortSignal) {
  const request = <T>(path: string, method = 'GET', body?: unknown) =>
    api.request<T>('/ai-history' + path, method, body, signal);
  return {
    upload: (source: Provider, file: LocalFile) => {
      if (!/\.(zip|json)$/i.test(file.name)) {
        throw new Error('请选择官方导出的 ZIP 或 JSON 文件。');
      }
      if (file.size !== undefined && file.size > 25 * 1024 * 1024) {
        throw new Error('文件超过 25 MB，请解压后分批导入对话 JSON。');
      }
      const form = new FormData();
      form.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mime_type,
      } as any);
      return request<Preview>('/' + source + '/preview', 'POST', form);
    },
    previews: () => request<{ items: Preview[] }>('/previews'),
    preview: (id: string, offset = 0) =>
      request<Preview>(
        '/previews/' + encodeURIComponent(id) + '?offset=' + offset,
      ),
    previewDetail: (id: string, key: string, offset = 0) =>
      request<HistoryDetail>(
        '/previews/' +
          encodeURIComponent(id) +
          '?conversation_key=' +
          encodeURIComponent(key) +
          '&limit=20&offset=' +
          offset,
      ),
    discard: (id: string) =>
      request('/previews/' + encodeURIComponent(id), 'DELETE'),
    commit: (
      id: string,
      selection: { all: true; exclude_keys: string[] } | { keys: string[] },
    ) =>
      request<CommitResult>(
        '/previews/' + encodeURIComponent(id) + '/commit',
        'POST',
        selection,
      ),
    list: (query = '', source = '', offset = 0) =>
      request<{ items: HistoryItem[]; has_more: boolean }>(
        '/conversations?q=' +
          encodeURIComponent(query) +
          '&provider=' +
          encodeURIComponent(source) +
          '&offset=' +
          offset,
      ),
    detail: (id: string, offset = 0) =>
      request<HistoryDetail>(
        '/conversations/' +
          encodeURIComponent(id) +
          '?offset=' +
          offset +
          '&limit=20',
      ),
    remove: (id: string) =>
      request('/conversations/' + encodeURIComponent(id), 'DELETE'),
  };
}
