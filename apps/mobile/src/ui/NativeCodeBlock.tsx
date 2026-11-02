import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { platform } from '../platform/ports';
import { Text } from './Text';
import { ReadingText } from './ChatReadingMetrics';
import { Icon } from './visuals';
import { codeLanguage, highlightCode, type CodeToken } from './codeHighlight';
import type { MarkdownBlock } from './markdownBlocks';

type Block = Extract<MarkdownBlock, { kind: 'code' }>;
type CodeRow = { index: number; text: string; tokens: CodeToken[] };
const PREVIEW_LINES = 14;
const EXPANDED_CARD_LINES = 200;
const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const tokenColors = { keyword: '#8055B6', type: '#2E65A6', comment: '#77849A', string: '#297B68', number: '#9E6331', attribute: '#956138', lifetime: '#7961A1' };

/** Split already-bounded highlighting into rows; untouched tail remains plain text. */
function sourceRows(source: string, grammar: ReturnType<typeof codeLanguage>['grammar']): CodeRow[] {
  if (!source) return [];
  const normalized = source.replace(/\r\n/g, '\n');
  const rows: CodeRow[] = [{ index: 0, text: '', tokens: [] }];
  for (const token of highlightCode(normalized, grammar)) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (index) rows.push({ index: rows.length, text: '', tokens: [] });
      const row = rows[rows.length - 1];
      row.text += part;
      if (part) row.tokens.push({ text: part, kind: token.kind });
    });
  }
  if (rows[rows.length - 1].text === '' && normalized.endsWith('\n')) rows.pop();
  return rows;
}
function paint(tokens: CodeToken[]) {
  return tokens.map((token, index) => token.kind
    ? <Text key={index} style={{ color: tokenColors[token.kind] }}>{token.text}</Text> : token.text);
}
function Tool({ label, children, onPress, active, disabled, testID }: {
  label: string; children: React.ReactNode; onPress: () => void; active?: boolean; disabled?: boolean; testID?: string;
}) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [css.tool, active && css.activeTool, pressed && css.pressed, disabled && css.disabled]}>{children}</Pressable>;
}

/** Native text only. No HTML, browser, evaluator, provider request or syntax dependency. */
export const NativeCodeBlock = memo(function NativeCodeBlock({ block }: { block: Block }) {
  const { width, fontScale } = useWindowDimensions();
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [reader, setReader] = useState(false);
  const [numbers, setNumbers] = useState(false);
  const [fontSize, setFontSize] = useState(12.5);
  const [copied, setCopied] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const generation = useRef(0), busy = useRef(false), alive = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const language = useMemo(() => codeLanguage(block.language), [block.language]);
  const rows = useMemo(() => sourceRows(block.text, language.grammar), [block.text, language.grammar]);
  const maxUnits = useMemo(() => rows.reduce((max, row) => {
    let units = 0;
    for (const char of row.text) units += char === '\t' ? 4 : /[^\u0000-\u007f]/.test(char) ? 2 : 1;
    return Math.max(max, units);
  }, 0), [rows]);
  // Very long individual lines wrap instead of creating an enormous native canvas.
  const forcedWrap = maxUnits * fontSize * Math.min(fontScale, 2.5) * .64 > 12000;
  const wrapping = wrap || forcedWrap;
  const lineHeight = Math.round(fontSize * 1.85);
  const available = Math.max(1, measuredWidth || width - 44);
  const wanted = Math.ceil(maxUnits * fontSize * Math.min(fontScale, 2.5) * .64 + 32);
  const codeWidth = Math.max(available, wanted);
  const readerWidth = Math.max(width - 28, wanted + (numbers ? 42 : 0));
  const visible = rows.slice(0, expanded ? EXPANDED_CARD_LINES : PREVIEW_LINES);
  const visibleSource = visible.map(row => row.text).join('\n');
  useEffect(() => {
    generation.current++; busy.current = false; setCopyBusy(false); setCopied(false); setCopyError(false);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, [block.text]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, []);
  async function copy() {
    if (busy.current || !block.text) return;
    busy.current = true; setCopyBusy(true); setCopyError(false);
    const ticket = ++generation.current;
    try {
      await platform.copyText(block.text);
      if (!alive.current || generation.current !== ticket) return;
      setCopied(true);
      copyTimer.current = setTimeout(() => { if (alive.current && generation.current === ticket) setCopied(false); }, 1800);
    } catch {
      if (alive.current && generation.current === ticket) { setCopyError(true); setReader(true); }
    } finally {
      if (alive.current && generation.current === ticket) { busy.current = false; setCopyBusy(false); }
    }
  }
  const copyTool = <Tool label="复制代码" disabled={copyBusy || !block.text} onPress={() => { void copy(); }}>
    <Icon name={copied ? 'check' : 'copy'} size={15} color="#667187" /><Text accessibilityLiveRegion="polite" style={css.toolText}>{copied ? '已复制' : copyBusy ? '复制中' : '复制'}</Text>
  </Tool>;
  const readerRows = <FlatList<CodeRow> testID="code-reader-list" data={rows} keyExtractor={row => String(row.index)}
    style={wrapping ? css.readerList : { width: readerWidth }} contentContainerStyle={css.readerListContent}
    initialNumToRender={32} maxToRenderPerBatch={24} windowSize={5} keyboardShouldPersistTaps="handled"
    removeClippedSubviews={false}
    ListEmptyComponent={<Text style={css.empty}>{block.closed ? '空代码块' : '正在生成代码…'}</Text>}
    renderItem={({ item }) => <View style={css.readerLine} testID="code-reader-line">
      {numbers && <Text accessible={false} selectable={false} maxFontSizeMultiplier={2.5}
        style={[css.gutter, { fontSize: Math.max(11, fontSize - 1), lineHeight }]}>{item.index + 1}</Text>}
      <Text selectable maxFontSizeMultiplier={2.5} style={[css.codeText, { fontSize, lineHeight }, wrapping && css.wrappedRow]}>{item.tokens.length ? paint(item.tokens) : '\u200b'}</Text>
    </View>} />;
  return <View testID="native-code-block" style={css.card} onLayout={event => {
    const next = event.nativeEvent.layout.width - 2;
    if (next > 0 && Math.abs(next - measuredWidth) > 1) setMeasuredWidth(next);
  }}>
    <View style={css.header}>
      <View style={css.languageGroup}><Icon name="code" size={15} color="#5369B4" /><Text numberOfLines={1} style={css.language}>{language.label}</Text><Text style={css.count}>{rows.length} 行</Text></View>
      <View style={css.tools}>{copyTool}<Tool label="全屏阅读代码" testID="code-open-reader" onPress={() => setReader(true)}><Icon name="expand" size={15} color="#667187" /></Tool></View>
    </View>
    <ScrollView testID="code-card-scroll" horizontal={!wrapping} nestedScrollEnabled
      showsHorizontalScrollIndicator={!wrapping && codeWidth > available + 1} style={css.cardScroll}>
      {rows.length ? <View style={wrapping ? { width: available } : { width: codeWidth }}>
        <ReadingText testID="code-card-source" readingText={visibleSource} selectable maxFontSizeMultiplier={2.5}
          style={[css.codeText, css.cardSource, { fontSize, lineHeight }]}>
          {visible.map((row, index) => <React.Fragment key={row.index}>{index ? '\n' : ''}{paint(row.tokens)}</React.Fragment>)}
        </ReadingText>
      </View> : <Text style={css.empty}>{block.closed ? '空代码块' : '正在生成代码…'}</Text>}
    </ScrollView>
    {rows.length > PREVIEW_LINES && <Pressable accessibilityRole="button" testID="code-expand"
      accessibilityLabel={expanded ? '收起代码' : rows.length > EXPANDED_CARD_LINES ? `展开前 ${EXPANDED_CARD_LINES} 行预览，共 ${rows.length} 行代码` : `展开全部 ${rows.length} 行代码`} accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={css.expand}>
      <Text style={css.expandText}>{expanded ? '收起代码' : rows.length > EXPANDED_CARD_LINES ? `展开预览 · 共 ${rows.length} 行` : `展开全部 ${rows.length} 行`}</Text>
      <View style={expanded ? css.chevronUp : undefined}><Icon name="chevronDown" size={14} color="#5369B4" /></View>
    </Pressable>}
    {expanded && rows.length > EXPANDED_CARD_LINES && <Pressable accessibilityRole="button" accessibilityLabel="阅读全部代码" onPress={() => setReader(true)} style={css.expand}><Text style={css.expandText}>已显示前 {EXPANDED_CARD_LINES} 行，打开阅读模式查看全部</Text></Pressable>}
    <View style={css.footer}><Text style={css.hint}>{forcedWrap ? '超长行已自动换行' : wrapping ? '保留缩进，自动换行' : codeWidth > available + 1 ? '↔ 左右滑动看完整代码' : '保留原始缩进'}</Text>
      <Tool label={wrap ? '关闭代码自动换行' : '开启代码自动换行'} active={wrap} onPress={() => setWrap(value => !value)}><Text style={css.toolText}>自动换行</Text></Tool>
    </View>
    {reader && <Modal visible animationType="slide" onRequestClose={() => setReader(false)}>
      <SafeAreaView style={css.reader} accessibilityViewIsModal testID="code-reader">
        <View style={css.readerHeader}>
          <Tool label="返回对话" onPress={() => setReader(false)}><Icon name="back" size={21} color="#5369B4" /></Tool>
          <View style={css.readerTitle}><Text style={css.readerName}>{language.label} 代码</Text><Text style={css.count}>{rows.length} 行</Text></View>{copyTool}
        </View>
        {copyError && <Text accessibilityRole="alert" style={css.copyError}>未能直接复制，请长按代码选择文字，也可以再次点复制。</Text>}
        {wrapping ? readerRows : <ScrollView testID="code-reader-horizontal" horizontal nestedScrollEnabled contentContainerStyle={css.horizontalContent} style={css.readerScroll}>{readerRows}</ScrollView>}
        <View style={css.readerFooter}>
          <View style={css.tools}><Tool label={wrap ? '关闭代码自动换行' : '开启代码自动换行'} active={wrap} onPress={() => setWrap(value => !value)}><Text style={css.toolText}>换行</Text></Tool><Tool label={numbers ? '隐藏代码行号' : '显示代码行号'} active={numbers} onPress={() => setNumbers(value => !value)}><Text style={css.toolText}>行号</Text></Tool></View>
          <View style={css.tools}><Tool label="减小代码字号" disabled={fontSize <= 11} onPress={() => setFontSize(value => Math.max(11, value - .5))}><Text style={css.toolText}>A−</Text></Tool><Text style={css.count}>{fontSize}</Text><Tool label="增大代码字号" disabled={fontSize >= 18} onPress={() => setFontSize(value => Math.min(18, value + .5))}><Text style={css.toolText}>A＋</Text></Tool></View>
        </View>
      </SafeAreaView>
    </Modal>}
  </View>;
});

const css = StyleSheet.create({
  card: { minWidth: 0, alignSelf: 'stretch', backgroundColor: '#FAFBFF', borderWidth: 1, borderColor: '#E2E6F1', borderRadius: 16, overflow: 'hidden', marginVertical: 6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 13, paddingRight: 5, backgroundColor: '#F0F3FB', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E2E6F1', minHeight: 45 },
  languageGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 },
  language: { fontSize: 12, fontWeight: '500', color: '#303849', flexShrink: 1 }, codeGlyph: { fontSize: 12, color: '#5369B4' },
  count: { color: '#77849A', fontSize: 11, lineHeight: 18 }, tools: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  tool: { minWidth: 44, minHeight: 44, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  toolText: { color: '#667187', fontSize: 12, lineHeight: 19 }, activeTool: { backgroundColor: '#E3E9FA' }, pressed: { opacity: .65 }, disabled: { opacity: .45 },
  expandGlyph: { fontSize: 21, color: '#667187' }, cardScroll: { flexGrow: 0 },
  codeText: { fontFamily: mono, color: '#303849', includeFontPadding: false }, cardSource: { paddingHorizontal: 14, paddingTop: 13, paddingBottom: 15 },
  empty: { color: '#77849A', padding: 15, fontSize: 12 }, expand: { minHeight: 41, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E2E6F1', backgroundColor: '#F0F3FC' },
  expandText: { color: '#5369B4', fontSize: 12, lineHeight: 19, flexShrink: 1 }, chevronUp: { transform: [{ rotate: '180deg' }] },
  footer: { minHeight: 41, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 6, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E7EAF4' },
  hint: { color: '#77849A', fontSize: 11, lineHeight: 18, flex: 1, minWidth: 0 },
  reader: { flex: 1, backgroundColor: '#FBFCFF' }, readerHeader: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 5, backgroundColor: '#F5F7FD', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E2E6F1' },
  readerTitle: { flex: 1, minWidth: 0, paddingHorizontal: 5 }, readerName: { fontSize: 15, fontWeight: '500', color: '#303849' },
  readerScroll: { flex: 1 }, horizontalContent: { flexGrow: 1 }, readerList: { flex: 1 }, readerListContent: { paddingHorizontal: 14, paddingVertical: 18 },
  readerLine: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 1 }, gutter: { fontFamily: mono, width: 35, marginRight: 7, textAlign: 'right', color: '#9AA3B9' }, wrappedRow: { flex: 1, minWidth: 0 },
  readerFooter: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7, gap: 2, backgroundColor: '#F5F7FD', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E2E6F1' },
  copyError: { color: '#82536A', backgroundColor: '#FAEDF2', paddingHorizontal: 15, paddingVertical: 8, fontSize: 12, lineHeight: 20 },
});
