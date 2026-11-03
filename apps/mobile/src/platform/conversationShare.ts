/** Local export boundary. iOS and HarmonyOS can supply the same native port. */
import { NativeModules } from 'react-native';

export type ShareBlock =
  | { type: 'text'; text: string; heading?: number }
  | { type: 'code'; text: string; language?: string }
  | { type: 'table'; headers: string[]; rows: string[][] };
export type ConversationShareDocument = {
  title: string;
  messages: Array<{ role: 'user' | 'assistant'; blocks: ShareBlock[]; timeLabel?: string }>;
};
export type PreparedConversationImage = { id: string; uri: string; width: number; height: number; size: number };
interface NativeSharePort {
  prepare(requestId: string, document: string): Promise<PreparedConversationImage>;
  cancel(requestId: string): Promise<void>;
  cancelAll(): Promise<void>;
  save(id: string): Promise<void>;
  share(id: string): Promise<void>;
  release(id: string): Promise<void>;
}
export type ConversationShareErrorCode = 'unsupported' | 'cancelled' | 'too_large' | 'busy' | 'expired' | 'foreground' | 'unavailable';
const messages: Record<ConversationShareErrorCode, string> = {
  unsupported: '此设备暂不支持保存长图，请使用文字分享。',
  cancelled: '分享已取消。',
  too_large: '所选内容太长或表格太宽，无法生成一张清晰长图。请减少选择，或改用文字分享。',
  busy: '正在处理上一张长图，请稍后重试。',
  expired: '长图已失效，请重新生成。',
  foreground: '请回到应用前台再保存或分享。',
  unavailable: '暂时无法处理长图，请重试或使用文字分享。',
};
export class ConversationShareError extends Error {
  constructor(public code: ConversationShareErrorCode) { super(messages[code]); this.name = 'ConversationShareError'; }
}
function mapped(error: unknown) {
  if (error instanceof ConversationShareError) return error;
  const code = String((error as { code?: unknown } | null)?.code ?? '').replace(/^E_SHARE_/, '').toLowerCase();
  return new ConversationShareError(Object.prototype.hasOwnProperty.call(messages, code) ? code as ConversationShareErrorCode : 'unavailable');
}
function nativePort(): NativeSharePort {
  const value = NativeModules.TadaConversationShare as NativeSharePort | undefined;
  if (!value) throw new ConversationShareError('unsupported');
  return value;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readPreparedConversationImage(value: unknown): PreparedConversationImage {
  const item = value as Partial<PreparedConversationImage> | null;
  if (!item || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.uri !== 'string' ||
      !/^content:\/\/com\.tomorrowai(?:\.[a-z0-9_]+)*\.attachments\/conversation_share\/[0-9a-f-]+\.png$/i.test(item.uri) ||
      typeof item.width !== 'number' || item.width !== 900 || typeof item.height !== 'number' ||
      !Number.isInteger(item.height) || item.height < 1 || item.height > 12000 ||
      typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 8 * 1024 * 1024 ||
      !item.uri.toLowerCase().endsWith('/' + item.id.toLowerCase() + '.png')) throw new ConversationShareError('unavailable');
  return { id: item.id, uri: item.uri, width: item.width, height: item.height, size: item.size };
}
let nextRequest = 0;
let epoch = 0;
const active = new Set<() => void>();
const known = new Set<string>();
export const conversationShare = {
  get available() { return Boolean(NativeModules.TadaConversationShare); },
  async prepare(document: ConversationShareDocument, signal?: AbortSignal): Promise<PreparedConversationImage> {
    if (signal?.aborted) throw new ConversationShareError('cancelled');
    const port = nativePort();
    const owner = epoch;
    const id = `share-${Date.now()}-${++nextRequest}`;
    let serialized: string;
    try { serialized = JSON.stringify(document); } catch { throw new ConversationShareError('unavailable'); }
    if (typeof serialized !== 'string' || serialized.length > 262144) throw new ConversationShareError('too_large');
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); active.delete(abort); action();
      };
      const abort = () => {
        if (settled) return;
        if (started) { try { Promise.resolve(port.cancel(id)).catch(() => {}); } catch { /* A late result is released below. */ } }
        finish(() => reject(new ConversationShareError('cancelled')));
      };
      active.add(abort); signal?.addEventListener('abort', abort);
      if (signal?.aborted || epoch !== owner) { abort(); return; }
      Promise.resolve().then(() => {
        if (settled || owner !== epoch) return;
        started = true; return port.prepare(id, serialized);
      }).then(raw => {
        if (!raw) { if (!settled) finish(() => reject(new ConversationShareError('unavailable'))); return; }
        let image: PreparedConversationImage;
        try { image = readPreparedConversationImage(raw); }
        catch (error) {
          // Never reflect an arbitrary native path back into a native operation.
          if (typeof (raw as { id?: unknown }).id === 'string' && uuid.test((raw as { id: string }).id)) {
            try { Promise.resolve(port.release((raw as { id: string }).id)).catch(() => {}); } catch { /* Best effort cleanup. */ }
          }
          finish(() => reject(mapped(error))); return;
        }
        if (settled || owner !== epoch || signal?.aborted) {
          try { Promise.resolve(port.release(image.id)).catch(() => {}); } catch { /* Never return a stale image. */ }
          if (!settled) abort(); return;
        }
        known.add(image.id); finish(() => resolve(image));
      }).catch(error => finish(() => reject(mapped(error))));
    });
  },
  async save(id: string): Promise<void> { return operate('save', id); },
  async share(id: string): Promise<void> { return operate('share', id); },
  async release(id: string): Promise<void> {
    if (!uuid.test(id)) return;
    known.delete(id);
    try { await nativePort().release(id); } catch { /* Cache expiry remains a final cleanup backstop. */ }
  },
  async cancelAll(): Promise<void> {
    epoch++; [...active].forEach(abort => abort()); known.clear();
    try { await nativePort().cancelAll(); } catch { /* JS also fences every late result. */ }
  },
};
async function operate(action: 'save' | 'share', id: string): Promise<void> {
  if (!uuid.test(id) || !known.has(id)) throw new ConversationShareError('expired');
  const owner = epoch;
  try {
    if (owner !== epoch) throw new ConversationShareError('cancelled');
    await nativePort()[action](id);
    if (owner !== epoch) throw new ConversationShareError('cancelled');
  } catch (error) { throw mapped(error); }
}
