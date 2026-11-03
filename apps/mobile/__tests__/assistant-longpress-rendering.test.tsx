import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ResultText } from '../src/ui/ResultText';
import { MessageLongPress } from '../src/ui/MessageLongPress';
import { ChatReplyMemory } from '../src/ui/ChatReplyMemory';
import { AppProvider, type AppContextValue } from '../src/app/context';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees: ReactTestRenderer[] = [];
afterEach(async () => { await act(async () => trees.splice(0).forEach(tree => tree.unmount())); });
async function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(element); }); trees.push(tree); return tree;
}

test('AI prose, table cells, code previews and inline/PDF links share the menu handler', async () => {
  const open = jest.fn();
  const tree = await render(<MessageLongPress.Provider value={open}><ResultText content={
    '正文说明\n正文[官网](https://example.com)\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |\n\n```rust\nlet x = 1;\n```\n\n[报告](https://example.com/report.pdf)'
  } /></MessageLongPress.Provider>);
  const table = tree.root.findAllByType(Text).find(n => n.props.children === '完成')!;
  const code = tree.root.findAllByType(Text).find(n => n.props.testID === 'code-card-source')!;
  const prose = tree.root.findAllByType(Text).find(n => n.props.children === '正文说明')!;
  const link = tree.root.findAllByType(Text).find(n => n.props.accessibilityRole === 'link')!;
  const pdf = tree.root.findAll(n => n.props.accessibilityLabel?.startsWith('报告，PDF') && typeof n.props.onLongPress === 'function')[0];
  expect(table.props.selectable).toBe(false); expect(code.props.selectable).toBe(false);
  for (const node of [table, code, prose, link, pdf]) {
    expect(node.props.onLongPress).toBe(open); await act(async () => node.props.onLongPress());
  }
  expect(open).toHaveBeenCalledTimes(5);
  expect(link.props.onPress).toEqual(expect.any(Function));
});

test('non-chat rendering retains native selectable text', async () => {
  const tree = await render(<ResultText content="普通阅读正文" />);
  const text = tree.root.findAllByType(Text).find(n => n.props.children === '普通阅读正文')!;
  expect(text.props.selectable).toBe(true); expect(text.props.onLongPress).toBeUndefined();
});

test('save reply requires confirmation, allows editing and retries with the same idempotency key', async () => {
  const saveMemory = jest.fn().mockRejectedValueOnce(new Error('暂时离线')).mockResolvedValueOnce({ id: 'm' });
  const invalidate = jest.fn(), close = jest.fn();
  const tree = await render(<AppProvider value={{ api: { saveMemory }, invalidate } as unknown as AppContextValue}>
    <ChatReplyMemory content="模型原文" onClose={close} />
  </AppProvider>);
  const action = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  expect(saveMemory).not.toHaveBeenCalled();
  const input = tree.root.findAll(n => n.props.accessibilityLabel === '要保存的回复内容' && typeof n.props.onChangeText === 'function')[0];
  await act(async () => input.props.onChangeText('我确认保留的内容'));
  await act(async () => { await action('确认保存回复到记忆').props.onPress(); });
  expect(close).not.toHaveBeenCalled();
  expect(saveMemory).toHaveBeenCalledWith(expect.objectContaining({ content: '我确认保留的内容', source: '用户从 AI 回复中主动保存' }));
  await act(async () => { await action('确认保存回复到记忆').props.onPress(); });
  expect(saveMemory.mock.calls[1][0]).toEqual(saveMemory.mock.calls[0][0]);
  expect(invalidate).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});
