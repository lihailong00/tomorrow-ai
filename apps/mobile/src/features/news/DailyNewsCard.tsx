import React, { useState } from 'react';
import { Switch, View } from 'react-native';
import { useAction, useApp, useResource } from '../../app/context';
import { platform } from '../../platform/ports';
import { Button, Card, ErrorNotice, Field, Loading, Notice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';

type Settings = { topics: string[]; time: string; timezone: string; enabled: boolean };
type Subscription = Settings & { next_run_at: string | null };
const topics = ['人工智能', '科技', '商业', '国际', '体育', '科学', '文化', '游戏'];

export function DailyNewsCard() {
  const { api } = useApp();
  const [open, setOpen] = useState(false);
  return <Card style={{ marginTop: 12, gap: 8 }}>
    <Text style={s.cardTitle}>每日新闻</Text>
    <Text style={s.body}>选几个关心的主题，每天收到一份带原文链接的简报。</Text>
    <Button variant="secondary" onPress={() => setOpen(!open)}>{open ? '收起设置' : '设置新闻订阅'}</Button>
    {open && <SubscriptionEditor key={api.baseUrl} />}
  </Card>;
}

function SubscriptionEditor() {
  const { api, user } = useApp();
  const data = useResource(() => api.request<Subscription | null>('/daily-news'), [api]);
  if (data.error) return <ErrorNotice message={data.error} retry={data.refresh} />;
  if (data.loading) return <Loading />;
  return <SubscriptionForm initial={data.value} timezone={user?.timezone || 'Asia/Shanghai'} />;
}

function SubscriptionForm({ initial, timezone }: { initial: Subscription | null; timezone: string }) {
  const { api, formatDate, user } = useApp();
  const [settings, setSettings] = useState<Settings>(initial ?? { topics: [], time: '08:00', timezone, enabled: false });
  const [saved, setSaved] = useState(initial);
  const [notice, setNotice] = useState('');
  const save = useAction();
  const notification = useAction();
  const canNotify = platform.supportsDailyNewsNotifications() && api.baseUrl.startsWith('https://');
  const changed = !saved || settings.enabled !== saved.enabled || settings.time !== saved.time ||
    settings.topics.length !== saved.topics.length || settings.topics.some(topic => !saved.topics.includes(topic));
  const toggle = (topic: string) => setSettings(previous => ({ ...previous, topics: previous.topics.includes(topic)
    ? previous.topics.filter(item => item !== topic) : [...previous.topics, topic] }));
  return <View style={{ gap: 9 }}>
    <View style={[s.between, { gap: 12 }]}>
      <Text style={s.body}>启用每日新闻</Text>
      <Switch accessibilityLabel="启用每日新闻" value={settings.enabled} disabled={save.busy}
        onValueChange={enabled => setSettings(previous => ({ ...previous, enabled }))} />
    </View>
    <Text style={s.small}>选 1 至 4 个主题</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {topics.map(topic => {
        const selected = settings.topics.includes(topic);
        return <Button key={topic} variant={selected ? 'primary' : 'secondary'}
          disabled={save.busy || (!selected && settings.topics.length >= 4)}
          onPress={() => toggle(topic)}>{selected ? `✓ ${topic}` : topic}</Button>;
      })}
    </View>
    <Field label="生成时间（24 小时制）" value={settings.time} placeholder="08:00"
      maxLength={5} onChangeText={time => setSettings(previous => ({ ...previous, time }))} />
    <Text style={s.small}>按 {settings.timezone} 时区执行，简报可在「消息」查看。</Text>
    <ErrorNotice message={save.error || notification.error} />
    {!!notice && <Notice>{notice}</Notice>}
    {saved?.next_run_at && <Text style={s.small}>下次运行 {formatDate(saved.next_run_at)}</Text>}
    <Button loading={save.busy} disabled={!changed || !settings.topics.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.time)}
      onPress={() => save.run(async ({ isCurrent }) => {
        const value = await api.request<Subscription>('/daily-news', 'PUT', {
          topics: settings.topics, time: settings.time, timezone: settings.timezone, enabled: settings.enabled,
        });
        if (!isCurrent()) return;
        setSaved(value);
        setNotice(value.enabled ? '新闻订阅已保存' : '新闻订阅已暂停');
      })}>保存订阅</Button>
    {canNotify && user?.id && <>
      <Text style={s.small}>本机系统通知通过 Android 后台检查送达，可能晚于简报生成时间。</Text>
      {saved?.enabled && <Button variant="secondary" disabled={notification.busy} onPress={() =>
        notification.run(async ({ isCurrent }) => {
          const permission = await platform.manageNotificationPermission();
          if (!isCurrent()) return;
          if (permission !== 'granted') { setNotice('开启系统通知权限后可启用本机提醒'); return; }
          await platform.configureDailyNewsNotifications(api.baseUrl, user.id, true);
          if (isCurrent()) setNotice('本机新闻通知已开启');
        })}>开启本机新闻通知</Button>}
      <Button variant="ghost" disabled={notification.busy} onPress={() =>
        notification.run(async ({ isCurrent }) => {
          await platform.configureDailyNewsNotifications(api.baseUrl, user.id, false);
          if (isCurrent()) setNotice('本机新闻通知已关闭');
        })}>关闭本机新闻通知</Button>
    </>}
  </View>;
}
