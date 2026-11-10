import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Text } from '../../ui/Text';
import { inspectInstance } from '../../api/instance';
import { useAction, useApp } from '../../app/context';
import { connectionFromLink, InstanceManifest, instanceServerUrl } from '../../domain/instance';
import { defaultServerUrl } from '../../platform/ports';
import { Button, Card, ErrorNotice, Field, Notice } from '../../ui/components';
import { colors, styles as s } from '../../ui/theme';

export function InstanceConnectionCard() {
  const { preferences, savePreferences, user } = useApp();
  const [custom, setCustom] = useState(preferences.serverUrl !== defaultServerUrl);
  const [input, setInput] = useState(preferences.serverUrl);
  const [allowLan, setAllowLan] = useState(preferences.allowInsecureLan === true);
  const [expectedId, setExpectedId] = useState<string>();
  const [checked, setChecked] = useState<{ serverUrl: string; instance: InstanceManifest }>();
  const [notice, setNotice] = useState('');
  const [showDataflow, setShowDataflow] = useState(false);
  const action = useAction();
  useEffect(() => {
    const proposal = preferences.pendingConnection;
    if (!proposal) return;
    setCustom(true); setInput(proposal.url); setExpectedId(proposal.instanceId);
    setChecked(undefined); setNotice('连接链接已读取。请检查服务器身份与处理方式，再确认连接。');
  }, [preferences.pendingConnection]);
  const reset = () => { setChecked(undefined); setExpectedId(undefined); setNotice(''); action.setError(null); };
  const target = () => {
    if (!custom) return { url: defaultServerUrl, instanceId: undefined };
    if (input.trim().startsWith('tada:')) return connectionFromLink(input.trim());
    return { url: input, instanceId: expectedId };
  };
  const inspect = async () => {
    const proposal = target();
    const result = await inspectInstance(proposal.url, { allowInsecureLan: allowLan, expectedId: proposal.instanceId });
    setChecked(result);
    setShowDataflow(false);
    setNotice('');
    return result;
  };
  const manifest = checked?.instance ?? preferences.instance;
  const dataflowToggle = manifest && <Pressable accessibilityRole="button" accessibilityLabel={showDataflow ? '收起数据去向' : '查看数据去向'} accessibilityState={{ expanded: showDataflow }}
    onPress={() => setShowDataflow(value => !value)} style={layout.link}>
    <Text style={layout.linkText}>{showDataflow ? '收起数据去向' : '查看数据去向'}</Text>
  </Pressable>;
  const dataflow = showDataflow && manifest && <View style={layout.summary}>
      <Text selectable style={s.small}>服务器身份：{manifest.id}</Text>
      <Text style={s.small}>对话：{manifest.dataflow.conversation}</Text>
      <Text style={s.small}>语音：{manifest.dataflow.voice}</Text>
      <Text style={s.small}>图片：{manifest.dataflow.images}</Text>
      <Text style={s.small}>文字向量：{manifest.dataflow.embeddings ?? '服务器未提供处理去向'}</Text>
      <Text style={s.small}>文件：{manifest.dataflow.files}</Text>
  </View>;
  if (checked) return <Card>
    <Text accessibilityRole="header" style={s.cardTitle}>确认连接服务器</Text>
    <View style={[layout.summary, s.topGap]}>
      <Text style={s.small}>服务器身份已验证</Text>
      <Text style={s.cardTitle}>{checked.instance.name}</Text>
      <Text selectable style={s.small}>{checked.serverUrl}</Text>
    </View>
    <Text style={[s.small, s.topGap]}>对话和文件由这台服务器处理。使用外部模型时，相关内容也会发给该服务器配置的服务商。</Text>
    {checked.serverUrl.startsWith('http:') && <Text style={s.small}>当前使用未加密的 HTTP，仅适用于受信任的私有网络。</Text>}
    {user && <Text style={[s.small, s.topGap]}>切换后需要重新登录。当前上传会停止，相册与手机应用资料导入需要重新授权。</Text>}
    <View style={s.topGap}>
      <Button loading={action.busy} onPress={() => action.run(async () => {
        const proposal = target();
        if (instanceServerUrl(proposal.url, allowLan) !== checked.serverUrl) throw new Error('地址已变化，请重新检查。');
        if (proposal.instanceId && proposal.instanceId !== checked.instance.id) throw new Error('连接链接的服务器身份已变化，请重新检查。');
        // Recheck the pinned identity immediately before saving.
        const latest = await inspectInstance(checked.serverUrl, { allowInsecureLan: allowLan, expectedId: checked.instance.id });
        await savePreferences({ ...preferences, serverUrl: latest.serverUrl, instance: latest.instance,
          serverUrlCustomized: custom, allowInsecureLan: allowLan, connectionError: undefined, pendingConnection: undefined });
        setChecked(undefined);
        setNotice('服务连接已保存。请使用这台服务器的账号登录。');
      })}>连接这台服务器</Button>
    </View>
    <View style={[s.row, s.gap]}>
      {dataflowToggle}
      <Pressable accessibilityRole="button" style={layout.link} disabled={action.busy}
        onPress={() => { setChecked(undefined); action.setError(null); }}><Text style={layout.linkText}>返回修改</Text></Pressable>
    </View>
    {dataflow}
    <ErrorNotice message={action.error} />
    {notice ? <Notice>{notice}</Notice> : null}
  </Card>;
  return <Card>
    <Text style={s.cardTitle}>选择你的服务</Text>
    <Text style={[s.small, { marginVertical: 8 }]}>官方服务开箱即用。自建服务使用你自己的账号、存储和 API 配置。</Text>
    <View style={[s.row, s.gap]}>
      <View style={s.fill}><Button variant={custom ? 'secondary' : 'primary'} disabled={action.busy}
        onPress={() => { setCustom(false); reset(); }}>官方服务</Button></View>
      <View style={s.fill}><Button variant={custom ? 'primary' : 'secondary'} disabled={action.busy}
        onPress={() => { setCustom(true); reset(); }}>自己的服务器</Button></View>
    </View>
    {custom ? <>
      <Field label="服务器地址或连接链接" placeholder="https://tada.example.com"
        value={input} onChangeText={value => { setInput(value); reset(); }}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!action.busy} maxLength={3000} />
      <Text style={s.small}>可用系统相机扫描后台二维码，也可粘贴后台提供的连接链接。</Text>
      <View style={[s.row, { justifyContent: 'space-between', marginTop: 14 }]}>
        <Text style={[s.small, s.fill]}>高级：允许局域网 HTTP</Text>
        <Switch accessibilityLabel="允许局域网 HTTP" value={allowLan} disabled={action.busy}
          onValueChange={value => { setAllowLan(value); reset(); }} />
      </View>
      {allowLan && <Notice>仅限受信任的私有网络。HTTP 未加密，相册后台分析仍要求 HTTPS。</Notice>}
    </> : <Text selectable style={[s.small, s.topGap]}>{defaultServerUrl}</Text>}
    {preferences.connectionError ? <Notice>{preferences.connectionError}</Notice> : null}
    <View style={s.topGap}><Button variant="secondary" loading={action.busy}
      onPress={() => action.run(async () => { await inspect(); })}>检查服务器</Button></View>
    {dataflowToggle}
    {dataflow}
    <Text style={[s.small, s.topGap]}>当前地址</Text>
    <Text selectable style={s.small}>{preferences.serverUrl || '尚未选择'}</Text>
    <ErrorNotice message={action.error} />
    {notice ? <Notice>{notice}</Notice> : null}
  </Card>;
}

const layout = StyleSheet.create({
  summary: { backgroundColor: colors.blueLight, borderRadius: 16, padding: 14, gap: 4 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  linkText: { color: colors.action, fontSize: 14, fontWeight: '500' },
});
