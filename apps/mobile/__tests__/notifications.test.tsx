import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { useForegroundNotifications } from '../src/app/notifications';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({
  platform: {
    isForeground: jest.fn(() => true),
    onForeground: jest.fn(() => jest.fn()),
    showNotification: jest.fn(async () => {}),
  },
}));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

it('does not replay history, delivers each new notification once, and resets safely for another user', async () => {
  const history = {
    id: 'history',
    title: '旧动态',
    body: '旧结果',
    read: false,
    created_at: '',
  };
  const update = {
    id: 'new',
    title: '新的进展',
    body: '已完成',
    read: false,
    created_at: '',
  };
  const notifications = jest
    .fn()
    .mockResolvedValueOnce({ items: [history] })
    .mockResolvedValue({ items: [update, history] });
  const api = { notifications } as unknown as ApiClient;
  function Screen({ user }: { user?: string }) {
    useForegroundNotifications(api, user);
    return null;
  }
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<Screen user="one" />);
  });
  expect(platform.showNotification).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(15000);
  });
  expect(platform.showNotification).toHaveBeenCalledTimes(1);
  expect(platform.showNotification).toHaveBeenCalledWith('新的进展', '已完成');
  await act(async () => {
    jest.advanceTimersByTime(15000);
  });
  expect(platform.showNotification).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.update(<Screen user="two" />);
  });
  expect(platform.showNotification).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.unmount();
  });
  const requestsBeforeUnmount = notifications.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(30000);
  });
  expect(notifications).toHaveBeenCalledTimes(requestsBeforeUnmount);
});
