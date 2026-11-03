import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Switch, View } from 'react-native';
import { errorMessage, type ApiClient } from '../../api/client';
import { useApp } from '../../app/context';
import { Text } from '../../ui/Text';
import { Icon, type IconName } from '../../ui/visuals';
import { reminderThresholds, usageApi, usagePath, type UsageMetrics, type UsageQuery, type UsageReminder, type UsageReport } from './api';
import { capabilityLabels, costPresentation, coverageDate, dateLabel, durationLabel, groupCells, integerLabel, moneyLabel, periodLabels, tokenLabel, usageSummary, type UsageGroup, type UsageGrouping } from './model';
import { UsageDateRange } from './UsageDateRange';
import { palette, u } from './styles';

let nextSession = 0;
let nextSnapshotOrder = 0;
export function UsageScreen() {
  const { api, user, preferences, back } = useApp();
  // Synchronous remount hides every old owner's report, dialogs and settings.
  const session = useMemo(() => ({ id: ++nextSession, api, userId: user?.id, server: preferences.serverUrl, instance: preferences.instance?.id }),
    [api, user?.id, preferences.serverUrl, preferences.instance?.id]);
  return user ? <UsageSession key={session.id} api={api} back={back}
    serverName={preferences.instance?.name || preferences.serverUrl}
    serverMode={preferences.instance?.deployment_mode === 'official' ? '官方服务' : preferences.instance?.deployment_mode === 'self_hosted' ? '自建服务' : '当前服务器'} /> : null;
}

function useUsageResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [version, setVersion] = useState(0);
  const scope = useMemo(() => ({ load }), [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  scope.load = load;
  const current = useRef(scope);
  current.current = scope;
  const [state, setState] = useState<{ scope: typeof scope; value: T | null; loading: boolean; error: string | null; order: number }>({ scope, value: null, loading: true, error: null, order: 0 });
  useEffect(() => {
    const controller = new AbortController();
    const order = ++nextSnapshotOrder;
    let active = true;
    const isCurrent = () => active && !controller.signal.aborted && current.current === scope;
    setState({ scope, value: null, loading: true, error: null, order });
    (async () => {
      try {
        const value = await scope.load(controller.signal);
        if (isCurrent()) setState(previous => previous.scope === scope && previous.order > order ? previous :
          { scope, value, loading: false, error: null, order });
      } catch (failure) {
        if (isCurrent()) setState(previous => previous.scope === scope && previous.order > order ? previous :
          { scope, value: null, loading: false, error: errorMessage(failure), order });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [scope]);
  return {
    value: state.scope === scope ? state.value : null,
    order: state.scope === scope ? state.order : 0,
    loading: state.scope !== scope || state.loading,
    error: state.scope === scope ? state.error : null,
    refresh: () => setVersion(previous => previous + 1),
    replace: (value: T) => {
      // A committed mutation supersedes every read dispatched before it completed.
      // The read may have refreshed since the save handler was created; its
      // current scope still belongs to this same mounted account session.
      setState({ scope: current.current, value, loading: false, error: null, order: ++nextSnapshotOrder });
    },
  };
}

type Page = 'overview' | 'info' | 'reminder';
type Selection = { group: UsageGrouping; id: string };
function UsageSession({ api, back, serverName, serverMode }: { api: ApiClient; back: () => void; serverName: string; serverMode: string }) {
  const [query, setQuery] = useState<UsageQuery>({ period: 'month' });
  const [group, setGroup] = useState<UsageGrouping>('model');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [page, setPage] = useState<Page>('overview');
  const [picker, setPicker] = useState(false);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const mutation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; mutation.current?.abort(); };
  }, []);
  const resource = useUsageResource(usagePath(query), signal => usageApi(api, signal).load(query));
  const reminderResource = useUsageResource('reminder', signal => usageApi(api, signal).reminder());
  const report = resource.value;
  // Both endpoints carry a complete current-month snapshot. Prefer the latest
  // request rather than permanently pinning progress to the first settings GET.
  // PATCH commits get a new order, so delayed pre-save reads cannot undo them.
  const reminder = report && (!reminderResource.value || resource.order > reminderResource.order) ?
    report.monthly_reminder : reminderResource.value ?? null;
  const selected = report && selection ? groupCells(report.cells, selection.group).find(item => item.id === selection.id) : null;
  const showPage = (next: Page) => {
    mutation.current?.abort();
    setSaving(false); setSaveError(''); setPage(next);
  };
  const goBack = () => {
    if (page !== 'overview') showPage('overview');
    else if (selection) setSelection(null);
    else back();
  };
  const applyQuery = (next: UsageQuery) => {
    setSelection(null); setQuery(next); setSavedNotice('');
  };
  const saveReminder = async (settings: Pick<UsageReminder, 'enabled' | 'threshold_cny_micros'>) => {
    if (!alive.current || saving) return;
    mutation.current?.abort();
    const controller = new AbortController();
    mutation.current = controller;
    setSaving(true); setSaveError('');
    try {
      const result = await usageApi(api, controller.signal).saveReminder(settings);
      if (!alive.current || controller.signal.aborted || mutation.current !== controller) return;
      reminderResource.replace(result);
      setPage('overview'); setSavedNotice('提醒设置已保存。');
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && mutation.current === controller) setSaveError(errorMessage(failure));
    } finally {
      if (alive.current && !controller.signal.aborted && mutation.current === controller) setSaving(false);
    }
  };
  const title = page === 'info' ? '数据说明' : page === 'reminder' ? '消费提醒' : selected ? selected.name : '用量与费用';
  return <View style={u.screen}>
    <View style={u.blueGlow} pointerEvents="none" /><View style={u.warmGlow} pointerEvents="none" />
    <View style={u.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={page === 'overview' && !selection ? '返回我的' : '返回用量概览'} onPress={goBack} style={u.circle}><Icon name="back" /></Pressable>
      <Text accessibilityRole="header" style={u.title}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="用量数据说明" onPress={() => showPage('info')} style={u.circle}><Icon name="help" color={palette.blue} size={21} /></Pressable>
    </View>
    <ScrollView contentContainerStyle={u.content}>
      <View style={u.context}><Text style={u.contextName}>当前账号 · {serverName}</Text><View style={u.badge}><Text style={u.badgeText}>{serverMode}</Text></View></View>
      {page === 'info' ? <DataInfo report={report} onClose={() => showPage('overview')} /> : page === 'reminder' ? <>
        <View style={u.card}><Text style={u.heading}>花费心里有数</Text><Text style={u.small}>当本月个人已知预估费用达到设置金额时，在本页提醒。提醒不会自动停止对话或任务。</Text></View>
        {reminderResource.loading ? <Loading label="正在读取提醒设置" /> : reminderResource.error ? <Failure message={reminderResource.error} retry={reminderResource.refresh} /> : reminder ?
          <ReminderEditor key={`${reminder.month}-${reminder.enabled}-${reminder.threshold_cny_micros}`}
            reminder={reminder} saving={saving} error={saveError} save={saveReminder} /> : null}
      </> : <>
        <View style={u.periods}>{(['today', 'week', 'month', 'all', 'custom'] as const).map(period => <Pressable key={period}
          accessibilityRole="button" accessibilityLabel={'统计周期' + periodLabels[period]}
          accessibilityState={{ selected: query.period === period, disabled: period === 'custom' && !report }}
          disabled={period === 'custom' && !report}
          onPress={() => period === 'custom' ? setPicker(true) : applyQuery({ period })}
          style={[u.period, query.period === period && u.selectedPeriod, period === 'custom' && !report && u.disabled]}>
          <Text style={[u.periodText, query.period === period && u.ink]}>{periodLabels[period]}</Text>
        </Pressable>)}</View>
        {savedNotice ? <Text accessibilityRole="alert" style={u.note}>{savedNotice}</Text> : null}
        {resource.loading ? <Loading label="正在读取个人用量" /> : resource.error ? <Failure message={resource.error} retry={resource.refresh} /> : report ? <>
          {reminder?.enabled && reminder.reached && reminder.notice_key && dismissedNotice !== reminder.notice_key ? <View style={u.notice} accessibilityRole="alert">
            <Text style={u.medium}>本月消费提醒</Text><Text style={u.small}>本月已知预估达到 {moneyLabel(reminder.threshold_cny_micros)}。{reminder.cost_status !== 'complete' ? '部分费用未定价。' : ''}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="知道本月消费提醒" onPress={() => setDismissedNotice(reminder.notice_key)} style={u.quiet}><Text style={u.blueText}>知道了</Text></Pressable>
          </View> : null}
          {selected && selection ? <UsageDetail report={report} selected={selected} selection={selection} onSelect={setSelection} /> : <>
            <CostCard metrics={report.totals} report={report} onEdit={() => setPicker(true)} />
            <View style={u.section}><View style={u.groups}>{(['model', 'purpose'] as const).map(value => <Pressable key={value} accessibilityRole="button"
              accessibilityLabel={value === 'model' ? '按模型分组' : '按用途分组'} accessibilityState={{ selected: group === value }}
              onPress={() => setGroup(value)} style={[u.group, value === group && u.groupSelected]}><Text style={[u.medium, value !== group && u.small]}>{value === 'model' ? '按模型' : '按用途'}</Text></Pressable>)}</View><Text style={u.tiny}>预估费用</Text></View>
            {report.cells.length ? <View style={u.list}>{groupCells(report.cells, group).map((item, index) => <UsageRow key={item.id} item={item} group={group} first={index === 0} onPress={() => setSelection({ group, id: item.id })} />)}</View> :
              <View style={[u.card, u.empty]}><Icon name="calendar" color={palette.sub} /><Text style={u.medium}>这段时间暂无调用记录</Text><Text style={u.small}>已记录区间内没有模型调用。{report.history_status === 'partial' ? '更早的用量未记录，不会当成零。' : ''}</Text></View>}
            <Text style={u.note}>调用次数不等于消息条数。输入已包含缓存 Token，语音时长和图片数量单独计量。</Text>
          </>}
          {reminder ? <ReminderSummary reminder={reminder} open={() => showPage('reminder')} /> : <Pressable accessibilityRole="button" accessibilityLabel="设置消费提醒" onPress={() => showPage('reminder')} style={u.reminder}><Text style={u.medium}>消费提醒</Text><Icon name="chevronRight" /></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="刷新个人用量" onPress={() => { resource.refresh(); reminderResource.refresh(); }} style={u.quiet}><Text style={u.blueText}>刷新用量</Text></Pressable>
          <Text style={[u.tiny, u.centerText]}>预估费用仅供参考，以服务商实际账单为准</Text>
        </> : null}
      </>}
    </ScrollView>
    {picker && report ? <UsageDateRange minimum={coverageDate(report)} today={report.today}
      initialStart={query.period === 'custom' ? query.start : report.start_date} initialEnd={query.period === 'custom' ? query.end : report.end_date}
      onCancel={() => setPicker(false)} onApply={(start, end) => { applyQuery({ period: 'custom', start, end }); setPicker(false); }} /> : null}
  </View>;
}

function Loading({ label }: { label: string }) {
  return <View accessibilityRole="progressbar" accessibilityLabel={label} style={[u.card, u.empty]}><ActivityIndicator color={palette.blue} /><Text style={u.small}>{label}</Text></View>;
}
function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <View style={u.card}><Text accessibilityRole="alert" style={u.error}>读取失败：{message}</Text><Text style={u.small}>暂时无法显示用量，不能据此判断为零费用。</Text><Pressable accessibilityRole="button" accessibilityLabel="重试读取用量" onPress={retry} style={u.primary}><Text style={u.primaryText}>重试</Text></Pressable></View>;
}
function CostCard({ metrics, report, onEdit }: { metrics: UsageMetrics; report: UsageReport; onEdit?: () => void }) {
  const cost = costPresentation(metrics);
  return <View style={u.overview}>
    <Text style={u.amountLabel}>{periodLabels[report.period]} · {cost.title}</Text>
    <Text accessibilityLabel={'预估金额' + cost.amount} style={[u.amount, metrics.cost_status === 'unknown' && u.unknownAmount]}>{cost.amount}</Text>
    {metrics.cost_status !== 'complete' ? <Text style={u.caveat}>{cost.note} · {integerLabel(metrics.unknown_cost_call_count)} 次调用暂未完整估价</Text> : null}
    {(metrics.reconstructed_cost_call_count ?? 0) > 0 ? <Text style={u.tiny}>其中 {metrics.reconstructed_cost_call_count} 次按带版本的参考价格补算，非历史实扣账单。</Text> : null}
    {onEdit ? <Pressable accessibilityRole="button" accessibilityLabel="修改统计日期范围" onPress={onEdit} style={u.rangeButton}><Text style={u.small}>{dateLabel(report.start_date)} — {dateLabel(report.end_date)}　⌄</Text></Pressable> : <Text style={u.small}>{dateLabel(report.start_date)} — {dateLabel(report.end_date)}</Text>}
    <Text style={u.tiny}>北京时间 · 包含起止当天</Text>
    {report.history_status === 'partial' ? <Text style={u.caveat}>仅含开始记录后的用量。{dateLabel(coverageDate(report))} 之前的历史未记录，不会当成零。</Text> : null}
    {metrics.usage_status !== 'complete' ? <Text style={u.caveat}>{metrics.usage_status === 'unknown' ? '模型未返回可用的测量数据，调用已记录。' : '部分用量未返回，下列数字仅为已记录部分。'}</Text> : null}
    <View style={u.meta}><Text style={u.small}><Text style={u.medium}>{integerLabel(metrics.call_count)}</Text> 次调用</Text><Text style={u.small}>{usageSummary(metrics)}</Text></View>
  </View>;
}
function groupIcon(item: UsageGroup, group: UsageGrouping): IconName {
  if (group === 'purpose') {
    const icons: Record<string, IconName> = { chat: 'sparkles', brief: 'today', memory: 'memory', todo: 'tasks', voice: 'mic', image: 'image', gallery: 'image', index: 'file', other: 'more' };
    return icons[item.id] ?? 'more';
  }
  return ({ llm: 'sparkles', asr: 'mic', vision: 'image', embedding: 'file' } as const)[item.cells[0].capability];
}
function UsageRow({ item, group, first, onPress }: { item: UsageGroup; group: UsageGrouping; first: boolean; onPress: () => void }) {
  const cost = costPresentation(item.metrics);
  const label = `查看${group === 'model' ? '模型' : '用途'}${item.name}，${item.subtitle}，${integerLabel(item.metrics.call_count)} 次调用，${usageSummary(item.metrics)}，${cost.title} ${cost.amount}，${cost.note}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID={`usage-row-${group}-${item.id}`} onPress={onPress} style={[u.row, !first && u.rowBorder]}>
    <View style={u.rowIcon}><Icon name={groupIcon(item, group)} size={20} color={palette.blue} /></View>
    <View style={u.rowCopy}><Text style={u.rowName}>{item.name}</Text><Text style={u.tiny}>{item.subtitle}</Text><Text style={u.tiny}>{integerLabel(item.metrics.call_count)} 次 · {usageSummary(item.metrics)}</Text></View>
    <View style={u.rowValue}><Text style={u.rowMoney}>{cost.amount}</Text><Text style={u.tiny}>{item.metrics.cost_status === 'complete' ? '预估' : item.metrics.cost_status === 'partial' ? '已知预估 · 部分未定价' : '价格 / 用量未齐'}</Text></View>
    <Icon name="chevronRight" size={15} color="#ABB4C6" />
  </Pressable>;
}
function UsageDetail({ report, selected, selection, onSelect }: { report: UsageReport; selected: UsageGroup; selection: Selection; onSelect: (selection: Selection) => void }) {
  const metrics = selected.metrics;
  const other: UsageGrouping = selection.group === 'model' ? 'purpose' : 'model';
  const unknown = metrics.usage_status === 'unknown';
  const applicable = new Set(selected.cells.map(cell => cell.capability));
  const lines: Array<[string, string]> = [['调用次数', integerLabel(metrics.call_count) + ' 次']];
  if (applicable.has('llm') || applicable.has('vision') || applicable.has('embedding')) {
    lines.push(['输入 Token', unknown ? '未返回' : tokenLabel(metrics.input_tokens)], ['输出 Token', unknown ? '未返回' : tokenLabel(metrics.output_tokens)],
      ['缓存读取 Token（输入子集）', unknown ? '未返回' : tokenLabel(metrics.cache_read_tokens)], ['缓存写入 Token（输入子集）', unknown ? '未返回' : tokenLabel(metrics.cache_write_tokens)]);
  }
  if (applicable.has('asr')) lines.push(['语音时长', unknown ? '未返回' : durationLabel(metrics.audio_ms)]);
  if (applicable.has('vision')) lines.push(['提交图片数量', unknown || metrics.image_count === null ? '未测量' : integerLabel(metrics.image_count) + ' 张']);
  return <>
    <View style={u.detailTitle}><Text style={u.heading}>{selected.name}</Text><Text style={u.small}>{selected.subtitle}</Text>
      {selection.group === 'model' ? <Text style={u.tiny}>{selected.cells[0].model || '未知模型标识'} · {[...new Set(selected.cells.map(cell => capabilityLabels[cell.capability]))].join(' / ')}</Text> : null}</View>
    <CostCard metrics={metrics} report={report} />
    <View style={u.list}>{lines.map(([name, value], index) => <View key={name} style={[u.stat, index > 0 && u.rowBorder]}><Text style={u.small}>{name}</Text><Text style={u.statValue}>{value}</Text></View>)}</View>
    <View style={u.section}><Text style={u.heading}>{other === 'purpose' ? '花在了哪些事上' : '使用了哪些模型'}</Text><Text style={u.tiny}>预估费用</Text></View>
    <View style={u.list}>{groupCells(selected.cells, other).map((item, index) => <UsageRow key={item.id} item={item} group={other} first={index === 0} onPress={() => onSelect({ group: other, id: item.id })} />)}</View>
    <Text style={u.note}>缓存已包含在输入 Token 中，不重复相加。语音时长和图片数量不与 Token 相加。{metrics.usage_status !== 'complete' ? '未测量的数据保持未知，部分汇总仅包含已记录用量。' : ''}</Text>
  </>;
}
function ReminderSummary({ reminder, open }: { reminder: UsageReminder; open: () => void }) {
  const percentage = Math.min(100, reminder.known_cost_cny_micros / reminder.threshold_cny_micros * 100);
  const label = `设置消费提醒，本月消费提醒，${reminder.month}，${reminder.enabled ? '已开启' : '已关闭'}，每月提醒金额 ${moneyLabel(reminder.threshold_cny_micros)}，本月已知预估 ${moneyLabel(reminder.known_cost_cny_micros)}${reminder.cost_status !== 'complete' ? '，部分费用未定价' : ''}${reminder.enabled && reminder.reached ? '，已达到提醒金额' : ''}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} testID="usage-reminder" onPress={open} style={u.reminder}>
    <View style={u.rowIcon}><Icon name="bell" color={palette.blue} size={20} /></View><View style={u.rowCopy}>
      <View style={u.section}><Text style={u.rowName}>本月消费提醒</Text><Text style={u.tiny}>{reminder.enabled ? moneyLabel(reminder.threshold_cny_micros) + ' / 月' : '已关闭'}</Text></View>
      <Text style={u.tiny}>{reminder.month} · 已知预估 {moneyLabel(reminder.known_cost_cny_micros)}{reminder.cost_status !== 'complete' ? ' · 部分费用未定价' : ''}</Text>
      <View style={u.track}><View style={[u.progress, { width: `${percentage}%` }]} /></View>
      {reminder.reached && reminder.enabled ? <Text style={u.tiny}>已达到提醒金额</Text> : null}
    </View><Icon name="chevronRight" size={18} color="#ABB4C6" />
  </Pressable>;
}
function ReminderEditor({ reminder, saving, error, save }: { reminder: UsageReminder; saving: boolean; error: string; save: (settings: Pick<UsageReminder, 'enabled' | 'threshold_cny_micros'>) => void }) {
  const [enabled, setEnabled] = useState(reminder.enabled);
  const [threshold, setThreshold] = useState(reminder.threshold_cny_micros);
  return <>
    <Text style={u.small}>{reminder.month} · 本月已知预估 {moneyLabel(reminder.known_cost_cny_micros)}{reminder.cost_status !== 'complete' ? ' · 部分费用未定价，不能据此判断低于提醒金额。' : ''}</Text>
    <View style={u.choices}>{reminderThresholds.map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={'每月提醒' + value / 1000000 + '元'} accessibilityState={{ selected: threshold === value, disabled: saving }}
      disabled={saving} onPress={() => setThreshold(value)} style={[u.choice, value === threshold && u.selectedChoice]}><Text style={u.choiceText}>¥{value / 1000000} <Text style={u.small}>/ 月</Text></Text></Pressable>)}</View>
    <View style={[u.card, u.switchRow]}><View style={u.rowCopy}><Text style={u.medium}>开启消费提醒</Text><Text style={u.tiny}>按月累计，达到设定金额时提醒</Text></View><Switch accessibilityLabel="开启消费提醒" value={enabled} disabled={saving} onValueChange={setEnabled} trackColor={{ true: '#A6B7E5', false: '#D7DCE7' }} /></View>
    <Text style={u.note}>设置只针对当前账号和服务器。关闭后保留所选金额。提醒仅在应用内展示，不会发送短信或自动阻止调用。</Text>
    {error ? <Text accessibilityRole="alert" style={u.error}>保存失败：{error}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="保存提醒设置" accessibilityState={{ disabled: saving }} disabled={saving} onPress={() => save({ enabled, threshold_cny_micros: threshold })} style={[u.primary, saving && u.disabled]}><Text style={u.primaryText}>{saving ? '正在保存…' : '保存提醒设置'}</Text></Pressable>
  </>;
}
function DataInfo({ report, onClose }: { report: UsageReport | null; onClose: () => void }) {
  const cards = [
    ['只看自己的用量', '显示当前账号在所连接服务器上的模型用量，其他用户的费用不会混进来。'],
    ['预估费用与实际扣费', '按模型返回的用量和部署者配置的单价估算。免费额度、优惠和套餐抵扣，以服务商最终账单为准。缺少价格或计费用量时，费用保持未知。'],
    ['全部覆盖到哪里？', report ? `从 ${dateLabel(coverageDate(report))} 开始记录。开始记录前的历史未记录，不会当成零。自定义包含起止日期当天，按北京时间统计。` : '从服务器启用计量时开始记录。历史缺失不会补成零，具体覆盖日期在成功读取用量后显示。'],
    ['一次提问，可能调用多次模型', '搜索、整理资料、理解图片和后台任务都可能产生调用。实际重试另算一次，调用次数不等于发送消息条数。取消任务不会抹去已消耗的用量。'],
    ['用量如何统计？', '输入 Token 已包含缓存读取和写入，不重复相加。语音毫秒数、提交图片数独立计量。未返回的测量不会当成零，部分用量只汇总已记录部分。'],
    ['自建服务也能查看', '显示当前服务器记录的个人用量，模型名称和价格来自实际配置。不从演示数据或其他服务器补全历史。'],
  ];
  return <>{cards.map(([heading, body]) => <View key={heading} style={u.card}><Text style={u.heading}>{heading}</Text><Text style={u.small}>{body}</Text></View>)}<Pressable accessibilityRole="button" accessibilityLabel="关闭数据说明" onPress={onClose} style={u.primary}><Text style={u.primaryText}>知道了</Text></Pressable></>;
}
