import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { Text } from '../ui/Text';
import { ApiError } from '../api/client';
import { useAction, useApp } from '../app/context';
import { defaultServerUrl, platform } from '../platform/ports';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Notice,
  Section,
} from '../ui/components';
import { colors, styles as s } from '../ui/theme';
import { AssistantOrb, Icon } from '../ui/visuals';
import { normalizePhoneNumber } from '../domain/phone';
import { validatePassword } from '../domain/password';
import { PhotoIndexSettings } from '../features/photo-index/PhotoIndexSettings';
import { EmailAuthScreen } from '../features/instances/EmailAuthScreen';
import { InstanceConnectionCard } from '../features/instances/InstanceConnectionCard';
import { version as appVersion } from '../../package.json';

export function IntroScreen({
  onContinue,
}: {
  onContinue: () => Promise<void>;
}) {
  const action = useAction();
  return (
    <ScrollView contentContainerStyle={[s.content, { paddingTop: 20 }]}>
      <View
        style={{
          height: 218,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 4,
        }}
      >
        <View
          style={{
            position: 'absolute',
            width: 208,
            height: 208,
            borderRadius: 104,
            backgroundColor: '#EBEEFA',
            opacity: 0.65,
          }}
        />
        <View
          style={{
            position: 'absolute',
            width: 156,
            height: 156,
            borderRadius: 78,
            backgroundColor: '#F4EDEB',
            right: 28,
            bottom: 8,
            opacity: 0.65,
          }}
        />
        <AssistantOrb size={112} />
      </View>
      <Text
        style={[
          s.title,
          {
            fontSize: 29,
            lineHeight: 40,
            fontWeight: '400',
            textAlign: 'center',
          },
        ]}
      >
        你好，我是妥啦
      </Text>
      <Text
        style={[
          s.subtitle,
          { textAlign: 'center', marginTop: 9, marginBottom: 28 },
        ]}
      >
        了解你的日常，帮你把事情继续做好。
      </Text>
      {[
        {
          icon: 'today' as const,
          title: '理清今天',
          body: '把任务与值得关注的事，整理在一起。',
          tint: '#EAF1FF',
        },
        {
          icon: 'memory' as const,
          title: '记住你的偏好',
          body: '记忆可查看、修改，也能随时删除。',
          tint: '#EEEAFE',
        },
        {
          icon: 'tasks' as const,
          title: '让事情有进展',
          body: '交代任务、设置计划，回来查看成果。',
          tint: '#FFF0E8',
        },
      ].map(({ icon, title, body, tint }) => (
        <View key={title} style={[s.row, { gap: 14, marginBottom: 22 }]}>
          <View
            style={{
              width: 42,
              height: 42,
              borderRadius: 14,
              backgroundColor: tint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={20} color="#6F88BD" />
          </View>
          <View style={s.fill}>
            <Text style={[s.cardTitle, { fontSize: 14, fontWeight: '500' }]}>
              {title}
            </Text>
            <Text style={s.small}>{body}</Text>
          </View>
        </View>
      ))}
      <ErrorNotice message={action.error} />
      <Button loading={action.busy} onPress={() => action.run(onContinue)}>
        开始使用
      </Button>
      <Text style={[s.small, { textAlign: 'center', marginTop: 15 }]}>
        你的记忆与资料，由你掌控
      </Text>
    </ScrollView>
  );
}

export function AuthScreen(props: { expired: boolean; notice?: string }) {
  const { preferences, navigate } = useApp();
  const instance = preferences.instance;
  if (preferences.connectionError ||
      (preferences.serverUrl !== defaultServerUrl && !instance)) {
    return <ScrollView contentContainerStyle={s.content}>
      <Text style={s.title}>确认服务器连接</Text>
      <Notice>{preferences.connectionError || '请先检查服务器身份，再使用这台服务器的账号登录。'}</Notice>
      <Button onPress={() => navigate({ name: 'settings' })}>选择服务器</Button>
    </ScrollView>;
  }
  const emailSupported = instance?.auth_methods.includes('email_password') === true;
  const phoneSupported = !instance || instance.auth_methods.includes('phone_password');
  // A connection or capability change must discard credentials and method state.
  const connectionKey = JSON.stringify([preferences.serverUrl, instance?.id, instance?.auth_methods]);
  return <PasswordAuthScreen key={connectionKey} {...props} emailSupported={emailSupported}
    phoneSupported={phoneSupported} preferEmail={instance?.deployment_mode === 'self_hosted'} />;
}

function PasswordAuthScreen({ emailSupported, phoneSupported, preferEmail, ...props }: {
  expired: boolean; notice?: string; emailSupported: boolean; phoneSupported: boolean; preferEmail: boolean;
}) {
  const [method, setMethod] = useState<'email' | 'phone'>(emailSupported && (preferEmail || !phoneSupported) ? 'email' : 'phone');
  if (method === 'email') {
    return <EmailAuthScreen {...props} onSwitchMethod={phoneSupported ? () => setMethod('phone') : undefined} />;
  }
  return <PhoneAuthScreen {...props} onSwitchMethod={emailSupported ? () => setMethod('email') : undefined} />;
}

function PhoneAuthScreen({
  expired,
  notice,
  onSwitchMethod,
}: {
  expired: boolean;
  notice?: string;
  onSwitchMethod?: () => void;
}) {
  const { api, signIn, navigate, preferences } = useApp();
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [codeNotice, setCodeNotice] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const [connected, setConnected] = useState(false);
  const pending = useRef(false);
  const action = useAction();
  const connection = useAction();
  const verification = useAction();
  useEffect(() => {
    if (retryAfter <= 0) {
      return;
    }
    const timer = setTimeout(
      () => setRetryAfter(value => Math.max(0, value - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [retryAfter]);
  const busy = action.busy || verification.busy;
  const registering = mode === 'register';
  const resetting = mode === 'reset';
  const needsCode = mode !== 'login';
  let smsRecipient = '';
  try {
    const national = normalizePhoneNumber(phone).slice(3);
    smsRecipient = `${national.slice(0, 3)}****${national.slice(-4)}`;
  } catch { /* The phone field may still be incomplete. */ }
  const registrationOpen = !preferences.instance || preferences.instance.registration_policy === 'open';
  const resetCode = () => {
    setCode('');
    setChallengeId('');
    setCodeNotice('');
    setRetryAfter(0);
  };
  const changeMode = (next: typeof mode) => {
    if (pending.current) {
      return;
    }
    setMode(next);
    resetCode();
    setPassword('');
    setConfirmation('');
    setAuthNotice('');
    action.setError(null);
    verification.setError(null);
  };
  const getCode = () => {
    if (pending.current || retryAfter > 0 || !needsCode) {
      return Promise.resolve();
    }
    pending.current = true;
    return verification
      .run(async () => {
        normalizePhoneNumber(phone);
        setAuthNotice('');
        try {
          const challenge = await api.requestPhoneCode(
            phone,
            registering ? 'register' : 'reset_password',
          );
          setChallengeId(challenge.challenge_id);
          setRetryAfter(challenge.retry_after);
          setCodeNotice(
            challenge.test_mode
              ? '测试验证码：123456，有效期 5 分钟。'
              : `验证码已发送至 ${smsRecipient}，请查看该手机号的短信。`,
          );
        } catch (error) {
          if (error instanceof ApiError && error.retryAfterSeconds) {
            setRetryAfter(error.retryAfterSeconds);
          }
          throw error;
        }
      })
      .finally(() => {
        pending.current = false;
      });
  };
  const submit = () => {
    if (pending.current) {
      return Promise.resolve();
    }
    pending.current = true;
    return action
      .run(async () => {
        normalizePhoneNumber(phone);
        validatePassword(password);
        if (!needsCode) {
          await signIn(await api.loginWithPhone(phone, password));
          return;
        }
        if (password !== confirmation) {
          throw new Error('两次输入的密码不一致。');
        }
        if (!challengeId) {
          throw new Error('请先获取验证码。');
        }
        if (!/^[0-9]{6}$/.test(code)) {
          throw new Error('请输入 6 位验证码。');
        }
        if (resetting) {
          await api.resetPhonePassword(phone, code, challengeId, password);
          setMode('login');
          resetCode();
          setPassword('');
          setConfirmation('');
          verification.setError(null);
          setAuthNotice('密码已重置，请使用新密码登录。');
          return;
        }
        await signIn(
          await api.registerWithPhone(phone, code, challengeId, password, name),
        );
      })
      .finally(() => {
        pending.current = false;
      });
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[s.content, { paddingTop: 18 }]}
    >
      <View style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 18 }}>
        <AssistantOrb size={62} />
      </View>
      <Text style={[s.title, { textAlign: 'center', fontWeight: '400' }]}>
        {registering ? '创建你的账号' : resetting ? '重置密码' : '手机号密码登录'}
      </Text>
      <Text style={[s.subtitle, { textAlign: 'center', marginBottom: 6 }]}>
        {registering
          ? '保存你的对话、记忆与任务。'
          : resetting
          ? '验证手机号，为账号设置新密码。'
          : '登录后，接着上次的想法继续。'}
      </Text>
      {onSwitchMethod && <Button variant="ghost" disabled={busy}
        onPress={() => { if (!pending.current) onSwitchMethod(); }}>使用邮箱密码登录</Button>}
      {expired && (
        <Notice>登录已失效，请重新登录。已保存的任务与记忆仍在服务端。</Notice>
      )}
      {notice ? <Notice>{notice}</Notice> : null}
      {authNotice ? <Notice>{authNotice}</Notice> : null}
      <View
        style={{
          flexDirection: 'row',
          gap: 4,
          marginTop: 25,
          marginBottom: 10,
          backgroundColor: '#EDEFF6',
          borderRadius: 24,
          padding: 4,
        }}
      >
        {(registrationOpen ? ['登录', '创建账号'] : ['登录']).map((label, i) => (
          <Pressable
            key={label}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{
              selected: !resetting && registering === Boolean(i),
              disabled: busy,
            }}
            disabled={busy}
            onPress={() => changeMode(i ? 'register' : 'login')}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: 9,
              paddingHorizontal: 18,
              borderRadius: 20,
              backgroundColor:
                !resetting && registering === Boolean(i)
                  ? colors.surface
                  : 'transparent',
            }}
          >
            <Text
              style={[
                s.body,
                {
                  fontWeight: '500',
                  color:
                    !resetting && registering === Boolean(i)
                      ? colors.ink
                      : colors.secondary,
                },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {!registrationOpen && <Notice>当前服务器未开放手机号自助注册，请联系管理员创建账号。</Notice>}
      {registering && (
        <Field
          label="怎么称呼你"
          placeholder="你的名字（可选）"
          value={name}
          onChangeText={setName}
          maxLength={80}
          autoComplete="name"
          editable={!busy}
        />
      )}
      <Field
        label="手机号 · +86"
        placeholder="请输入 11 位手机号"
        value={phone}
        onChangeText={value => {
          if (pending.current) {
            return;
          }
          setPhone(value);
          resetCode();
          setPassword('');
          setConfirmation('');
          setAuthNotice('');
          action.setError(null);
          verification.setError(null);
        }}
        keyboardType="phone-pad"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="tel-national"
        maxLength={20}
        editable={!busy}
      />
      {needsCode && smsRecipient ? <Text style={s.small}>验证码收件手机号：{smsRecipient}，请核对后再发送。</Text> : null}
      <Field
        key={mode}
        label={resetting ? '新密码' : '密码'}
        placeholder={needsCode ? '设置 8–128 个字符的密码' : '请输入密码'}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={needsCode ? 'new-password' : 'current-password'}
        textContentType={needsCode ? 'newPassword' : 'password'}
        maxLength={256}
        editable={!busy}
        onSubmitEditing={needsCode ? undefined : submit}
      />
      {needsCode && (
        <Field
          label="确认密码"
          placeholder="再次输入密码"
          value={confirmation}
          onChangeText={setConfirmation}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={256}
          editable={!busy}
        />
      )}
      {needsCode && (
        <View style={[s.row, { gap: 12, alignItems: 'flex-end' }]}>
          <View style={s.fill}>
            <Field
              label="验证码"
              placeholder="请输入 6 位验证码"
              value={code}
              onChangeText={value => setCode(value.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              autoComplete="sms-otp"
              textContentType="oneTimeCode"
              maxLength={6}
              editable={!busy}
              onSubmitEditing={submit}
            />
          </View>
          <View style={{ paddingBottom: 2 }}>
            <Button
              variant="secondary"
              disabled={retryAfter > 0 || action.busy}
              loading={verification.busy}
              onPress={getCode}
            >
              {retryAfter > 0 ? `${retryAfter} 秒后重试` : '获取验证码'}
            </Button>
          </View>
        </View>
      )}
      {needsCode && codeNotice ? <Notice>{codeNotice}</Notice> : null}
      {needsCode && <ErrorNotice message={verification.error} />}
      <ErrorNotice message={action.error} />
      <View style={{ marginTop: 24 }}>
        <Button
          loading={action.busy}
          disabled={verification.busy}
          onPress={submit}
        >
          {registering ? '创建账号' : resetting ? '重置密码' : '登录'}
        </Button>
      </View>
      <Button
        variant="ghost"
        disabled={busy}
        onPress={() => changeMode(resetting ? 'login' : 'reset')}
      >
        {resetting ? '返回登录' : '忘记密码'}
      </Button>
      {mode === 'login' && (
        <Text style={s.small}>
          已有账号还未设置密码？请通过“忘记密码”验证手机号并设置。
        </Text>
      )}
      {!platform.hasSecureStorage && (
        <Notice>
          当前平台暂未接入安全存储，本次登录仅保存在内存中，关闭 App
          后需要重新登录。
        </Notice>
      )}
      <Section
        title="服务连接"
        action="设置地址"
        onAction={() => {
          if (!pending.current) {
            navigate({ name: 'settings' });
          }
        }}
      />
      <Card>
        <Text style={s.small}>当前地址</Text>
        <Text selectable style={[s.body, { fontSize: 12, marginVertical: 5 }]}>
          {preferences.serverUrl}
        </Text>
        <Text style={s.small}>如果无法登录，可在设置中检查服务地址。</Text>
        <ErrorNotice message={connection.error} />
        <Button
          variant="ghost"
          loading={connection.busy}
          onPress={() =>
            connection.run(async () => {
              await api.health();
              setConnected(true);
            })
          }
        >
          {connected ? '服务已连接 · 重新检查' : '检查连接'}
        </Button>
      </Card>
      <Text style={[s.small, { textAlign: 'center' }]}>
        模型、连接器与运行状态均以服务实际配置为准。
      </Text>
    </ScrollView>
  );
}

export function SettingsScreen() {
  const {
    api,
    user,
    signOut,
    updateUser,
    navigate,
  } = useApp();
  const [name, setName] = useState(user?.name ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'Asia/Shanghai');
  const [notice, setNotice] = useState('');
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const action = useAction();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={s.content}
    >
      <Text style={s.title}>设置</Text>
      <Text style={s.subtitle}>连接方式、个人资料与数据控制。</Text>
      <Section title="服务连接" />
      <InstanceConnectionCard />
      {user && (
        <>
          <Section title="个人资料" />
          <Card>
            <Text style={s.small}>{user.phone ?? user.email}</Text>
            <Field
              label="称呼"
              value={name}
              onChangeText={setName}
              maxLength={80}
            />
            <Field
              label="时区"
              value={timezone}
              onChangeText={setTimezone}
              placeholder="Asia/Shanghai"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[s.small, s.topGap]}>
              计划按照各自保存的时区执行。修改账号时区不会更改已有计划。
            </Text>
            <View style={s.topGap}>
              <Button
                variant="secondary"
                loading={action.busy}
                onPress={() =>
                  action.run(async () => {
                    try {
                      new Intl.DateTimeFormat('zh-CN', {
                        timeZone: timezone,
                      }).format();
                    } catch {
                      throw new Error('请输入有效时区，如 Asia/Shanghai。');
                    }
                    const updated = await api.updateMe({
                      name: name.trim(),
                      timezone,
                    });
                    await updateUser(updated);
                    setNotice('个人资料已更新。');
                  })
                }
              >
                保存资料
              </Button>
            </View>
          </Card>
          <PhotoIndexSettings key={api.baseUrl + user.id} />
          <Section title="我的资料" />
          <Card>
            <Text style={s.cardTitle}>已上传的文件与录音</Text>
            <Text style={[s.small, { marginVertical: 8 }]}>
              查看服务端实际保存的资料，随时删除不再需要的文件。
            </Text>
            <Button
              variant="secondary"
              onPress={() => navigate({ name: 'uploads' })}
            >
              管理我的资料
            </Button>
          </Card>
          <Section title="通知与本地资料" />
          <Card>
            <Text style={s.cardTitle}>通知权限</Text>
            <Text style={[s.small, { marginVertical: 7 }]}>
              App 在前台时会检查新的任务动态，授权后显示本机提醒。后台或关闭 App
              后的远程推送尚未配置。
            </Text>
            <Button
              variant="ghost"
              loading={action.busy}
              onPress={() =>
                action.run(async ({ isCurrent }) => {
                  const result = await platform.manageNotificationPermission();
                  if (!isCurrent()) return;
                  setShowNotificationSettings(result === 'blocked' || result === 'denied');
                  setNotice(
                    result === 'granted'
                      ? '通知权限已开启。App 前台可提示新的任务动态，远程推送仍需后续配置。'
                      : result === 'settings'
                      ? '已打开系统通知设置。开启通知后返回 App 即可。'
                      : result === 'blocked'
                      ? '系统已停止弹出通知授权，请点击“打开系统通知设置”后开启。'
                      : '通知权限未开启。你可以在 App 内查看任务结果，也可在系统通知设置中开启。',
                  );
                })
              }
            >
              管理通知权限
            </Button>
            {showNotificationSettings && <Button variant="ghost" loading={action.busy}
              onPress={() => action.run(async () => { await platform.openNotificationSettings(); })}>
              打开系统通知设置
            </Button>}
            <View style={s.divider} />
            <Text style={s.cardTitle}>清理本地临时文件</Text>
            <Text style={[s.small, { marginVertical: 7 }]}>
              删除本机选择附件和录音产生的缓存。云端会话、任务与记忆不会删除。
            </Text>
            <Button
              variant="ghost"
              onPress={() =>
                Alert.alert(
                  '清理本地临时文件？',
                  '未上传的录音与附件将无法找回。',
                  [
                    { text: '保留', style: 'cancel' },
                    {
                      text: '清理',
                      style: 'destructive',
                      onPress: () =>
                        action.run(async () => {
                          await platform.clearCache();
                          setNotice('本地临时文件已清理。');
                        }),
                    },
                  ],
                )
              }
            >
              清理缓存
            </Button>
          </Card>
          <Section title="账号与数据" />
          <Card>
            <Text style={s.body}>
              你可以在记忆中心逐条删除记忆。删除后，后续回答不再使用该条目；原始会话会保留。
            </Text>
            <Text style={[s.small, s.topGap]}>
              首版暂未开放账号注销与完整数据导出。请勿导入不希望保存在此服务中的敏感资料。
            </Text>
            <View style={s.topGap}>
              <Button
                variant="secondary"
                loading={action.busy}
                onPress={() =>
                  Alert.alert(
                    '退出当前账号？',
                    '云端任务仍会按已保存的计划执行。',
                    [
                      { text: '留在这里', style: 'cancel' },
                      { text: '退出账号', onPress: () => action.run(signOut) },
                    ],
                  )
                }
              >
                退出账号
              </Button>
            </View>
          </Card>
        </>
      )}
      <ErrorNotice message={action.error} />
      {notice ? <Notice>{notice}</Notice> : null}
      <Text style={[s.small, { textAlign: 'center', marginTop: 24 }]}>
        {`妥啦 · ${appVersion}`}
      </Text>
    </ScrollView>
  );
}
