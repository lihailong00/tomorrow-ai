import { ApiError } from './errors';
import type { ChatResponse, ChatStreamEvent, Message } from './types';

/** Incremental framing. Only one event/partial line is retained, not the stream. */
export class SseParser {
  private pending = ''; private scanned = 0; private data: string[] = [];
  private event = 'message'; private id = ''; private size = 0; private first = true;
  constructor(private emit: (event: ChatStreamEvent) => void, private limit = 1024 * 1024) {}
  push(chunk: string): void {
    if (this.first && chunk) { this.first = false; chunk = chunk.replace(/^\uFEFF/, ''); }
    this.pending += chunk;
    let start = 0; let index = this.scanned;
    for (; index < this.pending.length; index++) {
      const c = this.pending[index];
      if (c !== '\r' && c !== '\n') continue;
      if (c === '\r' && index === this.pending.length - 1) break;
      this.line(this.pending.slice(start, index));
      if (c === '\r' && this.pending[index + 1] === '\n') index++;
      start = index + 1;
    }
    this.pending = this.pending.slice(start); this.scanned = index - start;
    if (this.pending.length + this.size > this.limit) throw new ApiError('invalid_response', '回复数据过大，请重新连接。');
  }
  end(): void { if (this.pending.endsWith('\r')) this.push('\n'); }
  private line(line: string): void {
    if (!line) {
      if (this.data.length) {
        if (!/^\d+$/.test(this.id) || !Number.isSafeInteger(Number(this.id))) throw new ApiError('invalid_response', '回复缺少有效进度编号。');
        let value: unknown;
        try { value = JSON.parse(this.data.join('\n')); } catch { throw new ApiError('invalid_response', '回复数据无法识别。'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_response', '回复数据格式不正确。');
        this.emit({ id: Number(this.id), event: this.event, data: value as Record<string, unknown> });
      }
      this.data = []; this.event = 'message'; this.id = ''; this.size = 0; return;
    }
    if (line.length > this.limit) throw new ApiError('invalid_response', '回复数据过大。');
    if (line.startsWith(':')) return;
    this.size += line.length;
    if (this.size > this.limit) throw new ApiError('invalid_response', '回复数据过大。');
    const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.event = value;
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

export interface ChatStreamState {
  status: 'connecting' | 'running' | 'complete' | 'interrupted'; content: string;
  conversationId?: string; userMessage?: Message; messageId?: string; messageCreatedAt?: string;
  lastEventId: number; attempt: number; previousContent?: string; toolStatus?: Record<string, unknown> | null;
  error?: string; response?: ChatResponse;
  didiOrder?: DidiOrder;
  inputRequest?: InputRequest;
}
type InteractionIdentity = {id: string; run_id: string; expires_at: number};
export type InputRequest = InteractionIdentity & ({kind: 'location'} | {kind: 'choice'; question: string; options: string[]});
export interface DidiOrder {
  id: string; run_id: string; expires_at: number; from: string; to: string;
  products: {name: string; price: string}[]; sandbox: boolean; phone_suffix?: string;
}
export function initialChatStreamState(): ChatStreamState {
  return { status: 'connecting', content: '', lastEventId: -1, attempt: 1 };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function readIdentity(value: Record<string, unknown>): InteractionIdentity | undefined {
  const validId = (text: unknown): text is string => typeof text === 'string' && /^[\w-]{1,120}$/.test(text);
  const {id, run_id, expires_at} = value;
  if (!validId(id) || !validId(run_id) || typeof expires_at !== 'number' || !Number.isSafeInteger(expires_at)) return;
  return {id, run_id, expires_at};
}
function readInputRequest(value: unknown): InputRequest | undefined {
  if (!record(value)) return;
  const identity = readIdentity(value);
  if (!identity) return;
  if (value.kind === 'location') return {...identity, kind: 'location'};
  const {question, options} = value;
  if (value.kind === 'choice' && typeof question === 'string' && question.length <= 280 &&
    Array.isArray(options) && options.length >= 2 && options.length <= 6 &&
    options.every(option => typeof option === 'string' && option.length <= 120)) {
    return {...identity, kind: 'choice', question, options};
  }
}
function readDidiOrder(value: unknown): DidiOrder | undefined {
  if (!record(value) || value.kind !== 'didi_order') return;
  const identity = readIdentity(value);
  const {from, to, products, sandbox, phone_suffix} = value;
  const label = (text: unknown, limit: number): text is string => typeof text === 'string' && !!text.trim() && Array.from(text).length <= limit;
  if (!identity || !label(from, 200) || !label(to, 200) || typeof sandbox !== 'boolean'
    || !Array.isArray(products) || products.length < 1 || products.length > 6) return;
  const options: DidiOrder['products'] = [];
  for (const product of products) {
    if (!record(product) || !label(product.name, 80) || !label(product.price, 80)) return;
    options.push({name: product.name, price: product.price});
  }
  return {...identity, from, to, products: options, sandbox,
    phone_suffix: typeof phone_suffix === 'string' && /^\d{4}$/.test(phone_suffix) ? phone_suffix : undefined};
}
function response(value: unknown): ChatResponse | undefined {
  if (!record(value) || typeof value.conversation_id !== 'string' || !record(value.message) || typeof value.message.content !== 'string' || typeof value.message.id !== 'string') return;
  return value as unknown as ChatResponse;
}
/** Snapshots replace content; replayed deltas are ignored by numeric sequence. */
export function reduceChatStream(state: ChatStreamState, event: ChatStreamEvent): ChatStreamState {
  // Interaction announcements reuse the current progress sequence.
  if (event.event === 'interaction') {
    if (event.id < state.lastEventId || state.status === 'complete' || state.status === 'interrupted') return state;
    return {...state, didiOrder: readDidiOrder(event.data.card), inputRequest: readInputRequest(event.data.card)};
  }
  if (event.event !== 'snapshot' && event.id <= state.lastEventId) return state;
  if (event.event === 'snapshot' && event.id < state.lastEventId) return state;
  const d = event.data;
  const next: ChatStreamState = { ...state, lastEventId: event.id };
  if (typeof d.attempt === 'number') next.attempt = d.attempt;
  if (typeof d.conversation_id === 'string') next.conversationId = d.conversation_id;
  if (typeof d.message_id === 'string') next.messageId = d.message_id;
  if (typeof d.message_created_at === 'string') next.messageCreatedAt = d.message_created_at;
  if (record(d.user_message) && typeof d.user_message.id === 'string') next.userMessage = d.user_message as unknown as Message;
  if (event.event === 'snapshot') {
    next.content = typeof d.content === 'string' ? d.content : '';
    next.status = d.status === 'done' ? 'complete' : d.status === 'interrupted' ? 'interrupted' : 'running';
    next.error = typeof d.error === 'string' ? d.error : undefined;
    next.previousContent = typeof d.previous_content === 'string' ? d.previous_content : undefined;
    next.toolStatus = record(d.tool_status) ? d.tool_status : null;
    next.response = response(d.response);
    next.didiOrder = next.status === 'running' ? readDidiOrder(d.interaction) : undefined;
    next.inputRequest = next.status === 'running' ? readInputRequest(d.interaction) : undefined;
  } else if (event.event === 'text_delta') {
    if (typeof d.delta !== 'string') throw new ApiError('invalid_response', '回复文字格式不正确。');
    next.content = d.replace === true ? d.delta : state.content + d.delta;
    next.status = 'running'; next.toolStatus = null; next.error = undefined;
  } else if (event.event === 'accepted' || event.event === 'text_start' || event.event === 'retrying') {
    next.status = 'running'; next.error = undefined;
    if (event.event === 'retrying') {next.didiOrder = undefined; next.inputRequest = undefined;}
    if (event.event === 'text_start') next.toolStatus = null;
  } else if (event.event === 'tool_start') { next.toolStatus = d; next.status = 'running'; }
  else if (event.event === 'tool_end') next.toolStatus = null;
  else if (event.event === 'done') {
    next.response = response(d.response);
    if (!next.response) throw new ApiError('invalid_response', '回复完成信息无法识别，请重新连接。');
    next.status = 'complete'; next.error = undefined; next.toolStatus = null;
  } else if (event.event === 'error') {
    next.status = 'interrupted'; next.error = typeof d.message === 'string' ? d.message : '回复已中断，已保留收到的内容。'; next.toolStatus = null;
  }
  if (next.status === 'complete' || next.status === 'interrupted') {next.didiOrder = undefined; next.inputRequest = undefined;}
  if (next.response) {
    next.content = next.response.message.content; next.messageId = next.response.message.id;
    next.conversationId = next.response.conversation_id;
    if (next.response.user_message) next.userMessage = next.response.user_message;
  }
  return next;
}
