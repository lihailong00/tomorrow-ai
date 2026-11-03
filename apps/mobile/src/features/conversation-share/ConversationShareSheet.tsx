import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, useWindowDimensions, View } from 'react-native';
import { Text } from '../../ui/Text';
import { AmbientBackground, Icon } from '../../ui/visuals';
import { platform } from '../../platform/ports';
import { conversationShare, type PreparedConversationImage } from '../../platform/conversationShare';
import { candidateBlocks, blockPlainText, DEFAULT_SHARE_TITLE, shareDocument, shareText, type ShareCandidate } from './model';
import type { ShareBlock } from '../../platform/conversationShare';

type Props = {
  candidates: readonly ShareCandidate[];
  initialSelectedId: string;
  hasOlder: boolean;
  isCurrent: () => boolean;
  validateSelection?: (ids: readonly string[]) => string | null;
  formatDate: (value: string) => string;
  onClose: () => void;
};

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
const release = (image: PreparedConversationImage | null) => { if (image) void conversationShare.release(image.id).catch(() => {}); };

/** Local-only sharing. Its frozen candidates are independent of mutable chat drafts/history. */
export function ConversationShareSheet({ candidates, initialSelectedId, hasOlder, isCurrent, validateSelection, formatDate, onClose }: Props) {
  const [selected, setSelected] = useState<string[]>([initialSelectedId]);
  const [stage, setStage] = useState<'select' | 'preview'>('select');
  const [format, setFormat] = useState<'image' | 'text'>('image');
  const [title, setTitle] = useState(DEFAULT_SHARE_TITLE);
  const [showTime, setShowTime] = useState(false);
  const [image, setImage] = useState<PreparedConversationImage | null>(null);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [imageWidth, setImageWidth] = useState(0);
  const [imageAttempt, setImageAttempt] = useState(0);
  const { width, fontScale } = useWindowDimensions();
  const [listMount, setListMount] = useState(0);
  const listKey = `share-list:${width}:${fontScale}:${listMount}`;
  const currentListKey = useRef(listKey); currentListKey.current = listKey;
  const alive = useRef(true);
  const owner = useRef(isCurrent); owner.current = isCurrent;
  const source = useRef(validateSelection); source.current = validateSelection;
  const actionBusy = useRef(false);
  const imageRef = useRef<PreparedConversationImage | null>(null);
  const imageDocument = useRef<unknown>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const listRef = useRef<FlatList<ShareCandidate>>(null);
  const seedIndex = useRef(Math.max(0, candidates.findIndex(item => item.id === initialSelectedId))).current;
  const seedRetries = useRef(0);
  const seedVisible = useRef(false);
  const seedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seedViewability = useMemo(() => (event: { viewableItems: Array<{ item?: ShareCandidate }> }) => {
    if (currentListKey.current !== listKey) return;
    if (event.viewableItems.some(item => item.item?.id === initialSelectedId)) {
      seedVisible.current = true;
      if (seedTimer.current) clearTimeout(seedTimer.current);
    }
  }, [initialSelectedId, listKey]);
  useLayoutEffect(() => {
    // A resized/re-scaled native list must measure its rows again, keeping the share choices above it.
    seedVisible.current = false; seedRetries.current = 0;
    if (seedTimer.current) clearTimeout(seedTimer.current);
  }, [listKey]);
  const current = () => alive.current && owner.current();
  const validate = () => source.current?.(selected) ?? null;
  const sourceError = validate();
  const invalidate = () => {
    alive.current = false; generation.current++;
    if (seedTimer.current) clearTimeout(seedTimer.current);
    pending.current?.abort(); pending.current = null;
    void conversationShare.cancelAll().catch(() => {});
    release(imageRef.current); imageRef.current = null; imageDocument.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return invalidate;
    // All callbacks use the current owner fence; a new modal owns a fresh lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => { if (!current()) return; invalidate(); onClose(); };
  const payload = useMemo(() => {
    try { return { document: shareDocument(candidates, selected, title, showTime, formatDate), error: null }; }
    catch (failure) { return { document: null, error: errorText(failure) }; }
  }, [candidates, selected, title, showTime, formatDate]);
  const textPayload = useMemo(() => {
    try { return { text: shareText(candidates, selected), error: null }; }
    catch (failure) { return { text: '', error: errorText(failure) }; }
  }, [candidates, selected]);

  useEffect(() => {
    const request = ++generation.current;
    pending.current?.abort(); pending.current = null;
    release(imageRef.current); imageRef.current = null; imageDocument.current = null; setImage(null);
    setGenerating(false);
    if (sourceError) { void conversationShare.cancelAll().catch(() => {}); return; }
    if (stage !== 'preview' || format !== 'image' || !payload.document || sourceError || !current()) return;
    if (!conversationShare.available) { setError('此设备暂不支持生成长图，可以切换到文字分享。'); return; }
    const controller = new AbortController(); pending.current = controller;
    setGenerating(true); setError(null);
    const timer = setTimeout(() => {
      if (!current() || controller.signal.aborted) return;
      const invalid = validate();
      if (invalid) { setError(invalid); setGenerating(false); return; }
      void conversationShare.prepare(payload.document!, controller.signal).then(result => {
        if (!current() || controller.signal.aborted || generation.current !== request) { release(result); return; }
        const stale = validate();
        if (stale) { release(result); setError(stale); return; }
        imageRef.current = result; imageDocument.current = payload.document; setImage(result);
      }).catch(failure => {
        if (current() && !controller.signal.aborted && generation.current === request) setError(errorText(failure));
      }).finally(() => {
        if (current() && generation.current === request) { setGenerating(false); if (pending.current === controller) pending.current = null; }
      });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
    // Current owner is read from a ref so unrelated chat renders do not regenerate PNGs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, format, payload.document, imageAttempt, sourceError]);

  const toggle = (id: string) => {
    if (!current() || actionBusy.current) return;
    setError(null); setNotice(null);
    setSelected(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]);
  };
  const allSelected = selected.length === candidates.length;
  const preview = (next: 'image' | 'text') => {
    if (!current() || actionBusy.current || !selected.length) return;
    if (seedTimer.current) clearTimeout(seedTimer.current);
    setError(null); setNotice(null); setFormat(next); setStage('preview');
  };
  const back = () => {
    if (!current() || actionBusy.current) return;
    seedVisible.current = false; seedRetries.current = 0;
    if (seedTimer.current) clearTimeout(seedTimer.current);
    setListMount(value => value + 1);
    setStage('select'); setError(null); setNotice(null);
  };
  const perform = async (action: 'copy' | 'save' | 'share') => {
    if (!current() || actionBusy.current) return;
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    const actual = imageRef.current;
    if (format === 'image' && (!actual || actual !== image || imageDocument.current !== payload.document || generating || payload.error)) return;
    if (format === 'text' && textPayload.error) return;
    actionBusy.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      // Recheck immediately before crossing a platform boundary; native epoch also fences queued work.
      if (!current()) return;
      if (format === 'text') {
        if (action === 'copy') await platform.copyText(textPayload.text);
        else await platform.share(textPayload.text);
      } else if (action === 'save') await conversationShare.save(actual!.id);
      else await conversationShare.share(actual!.id);
      if (current() && action !== 'share') setNotice(action === 'copy' ? '文字已复制' : '长图已保存到相册');
    } catch (failure) {
      if (current()) {
        if (format === 'image' && (failure as { code?: unknown } | null)?.code === 'expired') {
          release(imageRef.current); imageRef.current = null; imageDocument.current = null; setImage(null);
        }
        setError(errorText(failure));
      }
    }
    finally { actionBusy.current = false; if (current()) setBusy(false); }
  };
  const listItem = ({ item }: { item: ShareCandidate }) => <SelectionRow message={item}
    checked={selected.includes(item.id)} onPress={() => toggle(item.id)} />;
  const cancelSeedScroll = () => { if (currentListKey.current !== listKey) return; seedVisible.current = true; if (seedTimer.current) clearTimeout(seedTimer.current); };
  const failedSeedScroll = (event: { averageItemLength: number; index: number }) => {
    if (!current() || currentListKey.current !== listKey || seedVisible.current) return;
    listRef.current?.scrollToOffset({ offset: event.averageItemLength * event.index, animated: false });
    if (seedRetries.current++ < 4) {
      if (seedTimer.current) clearTimeout(seedTimer.current);
      seedTimer.current = setTimeout(() => {
        if (current() && currentListKey.current === listKey && !seedVisible.current) listRef.current?.scrollToIndex({ index: seedIndex, animated: false, viewPosition: 0.25 });
      }, 120);
    }
  };
  const canExport = !sourceError && (format === 'text' ? !textPayload.error : !!image && imageDocument.current === payload.document && !generating && !payload.error);
  const displayedError = sourceError || error || (stage === 'preview' ? (format === 'text' ? textPayload.error : payload.error) : null);
  const availableWidth = imageWidth || Math.max(1, width - 40);
  return <Modal visible animationType="slide" onRequestClose={() => stage === 'preview' ? back() : close()}>
    <View style={css.root} testID="conversation-share-sheet" accessibilityViewIsModal>
      <AmbientBackground />
      <View style={css.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={stage === 'select' ? '取消分享' : '返回消息选择'}
          onPress={stage === 'select' ? close : back} style={css.headerButton} disabled={busy}>
          {stage === 'preview' && <Icon name="back" size={19} color="#5967bc" />}
          <Text style={css.headerAction}>{stage === 'select' ? '取消' : '返回'}</Text>
        </Pressable>
        <Text style={css.title}>{stage === 'select' ? '选择对话' : '分享预览'}</Text>
        {stage === 'select' ? <Pressable accessibilityRole="button"
          accessibilityLabel={allSelected ? '取消全选消息' : hasOlder ? '全选已加载消息' : '全选消息'}
          accessibilityState={{ disabled: busy }} disabled={busy}
          onPress={() => { if (current() && !actionBusy.current) { setSelected(allSelected ? [] : candidates.map(item => item.id)); setError(null); setNotice(null); } }}
          style={[css.headerButton, css.headerEnd]}><Text style={css.headerAction}>{allSelected ? '取消全选' : hasOlder ? '全选已加载' : '全选'}</Text></Pressable> : <View style={css.headerButton} />}
      </View>
      {stage === 'select' ? <>
        <View style={css.hintRow}><Text style={css.hint}>点选消息，按原顺序分享</Text>
          <Text style={css.hint}>{hasOlder ? '当前已加载的对话' : '原文件不会附带'}</Text></View>
        <FlatList key={listKey} ref={listRef} data={candidates} renderItem={listItem} keyExtractor={item => item.id} extraData={selected}
          initialScrollIndex={seedIndex} onScrollToIndexFailed={failedSeedScroll}
          onScrollBeginDrag={cancelSeedScroll}
          onViewableItemsChanged={seedViewability}
          testID="share-message-list" contentContainerStyle={css.list} initialNumToRender={8}
          maxToRenderPerBatch={6} windowSize={5} keyboardShouldPersistTaps="handled" />
      </> : <>
        <View style={css.segments}>
          {(['image', 'text'] as const).map(value => <Pressable key={value} accessibilityRole="button"
            accessibilityLabel={value === 'image' ? '长图预览' : '文字预览'} accessibilityState={{ selected: format === value }}
            disabled={busy} onPress={() => { if (current() && !actionBusy.current) { setFormat(value); setError(null); setNotice(null); } }}
            style={[css.segment, format === value && css.segmentSelected]}><Text style={[css.segmentText, format === value && css.segmentTextSelected]}>{value === 'image' ? '长图' : '文字'}</Text></Pressable>)}
        </View>
        <ScrollView style={css.previewPane} contentContainerStyle={css.previewContent} keyboardShouldPersistTaps="handled">
          {format === 'image' ? <>
            <View style={css.options}>
              <Text style={css.optionLabel}>长图标题</Text>
              <TextInput accessibilityLabel="长图标题" value={title} maxLength={60} editable={!busy}
                onChangeText={value => { if (current() && !actionBusy.current) setTitle(Array.from(value).slice(0, 30).join('')); }}
                placeholder={DEFAULT_SHARE_TITLE} placeholderTextColor="#9098ab" style={css.titleInput} />
              <View style={css.timeOption}><Text style={css.optionLabel}>显示对话时间</Text><Switch accessibilityLabel="显示对话时间"
                value={showTime} disabled={busy} onValueChange={value => { if (current() && !actionBusy.current) setShowTime(value); }}
                trackColor={{ false: '#dce0ed', true: '#8d9adf' }} thumbColor="#ffffff" /></View>
            </View>
            <View style={css.imageFrame} onLayout={event => setImageWidth(Math.max(1, event.nativeEvent.layout.width))}>
              {image ? <Image testID="share-generated-image" source={{ uri: image.uri }} resizeMode="contain"
                onError={() => {
                  if (current() && imageRef.current?.id === image.id) {
                    release(imageRef.current); imageRef.current = null; imageDocument.current = null; setImage(null);
                    setError('长图读取失败，请重新生成。');
                  }
                }}
                accessibilityLabel="选中消息生成的完整长图" style={{ width: '100%', height: availableWidth * image.height / image.width }} /> :
                <View style={css.imagePlaceholder}>{generating ? <><ActivityIndicator color="#5967bc" /><Text style={css.hint}>正在生成长图…</Text></> : <><Icon name="image" color="#9098ab" size={30} /><Text style={css.hint}>长图尚未生成，可改用文字分享</Text>
                  {!payload.error && conversationShare.available && <Pressable accessibilityRole="button" accessibilityLabel="重新生成长图"
                    onPress={() => { if (current() && !actionBusy.current) setImageAttempt(value => value + 1); }} style={css.retry}><Text style={css.headerAction}>重新生成</Text></Pressable>}</>}</View>}
            </View>
          </> : <View style={css.textCard}><Text selectable testID="share-text-preview" style={css.shareText}>{textPayload.text}</Text></View>}
          <Text style={css.previewCount}>已选 {selected.length} 条消息 · 保留原对话顺序</Text>
        </ScrollView>
      </>}
      <View style={css.footer}>
        {displayedError && <Text accessibilityRole="alert" testID="share-error" style={css.error}>{displayedError}</Text>}
        {notice && <Text accessibilityLiveRegion="polite" style={css.notice}>{notice}</Text>}
        {stage === 'select' ? <>
          <View style={css.summary}><Text accessibilityLiveRegion="polite" style={css.summaryCount}>已选 {selected.length} 条消息</Text><Text style={css.hint}>只分享你勾选的内容</Text></View>
          <View style={css.buttons}>
            <Action label="分享文字" icon="copy" onPress={() => preview('text')} disabled={!selected.length} secondary />
            <Action label="分享长图" icon="image" onPress={() => preview('image')} disabled={!selected.length} />
          </View>
        </> : <>
          <View style={css.privacy}><Icon name="shield" size={13} color="#7b8296" /><Text style={css.privacyText}>仅分享所选内容，不生成公开链接</Text></View>
          <View style={css.buttons}>
            <Action label={format === 'image' ? '保存长图' : '复制文字'} icon={format === 'image' ? 'import' : 'copy'}
              onPress={() => { void perform(format === 'image' ? 'save' : 'copy'); }} disabled={busy || !canExport} secondary />
            <Action label={busy ? '正在处理…' : '分享…'} accessibilityLabel="打开系统分享" icon="share"
              onPress={() => { void perform('share'); }} disabled={busy || !canExport} />
          </View>
        </>}
      </View>
    </View>
  </Modal>;
}

function Action({ label, accessibilityLabel, icon, secondary, disabled, onPress }: {
  label: string; accessibilityLabel?: string; icon: Parameters<typeof Icon>[0]['name'];
  secondary?: boolean; disabled?: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || label}
    accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={[css.action, secondary ? css.secondaryAction : css.primaryAction, disabled && css.disabled]}>
    <Icon name={icon} size={18} color={secondary ? '#5967bc' : '#ffffff'} />
    <Text style={[css.actionText, secondary && css.secondaryText]}>{label}</Text>
  </Pressable>;
}

const SelectionRow = React.memo(function SelectionRow({ message, checked, onPress }: {
  message: ShareCandidate; checked: boolean; onPress: () => void;
}) {
  const blocks = useMemo(() => candidateBlocks(message), [message]);
  const text = useMemo(() => blocks.map(blockPlainText).join('\n'), [blocks]);
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }}
    accessibilityLabel={`${message.role === 'user' ? '提问' : '回答'}：${text.slice(0, 100)}`}
    testID={`share-candidate-${message.id}`} onPress={onPress} style={css.selectionRow}>
    <View style={[css.checkbox, checked && css.checkboxSelected]}>{checked && <Icon name="check" size={15} color="#ffffff" />}</View>
    <View style={[css.message, message.role === 'user' ? css.question : css.answer, checked && message.role === 'assistant' && css.answerSelected]}>
      {message.role === 'assistant' && <Text style={css.author}>妥啦</Text>}
      {message.role === 'user' ? <Text numberOfLines={10} style={[css.messageText, css.questionText]}>{text}</Text> :
        <View style={css.safeBody}>{blocks.slice(0, 8).map((block, index) => <SelectionBlock key={index} block={block} />)}</View>}
      {(text.length > 500 || blocks.length > 8) && <Text style={[css.expandedHint, message.role === 'user' && css.questionText]}>完整内容将在分享预览中保留</Text>}
    </View>
  </Pressable>;
});

/** Native non-interactive content only: no link previews, file access, HTML or network requests. */
function SelectionBlock({ block }: { block: ShareBlock }) {
  if (block.type === 'table') {
    if (block.headers.length > 3) return <Text style={css.expandedHint}>表格：{block.headers.length} 列 · {block.rows.length} 行（长图中完整保留）</Text>;
    return <View style={css.selectionTable}>
      {[block.headers, ...block.rows.slice(0, 4)].map((row, index) => <View key={index} style={[css.selectionTableRow, index === 0 && css.selectionTableHead]}>
        {row.map((cell, column) => <Text key={column} numberOfLines={4} style={[css.selectionTableCell, index === 0 && css.selectionTableLabel]}>{cell}</Text>)}
      </View>)}
      {block.rows.length > 4 && <Text style={css.expandedHint}>另有 {block.rows.length - 4} 行，长图中完整保留</Text>}
    </View>;
  }
  return <Text numberOfLines={block.type === 'code' ? 8 : 5}
    style={[css.messageText, block.type === 'code' && css.selectionCode, block.type === 'text' && !!block.heading && css.selectionHeading]}>{block.text}</Text>;
}

const css = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f6fa' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 58, paddingHorizontal: 12 },
  headerButton: { minWidth: 80, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5 },
  headerEnd: { justifyContent: 'flex-end' }, headerAction: { fontSize: 13, color: '#5967bc' },
  title: { flexShrink: 1, fontSize: 18, fontWeight: '600', color: '#303646' },
  hintRow: { paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  hint: { color: '#777e91', fontSize: 11, lineHeight: 19 },
  list: { paddingHorizontal: 16, paddingTop: 3, paddingBottom: 24, gap: 15 },
  selectionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 3, minHeight: 48 },
  checkbox: { width: 23, height: 23, borderRadius: 12, borderWidth: 1.3, borderColor: '#bec6da', backgroundColor: '#ffffff90', alignItems: 'center', justifyContent: 'center', marginTop: 11 },
  checkboxSelected: { backgroundColor: '#5967bc', borderColor: '#5967bc' },
  message: { flex: 1, minWidth: 0, borderRadius: 20, paddingVertical: 14, paddingHorizontal: 15, borderWidth: 1.3, borderColor: 'transparent' },
  question: { backgroundColor: '#446bc7', borderBottomRightRadius: 6, marginLeft: 20 },
  answer: { backgroundColor: '#ffffffb8', borderBottomLeftRadius: 6 }, answerSelected: { backgroundColor: '#ffffff', borderColor: '#9ca9e5' },
  author: { color: '#777e91', fontSize: 11, marginBottom: 6 }, messageText: { color: '#303646', fontSize: 14, lineHeight: 25 }, questionText: { color: '#ffffff' },
  safeBody: { gap: 5 }, selectionHeading: { fontWeight: '600', fontSize: 15 },
  selectionCode: { fontFamily: 'monospace', fontSize: 12, lineHeight: 20, backgroundColor: '#f1f3fa', padding: 10, borderRadius: 9 },
  selectionTable: { marginVertical: 5 }, selectionTableRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e8ebf4' },
  selectionTableHead: { backgroundColor: '#f2f4fa' }, selectionTableCell: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 20, color: '#424959', padding: 6 },
  selectionTableLabel: { color: '#777e91', fontWeight: '500' },
  expandedHint: { fontSize: 11, color: '#777e91', marginTop: 9 },
  footer: { backgroundColor: '#ffffff', paddingHorizontal: 20, paddingTop: 14, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e5e8f2' },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  summaryCount: { fontSize: 15, fontWeight: '600', color: '#303646' }, buttons: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, minWidth: 0, minHeight: 48, borderRadius: 15, paddingHorizontal: 7, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryAction: { backgroundColor: '#5967bc' }, secondaryAction: { backgroundColor: '#f1f3fa' }, actionText: { flexShrink: 1, minWidth: 0, textAlign: 'center', color: '#ffffff', fontSize: 14, fontWeight: '500' },
  secondaryText: { color: '#535d83' }, disabled: { opacity: 0.38 },
  segments: { flexDirection: 'row', alignSelf: 'center', width: 190, padding: 4, borderRadius: 14, backgroundColor: '#e1e7f2', marginBottom: 8 },
  segment: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10 }, segmentSelected: { backgroundColor: '#ffffff' },
  segmentText: { color: '#777e91', fontSize: 13 }, segmentTextSelected: { color: '#303646' },
  previewPane: { flex: 1 }, previewContent: { padding: 20, paddingTop: 8, gap: 16 },
  options: { backgroundColor: '#ffffffc9', borderRadius: 17, padding: 14 }, optionLabel: { fontSize: 12, color: '#657083' },
  titleInput: { color: '#303646', fontSize: 17, fontWeight: '500', paddingHorizontal: 0, paddingVertical: 8 },
  timeOption: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 42 },
  imageFrame: { alignSelf: 'stretch', backgroundColor: '#ffffff', borderRadius: 18, overflow: 'hidden' },
  imagePlaceholder: { minHeight: 270, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 25 },
  retry: { paddingHorizontal: 16, minHeight: 44, justifyContent: 'center', backgroundColor: '#f1f3fa', borderRadius: 13 },
  textCard: { backgroundColor: '#ffffff', borderRadius: 18, padding: 18 }, shareText: { color: '#303646', fontSize: 14, lineHeight: 26 },
  previewCount: { textAlign: 'center', fontSize: 11, color: '#777e91' }, privacy: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginBottom: 13 },
  privacyText: { flexShrink: 1, minWidth: 0, textAlign: 'center', fontSize: 11, color: '#777e91' }, error: { color: '#b45164', fontSize: 13, lineHeight: 22, marginBottom: 12 }, notice: { color: '#49786b', fontSize: 12, marginBottom: 12 },
});
