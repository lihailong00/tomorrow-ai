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

test('source titles render, domains remain visible in preview, and opening is explicit', async () => {
  await render('参考[基金公告](https://media.example.com/long/path/file.pdf)。');
  expect(platform.openUrl).not.toHaveBeenCalled();
  expect(text()).not.toContain('https://');
  await press('基金公告，media.example.com，PDF 文档');
  expect(tree.root.findByType(Modal).props.visible).toBe(true);
  expect(text()).toContain('media.example.com');
  expect(text()).not.toContain('/long/path');
  await press('查看完整网址'); expect(text()).toContain('https://media.example.com/long/path/file.pdf');
  await press('打开 PDF'); expect(platform.openUrl).toHaveBeenCalledWith('https://media.example.com/long/path/file.pdf');
  await act(async () => tree.root.findByType(Modal).props.onRequestClose());
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
});
test('sources deduplicate by URL while retaining distinct query strings and work inside tables', async () => {
  await render('[甲](https://example.com/a) [再看](https://example.com/a)\n| 资料 | 来源 |\n| --- | --- |\n| 项目 | [乙](https://example.com/a?x=2) |');
  expect(action('查看 2 个来源')).toBeTruthy();
  await press('查看 2 个来源');
  expect(text()).toContain('甲'); expect(text()).toContain('乙');
  await press('来源 2：乙，example.com'); await press('打开原文');
  expect(platform.openUrl).toHaveBeenCalledWith('https://example.com/a?x=2');
});
test('standalone PDF appears as a document and opener failures retain the URL for recovery', async () => {
  (platform.openUrl as jest.Mock).mockRejectedValueOnce(new Error('internal failure'));
  await render('[报告](https://example.com/report.pdf)');
  expect(text()).toContain('example.com · PDF 文档');
  await press('报告，PDF 文档，example.com'); await press('打开 PDF');
  expect(text()).toContain('未能打开链接'); expect(text()).toContain('https://example.com/report.pdf');
  expect(text()).not.toContain('internal failure');
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
