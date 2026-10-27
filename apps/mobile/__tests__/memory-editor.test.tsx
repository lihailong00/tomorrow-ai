import React from 'react';
import { TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { MemoryEditor } from '../src/screens/Details';
import { Button, ErrorNotice } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

it('limits memory titles to the server limit and preserves user input after a rejected save', async () => {
  const saveMemory = jest.fn().mockRejectedValue(new Error('标题最多 120 字'));
  const back = jest.fn();
  const invalidate = jest.fn();
  const context = {
    api: { saveMemory },
    back,
    invalidate,
    formatDate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <MemoryEditor />
      </AppProvider>,
    );
  });
  const inputs = () => tree.root.findAllByType(TextInput);
  expect(inputs()[0].props.maxLength).toBe(120);
  // A rejected value can still arrive from a previous client or legacy data.
  const title = '记'.repeat(121);
  await act(async () => {
    inputs()[0].props.onChangeText(title);
    inputs()[1].props.onChangeText('Keep the original content');
  });
  await act(async () => {
    await tree.root
      .findAllByType(Button)
      .find(n => n.props.children === '保存记忆')!
      .props.onPress();
  });
  expect(saveMemory).toHaveBeenCalledWith(
    expect.objectContaining({ title, content: 'Keep the original content' }),
    undefined,
  );
  expect(inputs()[0].props.value).toBe(title);
  expect(inputs()[1].props.value).toBe('Keep the original content');
  expect(tree.root.findByType(ErrorNotice).props.message).toBe(
    '标题最多 120 字',
  );
  expect(back).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
}, 30000);
