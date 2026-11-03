import React from 'react';
import { Modal, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ResultText } from '../src/ui/ResultText';
import { platform } from '../src/platform/ports';
import { messageReadingCharacters, readingCharacters } from '../src/ui/ChatReadingMetrics';
import type { Message } from '../src/domain/types';
jest.mock('../src/platform/ports', () => ({ platform: { openUrl: jest.fn() } }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
let tree: ReactTestRenderer;
afterEach(async () => { if (tree) await act(async () => tree.unmount()); jest.clearAllMocks(); });
async function render(content: string) { await act(async () => { tree = create(<ResultText content={content} />); }); }
function action(label: string) { return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]; }
async function press(label: string) { const node = action(label); expect(node).toBeTruthy(); await act(async () => node.props.onPress()); }
const flatten = (value: unknown): string => Array.isArray(value) ? value.map(flatten).join('') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const text = () => tree.root.findAllByType(Text).map(n => flatten(n.props.children)).join(' ');

test('tapping an inline link opens its exact URL immediately without a preview step', async () => {
  await render('参考[基金公告](https://media.example.com/long/path/file.pdf)。');
  expect(platform.openUrl).not.toHaveBeenCalled();
  expect(text()).not.toContain('https://');
  await press('基金公告，media.example.com，PDF 文档');
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
  expect(platform.openUrl).toHaveBeenCalledWith('https://media.example.com/long/path/file.pdf');
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
});
test('sources deduplicate by URL while retaining distinct query strings and work inside tables', async () => {
  await render('[甲](https://example.com/a) [再看](https://example.com/a)\n| 资料 | 来源 |\n| --- | --- |\n| 项目 | [乙](https://example.com/a?x=2) |');
  expect(action('查看 2 个来源')).toBeTruthy();
  await press('查看 2 个来源');
  expect(text()).toContain('甲'); expect(text()).toContain('乙');
  await press('来源 2：乙，example.com');
  expect(platform.openUrl).toHaveBeenCalledWith('https://example.com/a?x=2');
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
});
test('standalone PDF appears as a document and opener failures retain the URL for recovery', async () => {
  (platform.openUrl as jest.Mock).mockRejectedValueOnce(new Error('internal failure'));
  await render('[报告](https://example.com/report.pdf)');
  expect(text()).toContain('example.com · PDF 文档');
  await press('报告，PDF 文档，example.com');
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
  expect(text()).toContain('未能打开链接'); expect(text()).toContain('https://example.com/report.pdf');
  expect(text()).not.toContain('internal failure');
  await press('打开 PDF');
  expect(platform.openUrl).toHaveBeenCalledTimes(2);
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
});
test('code fences do not create sources, and incomplete streamed Markdown does not expose a partial URL', async () => {
  await render('```\n[代码](https://example.com)\n```\n[来源](https://example.com/incomplete');
  expect(action('查看 1 个来源')).toBeUndefined();
  expect(text()).not.toContain('/incomplete');
  await act(async () => tree.update(<ResultText content="[来源](https://example.com/complete)" />));
  expect(action('查看 1 个来源')).toBeTruthy();
});
test('reading progress counts visible titles instead of hidden Markdown URLs', () => {
  const message = { content: '参考[来源](https://example.com/a/very/long/hidden/url)。' } as Message;
  expect(messageReadingCharacters(message)).toBe(readingCharacters('参考来源。'));
});

test('streaming new sources preserves a failed-launch recovery panel until that source disappears', async () => {
  (platform.openUrl as jest.Mock).mockRejectedValueOnce(new Error('browser unavailable'));
  const original = '[原始来源](https://example.com/original)';
  await render(original);
  await press('原始来源，example.com');
  await act(async () => tree.update(<ResultText content={`${original}\n继续参考[新增来源](https://example.org/new)`} />));
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  expect(action('收起完整网址')).toBeTruthy();
  expect(text()).toContain('https://example.com/original');
  await act(async () => tree.update(<ResultText content="改为[其他来源](https://example.org/new)" />));
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
});

test('a late URL open failure cannot restore a preview removed by a message edit', async () => {
  let rejectOpen!: (reason: Error) => void;
  (platform.openUrl as jest.Mock).mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }));
  await render('[来源](https://example.com/original)');
  act(() => { void action('来源，example.com').props.onPress(); });
  await act(async () => tree.update(<ResultText content="用户已修改这条消息，没有来源。" />));
  await act(async () => { rejectOpen(new Error('late failure')); });
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  expect(text()).not.toContain('未能打开链接');
});

test('an ordinary inline website opens directly and repeated taps do not launch it twice', async () => {
  let finish!: () => void;
  (platform.openUrl as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render('参考[官网](https://example.com/page?q=1#details)。');
  act(() => {
    void action('官网，example.com').props.onPress();
    void action('官网，example.com').props.onPress();
  });
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
  expect(platform.openUrl).toHaveBeenCalledWith('https://example.com/page?q=1#details');
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  await act(async () => finish());
});

test('a source row opens directly and a failed launch retains the URL with a retry action', async () => {
  (platform.openUrl as jest.Mock).mockRejectedValueOnce(new Error('no browser'));
  await render('[官网](https://example.com/page)');
  await press('查看 1 个来源');
  expect(platform.openUrl).not.toHaveBeenCalled();
  await press('来源 1：官网，example.com');
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
  expect(platform.openUrl).toHaveBeenCalledWith('https://example.com/page');
  expect(text()).toContain('未能打开链接');
  expect(text()).toContain('https://example.com/page');
  expect(action('打开原文')).toBeTruthy();
});
