import type { ChatIntent, ChatResponse } from '../src/domain/types';
import type { SseEvent } from '../src/api/chatSse';

/** Existing screen fixtures model a completed SSE event; production never falls back to JSON. */
export function addChatStreamMock(api: { chat: jest.Mock }) {
  return Object.assign(api, { chatStream: jest.fn(async (
    intent: ChatIntent,
    onEvent: (event: SseEvent) => void,
    options: { signal: AbortSignal },
  ) => {
    const response = await api.chat(intent.message, intent.conversation_id ?? undefined,
      intent.client_request_id, [...intent.upload_ids]) as ChatResponse;
    if (!options.signal.aborted) onEvent({ id: 1, event: 'done', data: { response } });
  }) });
}
