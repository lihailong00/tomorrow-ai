import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useAction, useApp } from '../app/context';
import { newRequestId } from '../api/client';
import { Text } from './Text';

/** Saving a reply is explicit and editable; opening this sheet never saves it. */
export function ChatReplyMemory({ content, onClose }: { content: string; onClose: () => void }) {
  const { api, invalidate } = useApp();
  const [draft, setDraft] = useState(content);
  const action = useAction();
  const request = useRef({ content: '', id: newRequestId() });
  const save = () => action.run(async ({ isCurrent }) => {
    const text = draft.trim();
    if (!text || text.length > 10000) return;
    if (request.current.content !== text) request.current = { content: text, id: newRequestId() };
    await api.saveMemory({ content: text, title: Array.from(text).slice(0, 40).join(''), kind: 'fact',
      source: '用户从 AI 回复中主动保存', client_request_id: request.current.id });
    if (!isCurrent()) return;
    invalidate(); onClose();
  });
  return <Modal transparent visible animationType="slide" onRequestClose={() => { if (!action.busy) onClose(); }}>
    <View style={css.layer}><View style={css.sheet} accessibilityViewIsModal>
      <View style={css.header}><Text style={css.title}>保存到记忆</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="取消保存回复" disabled={action.busy}
          onPress={onClose} style={css.button}><Text style={css.link}>取消</Text></Pressable>
      </View>
      <Text style={css.hint}>确认并编辑想长期保留的内容。保存后，它会用于后续回答。</Text>
      <ScrollView keyboardShouldPersistTaps="handled" style={css.scroll}>
        <TextInput accessibilityLabel="要保存的回复内容" value={draft} onChangeText={setDraft}
          editable={!action.busy} multiline textAlignVertical="top" style={css.input} />
      </ScrollView>
      {draft.trim().length > 10000 && <Text accessibilityRole="alert" style={css.error}>内容较长，请精简到 10000 字以内再保存。</Text>}
      {action.error && <Text accessibilityRole="alert" style={css.error}>{action.error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="确认保存回复到记忆"
        disabled={action.busy || !draft.trim() || draft.trim().length > 10000} onPress={() => { void save(); }}
        style={[css.save, (action.busy || !draft.trim() || draft.trim().length > 10000) && css.disabled]}>
        <Text style={css.saveText}>{action.busy ? '正在保存…' : '确认保存'}</Text>
      </Pressable>
    </View></View>
  </Modal>;
}

const css = StyleSheet.create({
  layer: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(24,31,55,0.20)' },
  sheet: { backgroundColor: '#f7f8fc', borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 32, maxHeight: '82%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: '#292f42' }, button: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  link: { color: '#5665be', fontSize: 14 }, hint: { color: '#606b80', fontSize: 13, lineHeight: 22, marginVertical: 12 },
  scroll: { flexGrow: 0 }, input: { minHeight: 140, backgroundColor: '#fff', borderRadius: 16, padding: 14, color: '#292f42', fontSize: 16, lineHeight: 26 },
  error: { color: '#c84c63', fontSize: 13, lineHeight: 22, marginTop: 10 }, save: { backgroundColor: '#5665be', borderRadius: 24, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  saveText: { color: '#fff', fontSize: 15 }, disabled: { opacity: 0.4 },
});
