import React from 'react';
import { TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { MemoryEditor } from '../src/screens/Details';
import { Button, ErrorNotice } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

it('generates a bounded title from one input and preserves the complete draft after a rejected save', async () => {
  const saveMemory = jest.fn().mockRejectedValue(new Error('网络中断'));
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
  expect(inputs()).toHaveLength(1);
  expect(inputs()[0].props.maxLength).toBe(10000);
  const content = '🧠'.repeat(121) + 'Keep the original content';
  await act(async () => {
    inputs()[0].props.onChangeText(content);
  });
  await act(async () => {
    await tree.root
      .findAll(n => n.props.accessibilityLabel === '记住这件事' && n.props.onPress)[0]
      .props.onPress();
  });
  expect(saveMemory).toHaveBeenCalledWith(
    expect.objectContaining({ content }),
    undefined,
  );
  expect([...saveMemory.mock.calls[0][0].title].length).toBeLessThanOrEqual(120);
  expect(inputs()[0].props.value).toBe(content);
  expect(tree.root.findByType(ErrorNotice).props.message).toBe(
    '网络中断',
  );
  expect(back).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
}, 30000);
