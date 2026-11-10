import React from 'react';
import { Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import type { Today } from '../src/domain/types';
import { HomeScreen } from '../src/screens/Main';
import { ResultText } from '../src/ui/ResultText';
import { briefingPreview } from '../src/ui/briefingPreview';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
afterEach(async () => { await act(async () => trees.forEach(tree => tree.unmount())); trees.clear(); });

const sample = '# 今日简报 · 2026年11月2日\n\n## 一、今日概况\n- 任务总数：**1 条**\n- 查看[资料](https://example.com)\n\n| 项目 | 状态 |\n| --- | --- |\n| 简报 | 已更新 |\n\n```rust\n    let value = 1;\n```\n\n末尾内容完整保留。';
async function render(briefing: string) {
  const value: Today = { date: '2026-11-02', greeting: '', briefing, tasks: [], schedules: [], memories: [], notifications: [],
    stats: { tasks_completed: 0, active_tasks: 0, active_routines: 0, memory_count: 0 },
    runtime: { model_mode: 'local', scheduler_mode: 'local', storage_mode: 'sqlite' } };
  const context = { api: { today: jest.fn().mockResolvedValue(value) }, revision: 0, navigate: jest.fn(), invalidate: jest.fn(),
    user: { id: 'brief-owner', name: '简报', timezone: 'Asia/Shanghai' } } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}><HomeScreen onTasks={jest.fn()} /></AppProvider>); });
  trees.add(tree); return tree;
}
const hasID = (tree: ReactTestRenderer, id: string) => tree.root.findAllByType(View).some(node => node.props.testID === id);

test('home keeps saved briefing content behind an explicit open action', async () => {
  const tree = await render(sample);
  expect(tree.root.findAllByType(ResultText)).toHaveLength(0);
  expect(tree.root.findAllByType(Text).some(node => node.props.children === '今日简报 · 2026年11月2日')).toBe(false);
  await act(async () => tree.root.findByProps({ accessibilityLabel: '查看简报' }).props.onPress());
  expect(tree.root.findAllByType(Text).some(node => node.props.children === '最近一次简报')).toBe(true);
});

test('briefing renders full Markdown and closing returns to the uncluttered home', async () => {
  const tree = await render(sample);
  await act(async () => tree.root.findByProps({ accessibilityLabel: '查看简报' }).props.onPress());
  expect(tree.root.findByType(ResultText).props.content).toBe(sample);
  const heading = tree.root.findAllByType(Text).find(node => node.props.children === '一、今日概况');
  expect(heading).toBeDefined();
  expect(hasID(tree, 'markdown-table')).toBe(true);
  expect(hasID(tree, 'native-code-block')).toBe(true);
  expect(tree.root.findAllByType(Text).some(node => node.props.children === '末尾内容完整保留。')).toBe(true);
  await act(async () => tree.root.findByProps({ accessibilityLabel: '关闭简报' }).props.onPress());
  expect(tree.root.findAllByType(ResultText)).toHaveLength(0);
});

test.each(['', ' \n\t ', '你有 0 个进行中的任务、0 条记忆。点击生成简报，后台会依据已保存的资料整理。'])('empty briefing %j offers generation on demand', async briefing => {
  const tree = await render(briefing);
  await act(async () => tree.root.findByProps({ accessibilityLabel: '查看简报' }).props.onPress());
  expect(tree.root.findAllByType(Text).some(node => String(node.props.children).includes('还没有生成简报'))).toBe(true);
  expect(tree.root.findAllByProps({ accessibilityLabel: '更新今日简报' }).length).toBeGreaterThan(0);
});

test('excerpt respects code and table boundaries without changing full source or leaking their Markdown fences', () => {
  expect(briefingPreview('```python\n# code\n\nprint(1)\n```')).toBe('代码片段 · 3 行');
  expect(briefingPreview('| A | B |\n| --- | --- |\n| **x** | `y` |')).toBe('A · B\nx · y');
  expect(briefingPreview('---\n> 提醒\n+ 事项')).toBe('提醒\n• 事项');
  expect(briefingPreview('> ## 引用标题')).toBe('引用标题');
  expect(briefingPreview('普通文字，原样显示。')).toBe('普通文字，原样显示。');
});

test('preview length is bounded after formatting and does not split an emoji surrogate pair', () => {
  expect(briefingPreview('**' + '长'.repeat(1000) + '**')).toHaveLength(801);
  const preview = briefingPreview('a'.repeat(799) + '😀' + 'b'.repeat(100));
  expect(preview).toBe('a'.repeat(799) + '…');
  expect(preview).not.toContain('**');
});
