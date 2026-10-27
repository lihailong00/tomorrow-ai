import React from 'react';
import { Switch } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { AiHistoryScreen } from '../src/features/ai-history/AiHistoryScreen';
import { aiHistoryApi, Preview } from '../src/features/ai-history/api';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    pickDocument: jest.fn(),
    share: jest.fn(),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
const preview: Preview = {
  id: 'preview-a',
  provider: 'chatgpt',
  expires_at: 1800000000,
  conversation_count: 2,
  message_count: 4,
  skipped_conversations: 0,
  skipped_blocks: 1,
  warnings: ['仅导入可见文字'],
  offset: 0,
  has_more: false,
  items: [
    {
      key: 'one',
      title: '旅行偏好',
      message_count: 2,
      preview: '我喜欢火车',
      warnings: [],
    },
    {
      key: 'two',
      title: '为朋友代写',
      message_count: 2,
      preview: '帮朋友写信',
      warnings: [],
    },
  ],
};
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  (platform.pickDocument as jest.Mock).mockResolvedValue({
    uri: 'file:///export.zip',
    name: 'export.zip',
    mime_type: 'application/zip',
    size: 1024,
  });
});

async function setup() {
  const request = jest.fn(async (path: string, method = 'GET') => {
    if (path.endsWith('/commit')) {
      return { imported: 1, updated: 0, skipped: 0, provider: 'chatgpt' };
    }
    if (path.endsWith('/preview')) {
      return preview;
    }
    if (method === 'DELETE') {
      return { ok: true };
    }
    if (path.includes('/conversations/history-one')) {
      return {
        id: 'history-one',
        title: '已导入',
        warnings: [],
        messages: [],
        message_count: 2,
        has_more: false,
      };
    }
    if (path.includes('/conversations')) {
      return {
        items: [
          {
            id: 'history-one',
            provider: 'chatgpt',
            title: '已导入',
            preview: '过去的对话',
            message_count: 2,
            imported_at: 1800000000,
          },
        ],
        has_more: false,
      };
    }
    return { items: [] };
  });
  const context = {
    api: { request, baseUrl: 'https://example.test' },
    user: { id: 'owner-a' },
    navigate: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <AiHistoryScreen />
      </AppProvider>,
    );
  });
  const button = (label: string) =>
    tree.root
      .findAllByType(Button)
      .find(
        n =>
          (Array.isArray(n.props.children)
            ? n.props.children.join('')
            : n.props.children) === label,
      )!;
  return {
    tree,
    request,
    context,
    button,
    async press(label: string) {
      await act(async () => {
        await button(label).props.onPress();
      });
    },
    async unmount() {
      await act(async () => tree.unmount());
    },
  };
}

it('requires a chosen file and explicit upload consent, then a separate import confirmation', async () => {
  const view = await setup();
  expect(view.request.mock.calls.every(c => c[1] !== 'POST')).toBe(true);
  await view.press('选择导出文件');
  expect(view.button('上传并预览').props.disabled).toBe(true);
  await view.press('上传并预览');
  expect(view.request.mock.calls.some(c => c[1] === 'POST')).toBe(false);
  await act(async () => {
    view.tree.root.findByType(Switch).props.onValueChange(true);
  });
  await view.press('上传并预览');
  expect(
    view.request.mock.calls.some(c => c[0] === '/ai-history/chatgpt/preview'),
  ).toBe(true);
  expect(view.request.mock.calls.some(c => c[0].endsWith('/commit'))).toBe(
    false,
  );
  await act(async () => {
    view.tree.root
      .findAll(n => n.props.accessibilityLabel === '导入 为朋友代写')[0]
      .props.onPress();
  });
  await view.press('确认导入 1 段对话');
  expect(view.request).toHaveBeenCalledWith(
    '/ai-history/previews/preview-a/commit',
    'POST',
    { all: true, exclude_keys: ['two'] },
    expect.anything(),
  );
  expect(
    view.request.mock.calls.some(
      c => c[0].includes('/memories') || c[0] === '/chat',
    ),
  ).toBe(false);
  await view.unmount();
});

it('discards temporary previews without saving their conversations or memories', async () => {
  const view = await setup();
  await view.press('选择导出文件');
  await act(async () => {
    view.tree.root.findByType(Switch).props.onValueChange(true);
  });
  await view.press('上传并预览');
  await view.press('取消并删除预览');
  expect(view.request).toHaveBeenCalledWith(
    '/ai-history/previews/preview-a',
    'DELETE',
    undefined,
    expect.anything(),
  );
  expect(view.request.mock.calls.some(c => c[0].endsWith('/commit'))).toBe(
    false,
  );
  await view.unmount();
});

it('memory extraction opens a review conversation instead of writing memories', async () => {
  const view = await setup();
  await act(async () => {
    view.tree.root
      .findAll(
        n =>
          n.props.accessibilityRole === 'button' &&
          n.props.children?.[0]?.props?.children === '已导入',
      )[0]
      .props.onPress();
  });
  await view.press('整理记忆候选，先给我确认');
  expect(view.context.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'chat',
      prompt: expect.stringContaining('不要保存任何记忆'),
    }),
  );
  expect(view.request.mock.calls.some(c => c[0].includes('/memories'))).toBe(
    false,
  );
  await view.unmount();
});

it('rejects a login page or oversized file before making an import request', () => {
  const request = jest.fn();
  const client = aiHistoryApi({ request } as unknown as ApiClient);
  expect(() =>
    client.upload('claude', {
      uri: 'file:///a.html',
      name: 'a.html',
      mime_type: 'text/html',
    }),
  ).toThrow('ZIP 或 JSON');
  expect(() =>
    client.upload('deepseek', {
      uri: 'file:///a.json',
      name: 'a.json',
      mime_type: 'application/json',
      size: 26 * 1024 * 1024,
    }),
  ).toThrow('25 MB');
  expect(request).not.toHaveBeenCalled();
});
