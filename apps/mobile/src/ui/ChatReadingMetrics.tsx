import React, { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { View, type Text as NativeText, type TextProps } from 'react-native';
import type { Message } from '../domain/types';
import { markdownBlocks, markdownInlineText } from './markdownBlocks';
import { Text } from './Text';

type NativeLine = { text: string; y: number; height: number };
export type ReadingLine = NativeLine & { characters: number };
export type ReadingBlock = { text: string; top: number; height: number; lines: ReadingLine[]; geometry: string };
export type ReadingRow = { content: string; blocks: Map<string, ReadingBlock>; pending: Set<string> };
export type ReadingRegistry = { rows: Map<string, ReadingRow>; notify: () => void };
type RowContext = {
  root: React.RefObject<View | null>;
  row: ReadingRow;
  geometry: string;
  valid: () => boolean;
  notify: () => void;
  measurements: Set<() => void>;
};
const ReadingContext = createContext<RowContext | null>(null);

type Segmenter = { segment: (text: string) => Iterable<{ segment: string }> };
const SegmenterConstructor = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: 'grapheme' }) => Segmenter }).Segmenter;
const segmenter = SegmenterConstructor ? new SegmenterConstructor('zh-CN', { granularity: 'grapheme' }) : null;
export function readingCharacters(text: string): number {
  if (!segmenter) return Array.from(text.replace(/\s/gu, '')).length;
  let count = 0;
  for (const { segment } of segmenter.segment(text)) if (!/^\s+$/u.test(segment)) count++;
  return count;
}
export const formatReadingCharacters = (count: number) => count < 1000
  ? `${count}字` : `${(count / 1000).toFixed(1).replace(/\.0$/, '')}千字`;

const counts = new WeakMap<Message, number>();
/** Count the text actually shown by ResultText, excluding Markdown syntax and UI labels. */
export function messageReadingCharacters(message: Message): number {
  const cached = counts.get(message);
  if (cached !== undefined) return cached;
  const count = markdownBlocks(message.content).reduce((sum, block) => {
    if (block.kind === 'code') return sum + readingCharacters(block.text);
    if (block.kind === 'table') return sum + [...block.headers, ...block.rows.flat()]
      .reduce((total, cell) => total + readingCharacters(markdownInlineText(cell)), 0);
    const heading = !block.code && /^(#{1,4})\s+(.+)$/.exec(block.text);
    const text = block.code ? block.text
      : markdownInlineText(heading ? heading[2] : block.text).replace(/^[-*]\s/, '• ');
    return sum + readingCharacters(text);
  }, 0);
  counts.set(message, count);
  return count;
}
export const isReadingStream = (message: Message) => message.role === 'assistant' &&
  Boolean(message.stream_status) && !message.stream_error;

/** FlashList coordinates are inverted: native offset zero is the visual bottom. */
export function unreadReadingCharacters(
  message: Message, row: ReadingRow | undefined, geometry: string,
  layout: { y: number; height: number; isHeightMeasured?: boolean } | undefined,
  firstItemOffset: number, nativeOffset: number,
): number | null {
  if (!layout?.isHeightMeasured || !Number.isFinite(nativeOffset)) return null;
  const start = firstItemOffset + layout.y;
  if (start >= nativeOffset - 1) return 0;
  if (start + layout.height <= nativeOffset + 1) return messageReadingCharacters(message);
  if (!row || row.content !== message.content || row.pending.size || !row.blocks.size) return null;
  let unread = 0;
  for (const block of row.blocks.values()) {
    if (block.geometry !== geometry) return null;
    for (const line of block.lines) {
      const lineBottom = start + layout.height - (block.top + line.y + line.height);
      if (lineBottom < nativeOffset - 1) unread += line.characters;
    }
  }
  return Math.min(messageReadingCharacters(message), unread);
}

export const ChatReadingRow = memo(function ChatReadingRow({ message, geometry, registry, valid, children }: {
  message: Message; geometry: string; registry: ReadingRegistry; valid: () => boolean; children: React.ReactNode;
}) {
  const root = useRef<View>(null);
  const key = message.client_key ?? message.id;
  const slot = useRef<{ key: string; row: ReadingRow } | null>(null);
  if (!slot.current || slot.current.key !== key) slot.current = { key,
    row: { content: message.content, blocks: new Map(), pending: new Set() } };
  const row = slot.current.row;
  const active = isReadingStream(message);
  const live = useRef({ key, active });
  live.current = { key, active };
  row.content = message.content;
  if (active) registry.rows.set(key, row);
  else if (registry.rows.get(key) === row) registry.rows.delete(key);
  const context = useMemo<RowContext>(() => ({ root, row, geometry,
    valid: () => valid() && live.current.active && live.current.key === key,
    notify: () => registry.notify(), measurements: new Set(),
  }), [row, registry, geometry, valid, key]);
  useEffect(() => () => {
    if (registry.rows.get(key) === row) registry.rows.delete(key);
  }, [registry, key, row]);
  return <ReadingContext.Provider value={active ? context : null}>
    <View ref={root} collapsable={false} onLayout={active ? () => {
      if (context.valid()) context.measurements.forEach(measure => measure());
    } : undefined}>{children}</View>
  </ReadingContext.Provider>;
});

/** Record real native line breaks and positions only for the active chat reply. */
export function ReadingText({ readingText, ...props }: TextProps & { readingText?: string }) {
  const context = useContext(ReadingContext);
  const id = useId();
  const native = useRef<React.ElementRef<typeof NativeText>>(null);
  const live = useRef({ context, text: readingText ?? String(props.children ?? ''), mounted: true });
  live.current.context = context;
  live.current.text = readingText ?? String(props.children ?? '');
  const lines = useRef<{ text: string; values: ReadingLine[]; geometry: string;
    native: React.ElementRef<typeof NativeText> | null } | null>(null);
  const request = useRef(0);
  const text = live.current.text;
  if (context && context.row.blocks.get(id)?.text !== text) context.row.pending.add(id);
  const measure = useMemo(() => () => {
    const snapshot = live.current;
    const current = snapshot.context;
    const measured = lines.current;
    if (!snapshot.mounted || !current?.valid() || !measured || measured.text !== snapshot.text ||
      measured.geometry !== current.geometry || measured.native !== native.current ||
      !native.current?.measureLayout || !current.root.current) return;
    const ticket = ++request.current;
    const measuredNative = native.current;
    measuredNative.measureLayout(current.root.current, (_x, top, _width, height) => {
      if (!live.current.mounted || live.current.context !== current || live.current.text !== measured.text ||
        native.current !== measuredNative || request.current !== ticket || !current.valid() ||
        !Number.isFinite(top) || !Number.isFinite(height)) return;
      current.row.blocks.set(id, { text: measured.text, top, height, lines: measured.values, geometry: current.geometry });
      current.row.pending.delete(id);
      current.notify();
    }, () => { /* Wait for the next real layout instead of guessing a position. */ });
  }, [id]);
  useLayoutEffect(() => {
    live.current.mounted = true;
    if (!context) lines.current = null;
    else if (context.row.blocks.get(id)?.text !== live.current.text) context.row.pending.add(id);
    context?.measurements.add(measure);
    return () => {
      live.current.mounted = false;
      request.current++;
      context?.measurements.delete(measure);
      context?.row.blocks.delete(id);
      context?.row.pending.delete(id);
    };
  }, [context, id, measure]);
  if (!context) return <Text {...props} />;
  return <Text {...props} ref={native}
    onLayout={event => { props.onLayout?.(event); measure(); }}
    onTextLayout={event => {
      props.onTextLayout?.(event);
      if (live.current.context !== context || live.current.text !== text || !context.valid()) return;
      lines.current = { text, geometry: context.geometry, native: native.current,
        values: event.nativeEvent.lines.map(line => ({
        text: line.text, y: line.y, height: line.height, characters: readingCharacters(line.text),
      })) };
      measure();
    }} />;
}
