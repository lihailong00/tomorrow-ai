import React, { useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '../../ui/Text';
import { useAction, useApp } from '../../app/context';
import { validatePassword } from '../../domain/password';
import { Button, ErrorNotice, Field, Notice, Section } from '../../ui/components';
import { styles as s } from '../../ui/theme';
import { AssistantOrb } from '../../ui/visuals';

export function EmailAuthScreen({ expired, notice, onSwitchMethod }: {
  expired: boolean; notice?: string; onSwitchMethod?: () => void;
}) {
  const { api, preferences, signIn, navigate } = useApp();
  const instance = preferences.instance!;
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [invite, setInvite] = useState('');
  const [recovery, setRecovery] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  React.useEffect(() => () => { mounted.current = false; }, []);
  const action = useAction();
  const submit = () => {
    if (pending.current) return Promise.resolve();
    pending.current = true;
    return action.run(async () => {
      const address = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) throw new Error('请输入有效的邮箱地址。');
      validatePassword(password);
      if (registering && password !== confirmation) throw new Error('两次输入的密码不一致。');
      if (registering && instance.registration_policy === 'closed') throw new Error('当前服务器未开放注册，请联系管理员。');
      if (registering && instance.registration_policy === 'invite_only' && !invite.trim()) throw new Error('请输入管理员提供的邀请码。');
      const session = registering
        ? await api.register(address, password, name, 'Asia/Shanghai', invite || undefined)
        : await api.login(address, password);
      if (mounted.current) await signIn(session);
    }).finally(() => { pending.current = false; });
  };
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
    <View style={{ alignItems: 'center', paddingVertical: 18 }}><AssistantOrb size={62} /></View>
    <Text style={[s.title, { textAlign: 'center' }]}>{registering ? '创建你的账号' : '邮箱密码登录'}</Text>
    <Text style={[s.subtitle, { textAlign: 'center' }]}>{instance.name}</Text>
    {onSwitchMethod && <Button variant="ghost" disabled={action.busy}
      onPress={() => { if (!pending.current) onSwitchMethod(); }}>使用手机号密码登录</Button>}
    {expired && <Notice>登录已失效，请重新登录。</Notice>}
    {notice ? <Notice>{notice}</Notice> : null}
    {registering && <Field label="怎么称呼你" value={name} onChangeText={setName} editable={!action.busy} maxLength={80} />}
    <Field label="邮箱" placeholder="you@example.com" value={email} onChangeText={setEmail}
      keyboardType="email-address" autoComplete="email" autoCapitalize="none" autoCorrect={false} maxLength={254} editable={!action.busy} />
    <Field label="密码" placeholder={registering ? '设置 8–128 个字符的密码' : '请输入密码'}
      value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false}
      autoComplete={registering ? 'new-password' : 'current-password'} maxLength={256} editable={!action.busy} />
    {registering && <Field label="确认密码" value={confirmation} onChangeText={setConfirmation}
      secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={256} editable={!action.busy} />}
    {registering && instance.registration_policy === 'invite_only' && <Field label="邀请码"
      value={invite} onChangeText={setInvite} autoCapitalize="none" autoCorrect={false} maxLength={256} editable={!action.busy} />}
    <ErrorNotice message={action.error} />
    <View style={s.topGap}><Button loading={action.busy} onPress={submit}>{registering ? '创建账号' : '登录'}</Button></View>
    {instance.registration_policy !== 'closed' && <Button variant="ghost" disabled={action.busy}
      onPress={() => { setRegistering(!registering); setPassword(''); setConfirmation(''); setRecovery(false); action.setError(null); }}>
      {registering ? '返回登录' : '创建账号'}</Button>}
    {instance.registration_policy === 'closed' && <Notice>当前服务器由管理员创建账号，请联系管理员获取账号。</Notice>}
    {!registering && <Button variant="ghost" onPress={() => setRecovery(true)}>忘记密码</Button>}
    {recovery && <Notice>请联系这台服务器的管理员重置账号密码。此登录方式无需短信验证码。</Notice>}
    <Section title="服务连接" action="更换服务器" onAction={() => navigate({ name: 'settings' })} />
    <Text selectable style={s.small}>{preferences.serverUrl}</Text>
    <Text style={[s.small, s.topGap]}>账号和资料仅属于当前服务器。更换服务后需要重新登录。</Text>
  </ScrollView>;
}
