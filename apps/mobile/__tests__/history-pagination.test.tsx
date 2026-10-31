import React from 'react';
import { RefreshControl, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { ConversationsScreen } from '../src/screens/Chat';
import { ArtifactsScreen, NotificationsScreen } from '../src/screens/Details';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

const item = (id: string) => ({
  id,
  title: `历史${id}`,
  content: 'fixture',
  body: 'fixture',
  read: false,
  created_at: '',
  updated_at: '',
  task_id: 'fixture',
});
const cases = [
  ['conversations', ConversationsScreen, '加载更多对话'],
  ['notifications', NotificationsScreen, '加载更多消息'],
  ['artifacts', ArtifactsScreen, '加载更多成果'],
] as const;
function context(api: unknown) {
  return {
    api,
    revision: 0,
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: () => '今天',
  } as unknown as AppContextValue;
}
const titles = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(node => node.props.children);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it('keeps default history URLs and serializes bounded pages plus false read filters', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"items":[],"next_offset":null}',
    });
  const api = new ApiClient(
    'https://api.example.com',
    undefined,
    undefined,
    fetcher,
  );
  await api.conversations();
  await api.notifications();
  await api.artifacts();
  await api.conversations({ offset: 500, limit: 50 });
  await api.notifications({ offset: 500, limit: 50, read: false });
  await api.artifacts({ offset: 500, limit: 50 });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    'https://api.example.com/v1/conversations',
    'https://api.example.com/v1/notifications',
    'https://api.example.com/v1/artifacts',
    'https://api.example.com/v1/conversations?offset=500&limit=50',
    'https://api.example.com/v1/notifications?offset=500&limit=50&read=false',
    'https://api.example.com/v1/artifacts?offset=500&limit=50',
  ]);
});

it.each(cases)(
  '%s continues older pages, deduplicates overlapping rows, and refreshes from zero',
  async (method, Screen, label) => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({ items: [item('new')], next_offset: 50 })
      .mockResolvedValueOnce({
        items: [item('new'), item('old')],
        next_offset: null,
      })
      .mockResolvedValueOnce({ items: [item('fresh')], next_offset: null });
    const value = context({ [method]: list });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AppProvider value={value}>
          <Screen />
        </AppProvider>,
      );
    });
    await act(async () => {
      tree.root
        .findAllByType(Button)
        .find(node => node.props.children === label)!
        .props.onPress();
    });
    expect(list).toHaveBeenNthCalledWith(2, { offset: 50, limit: 50 });
    expect(titles(tree).filter(title => title === '历史new')).toHaveLength(1);
    expect(titles(tree)).toContain('历史old');
    expect(
      tree.root
        .findAllByType(Button)
        .some(node => node.props.children === label),
    ).toBe(false);
    await act(async () => {
      tree.root.findByType(RefreshControl).props.onRefresh();
    });
    expect(list).toHaveBeenLastCalledWith({ offset: 0, limit: 50 });
    expect(titles(tree)).toContain('历史fresh');
    expect(titles(tree)).not.toContain('历史old');
    await act(async () => tree.unmount());
  },
);

it.each(cases)(
  '%s discards an old account continuation response after switching API ownership',
  async (method, Screen, label) => {
    const late = deferred<{
      items: ReturnType<typeof item>[];
      next_offset: null;
    }>();
    const oldList = jest
      .fn()
      .mockResolvedValueOnce({ items: [item('old-account')], next_offset: 50 })
      .mockReturnValueOnce(late.promise);
    const newList = jest
      .fn()
      .mockResolvedValue({ items: [item('new-account')], next_offset: null });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        <AppProvider value={context({ [method]: oldList })}>
          <Screen />
        </AppProvider>,
      );
    });
    await act(async () => {
      tree.root
        .findAllByType(Button)
        .find(node => node.props.children === label)!
        .props.onPress();
    });
    await act(async () => {
      tree.update(
        <AppProvider value={context({ [method]: newList })}>
          <Screen />
        </AppProvider>,
      );
    });
    await act(async () => {
      late.resolve({ items: [item('stale-account')], next_offset: null });
    });
    expect(newList).toHaveBeenCalledWith({ offset: 0, limit: 50 });
    expect(titles(tree)).toContain('历史new-account');
    expect(titles(tree)).not.toContain('历史stale-account');
    expect(titles(tree)).not.toContain('历史old-account');
    await act(async () => tree.unmount());
  },
);
