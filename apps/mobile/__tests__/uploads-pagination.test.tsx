import React from 'react';
import { Alert, RefreshControl, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { UploadsScreen } from '../src/screens/Uploads';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => jest.restoreAllMocks());

const upload = (id: string, mime = 'text/plain') => ({
  id,
  name: `File ${id}`,
  mime_type: mime,
  size: 100,
  created_at: '',
  uri: '',
});
function context(api: unknown, user = 'owner', server = 'https://one.test') {
  return {
    api,
    user: { id: user },
    preferences: { serverUrl: server, instance: { id: server } },
    revision: 0,
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: () => '今天',
  } as unknown as AppContextValue;
}
const names = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter(text => typeof text === 'string' && text.startsWith('File '));
function press(tree: ReactTestRenderer, label: string) {
  tree.root
    .findAllByType(Button)
    .find(node => node.props.children === label)!
    .props.onPress();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function render(value: AppContextValue) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        <UploadsScreen />
      </AppProvider>,
    );
  });
  return tree;
}

it('keeps default callers compatible and sends bounded paging and category arguments', async () => {
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
  await api.uploads();
  await api.uploads({ offset: 200, limit: 50, kind: 'audio' });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    'https://api.example.com/v1/uploads',
    'https://api.example.com/v1/uploads?offset=200&limit=50&kind=audio',
  ]);
});

it('continues the archive, deduplicates overlaps and filters at the server from page zero', async () => {
  const uploads = jest
    .fn()
    .mockResolvedValueOnce({ items: [upload('new')], next_offset: 50 })
    .mockResolvedValueOnce({
      items: [upload('new'), upload('old')],
      next_offset: null,
    })
    .mockResolvedValueOnce({
      items: [upload('voice', 'audio/mp4')],
      next_offset: null,
    });
  const tree = await render(context({ uploads }));
  await act(async () => {
    press(tree, '加载更多资料');
    press(tree, '加载更多资料');
  });
  expect(uploads).toHaveBeenCalledTimes(2);
  expect(uploads.mock.calls[1][0]).toEqual({
    offset: 50,
    limit: 50,
    kind: 'all',
  });
  expect(names(tree)).toEqual(['File new', 'File old']);
  expect(
    tree.root
      .findAllByType(Button)
      .some(node => node.props.children === '加载更多资料'),
  ).toBe(false);
  await act(async () => press(tree, '录音'));
  expect(uploads.mock.calls[2][0]).toEqual({
    offset: 0,
    limit: 50,
    kind: 'audio',
  });
  expect(names(tree)).toEqual(['File voice']);
  await act(async () => tree.unmount());
});

it('ignores an old continuation after a filter change and refreshes the active filter', async () => {
  const late = deferred<{
    items: ReturnType<typeof upload>[];
    next_offset: number | null;
  }>();
  const uploads = jest
    .fn()
    .mockResolvedValueOnce({ items: [upload('all')], next_offset: 50 })
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({
      items: [upload('audio', 'audio/mp4')],
      next_offset: 50,
    })
    .mockResolvedValueOnce({
      items: [upload('refreshed', 'audio/mp4')],
      next_offset: null,
    });
  const tree = await render(context({ uploads }));
  await act(async () => press(tree, '加载更多资料'));
  await act(async () => press(tree, '录音'));
  await act(async () =>
    late.resolve({ items: [upload('stale')], next_offset: null }),
  );
  expect(names(tree)).toEqual(['File audio']);
  await act(async () => tree.root.findByType(RefreshControl).props.onRefresh());
  expect(uploads.mock.calls[3][0]).toEqual({
    offset: 0,
    limit: 50,
    kind: 'audio',
  });
  expect(names(tree)).toEqual(['File refreshed']);
  await act(async () => tree.unmount());
});

it('clears old account/server content immediately and ignores its late response', async () => {
  const late = deferred<{
    items: ReturnType<typeof upload>[];
    next_offset: number | null;
  }>();
  const first = { uploads: jest.fn().mockReturnValue(late.promise) };
  const second = {
    uploads: jest
      .fn()
      .mockResolvedValue({ items: [upload('private-b')], next_offset: null }),
  };
  const tree = await render(context(first));
  await act(async () =>
    tree.update(
      <AppProvider value={context(second, 'other', 'https://two.test')}>
        <UploadsScreen />
      </AppProvider>,
    ),
  );
  expect(names(tree)).toEqual(['File private-b']);
  await act(async () =>
    late.resolve({ items: [upload('private-a')], next_offset: null }),
  );
  expect(names(tree)).toEqual(['File private-b']);
  expect(second.uploads.mock.calls[0][0]).toEqual({
    offset: 0,
    limit: 50,
    kind: 'all',
  });
  await act(async () => tree.unmount());
});

it('does not execute an old delete confirmation after switching owners', async () => {
  let confirmation: any;
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    confirmation = buttons?.find(
      button => button.style === 'destructive',
    )?.onPress;
  });
  const first = {
    uploads: jest
      .fn()
      .mockResolvedValue({ items: [upload('a')], next_offset: null }),
    deleteUpload: jest.fn(),
  };
  const second = {
    uploads: jest
      .fn()
      .mockResolvedValue({ items: [upload('b')], next_offset: null }),
    deleteUpload: jest.fn(),
  };
  const tree = await render(context(first));
  await act(async () => press(tree, '删除这份资料'));
  expect(confirmation).toBeDefined();
  await act(async () =>
    tree.update(
      <AppProvider value={context(second, 'other')}>
        <UploadsScreen />
      </AppProvider>,
    ),
  );
  await act(async () => confirmation());
  expect(first.deleteUpload).not.toHaveBeenCalled();
  expect(second.deleteUpload).not.toHaveBeenCalled();
  expect(names(tree)).toEqual(['File b']);
  await act(async () => tree.unmount());
});
