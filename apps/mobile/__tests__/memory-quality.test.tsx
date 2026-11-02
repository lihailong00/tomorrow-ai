import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import type { Memory } from '../src/domain/types';
import { MemoryConfirmationCard } from '../src/features/memory/MemoryConfirmationCard';
import { MemorySourceCard } from '../src/features/memory/MemorySourceCard';
import {
  confirmedWeightContent,
  getMemoryConfirmation,
  memoryCategory,
  memorySource,
} from '../src/features/memory/memoryPresentation';

const id = '10d8be9f-bc1f-4e09-898a-bb67f309155b';
const memory: Memory = {
  id: 'weight',
  title: '身体与运动',
  content: '身高约一米八七，体重为“−95kg”，平时运动较少。',
  source: `对话 ${id} · 2026-11-02T04:07:37.49751908Z\n你的原话：我体重已经一95kg了`,
  kind: 'fact',
  created_at: '2026-11-02T04:07:37Z',
  updated_at: '2026-11-02T04:07:37Z',
  version: 3,
};
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
const value = (saveMemory = jest.fn()) =>
  ({
    api: { saveMemory },
    user: { id: 'one' },
    invalidate: jest.fn(),
    navigate: jest.fn(),
    formatDate: () => '今天 12:07',
    preferences: {},
  } as unknown as AppContextValue);

async function mount(component: React.ReactNode, context = value()) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AppProvider value={context}>{component}</AppProvider>);
  });
  const press = async (label: string) => {
    const node = tree.root
      .findAll(
        n =>
          n.props.accessibilityLabel === label &&
          typeof n.props.onPress === 'function',
      )
      .pop()!;
    if (!node) throw new Error(`Missing ${label}`);
    await act(async () => {
      node.props.onPress();
    });
  };
  return {
    tree,
    press,
    text: () =>
      tree.root
        .findAllByType(Text)
        .map(n => n.props.children)
        .join(' '),
    close: () => act(async () => tree.unmount()),
  };
}

test('legacy negative values become choices without changing surrounding facts', () => {
  const review = getMemoryConfirmation(memory)!;
  expect(review.options).toEqual([95]);
  expect(confirmedWeightContent(review, 95)).toBe(
    '身高约一米八七，体重为95 公斤，平时运动较少。',
  );
  expect(
    getMemoryConfirmation({ ...memory, content: '体重为一95kg。' })?.options,
  ).toEqual([95, 195]);
  expect(
    getMemoryConfirmation({ ...memory, content: '体重为195kg。' }),
  ).toBeUndefined();
  expect(
    getMemoryConfirmation({ ...memory, content: '杠铃重量为-95kg。' }),
  ).toBeUndefined();
  expect(confirmedWeightContent(review, -95)).toBeUndefined();
  expect(confirmedWeightContent(review, NaN)).toBeUndefined();
  expect(memoryCategory(memory)).toBe('个人资料');
  expect(
    memoryCategory({
      ...memory,
      content: '不喝酒、不喝奶茶',
      title: '饮食习惯',
    }),
  ).toBe('生活习惯');
});

test('a one-tap choice uses the original version; failed saves keep choices available', async () => {
  const saved = {
    ...memory,
    content: '身高约一米八七，体重为95 公斤，平时运动较少。',
    version: 4,
  };
  const saveMemory = jest
    .fn()
    .mockRejectedValueOnce(new Error('网络中断'))
    .mockResolvedValueOnce(saved);
  const onSaved = jest.fn();
  const app = await mount(
    <MemoryConfirmationCard memory={memory} onSaved={onSaved} />,
    value(saveMemory),
  );
  expect(saveMemory).not.toHaveBeenCalled();
  expect(app.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(app.text()).toContain('你目前的体重是 95 公斤吗？');
  await app.press('是 95 公斤');
  expect(onSaved).not.toHaveBeenCalled();
  expect(app.text()).toContain('网络中断');
  await app.press('是 95 公斤');
  expect(saveMemory.mock.calls[1]).toEqual(saveMemory.mock.calls[0]);
  expect(saveMemory).toHaveBeenLastCalledWith(
    { content: saved.content, kind: 'fact', version: 3 },
    'weight',
  );
  expect(onSaved).toHaveBeenCalledWith(saved);
  await app.close();
});

test('custom weight appears only after rejecting the choices and rejects invalid numbers', async () => {
  const saveMemory = jest
    .fn()
    .mockResolvedValue({ ...memory, content: '体重为92.5 公斤。', version: 4 });
  const app = await mount(
    <MemoryConfirmationCard memory={memory} onSaved={jest.fn()} />,
    value(saveMemory),
  );
  await app.press('都不对，自己填写');
  const input = () => app.tree.root.findByType(TextInput);
  await act(async () => input().props.onChangeText('-95'));
  const button = () =>
    app.tree.root
      .findAll(
        n =>
          n.props.accessibilityLabel === '确认体重' &&
          typeof n.props.onPress === 'function',
      )
      .pop()!;
  expect(button().props.disabled).toBe(true);
  await act(async () => input().props.onChangeText('92.5'));
  expect(button().props.disabled).toBe(false);
  await app.press('确认体重');
  expect(saveMemory).toHaveBeenCalledWith(
    expect.objectContaining({
      content: '身高约一米八七，体重为92.5 公斤，平时运动较少。',
      version: 3,
    }),
    'weight',
  );
  await app.close();
});

test('provenance hides internal IDs and timestamps while retaining a working conversation link', async () => {
  const context = value();
  const app = await mount(<MemorySourceCard memory={memory} />, context);
  expect(app.text()).not.toContain(id);
  expect(app.text()).not.toContain('2026-11-02T');
  expect(app.text()).not.toContain('我体重已经');
  expect(app.text()).toContain('来自对话 · 今天 12:07');
  await app.press('查看原话');
  expect(app.text()).toContain('我体重已经一95kg了');
  await app.press('查看原对话');
  expect(context.navigate).toHaveBeenCalledWith({
    name: 'chat',
    conversationId: id,
  });
  await app.close();
  expect(memorySource('用户主动添加').label).toBe('用户主动添加');
});
