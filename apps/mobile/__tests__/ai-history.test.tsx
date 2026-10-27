import React from 'react';
import { Switch } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient, ApiError } from '../src/api/client';
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

async function setup(initialPreview: Preview | null = null) {
  const request = jest.fn<
    Promise<any>,
    [string, string?, unknown?, AbortSignal?]
  >(async (path: string, method = 'GET') => {
    if (path.endsWith('/commit')) {
      return { imported: 1, updated: 0, skipped: 0, provider: 'chatgpt' };
    }
    if (path.endsWith('/preview')) {
      return preview;
    }
    if (method === 'DELETE') {
      return { ok: true };
    }
    if (path === '/ai-history/previews') {
      return { items: initialPreview ? [initialPreview] : [] };
    }
    if (path.includes('/previews/')) {
      return path.includes('conversation_key=')
        ? {
            title: '旅行偏好',
            warnings: [],
            message_count: 22,
            has_more: true,
            messages: [
              {
                id: 'message-one',
                role: 'user',
                content: '我喜欢火车',
                on_current_branch: true,
              },
            ],
          }
        : initialPreview || preview;
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
    async rerender(next: Partial<AppContextValue>) {
      Object.assign(context, next);
      await act(async () => {
        tree.update(
          <AppProvider value={{ ...context }}>
            <AiHistoryScreen />
          </AppProvider>,
        );
      });
    },
  };
}

const receipt = { imported: 1, updated: 2, skipped: 3, provider: 'chatgpt' };
const completed = { completed: true, result: receipt };
const visibleText = (node: any): string =>
  typeof node === 'string'
    ? node
    : Array.isArray(node)
    ? node.map(visibleText).join('')
    : visibleText(node?.children || []);
const text = (view: Awaited<ReturnType<typeof setup>>) =>
  visibleText(view.tree.toJSON());
const expectReceipt = (view: Awaited<ReturnType<typeof setup>>) => {
  expect(text(view)).toContain(
    '导入完成：新增 1 段，更新 2 段，跳过 3 段相同记录',
  );
  expect(view.button('确认导入 2 段对话')).toBeUndefined();
};

it.each(['detail', 'conversation page', 'message page', 'foreground'])(
  'shows the completed receipt when another device commits before %s',
  async operation => {
    const view = await setup({ ...preview, has_more: true });
    if (operation === 'message page') {
      await view.press('查看消息');
    }
    const original = view.request.getMockImplementation()!;
    view.request.mockImplementation(async (path, method) =>
      path.includes('/previews/preview-a') ? completed : original(path, method),
    );
    if (operation === 'foreground') {
      await act(async () => {
        await (platform.onForeground as jest.Mock).mock.calls.slice(-1)[0][0]();
      });
    } else {
      await view.press(
        operation === 'detail'
          ? '查看消息'
          : operation === 'message page'
          ? '加载更多消息'
          : '加载更多对话',
      );
    }
    expectReceipt(view);
    expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(
      false,
    );
    expect(view.context.invalidate).toHaveBeenCalledTimes(1);
    await view.unmount();
  },
);

it('recovers the receipt after a lost commit response without importing again', async () => {
  const view = await setup(preview);
  const original = view.request.getMockImplementation()!;
  view.request.mockImplementation(async (path, method) => {
    if (path.endsWith('/commit')) {
      throw new ApiError('network', '连接已断开');
    }
    return path.includes('/previews/preview-a')
      ? completed
      : original(path, method);
  });
  await view.press('确认导入 2 段对话');
  expectReceipt(view);
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(1);
  expect(
    view.request.mock.calls.filter(call =>
      call[0].includes('/previews/preview-a?'),
    ),
  ).toHaveLength(1);
  await view.rerender({ invalidate: jest.fn(), revision: 1 });
  expectReceipt(view);
  expect(view.request.mock.calls[0][3]?.aborted).not.toBe(true);
  await view.unmount();
});

it.each(['before cancel', 'during cancel'])(
  'preserves a completed receipt when commit wins %s',
  async race => {
    const view = await setup(preview);
    const original = view.request.getMockImplementation()!;
    view.request.mockImplementation(async (path, method) => {
      if (
        path.includes('/previews/preview-a') &&
        (race === 'before cancel' || method === 'DELETE')
      ) {
        return completed;
      }
      return original(path, method);
    });
    await view.press('取消并删除预览');
    expectReceipt(view);
    expect(text(view)).not.toContain('已取消并删除预览');
    expect(
      view.request.mock.calls.filter(call => call[1] === 'DELETE'),
    ).toHaveLength(race === 'before cancel' ? 0 : 1);
    expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(
      false,
    );
    await view.unmount();
  },
);

it.each(['completed', 'pending'])(
  'pins the submitted selection when both the commit and receipt responses are lost (%s)',
  async outcome => {
    const view = await setup(preview);
    await view.press('取消全选');
    const selection = (title: string) =>
      view.tree.root.findAll(
        node =>
          node.props.accessibilityRole === 'checkbox' &&
          node.props.accessibilityLabel === '导入 ' + title,
      )[0];
    await act(async () => selection('旅行偏好').props.onPress());
    const original = view.request.getMockImplementation()!;
    let posts = 0;
    let reads = 0;
    view.request.mockImplementation(async (path, method) => {
      if (path.endsWith('/commit')) {
        if (++posts === 1) throw new ApiError('network', '响应已丢失');
        return receipt;
      }
      if (path.includes('/previews/preview-a?')) {
        if (++reads === 1) throw new ApiError('network', '查询结果已丢失');
        return outcome === 'completed' ? completed : preview;
      }
      return original(path, method);
    });
    await view.press('确认导入 1 段对话');
    expect(text(view)).toContain('导入范围已保留');
    expect(selection('为朋友代写').props.disabled).toBe(true);
    await act(async () => {
      selection('旅行偏好').props.onPress();
      selection('为朋友代写').props.onPress();
      view.button('全选').props.onPress();
    });
    expect(selection('旅行偏好').props.accessibilityState.checked).toBe(true);
    expect(selection('为朋友代写').props.accessibilityState.checked).toBe(
      false,
    );
    await view.press('确认导入 1 段对话');
    expectReceipt(view);
    const attempts = view.request.mock.calls.filter(call => call[1] === 'POST');
    expect(attempts).toHaveLength(outcome === 'completed' ? 1 : 2);
    expect(
      attempts.every(
        call => JSON.stringify(call[2]) === JSON.stringify({ keys: ['one'] }),
      ),
    ).toBe(true);
    await view.unmount();
  },
);

it('keeps the original selection pinned when an unresolved retry is rate limited', async () => {
  const view = await setup(preview);
  const original = view.request.getMockImplementation()!;
  let posts = 0;
  let reads = 0;
  view.request.mockImplementation(async (path, method) => {
    if (path.endsWith('/commit')) {
      posts += 1;
      throw posts === 1
        ? new ApiError('network', '响应已丢失')
        : new ApiError('rate_limited', '请稍后重试', 429);
    }
    if (path.includes('/previews/preview-a?')) {
      if (++reads === 1) throw new ApiError('network', '查询结果已丢失');
      return preview;
    }
    return original(path, method);
  });
  await view.press('确认导入 2 段对话');
  await view.press('确认导入 2 段对话');
  expect(view.button('取消全选').props.disabled).toBe(true);
  await act(async () => view.button('取消全选').props.onPress());
  expect(view.button('确认导入 2 段对话')).toBeDefined();
  expect(posts).toBe(2);
  expect(text(view)).toContain('导入范围已保留');
  await view.unmount();
});

it.each([
  ['查看消息', 404],
  ['加载更多对话', 400],
  ['确认导入 2 段对话', 404],
  ['取消并删除预览', 404],
])(
  'recovers an expired preview during %s (%s) without a retry loop',
  async (label, status) => {
    const view = await setup({ ...preview, has_more: true });
    const original = view.request.getMockImplementation()!;
    view.request.mockImplementation(async (path, method) => {
      if (path.includes('/previews/preview-a')) {
        throw new ApiError(
          'not_found',
          '找不到这份对话导入记录，或预览已过期',
          Number(status),
        );
      }
      return original(path, method);
    });
    await view.press(String(label));
    expect(text(view)).toContain('如需继续导入，请重新选择文件');
    expect(view.button('确认导入 2 段对话')).toBeUndefined();
    expect(
      view.request.mock.calls.filter(call =>
        call[0].includes('/previews/preview-a'),
      ),
    ).toHaveLength(1);
    await view.unmount();
  },
);

it('keeps a rejected selection actionable without automatically repeating the commit', async () => {
  const view = await setup(preview);
  const original = view.request.getMockImplementation()!;
  view.request.mockImplementation(async (path, method) => {
    if (path.endsWith('/commit')) {
      throw new ApiError(
        'invalid_ai_export',
        '请选择至少一段预览中的对话',
        400,
      );
    }
    return original(path, method);
  });
  await view.press('确认导入 2 段对话');
  expect(text(view)).toContain('请选择至少一段预览中的对话');
  expect(view.button('确认导入 2 段对话')).toBeDefined();
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(1);
  await view.unmount();
});

it.each(['account', 'instance', 'server'])(
  'ignores late completion after switching %s',
  async owner => {
    const view = await setup(preview);
    const original = view.request.getMockImplementation()!;
    let resolve!: (value: any) => void;
    view.request.mockImplementation(async (path, method) =>
      path.includes('/previews/preview-a?')
        ? new Promise(value => {
            resolve = value;
          })
        : original(path, method),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = view.button('查看消息').props.onPress();
    });
    view.request.mockImplementation(async (path, method) =>
      path === '/ai-history/previews' ? { items: [] } : original(path, method),
    );
    await view.rerender(
      owner === 'account'
        ? { user: { id: 'owner-b' } as any }
        : {
            preferences: {
              serverUrl:
                owner === 'server'
                  ? 'https://other.test'
                  : 'https://example.test',
              instance: {
                id: owner === 'instance' ? 'instance-b' : 'instance-a',
              },
            } as any,
          },
    );
    await act(async () => {
      resolve(completed);
      await pending;
    });
    expect(text(view)).not.toContain('导入完成：');
    expect(view.context.invalidate).not.toHaveBeenCalled();
    await view.unmount();
  },
);

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
