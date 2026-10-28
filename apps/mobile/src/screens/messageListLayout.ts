import type { Message } from '../domain/types';

export type MessageAnchor = { id: string; offset: number };
export type MessageViewport = {
  y: number;
  followTail: boolean;
  anchor: MessageAnchor | null;
  layoutKey: string;
  headerHeight: number;
  heights: Map<string, { message: Message; height: number }>;
};

export function createMessageViewport(): MessageViewport {
  return {
    y: 0,
    followTail: false,
    anchor: null,
    layoutKey: '',
    headerHeight: 0,
    heights: new Map(),
  };
}

export const messageRowKey = (message: Message) =>
  message.client_key ?? message.id;

export function messageAnchorAt(
  y: number,
  frames: ReadonlyMap<string, { y: number; height: number }>,
  viewportHeight = Infinity,
): MessageAnchor | null {
  let first: { id: string; y: number; height: number } | undefined;
  for (const [id, frame] of frames) {
    if (
      frame.y + frame.height > y &&
      frame.y < y + viewportHeight &&
      (!first || frame.y < first.y)
    )
      first = { id, ...frame };
  }
  return first ? { id: first.id, offset: y - first.y } : null;
}

export function messageInitialIndex(
  messages: Message[],
  anchor: MessageAnchor | null,
) {
  const retained = anchor
    ? messages.findIndex(message => messageRowKey(message) === anchor.id)
    : -1;
  return retained >= 0 ? retained : 0;
}
