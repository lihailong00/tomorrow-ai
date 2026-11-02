import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../../app/context';
import { errorMessage, newRequestId } from '../../api/client';
import { platform } from '../../platform/ports';
import { Text } from '../../ui/Text';
import { Button, ErrorNotice, Field, Notice } from '../../ui/components';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { integrationsApi } from './api';
import { connectionGuide } from './connectionGuides';
import type { Integration, MailDraft, MailReceipt } from './types';

export { QQ_MAIL_HELP } from './connectionGuides';
const domains: Record<string, string[]> = {
  qq_mail: ['qq.com', 'foxmail.com'],
  netease163: ['163.com'],
  netease126: ['126.com'],
};

function useMailboxSession() {
  const { api, user } = useApp();
  const scope = useMemo(
    () => ({
      api,
      userId: user?.id,
      active: true,
      controller: new AbortController(),
    }),
    [api, user?.id],
  );
  useEffect(() => {
    scope.active = true;
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    return () => {
      scope.active = false;
      scope.controller.abort();
    };
  }, [scope]);
  return {
    scope,
    client: useMemo(
      () => integrationsApi(api, () => scope.controller.signal),
      [api, scope],
    ),
  };
}

export function MailConnectionForm({
  item,
  onConnected,
}: {
  item: Integration;
  onConnected: () => Promise<void>;
}) {
  const { client, scope } = useMailboxSession();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const guide = connectionGuide(item.id);
  useEffect(() => {
    setEmail('');
    setCode('');
    setVisible(false);
    setError('');
    setBusy(false);
    working.current = false;
  }, [scope, item.id]);
  const normalized = email.trim();
  const codeValue = code.replace(/\s/g, '');
  const domain = normalized.split('@');
  const validEmail =
    domain.length === 2 &&
    domain[0].length > 0 &&
    !/\s/.test(normalized) &&
    domains[item.id]?.includes(domain[1].toLowerCase());
  const validCode =
    /^[a-zA-Z0-9]{8,128}$/.test(codeValue) &&
    (item.id !== 'qq_mail' || codeValue.length === 16);
  const connect = async () => {
    if (working.current || !validEmail || !validCode || !scope.active) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await client.connect(item.id, {
        email: normalized,
        authorization_code: codeValue,
      });
      if (scope.active) {
        setCode('');
        setVisible(false);
        await onConnected();
      }
    } catch (failure) {
      if (scope.active) setError(errorMessage(failure));
    } finally {
      if (scope.active) {
        working.current = false;
        setBusy(false);
        setCode('');
        setVisible(false);
      }
    }
  };
  return (
    <View>
      <Text style={v.instructions}>
        {guide?.before || `请先在 ${item.name}设置中`}
        {guide ? (
          <Text
            accessibilityRole="link"
            accessibilityLabel={guide.linkText}
            accessibilityHint={`在浏览器中打开${item.name}官方设置教程`}
            style={v.link}
            onPress={() => {
              if (!scope.active) return;
              void platform.openUrl(guide.url).catch(failure => {
                if (scope.active) setError(errorMessage(failure));
              });
            }}
          >
            {guide.linkText}
          </Text>
        ) : (
          '开启 IMAP'
        )}
        {guide?.after || '，然后填写完整邮箱地址和客户端授权码。'}
      </Text>
      <TextInput
        accessibilityLabel="邮箱地址"
        value={email}
        onChangeText={setEmail}
        placeholder={
          item.id === 'qq_mail'
            ? 'you@qq.com'
            : item.id === 'netease126'
            ? 'you@126.com'
            : 'you@163.com'
        }
        placeholderTextColor={colors.muted}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        maxLength={254}
        style={v.input}
      />
      <View style={v.codeField}>
        <TextInput
          accessibilityLabel="邮箱客户端授权码"
          value={code}
          onChangeText={setCode}
          placeholder="客户端授权码"
          placeholderTextColor={colors.muted}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          maxLength={160}
          importantForAutofill="noExcludeDescendants"
          style={v.codeInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={visible ? '隐藏授权码' : '显示授权码'}
          onPress={() => setVisible(!visible)}
          style={v.eye}
          disabled={busy}
        >
          <Svg width={23} height={23} viewBox="0 0 24 24" accessible={false}>
            <Path
              d={
                visible
                  ? 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
                  : 'M3 9s3 7 9 7 9-7 9-7M5 13l-2 3m6-1-1 4m7-4 1 4m3-6 2 3'
              }
              stroke={colors.secondary}
              strokeWidth={1.6}
              strokeLinecap="round"
              fill="none"
            />
          </Svg>
        </Pressable>
      </View>
      <Text style={v.caption}>授权码会加密保存，保存后不再显示。</Text>
      <ErrorNotice message={error} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="验证并连接"
        disabled={!validEmail || !validCode || busy}
        accessibilityState={{
          disabled: !validEmail || !validCode || busy,
          busy,
        }}
        onPress={() => {
          void connect();
        }}
        style={[v.connect, (!validEmail || !validCode || busy) && v.disabled]}
      >
        {busy ? <ActivityIndicator color={colors.action} /> : null}
        <Text
          style={[v.connectText, (!validEmail || !validCode) && v.disabledText]}
        >
          {busy ? '正在验证收发信服务…' : '验证并连接'}
        </Text>
      </Pressable>
    </View>
  );
}

export function MailConnectionSheet({
  item,
  onClose,
  onConnected,
}: {
  item: Integration | null;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  return (
    <Modal
      visible={!!item}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={v.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭邮箱连接"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={v.sheet} accessibilityViewIsModal>
          <View style={v.handle} />
          <View style={v.heading}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭邮箱连接弹层"
              onPress={onClose}
              style={v.close}
            >
              <Icon name="close" size={23} />
            </Pressable>
            <Text style={v.title}>连接 {item?.name}</Text>
            <View style={v.closeSpace} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={v.sheetBody}
          >
            {item ? (
              <MailConnectionForm
                key={item.id}
                item={item}
                onConnected={onConnected}
              />
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function MailComposer({ item }: { item: Integration }) {
  const { client, scope } = useMailboxSession();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [receipt, setReceipt] = useState<MailReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  useEffect(() => {
    setOpen(false);
    setTo('');
    setSubject('');
    setBody('');
    setDraft(null);
    setAttempted(false);
    setReceipt(null);
    setBusy(false);
    setError('');
    working.current = false;
  }, [scope, item.id]);
  const valid =
    /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to.trim()) &&
    !!subject.trim() &&
    !!body.trim() &&
    !/[\r\n]/.test(subject);
  const send = async () => {
    if (!draft || working.current || !scope.active) return;
    working.current = true;
    setBusy(true);
    setError('');
    setAttempted(true);
    try {
      const value = await client.sendMail(item.id, draft);
      if (scope.active) setReceipt(value);
    } catch (failure) {
      if (scope.active) setError(errorMessage(failure));
    } finally {
      if (scope.active) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  if (!open)
    return (
      <Button variant="secondary" onPress={() => setOpen(true)}>
        写邮件
      </Button>
    );
  return (
    <View style={v.composer}>
      <Text style={v.composerTitle}>{draft ? '确认这封邮件' : '写邮件'}</Text>
      {draft ? (
        <>
          <Text selectable style={v.preview}>
            收件人：{draft.to}
            {'\n'}主题：{draft.subject}
          </Text>
          <Text selectable style={v.previewBody}>
            {draft.body}
          </Text>
          <Text style={v.caption}>将通过已连接的{item.name}发送。</Text>
        </>
      ) : (
        <>
          <Field
            label="收件人"
            value={to}
            onChangeText={setTo}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={254}
            placeholder="填写完整邮箱地址"
          />
          <Field
            label="邮件主题"
            value={subject}
            onChangeText={setSubject}
            maxLength={150}
          />
          <Field
            label="邮件正文"
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={16000}
            placeholder="写下你要发送的内容"
          />
        </>
      )}
      <ErrorNotice message={error} />
      {receipt ? <Notice>{receipt.detail}</Notice> : null}
      {attempted &&
      receipt?.status !== 'sent' &&
      receipt?.status !== 'failed' ? (
        <Text style={v.caption}>
          发送结果未确认时，请先检查邮箱。检查状态会复用同一个请求，不会重复投递。
        </Text>
      ) : null}
      {!draft ? (
        <Button
          disabled={!valid}
          onPress={() => {
            setDraft({
              client_request_id: newRequestId(),
              to: to.trim(),
              subject: subject.trim(),
              body,
            });
          }}
        >
          预览邮件
        </Button>
      ) : receipt?.status !== 'sent' && receipt?.status !== 'failed' ? (
        <Button
          loading={busy}
          onPress={() => {
            void send();
          }}
        >
          {attempted ? '检查发送状态' : '确认发送'}
        </Button>
      ) : null}
      {draft && (!attempted || receipt?.status === 'failed') ? (
        <Button
          variant="ghost"
          onPress={() => {
            setDraft(null);
            setAttempted(false);
            setReceipt(null);
            setError('');
          }}
        >
          继续编辑
        </Button>
      ) : null}
      {attempted && receipt?.status !== 'sent' ? (
        <Button variant="ghost" disabled={busy} onPress={() => setOpen(false)}>
          收起邮件
        </Button>
      ) : null}
      {!attempted || receipt?.status === 'sent' ? (
        <Button
          variant="ghost"
          onPress={() => {
            setOpen(false);
            setTo('');
            setSubject('');
            setBody('');
            setDraft(null);
            setAttempted(false);
            setReceipt(null);
            setError('');
          }}
        >
          {receipt?.status === 'sent' ? '完成' : '取消写信'}
        </Button>
      ) : null}
    </View>
  );
}

const v = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(28,44,60,0.50)',
  },
  sheet: {
    backgroundColor: '#FAFBFE',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    maxHeight: '88%',
  },
  handle: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#CED2D9',
    alignSelf: 'center',
    marginTop: 8,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 18,
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ECEEF2',
  },
  closeSpace: { width: 44 },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 21,
    fontWeight: '600',
    color: colors.ink,
  },
  sheetBody: { paddingHorizontal: 26, paddingBottom: 36 },
  instructions: {
    fontSize: 16,
    lineHeight: 27,
    color: colors.secondary,
    marginBottom: 20,
  },
  link: { color: '#36A7CB', textDecorationLine: 'underline' },
  input: {
    backgroundColor: '#EEF0F3',
    color: colors.ink,
    borderRadius: 19,
    fontSize: 17,
    paddingHorizontal: 18,
    minHeight: 60,
    paddingVertical: 17,
    marginBottom: 16,
  },
  codeField: {
    backgroundColor: '#EEF0F3',
    borderRadius: 19,
    flexDirection: 'row',
    alignItems: 'center',
  },
  codeInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 60,
    paddingHorizontal: 18,
    paddingVertical: 17,
    fontSize: 17,
    color: colors.ink,
  },
  eye: {
    minWidth: 52,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 8,
  },
  caption: {
    fontSize: 13,
    lineHeight: 22,
    color: colors.secondary,
    marginTop: 12,
    marginBottom: 14,
  },
  connect: {
    marginTop: 12,
    minHeight: 52,
    padding: 14,
    borderRadius: 28,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.action,
  },
  connectText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  disabled: { backgroundColor: '#ECEEF2' },
  disabledText: { color: '#A8ADB7' },
  composer: {
    backgroundColor: '#F6F8FD',
    borderRadius: 22,
    padding: 18,
    marginTop: 14,
  },
  composerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.ink,
    marginBottom: 12,
  },
  preview: { color: colors.ink, fontSize: 15, lineHeight: 26 },
  previewBody: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 25,
    marginTop: 14,
  },
});
