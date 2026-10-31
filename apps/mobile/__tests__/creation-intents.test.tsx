import React from 'react';
import { TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { MemoryEditor, ScheduleEditor } from '../src/screens/Details';
import { Button, ErrorNotice } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

async function setup(kind: 'memory' | 'schedule') {
  const save = jest.fn();
  const back = jest.fn();
  const api = { saveMemory: save, saveSchedule: save };
  const value = {
    api,
    back,
    invalidate: jest.fn(),
    formatDate: () => '',
    user: { id: 'owner', timezone: 'UTC' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        {kind === 'memory' ? <MemoryEditor /> : <ScheduleEditor />}
      </AppProvider>,
    );
  });
  return {
    save,
    back,
    async input(index: number, text: string) {
      await act(async () =>
        tree.root.findAllByType(TextInput)[index].props.onChangeText(text),
      );
    },
    async press() {
      await act(async () =>
        tree.root
          .findAllByType(Button)
          .find(
            node =>
              node.props.children ===
              (kind === 'memory' ? '保存记忆' : '保存并开始'),
          )!
          .props.onPress(),
      );
    },
    draft: () =>
      tree.root.findAllByType(TextInput).map(node => node.props.value),
    error: () => tree.root.findByType(ErrorNotice).props.message,
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

test.each(['memory', 'schedule'] as const)(
  '%s retries one form with a stable creation ID and independent forms get new IDs',
  async kind => {
    const first = await setup(kind);
    first.save
      .mockRejectedValueOnce(new Error('Unknown network result'))
      .mockResolvedValueOnce({ id: 'original' });
    await first.input(0, 'Original title');
    await first.input(1, 'Original content');
    await first.press();
    expect(first.back).not.toHaveBeenCalled();
    expect(first.error()).toBe('Unknown network result');
    const initial = first.save.mock.calls[0][0];
    expect(initial.client_request_id).toEqual(expect.any(String));
    await first.press();
    expect(first.save.mock.calls[1][0]).toEqual(initial);
    expect(first.back).toHaveBeenCalledTimes(1);
    await first.close();
    const second = await setup(kind);
    second.save.mockResolvedValue({ id: 'intentional-second' });
    await second.input(0, 'Original title');
    await second.input(1, 'Original content');
    await second.press();
    expect(second.save.mock.calls[0][0].client_request_id).not.toBe(
      initial.client_request_id,
    );
    await second.close();
  },
  30000,
);

test.each(['memory', 'schedule'] as const)(
  '%s edits after an unknown result retain the intent and preserve the conflicting draft',
  async kind => {
    const form = await setup(kind);
    form.save
      .mockRejectedValueOnce(new Error('Unknown network result'))
      .mockRejectedValueOnce(
        new ApiError(
          'conflict',
          '请返回列表确认上次保存结果，再打开新表单创建',
          409,
        ),
      );
    await form.input(0, 'Original title');
    await form.input(1, 'Original content');
    await form.press();
    await form.input(0, 'Changed title');
    await form.press();
    expect(form.save.mock.calls[1][0].client_request_id).toBe(
      form.save.mock.calls[0][0].client_request_id,
    );
    expect(form.draft()[0]).toBe('Changed title');
    expect(form.draft()[1]).toBe('Original content');
    expect(form.error()).toContain('返回列表确认');
    expect(form.back).not.toHaveBeenCalled();
    await form.close();
  },
  30000,
);
