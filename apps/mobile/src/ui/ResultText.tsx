import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type TextStyle } from 'react-native';
import { Text as PlainText } from './Text';
import { ReadingText as Text } from './ChatReadingMetrics';
import { colors, styles as s } from './theme';
import { markdownBlocks, markdownInlineText, type MarkdownBlock } from './markdownBlocks';

import { LinkedText, LinkPreviewScope, DocumentLink } from './LinkPreview';
import { markdownLinks } from './markdownLinks';

function inline(value: string) { return markdownLinks(value).some(t => t.kind === 'link') ? <LinkedText value={value} /> : markdownInlineText(value); }

type TableBlock = Extract<MarkdownBlock, { kind: 'table' }>;

function columnWidths(table: TableBlock, available: number, fontSize: number, fontScale: number): number[] {
  const scale = Math.max(1, Math.min(fontScale, 2.5));
  const sizes = table.headers.map((header, column) => {
    let units = 0;
    for (const value of [header, ...table.rows.map(row => row[column])]) {
      // Estimate only the desired width; native Text does the actual wrapping.
      const length = Array.from(markdownInlineText(value)).reduce((total, char) => total + (/[^\u0000-\u007f]/.test(char) ? 1 : 0.58), 0);
      units = Math.max(units, length);
    }
    return Math.min(240 * scale, Math.max(92 * scale, units * fontSize * scale + 24));
  });
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total < available ? sizes.map(size => size + (available - total) / sizes.length) : sizes;
}

function NativeMarkdownTable({ table, textStyle }: { table: TableBlock; textStyle?: StyleProp<TextStyle> }) {
  const { width, fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const available = measuredWidth || Math.max(1, width - 52);
  const fontSize = StyleSheet.flatten([s.body, textStyle])?.fontSize ?? 14;
  const widths = useMemo(() => columnWidths(table, available, fontSize, fontScale), [table, available, fontSize, fontScale]);
  const wide = widths.reduce((sum, size) => sum + size, 0) > available + 1;
  const row = (values: string[], index: number, header = false) => (
    <View key={header ? 'header' : `row:${index}`} testID={header ? 'markdown-table-header' : 'markdown-table-row'}
      style={[tableStyles.row, header && tableStyles.header, !header && index % 2 === 1 && tableStyles.alternate]}>
      {values.map((value, column) => {
        const plain = markdownInlineText(value);
        const label = markdownInlineText(table.headers[column]) || `第 ${column + 1} 列`;
        return <View key={column} style={[tableStyles.cell, { width: widths[column] }, column > 0 && tableStyles.nextColumn]}>
          <Text readingText={plain} selectable accessibilityRole={header ? 'header' : 'text'}
            accessibilityLabel={header ? label : `${label}：${plain || '空白'}`}
            style={[s.body, textStyle, tableStyles.cellText, header && tableStyles.headerText, { textAlign: table.alignments[column] }]}>
            {inline(value)}
          </Text>
        </View>;
      })}
    </View>
  );
  return <View testID="markdown-table" style={tableStyles.container} onLayout={event => {
    const next = event.nativeEvent.layout.width;
    if (next > 0 && Math.abs(next - measuredWidth) > 1) setMeasuredWidth(next);
  }}>
    {wide && <PlainText style={tableStyles.hint}>左右滑动查看表格</PlainText>}
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={wide}
      testID="markdown-table-scroll" style={tableStyles.scroller}>
      <View style={tableStyles.grid}>
        {row(table.headers, -1, true)}
        {table.rows.map((cells, index) => row(cells, index))}
      </View>
    </ScrollView>
  </View>;
}

/** Safe native rendering: model output never becomes executable HTML or a WebView. */
export function ResultText({ content, textStyle }: { content: string; textStyle?: StyleProp<TextStyle> }) {
  const blocks = useMemo(() => markdownBlocks(content), [content]);
  return <LinkPreviewScope blocks={blocks}><View style={{ gap: 7 }}>
    {blocks.map(block => {
      if (block.kind === 'table') return <NativeMarkdownTable key={`table:${block.line}`} table={block} textStyle={textStyle} />;
      const { text: line, code } = block;
      if (!line.trim()) return <View key={`line:${block.line}`} style={{ height: 4 }} />;
      const tokens = !code ? markdownLinks(line.trim()) : [];
      if (tokens.length === 1 && tokens[0].kind === 'link' && tokens[0].source.pdf) return <DocumentLink key={`pdf:${block.line}`} source={tokens[0].source} />;
      const heading = !code && /^(#{1,4})\s+(.+)$/.exec(line);
      const value = (heading ? heading[2] : line).replace(/^[-*]\s/, '• ');
      return <Text readingText={code ? line : markdownInlineText(value)} selectable key={`line:${block.line}`} style={[
        s.body,
        textStyle,
        heading && { fontSize: heading[1].length < 3 ? 18 : 15, fontWeight: '600', color: colors.ink, marginTop: 12 },
        code && { fontFamily: 'monospace', fontSize: 12, backgroundColor: colors.cream, padding: 8 },
        !code && /^[-*]\s/.test(line) && { paddingLeft: 7 },
      ]}>
        {code ? line : inline(value)}
      </Text>;
    })}
  </View></LinkPreviewScope>;
}

const tableStyles = StyleSheet.create({
  container: { alignSelf: 'stretch', minWidth: 0, marginVertical: 6 },
  hint: { color: colors.secondary, fontSize: 11, lineHeight: 18, marginBottom: 5 },
  scroller: { flexGrow: 0 },
  grid: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  header: { backgroundColor: colors.cream },
  alternate: { backgroundColor: '#F7F8FC' },
  cell: { paddingHorizontal: 12, paddingVertical: 10, justifyContent: 'flex-start' },
  nextColumn: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  cellText: { flexShrink: 1 },
  headerText: { fontWeight: '600' },
});
