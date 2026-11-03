import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Image, Switch, Text, TextInput } from 'react-native';
import { ConversationShareSheet } from '../src/features/conversation-share/ConversationShareSheet';
import { candidateBlocks, candidatePlainText, orderedShareSelection, shareDocument, shareText, snapshotShareCandidates, utf8Bytes, validateShareSelection } from '../src/features/conversation-share/model';
import { conversationShare } from '../src/platform/conversationShare';
import { platform } from '../src/platform/ports';
import type { Message } from '../src/domain/types';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AmbientBackground: () => null }));
jest.mock('../src/platform/ports', () => ({ platform: { copyText: jest.fn().mockResolvedValue(undefined), share: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/platform/conversationShare', () => ({ conversationShare: { available: true,
  prepare: jest.fn(), share: jest.fn().mockResolvedValue(undefined), save: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined), cancelAll: jest.fn().mockResolvedValue(undefined) } }));

const question: Message = { id: 'q1', conversation_id: 'c1', role: 'user', content: '周六去陆家嘴', created_at: '2026-11-03T01:00:00Z',
  attachments: [{ upload_id: 'secret-upload-id', name: 'PRIVATE-NAME.jpg', mime_type: 'image/jpeg', size: 12 }] };
const answer: Message = { id: 'a1', conversation_id: 'c1', role: 'assistant', content: '**轻松的下午**\n\n| 时间 | 安排 |\n| --- | --- |\n| 14:00 | 散步 |\n\n```rust\nlet x = 1;\n```', created_at: '2026-11-03T01:00:01Z' };
const later: Message = { id: 'q2', conversation_id: 'c1', role: 'user', content: '不要分享的后续问题', created_at: '2026-11-03T01:00:02Z' };
const candidates = snapshotShareCandidates([question, answer, later], 'c1');
const prepared = { id: 'image-1', uri: 'content://local/image-1', width: 900, height: 1500, size: 12000 };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const trees: ReactTestRenderer[] = [];
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks();
  (conversationShare.prepare as jest.Mock).mockResolvedValue(prepared);
  (conversationShare.save as jest.Mock).mockResolvedValue(undefined);
  (conversationShare.share as jest.Mock).mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => trees.splice(0).forEach(tree => tree.unmount())); jest.useRealTimers(); });

test('snapshots all loaded stable messages without dropping an older seed or mixing conversations', () => {
  const history = Array.from({ length: 130 }, (_, i) => ({ ...question, id: `q${i}`, attachments: [] }));
  const snapshot = snapshotShareCandidates([...history, { ...question, id: 'pending', delivery: 'sending' },
    { ...answer, id: 'failed', stream_error: '中断' }, { ...answer, id: 'live', stream_status: '回答中' },
    { ...answer, id: 'other', conversation_id: 'c2' }], 'c1');
  expect(snapshot).toHaveLength(130); expect(snapshot[0].id).toBe('q0');
  expect(orderedShareSelection(snapshot, ['q129', 'q0']).map(m => m.id)).toEqual(['q0', 'q129']);
});

test('selected order is chronological snapshot order and never automatically adds a paired question', () => {
  expect(shareText(candidates, ['a1'])).not.toContain(question.content);
  const text = shareText(candidates, ['a1', 'q1']);
  expect(text.indexOf(question.content)).toBeLessThan(text.indexOf('轻松的下午'));
  expect(text).not.toContain(later.content);
  expect(() => shareText(candidates, ['missing'])).toThrow('不可用');
});

test('rich blocks keep table/code data while attachment metadata and remote image originals stay out', () => {
  const document = shareDocument(candidates, ['q1', 'a1'], '计划', false, jest.fn());
  const serialized = JSON.stringify(document);
  expect(serialized).not.toContain('PRIVATE-NAME'); expect(serialized).not.toContain('secret-upload-id');
  expect(serialized).toContain('1 张图片（原文件未包含）');
  expect(document.messages[1].blocks).toContainEqual({ type: 'table', headers: ['时间', '安排'], rows: [['14:00', '散步']] });
  expect(document.messages[1].blocks).toContainEqual({ type: 'code', language: 'rust', text: 'let x = 1;\n' });
  const imageMessage = { ...candidates[0], content: '![隐私图片](https://private.test/image?token=SECRET)\n[报告](https://docs.test/report.pdf?token=SECRET)' };
  expect(candidatePlainText(imageMessage)).not.toContain('SECRET');
  expect(candidatePlainText(imageMessage)).toContain('原文件未包含');
  const unavailable = snapshotShareCandidates([{ ...question, attachments: [{ ...question.attachments![0], unavailable: true }] }], 'c1')[0];
  expect(candidatePlainText(unavailable)).toContain('原文件不可用');
});

test('time and account metadata are absent by default; title and time are explicit', () => {
  const formatDate = jest.fn(() => '11月3日 09:00');
  const hidden = shareDocument(candidates, ['q1'], '', false, formatDate);
  expect(hidden.title).toBe('与妥啦的一段对话'); expect(hidden.messages[0].timeLabel).toBeUndefined(); expect(formatDate).not.toHaveBeenCalled();
  expect(shareDocument(candidates, ['q1'], '自定义', true, formatDate).messages[0].timeLabel).toBe('11月3日 09:00');
  expect(candidateBlocks(candidates[0])[0]).toEqual({ type: 'text', text: question.content });
});

test('oversized selections are rejected explicitly without mutating the selected IDs', () => {
  const many = snapshotShareCandidates(Array.from({ length: 101 }, (_, i) => ({ ...question, id: `m${i}` })), 'c1');
  const ids = many.map(m => m.id);
  expect(() => orderedShareSelection(many, ids)).toThrow('100'); expect(ids).toHaveLength(101);
  expect(utf8Bytes('A中😀')).toBe(8);
  const large = [{ ...candidates[0], content: '中'.repeat(90000) }];
  expect(() => shareText(large, ['q1'])).toThrow('过长');
});

test('a deleted or same-ID edited selected message invalidates the frozen snapshot', () => {
  expect(validateShareSelection(candidates, ['a1'], [question, answer, later], 'c1')).toBeNull();
  expect(validateShareSelection(candidates, ['a1'], [question, later], 'c1')).toContain('重新选择');
  expect(validateShareSelection(candidates, ['a1'], [question, { ...answer, content: '已修改的回答' }, later], 'c1')).toContain('重新选择');
  expect(validateShareSelection(candidates, ['q1'], [question, { ...answer, content: '已修改的回答' }], 'c1')).toBeNull();
});

async function setup(options: { seed?: string; hasOlder?: boolean; current?: () => boolean; validate?: (ids: readonly string[]) => string | null } = {}) {
  const close = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ConversationShareSheet candidates={candidates} initialSelectedId={options.seed || 'a1'}
    hasOlder={!!options.hasOlder} isCurrent={options.current || (() => true)} validateSelection={options.validate}
    formatDate={() => '11月3日 09:00'} onClose={close} />); });
  trees.push(tree);
  const node = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  return { tree, close, node,
    press: async (label: string) => { await act(async () => { await node(label).props.onPress(); }); },
    generate: async () => { await act(async () => { jest.advanceTimersByTime(300); }); },
    unmount: async () => { const at = trees.indexOf(tree); if (at >= 0) trees.splice(at, 1); await act(async () => tree.unmount()); },
  };
}

test('multiselect starts at the exact seed, labels loaded-only all, disables empty export and retains back state', async () => {
  const app = await setup({ hasOlder: true });
  expect(app.node('全选已加载消息')).toBeTruthy();
  expect(app.tree.root.findAll(n => n.props.testID === 'share-candidate-a1' && n.props.onPress)[0].props.accessibilityState.checked).toBe(true);
  await app.press('全选已加载消息'); await app.press('取消全选消息');
  expect(app.node('分享长图').props.disabled).toBe(true);
  await act(async () => app.tree.root.findAll(n => n.props.testID === 'share-candidate-a1' && n.props.onPress)[0].props.onPress());
  await app.press('分享长图');
  await act(async () => app.tree.root.findByType(TextInput).props.onChangeText('我的标题'));
  await act(async () => app.tree.root.findByType(Switch).props.onValueChange(true));
  await app.press('返回消息选择'); await app.press('分享长图'); await app.generate();
  expect(app.tree.root.findByType(TextInput).props.value).toBe('我的标题');
  expect(app.tree.root.findByType(Switch).props.value).toBe(true);
  expect((conversationShare.prepare as jest.Mock).mock.calls.at(-1)[0].messages).toHaveLength(1);
});

test('text preview and clipboard/system share contain only selected sanitized content', async () => {
  const app = await setup({ seed: 'q1' }); await app.press('分享文字');
  expect(app.tree.root.findAllByType(Text).find(n => n.props.testID === 'share-text-preview')?.props.children).toBe(shareText(candidates, ['q1']));
  await app.press('复制文字'); expect(platform.copyText).toHaveBeenCalledWith(shareText(candidates, ['q1']));
  await app.press('打开系统分享'); expect(platform.share).toHaveBeenCalledWith(shareText(candidates, ['q1']));
  expect(conversationShare.prepare).not.toHaveBeenCalled();
});

test('image preview displays the actual prepared PNG and duplicate saves are fenced', async () => {
  const pendingSave = deferred<void>(); (conversationShare.save as jest.Mock).mockReturnValueOnce(pendingSave.promise);
  const app = await setup(); await app.press('分享长图'); await app.generate();
  expect(app.tree.root.findByType(Image).props.source.uri).toBe(prepared.uri);
  const save = app.node('保存长图').props.onPress;
  await act(async () => { save(); save(); });
  expect(conversationShare.save).toHaveBeenCalledTimes(1);
  await act(async () => pendingSave.resolve());
  await app.press('打开系统分享'); expect(conversationShare.share).toHaveBeenCalledWith(prepared.id);
});

test('owner invalidation blocks old buttons; late preparations are released instead of displayed/shared', async () => {
  let current = true;
  const gate = deferred<typeof prepared>(); (conversationShare.prepare as jest.Mock).mockReturnValueOnce(gate.promise);
  const app = await setup({ current: () => current }); await app.press('分享长图'); await app.generate();
  current = false;
  await act(async () => gate.resolve(prepared));
  expect(conversationShare.release).toHaveBeenCalledWith(prepared.id);
  expect(app.tree.root.findAllByType(Image)).toHaveLength(0);
  await app.press('文字预览'); expect(platform.share).not.toHaveBeenCalled();
});

test('unmount cancels preparation and drops stale results without showing a success message', async () => {
  const gate = deferred<typeof prepared>(); (conversationShare.prepare as jest.Mock).mockReturnValueOnce(gate.promise);
  const app = await setup(); await app.press('分享长图'); await app.generate();
  const signal = (conversationShare.prepare as jest.Mock).mock.calls[0][1] as AbortSignal;
  await app.unmount(); expect(signal.aborted).toBe(true); expect(conversationShare.cancelAll).toHaveBeenCalled();
  await act(async () => gate.resolve(prepared)); expect(conversationShare.release).toHaveBeenCalledWith(prepared.id);
  expect(conversationShare.share).not.toHaveBeenCalled();
});

test('image limit/failure preserves selected content and permits text fallback', async () => {
  (conversationShare.prepare as jest.Mock).mockRejectedValueOnce(new Error('长图过高，请减少选择或使用文字。'));
  const app = await setup(); await app.press('分享长图'); await app.generate();
  expect(app.node('保存长图').props.disabled).toBe(true);
  expect(app.tree.root.findAllByType(Text).some(n => String(n.props.children).includes('长图过高'))).toBe(true);
  await app.press('文字预览'); await app.press('打开系统分享');
  expect(platform.share).toHaveBeenCalledWith(shareText(candidates, ['a1']));
});

test('a source edit between rendering and pressing share blocks the stale text payload', async () => {
  let live = [question, answer, later];
  const app = await setup({ validate: ids => validateShareSelection(candidates, ids, live, 'c1') });
  await app.press('分享文字');
  const oldShare = app.node('打开系统分享').props.onPress;
  live = [question, { ...answer, content: '内容已经改变' }, later];
  await act(async () => oldShare());
  expect(platform.share).not.toHaveBeenCalled();
  expect(app.tree.root.findAllByType(Text).some(n => String(n.props.children).includes('重新选择'))).toBe(true);
});

test('editing the image title disables sharing the previous PNG until the matching generation completes', async () => {
  const app = await setup(); await app.press('分享长图'); await app.generate();
  await act(async () => app.tree.root.findByType(TextInput).props.onChangeText('新标题'));
  expect(app.node('打开系统分享').props.disabled).toBe(true);
  await app.generate(); expect(app.node('打开系统分享').props.disabled).toBe(false);
  expect((conversationShare.prepare as jest.Mock).mock.calls.at(-1)[0].title).toBe('新标题');
});

test('an older-than-window seed is initially visible and measured fallback is reset after preview/back', async () => {
  const many = snapshotShareCandidates(Array.from({ length: 45 }, (_, i) => ({ ...question, id: `q${i}` })), 'c1');
  const scroll = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ConversationShareSheet candidates={many} initialSelectedId="q40"
    hasOlder isCurrent={() => true} formatDate={() => '时间'} onClose={jest.fn()} />); }); trees.push(tree);
  expect(tree.root.findByType(FlatList).props.initialScrollIndex).toBe(40);
  await act(async () => tree.root.findByType(FlatList).props.onViewableItemsChanged({ viewableItems: [{ item: many[40] }] }));
  const press = async (label: string) => { await act(async () => tree.root.findAll(n => n.props.accessibilityLabel === label && n.props.onPress)[0].props.onPress()); };
  await press('分享文字'); await press('返回消息选择');
  await act(async () => tree.root.findByType(FlatList).props.onScrollToIndexFailed({ index: 40, averageItemLength: 120 }));
  expect(scroll).toHaveBeenCalledWith({ offset: 4800, animated: false });
  scroll.mockRestore();
});

test('expired image handles offer regeneration while preserving title and selected content', async () => {
  (conversationShare.share as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('长图已失效，请重新生成。'), { code: 'expired' }));
  const app = await setup(); await app.press('分享长图'); await app.generate(); await app.press('打开系统分享');
  expect(app.tree.root.findAllByType(Image)).toHaveLength(0);
  expect(app.node('重新生成长图')).toBeTruthy();
  await app.press('重新生成长图'); await app.generate();
  expect(conversationShare.prepare).toHaveBeenCalledTimes(2);
  expect(app.node('打开系统分享').props.disabled).toBe(false);
});
