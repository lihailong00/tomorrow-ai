import type { Message } from '../../domain/types';
import type { ConversationShareDocument, ShareBlock } from '../../platform/conversationShare';
import { markdownBlocks, markdownInlineText } from '../../ui/markdownBlocks';

export const DEFAULT_SHARE_TITLE = '与妥啦的一段对话';
export const MAX_SHARE_MESSAGES = 100;
export const MAX_SHARE_BYTES = 256 * 1024;

/** The share snapshot deliberately contains no file names, URIs, upload IDs or profile data. */
export type ShareCandidate = Readonly<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  attachmentNotice: string;
}>;

export function shareEligible(message: Message, conversationId?: string): boolean {
  return (!conversationId || message.conversation_id === conversationId) &&
    (!message.delivery || message.delivery === 'sent') &&
    !message.stream_status && !message.stream_error &&
    Boolean(message.content.trim() || message.attachments?.length);
}

function attachmentNotice(message: Message): string {
  const files = message.attachments ?? [];
  if (!files.length) return '';
  const images = files.filter(file => file.mime_type.startsWith('image/')).length;
  const audio = files.filter(file => file.mime_type.startsWith('audio/')).length;
  const other = files.length - images - audio;
  const unavailable = files.filter(file => file.unavailable).length;
  const counts = [images && `${images} 张图片`, audio && `${audio} 段语音`, other && `${other} 个文件`].filter(Boolean);
  return `附件：${counts.join('、')}（原文件未包含${unavailable ? `；其中 ${unavailable} 个原文件不可用` : ''}）`;
}

/** Input already follows Chat history ordering; retain it, including an older tapped row. */
export function snapshotShareCandidates(messages: readonly Message[], conversationId?: string): readonly ShareCandidate[] {
  const seen = new Set<string>();
  return Object.freeze(messages.filter(message => {
    if (!shareEligible(message, conversationId) || seen.has(message.id)) return false;
    seen.add(message.id); return true;
  }).map(message => Object.freeze({ id: message.id, role: message.role, content: message.content,
    createdAt: message.created_at, attachmentNotice: attachmentNotice(message) })));
}

/** A stable snapshot must not remain exportable after an edit/delete finishes behind it. */
export function validateShareSelection(candidates: readonly ShareCandidate[], selected: readonly string[],
  messages: readonly Message[], conversationId?: string): string | null {
  const frozenById = new Map(candidates.map(item => [item.id, item]));
  const liveById = new Map(messages.map(item => [item.id, item]));
  for (const id of new Set(selected)) {
    const frozen = frozenById.get(id);
    const live = liveById.get(id);
    if (!frozen || !live || !shareEligible(live, conversationId) || frozen.role !== live.role || frozen.content !== live.content ||
        frozen.createdAt !== live.created_at || frozen.attachmentNotice !== attachmentNotice(live))
      return '所选消息已更新、删除或尚未完成。请退出分享后重新选择。';
  }
  return null;
}

function plainInline(value: string): string {
  // Inline images remain a placeholder. Sharing never downloads their remote originals.
  return markdownInlineText(value.replace(/!\[[^\]\n]*\]\((?:\\.|[^)\n])*\)/g, '〔图片，原文件未包含〕'));
}

export function candidateBlocks(message: ShareCandidate): ShareBlock[] {
  const blocks: ShareBlock[] = markdownBlocks(message.content).map(block => {
    if (block.kind === 'code') return { type: 'code', text: block.text, language: block.language };
    if (block.kind === 'table') return { type: 'table', headers: block.headers.map(plainInline),
      rows: block.rows.map(row => row.map(plainInline)) };
    const heading = /^(#{1,6})\s+(.+)$/.exec(block.text);
    return { type: 'text', text: plainInline((heading ? heading[2] : block.text).replace(/^[-*]\s/, '• ')),
      ...(heading ? { heading: heading[1].length } : {}) };
  });
  if (message.attachmentNotice) blocks.push({ type: 'text', text: message.attachmentNotice });
  return blocks;
}

export function blockPlainText(block: ShareBlock): string {
  if (block.type === 'table') return [block.headers.join('\t'), ...block.rows.map(row => row.join('\t'))].join('\n');
  return block.text;
}

export function candidatePlainText(message: ShareCandidate): string {
  return candidateBlocks(message).map(blockPlainText).join('\n');
}

export function orderedShareSelection(candidates: readonly ShareCandidate[], selected: readonly string[]): ShareCandidate[] {
  const ids = new Set(selected);
  if (ids.size > MAX_SHARE_MESSAGES) throw new Error(`一次最多分享 ${MAX_SHARE_MESSAGES} 条消息，请减少选择；当前选择已保留。`);
  const knownIds = new Set(candidates.map(message => message.id));
  if ([...ids].some(id => !knownIds.has(id))) throw new Error('所选消息已不可用，请返回重新选择。');
  const items = candidates.filter(message => ids.has(message.id));
  if (!items.length) throw new Error('请至少选择一条消息。');
  return items;
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function shareText(candidates: readonly ShareCandidate[], selected: readonly string[]): string {
  const text = orderedShareSelection(candidates, selected).map(message =>
    `${message.role === 'user' ? '我' : '妥啦'}：\n${candidatePlainText(message)}`).join('\n\n');
  if (utf8Bytes(text) > MAX_SHARE_BYTES) throw new Error('所选文字过长，请减少选择后再分享；当前选择已保留。');
  return text;
}

export function shareDocument(candidates: readonly ShareCandidate[], selected: readonly string[], title: string,
  showTime: boolean, formatDate: (value: string) => string): ConversationShareDocument {
  const document: ConversationShareDocument = {
    title: Array.from(title.trim() || DEFAULT_SHARE_TITLE).slice(0, 30).join(''),
    messages: orderedShareSelection(candidates, selected).map(message => ({ role: message.role,
      blocks: candidateBlocks(message),
      ...(showTime && Number.isFinite(Date.parse(message.createdAt)) ? { timeLabel: formatDate(message.createdAt) } : {}) })),
  };
  if (utf8Bytes(JSON.stringify(document)) > MAX_SHARE_BYTES) throw new Error('所选内容太长，无法生成长图。可以减少选择，或改用文字分享。');
  return document;
}
