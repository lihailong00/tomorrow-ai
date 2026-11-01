import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { platform } from '../platform/ports';
import { Text } from './Text';
import { ReadingText } from './ChatReadingMetrics';
import { markdownLinks, type WebSource } from './markdownLinks';
import { markdownInlineText, type MarkdownBlock } from './markdownBlocks';

type Context = { open: (source: WebSource) => void };
const Links = createContext<Context | null>(null);

export function LinkedText({ value }: { value: string }) {
  const context = useContext(Links);
  return <>{markdownLinks(value).map((token, i) => token.kind === 'link' ?
    <Text key={i} accessibilityRole="link" accessibilityLabel={`${markdownInlineText(token.text)}，${token.source.domain}${token.source.pdf ? '，PDF 文档' : ''}`}
      onPress={() => context?.open({ ...token.source, title: markdownInlineText(token.text) })}
      style={styles.inline}>{markdownInlineText(token.text)}</Text> :
    <React.Fragment key={i}>{markdownInlineText(token.text)}</React.Fragment>)}</>;
}

export function DocumentLink({ source }: { source: WebSource }) {
  const context = useContext(Links);
  return <Pressable accessibilityRole="link" accessibilityLabel={`${source.title}，PDF 文档，${source.domain}`} onPress={() => context?.open(source)} style={styles.document}>
    <Text style={styles.sourceIcon}>▤</Text><View style={styles.flex}><ReadingText readingText={markdownInlineText(source.title)} style={styles.rowTitle}>{markdownInlineText(source.title)}</ReadingText><Text style={styles.small}>{source.domain} · PDF 文档</Text></View><Text style={styles.secondary}>↗</Text>
  </Pressable>;
}

function sourceList(blocks: MarkdownBlock[]): WebSource[] {
  const found = new Map<string, WebSource>();
  for (const block of blocks) {
    const strings = block.kind === 'table' ? [...block.headers, ...block.rows.flat()] : block.code ? [] : [block.text];
    for (const value of strings) for (const token of markdownLinks(value)) {
      if (token.kind !== 'link') continue;
      const old = found.get(token.source.url);
      if (!old || old.title === old.domain) found.set(token.source.url, { ...token.source, title: markdownInlineText(token.text) });
    }
  }
  return [...found.values()];
}

/** Metadata is derived from the answer only. No page fetch, favicon request or guessed publisher. */
export function LinkPreviewScope({ blocks, children }: { blocks: MarkdownBlock[]; children: React.ReactNode }) {
  const sources = useMemo(() => sourceList(blocks), [blocks]);
  const [panel, setPanel] = useState<'list' | string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const attempt = useRef(0);
  const selected = sources.find(s => s.url === panel);
  const sourceIdentity = sources.map(source => source.url).join('\n');
  useEffect(() => {
    attempt.current++; setPanel(null); setExpanded(false); setError(''); setOpening(false);
    return () => { attempt.current++; };
  }, [sourceIdentity]);
  const show = useCallback((source: WebSource) => { attempt.current++; setPanel(source.url); setExpanded(false); setError(''); setOpening(false); }, []);
  const close = () => { attempt.current++; setPanel(null); setExpanded(false); setOpening(false); setError(''); };
  const context = useMemo(() => ({ open: show }), [show]);
  return <Links.Provider value={context}>{children}
    {sources.length > 0 && <Pressable testID="answer-sources" accessibilityRole="button" accessibilityLabel={`查看 ${sources.length} 个来源`} onPress={() => { close(); setPanel('list'); }} style={styles.summary}>
      <Text style={styles.sourceIcon}>↗</Text><View style={styles.flex}><Text style={styles.summaryTitle}>{sources.length} 个来源</Text><Text style={styles.small}>网页与文档，集中查看</Text></View><Text style={styles.secondary}>›</Text>
    </Pressable>}
    {panel !== null && <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.overlay}><Pressable accessibilityRole="button" accessibilityLabel="关闭来源预览" style={StyleSheet.absoluteFill} onPress={close} />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grip} />
          <View style={styles.heading}><Text style={styles.headingText}>{selected ? '来源预览' : `这条回答的来源 · ${sources.length}`}</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭来源窗口" onPress={close} style={styles.close}><Text style={styles.secondary}>×</Text></Pressable></View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
            {selected ? <>
              <View style={styles.meta}><Text style={styles.small}>{selected.domain}</Text><Text style={styles.badge}>{selected.pdf ? 'PDF' : '网页'}</Text></View>
              <Text selectable style={styles.title}>{selected.title}</Text>
              <Text style={styles.small}>{selected.pdf ? '将在设备支持的浏览器或文档应用中打开。' : '打开后前往以上域名，返回即可继续阅读对话。'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起完整网址' : '查看完整网址'} accessibilityState={{ expanded }} style={styles.urlToggle} onPress={() => setExpanded(v => !v)}><Text style={styles.link}>{expanded ? '收起完整网址' : '查看完整网址'}</Text></Pressable>
              {expanded && <View style={styles.urlBox}><Text selectable style={styles.url}>{selected.url}</Text></View>}
              <View style={styles.actions}><Pressable accessibilityRole="button" style={styles.action} onPress={() => { close(); setPanel('list'); }}><Text style={styles.link}>全部来源</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={selected.pdf ? '打开 PDF' : '打开原文'} disabled={opening} style={[styles.action, opening && styles.disabled]} onPress={async () => {
                  const token = ++attempt.current; setOpening(true); setError('');
                  try { await platform.openUrl(selected.url); }
                  catch { if (attempt.current === token) { setError('未能打开链接，请展开网址后复制，或稍后重试。'); setExpanded(true); } }
                  finally { if (attempt.current === token) setOpening(false); }
                }}><Text style={styles.link}>{opening ? '正在打开…' : selected.pdf ? '打开 PDF ↗' : '打开原文 ↗'}</Text></Pressable></View>
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            </> : sources.map((source, index) => <Pressable key={source.url} accessibilityRole="button" accessibilityLabel={`来源 ${index + 1}：${source.title}，${source.domain}`} onPress={() => show(source)} style={styles.row}>
              <Text style={styles.index}>{index + 1}</Text><View style={styles.flex}><Text style={styles.rowTitle}>{source.title}</Text><Text style={styles.small}>{source.domain}{source.pdf ? ' · PDF' : ''}</Text></View><Text style={styles.secondary}>›</Text>
            </Pressable>)}
          </ScrollView>
        </View>
      </View>
    </Modal>}
  </Links.Provider>;
}

const styles = StyleSheet.create({
  document: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: '#E6EAF3', backgroundColor: '#FFFFFF', borderRadius: 16, padding: 13, marginVertical: 5 },
  inline: { color: '#526EBA', textDecorationLine: 'underline', textDecorationColor: '#CCD7F0' },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DFE5EF', paddingVertical: 13, minHeight: 56, marginTop: 10 },
  sourceIcon: { fontSize: 18, color: '#7486B2' }, flex: { flex: 1, minWidth: 0 },
  summaryTitle: { color: '#526EBA', fontSize: 13, lineHeight: 22 }, small: { color: '#758095', fontSize: 12, lineHeight: 21, flexShrink: 1 }, secondary: { color: '#758095', fontSize: 21 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#28344B38' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingTop: 10, paddingHorizontal: 21, maxHeight: '82%' },
  grip: { width: 34, height: 4, backgroundColor: '#DBE0E9', borderRadius: 3, alignSelf: 'center', marginBottom: 13 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }, headingText: { fontSize: 18, color: '#303849', flex: 1 }, close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F1F3F8', borderRadius: 22 },
  scroll: { flexGrow: 0 }, sheetContent: { paddingBottom: 32 }, meta: { flexDirection: 'row', alignItems: 'center', gap: 9, flexWrap: 'wrap' }, badge: { fontSize: 11, color: '#7481A1', backgroundColor: '#EDF1FA', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  title: { fontSize: 20, lineHeight: 31, color: '#303849', marginTop: 14, marginBottom: 12 }, urlToggle: { minHeight: 44, justifyContent: 'center', marginTop: 6 }, link: { fontSize: 13, lineHeight: 23, color: '#526EBA' }, urlBox: { borderRadius: 11, padding: 12, backgroundColor: '#F5F7FB' }, url: { color: '#6F7D95', fontSize: 12, lineHeight: 21 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 15 }, action: { flex: 1, minWidth: 110, minHeight: 46, backgroundColor: '#EAF0FC', borderRadius: 15, padding: 11, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: 0.5 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#EDF0F5' }, index: { fontSize: 12, color: '#7A88A8', backgroundColor: '#F0F3FA', width: 27, paddingVertical: 5, textAlign: 'center', borderRadius: 8 }, rowTitle: { fontSize: 14, lineHeight: 23, color: '#303849', marginBottom: 3 }, error: { color: '#AE465D', fontSize: 12, lineHeight: 21, marginTop: 13 },
});
