import React from 'react';
import { Alert, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { SlackConnection } from '../src/features/integrations/SlackConnection';
import {
  slackIntegration,
  slackSearchQuery,
} from '../src/features/integrations/slackModel';
import { platform } from '../src/platform/ports';
import { ChatScreen } from '../src/screens/Chat';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: { openUrl: jest.fn(), onForeground: jest.fn(() => jest.fn()) },
}));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

it('recognizes explicit Slack searches without capturing questions about Slack', () => {
  expect(slackSearchQuery('/slack 发布 in:team')).toBe('发布 in:team');
  expect(slackSearchQuery('帮我在 Slack 里搜一下发布记录')).toBe('发布记录');
  expect(slackSearchQuery('查一下 Slack：发布记录')).toBe('发布记录');
  expect(slackSearchQuery('Slack 怎么申请加入工作区？')).toBeNull();
  expect(slackSearchQuery('帮我在 Slack 发消息')).toBeNull();
});

it('completes authorization, auto-search, paging and disconnect in the temporary view', async () => {
  let connected = false;
  const request = jest.fn(
    async (path: string, method?: string, body?: { cursor?: string }) => {
      switch (path) {
        case '/integrations':
          return {
            items: [
              {
                ...slackIntegration,
                status: connected ? 'connected' : 'not_connected',
              },
            ],
          };
        case '/integrations/slack/authorize':
          return {
            authorization_url:
              'https://slack.com/oauth/v2/authorize?state=fixture',
          };
        case '/integrations/slack/search':
          return body?.cursor
            ? { items: [], next_cursor: null }
            : {
                items: [
                  {
                    id: 'C123:123',
                    title: '#release',
                    text: 'Fixture only',
                    url: 'https://test.slack.com/archives/C123/p123?thread_ts=122.45&cid=C123',
                  },
                ],
                next_cursor: 'next-page',
              };
        case '/integrations/slack':
          expect(method).toBe('DELETE');
          connected = false;
          return { ok: true };
        default:
          throw new Error('Unexpected request: ' + path);
      }
    },
  );
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const context = {
    api: { request },
    user: { id: 'tester' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  const visible = () => JSON.stringify(tree.toJSON());
  const press = async (label: string) => {
    const button = tree.root
      .findAllByType(Button)
      .find(node => node.props.children === label);
    if (!button) throw new Error('Missing button: ' + label);
    await act(async () => {
      await button.props.onPress();
    });
  };
  try {
    await act(async () => {
      tree = create(
        <AppProvider value={context}>
          <SlackConnection initialQuery="发布记录" />
        </AppProvider>,
      );
    });
    expect(request).not.toHaveBeenCalledWith(
      '/integrations/slack/search',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    await press('前往 Slack 授权');
    expect(platform.openUrl).toHaveBeenCalledWith(
      'https://slack.com/oauth/v2/authorize?state=fixture',
    );
    connected = true;
    await act(async () => {
      const foreground = (platform.onForeground as jest.Mock).mock.calls[0][0];
      foreground();
    });
    expect(request).toHaveBeenCalledWith(
      '/integrations/slack/search',
      'POST',
      { query: '发布记录' },
      expect.any(AbortSignal),
    );
    expect(visible()).toContain('Fixture only');
    expect(visible()).not.toContain('导入');
    expect(tree.root.findByType(TextInput).props.value).toBe('发布记录');
    await press('打开 Slack 原消息 ↗');
    expect(platform.openUrl).toHaveBeenCalledWith(
      'https://test.slack.com/archives/C123/p123?thread_ts=122.45&cid=C123',
    );
    await press('加载更多');
    expect(request).toHaveBeenCalledWith(
      '/integrations/slack/search',
      'POST',
      { query: '发布记录', cursor: 'next-page' },
      expect.any(AbortSignal),
    );
    await press('断开 Slack');
    await act(async () => alert.mock.calls[0][2]?.[1].onPress?.());
    expect(visible()).not.toContain('Fixture only');
    expect(visible()).toContain('前往 Slack 授权');
  } finally {
    await act(async () => tree?.unmount());
    alert.mockRestore();
  }
});

it('opens a temporary Slack search from chat without creating a chat turn', async () => {
  const chatStream = jest.fn();
  const request = jest.fn(async (path: string) => {
    if (path === '/integrations') {
      return { items: [{ ...slackIntegration, status: 'connected' }] };
    }
    if (path === '/integrations/slack/search') {
      return {
        items: [{ id: 'test', title: '#release', text: 'Temporary result' }],
        next_cursor: null,
      };
    }
    throw new Error('Unexpected request: ' + path);
  });
  const context = {
    api: {
      capabilities: jest
        .fn()
        .mockResolvedValue({ runtime: { model_mode: 'local' } }),
      request,
      chatStream,
    },
    formatDate: () => '',
    invalidate: jest.fn(),
    user: { id: 'tester' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = create(
        <AppProvider value={context}>
          <ChatScreen />
        </AppProvider>,
      );
    });
    await act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('/slack 发布');
    });
    await act(async () => {
      tree.root
        .findAll(
          node =>
            node.props.accessibilityLabel === '发送消息' &&
            typeof node.props.onPress === 'function',
        )[0]
        .props.onPress();
    });
    expect(request).toHaveBeenCalledWith(
      '/integrations/slack/search',
      'POST',
      { query: '发布' },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(tree.toJSON())).toContain('Temporary result');
    expect(chatStream).not.toHaveBeenCalled();
    await act(async () => {
      tree.root
        .findAllByType(Button)
        .find(node => node.props.children === '关闭')
        ?.props.onPress();
    });
    expect(JSON.stringify(tree.toJSON())).not.toContain('Temporary result');
    expect(tree.root.findByType(TextInput).props.value).toBe('');
  } finally {
    await act(async () => tree?.unmount());
  }
});
