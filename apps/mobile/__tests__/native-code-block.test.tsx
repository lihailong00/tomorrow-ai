import React from 'react';
import { Dimensions, FlatList, Modal, ScrollView, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeCodeBlock } from '../src/ui/NativeCodeBlock';
import { ResultText } from '../src/ui/ResultText';
import { platform } from '../src/platform/ports';
import type { MarkdownBlock } from '../src/ui/markdownBlocks';
import { messageReadingCharacters, readingCharacters } from '../src/ui/ChatReadingMetrics';
import type { Message } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({ platform: { copyText: jest.fn().mockResolvedValue(undefined), openUrl: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
beforeEach(() => {
  jest.clearAllMocks(); (platform.copyText as jest.Mock).mockResolvedValue(undefined);
  Dimensions.set({ window: { width: 320, height: 640, scale: 2.75, fontScale: 1 } });
});
afterEach(async () => { await act(async () => trees.forEach(tree => tree.unmount())); trees.clear(); });
type CodeBlock = Extract<MarkdownBlock, { kind: 'code' }>;
const block = (text: string, closed = true, language = 'rust'): CodeBlock => ({ kind: 'code', line: 0, language, text, closed });
async function mount(value: CodeBlock) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<NativeCodeBlock block={value} />); });
  trees.add(tree); return tree;
}
function action(tree: ReactTestRenderer, label: string) { return tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0]; }
async function press(tree: ReactTestRenderer, label: string) { const target = action(tree, label); expect(target).toBeTruthy(); await act(async () => target.props.onPress()); }
function sourceNode(tree: ReactTestRenderer) { return tree.root.findAllByType(Text).find(node => node.props.testID === 'code-card-source')!; }
function flatten(value: any): string { return Array.isArray(value) ? value.map(flatten).join('') : typeof value === 'string' || typeof value === 'number' ? String(value) : value?.props ? flatten(value.props.children) : ''; }

test('Rust appears in one continuous selectable code card and copying preserves raw CRLF/blank lines', async () => {
  const raw = '#[derive(Accounts)]\r\npub struct A {\r\n\r\n\tvalue: u64, // 原样\r\n}\r\n';
  const tree = await mount(block(raw));
  expect(tree.root.findAll(node => node.props.testID === 'native-code-block' && typeof node.type === 'string')).toHaveLength(1);
  expect(sourceNode(tree).props.selectable).toBe(true);
  expect(flatten(sourceNode(tree).props.children)).toBe(raw.replace(/\r\n/g, '\n').replace(/\n$/, ''));
  await press(tree, '复制代码');
  expect(platform.copyText).toHaveBeenCalledTimes(1);
  expect(platform.copyText).toHaveBeenCalledWith(raw);
});
test('wrap, reader, line numbers, font controls and native Back retain code and settings', async () => {
  const tree = await mount(block('let long_name = "unchanged";\n'));
  await press(tree, '开启代码自动换行');
  expect(tree.root.findAllByType(ScrollView)[0].props.horizontal).toBe(false);
  await press(tree, '全屏阅读代码');
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  await press(tree, '显示代码行号');
  expect(action(tree, '隐藏代码行号')).toBeTruthy();
  await press(tree, '增大代码字号');
  expect(tree.root.findByType(FlatList).props.data).toHaveLength(1);
  await act(async () => tree.root.findByType(Modal).props.onRequestClose());
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  expect(action(tree, '关闭代码自动换行')).toBeTruthy();
  await press(tree, '全屏阅读代码');
  expect(action(tree, '隐藏代码行号')).toBeTruthy();
});
test('long blocks fold and expand while all rows remain available to a virtualized full reader', async () => {
  const raw = Array.from({ length: 5000 }, (_, i) => `let value_${i} = ${i};`).join('\n');
  const tree = await mount(block(raw));
  expect(flatten(sourceNode(tree).props.children).split('\n')).toHaveLength(14);
  await press(tree, '展开前 200 行预览，共 5000 行代码');
  expect(flatten(sourceNode(tree).props.children).split('\n')).toHaveLength(200);
  await press(tree, '阅读全部代码');
  const list = tree.root.findByType(FlatList);
  expect(list.props.data).toHaveLength(5000);
  expect(list.props.initialNumToRender).toBe(32);
  expect(tree.root.findAllByType(Text).length).toBeLessThan(2000);
  await press(tree, '复制代码'); expect(platform.copyText).toHaveBeenCalledWith(raw);
});
test('copy failure opens a recoverable selectable reader with no raw error leak', async () => {
  (platform.copyText as jest.Mock).mockRejectedValueOnce(new Error('SECRET_INTERNAL_ERROR'));
  const tree = await mount(block('const value = "hello";\n', true, 'js'));
  await press(tree, '复制代码');
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  const text = tree.root.findAllByType(Text).map(node => flatten(node.props.children)).join(' ');
  expect(text).toContain('未能直接复制'); expect(text).not.toContain('SECRET_INTERNAL_ERROR');
  expect(tree.root.findAllByType(Text).some(node => node.props.selectable)).toBe(true);
  await press(tree, '复制代码'); expect(platform.copyText).toHaveBeenCalledTimes(2);
});
test('streaming updates keep reader and wrap stable; stale clipboard results cannot mark newer source copied', async () => {
  let finish!: () => void;
  (platform.copyText as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const tree = await mount(block('pub struct', false));
  await press(tree, '开启代码自动换行'); await press(tree, '全屏阅读代码');
  act(() => { void action(tree, '复制代码').props.onPress(); });
  await act(async () => tree.update(<NativeCodeBlock block={block('pub struct A {}\n', true)} />));
  await act(async () => finish());
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  expect(action(tree, '关闭代码自动换行')).toBeTruthy();
  expect(tree.root.findAllByType(Text).map(node => flatten(node.props.children))).not.toContain('已复制');
});
test('empty, unknown inherited labels and untrusted HTML remain inert native text', async () => {
  for (const info of ['constructor', '__proto__', 'html']) {
    const tree = await mount(block('<script>secret()</script>\n', true, info));
    expect(flatten(sourceNode(tree).props.children)).toBe('<script>secret()</script>');
  }
  const empty = await mount(block('', false));
  expect(empty.root.findAllByType(Text).map(node => flatten(node.props.children))).toContain('正在生成代码…');
  expect(action(empty, '复制代码').props.disabled).toBe(true);
});
test('ResultText keeps code fenced in a single block, excludes code links from sources and counts raw code', async () => {
  const raw = '|a|b|\n|---|---|\n[x](https://example.com)\n';
  const content = `说明\n\`\`\`markdown\n${raw}\`\`\`\n末尾`;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ResultText content={content} />); }); trees.add(tree);
  expect(tree.root.findAllByType(Text).filter(node => node.props.testID === 'code-card-source')).toHaveLength(1);
  expect(tree.root.findAll(node => node.props.testID === 'markdown-table')).toHaveLength(0);
  expect(action(tree, '查看 1 个来源')).toBeUndefined();
  expect(messageReadingCharacters({ content } as Message)).toBe(readingCharacters('说明' + raw + '末尾'));
});
