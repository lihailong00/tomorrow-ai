import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState, Switch } from 'react-native';
import { AppContextValue, AppProvider } from '../src/app/context';
import {
  AutomaticMemoryNotice,
  AutomaticMemorySettings,
} from '../src/features/memory/AutomaticMemory';

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
let tree: ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  jest.useRealTimers();
});
const value = (api: unknown) =>
  ({
    api,
    invalidate: jest.fn(),
    navigate: jest.fn(),
  } as unknown as AppContextValue);

test('memory settings reflect the server default without an opt-in prompt or client-side overwrite', async () => {
  let enabled = true;
  const api = {
    request: jest
      .fn()
      .mockImplementation(async (_: string, method?: string, body?: any) => {
        if (method === 'PATCH') enabled = body.enabled;
        return { enabled, configured: false };
      }),
  };
  await act(async () => {
    tree = create(
      <AppProvider value={value(api)}>
        <AutomaticMemorySettings />
      </AppProvider>,
    );
  });
  expect(api.request.mock.calls.filter(c => c[1] === 'PATCH')).toHaveLength(0);
  expect(tree.root.findByType(Switch).props.value).toBe(true);
  expect(JSON.stringify(tree.toJSON())).not.toContain('允许自动记忆');
  await act(async () => tree.root.findByType(Switch).props.onValueChange(false));
  expect(api.request).toHaveBeenCalledWith('/memory/preferences', 'PATCH', {
    enabled: false,
  });
  expect(tree.root.findByType(Switch).props.value).toBe(false);
});

test('shows a saved receipt only after the server returns evidence and removes it on forget', async () => {
  jest.useFakeTimers();
  const before = AppState.currentState;
  AppState.currentState = 'active';
  let complete = false;
  const api = {
    request: jest.fn().mockImplementation(async () => ({
      items: complete
        ? [
            {
              id: 'receipt',
              memory_id: 'owned-memory',
              content: '近期在购买纳斯达克基金',
            },
          ]
        : [],
      pending: !complete,
    })),
    deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
  };
  await act(async () => {
    tree = create(
      <AppProvider value={value(api)}>
        <AutomaticMemoryNotice replyId="owned-reply" active />
      </AppProvider>,
    );
  });
  expect(tree.toJSON()).toBeNull();
  complete = true;
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(JSON.stringify(tree.toJSON())).toContain('近期在购买纳斯达克基金');
  const button = tree.root.findAll(
    n =>
      n.props.accessibilityLabel === '撤销记忆：近期在购买纳斯达克基金' &&
      typeof n.props.onPress === 'function',
  )[0];
  await act(async () => button.props.onPress());
  expect(api.request).toHaveBeenCalledWith(
    '/memory/receipts/receipt/undo',
    'POST',
    {},
  );
  expect(tree.toJSON()).toBeNull();
  AppState.currentState = before;
});

test('a row that is no longer the latest does not start background polling', async () => {
  const api = { request: jest.fn() };
  await act(async () => {
    tree = create(
      <AppProvider value={value(api)}>
        <AutomaticMemoryNotice replyId="old-reply" active={false} />
      </AppProvider>,
    );
  });
  expect(api.request).not.toHaveBeenCalled();
});


test('changing server while a memory preference save is pending releases the new owner switch', async () => {
  let finishOldSave!: (value: unknown) => void;
  const oldSave = new Promise(resolve => { finishOldSave = resolve; });
  const oldApi = { request: jest.fn().mockImplementation(async (_: string, method?: string) =>
    method === 'PATCH' ? oldSave : { enabled: false, configured: true }) };
  const nextApi = { request: jest.fn().mockResolvedValue({ enabled: true, configured: true }) };
  await act(async () => {
    tree = create(<AppProvider value={value(oldApi)}><AutomaticMemorySettings /></AppProvider>);
  });
  act(() => { void tree.root.findByType(Switch).props.onValueChange(true); });
  expect(tree.root.findByType(Switch).props.disabled).toBe(true);
  await act(async () => {
    tree.update(<AppProvider value={value(nextApi)}><AutomaticMemorySettings /></AppProvider>);
  });
  expect(tree.root.findByType(Switch).props.disabled).toBe(false);
  expect(tree.root.findByType(Switch).props.value).toBe(true);
  await act(async () => { finishOldSave({ enabled: false }); });
  expect(tree.root.findByType(Switch).props.value).toBe(true);
  expect(nextApi.request.mock.calls.filter(c => c[1] === 'PATCH')).toHaveLength(0);
});

test('a preference error from the previous server does not remain after switching servers', async () => {
  const oldApi = { request: jest.fn().mockImplementation(async (_: string, method?: string) => {
    if (method === 'PATCH') throw new Error('previous server failed');
    return { enabled: false, configured: true };
  }) };
  const nextApi = { request: jest.fn().mockResolvedValue({ enabled: false, configured: true }) };
  await act(async () => {
    tree = create(<AppProvider value={value(oldApi)}><AutomaticMemorySettings /></AppProvider>);
  });
  await act(async () => tree.root.findByType(Switch).props.onValueChange(true));
  expect(JSON.stringify(tree.toJSON())).toContain('previous server failed');
  await act(async () => {
    tree.update(<AppProvider value={value(nextApi)}><AutomaticMemorySettings /></AppProvider>);
  });
  expect(JSON.stringify(tree.toJSON())).not.toContain('previous server failed');
  expect(tree.root.findByType(Switch).props.disabled).toBe(false);
});
