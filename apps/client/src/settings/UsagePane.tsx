import {useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {ApiClient} from '@tada/client-core';
import {Notice} from '../Auth';
import {readReminder, readReport, reminderThresholds, usagePath, type UsageQuery, type UsageReminder} from './usageApi';
import {costPresentation, coverageDate, dateLabel, groupCells, integerLabel, moneyLabel, periodLabels, rangeError, tokenLabel, usageSummary, type UsageGrouping} from './usageModel';
import {useSettingsAction, useSettingsResource} from './shared';
import {ResourceState} from './elements';

export function UsagePane({api}: {api: ApiClient}) {
  const [query, setQuery] = useState<UsageQuery>({period: 'month'});
  const [choosingCustom, setChoosingCustom] = useState(false);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [error, setError] = useState(''); const [grouping, setGrouping] = useState<UsageGrouping>('model');
  const resource = useSettingsResource(api, usagePath(query), readReport);
  const report = resource.data;
  const cost = report && costPresentation(report.totals);
  return <>
    <div className="settings-pane-heading"><div><h3>用量与费用</h3><p>查看当前账号的模型调用，以及按服务端单价计算的预估费用。</p></div><button className="icon-text" disabled={resource.loading} onClick={resource.reload}><RefreshCw size={14}/>刷新</button></div>
    <div className="settings-periods" aria-label="统计周期">{(['today', 'week', 'month', 'all', 'custom'] as const).map(period => <button key={period} aria-pressed={choosingCustom ? period === 'custom' : query.period === period} onClick={() => {
      setError(''); setChoosingCustom(period === 'custom');
      if (period === 'custom') {setStart(report?.start_date || ''); setEnd(report?.end_date || '');}
      else setQuery({period});
    }}>{periodLabels[period]}</button>)}</div>
    {choosingCustom && <form className="settings-date-range" onSubmit={event => {event.preventDefault(); const problem = rangeError(start, end, report ? coverageDate(report) : '', report?.today || ''); setError(problem); if (!problem) setQuery({period: 'custom', start, end});}}>
      <label>开始日期<input type="date" aria-label="开始日期" value={start} min={report ? coverageDate(report) : undefined} max={report?.today} onChange={e => setStart(e.target.value)} required/></label>
      <label>结束日期<input type="date" aria-label="结束日期" value={end} min={start || undefined} max={report?.today} onChange={e => setEnd(e.target.value)} required/></label><button className="secondary" disabled={!report || resource.loading} type="submit">应用日期</button>
    </form>}
    {error && <Notice>{error}</Notice>}
    <ResourceState resource={resource}/>
    {report && cost && <>
      <div className="settings-metrics"><div className="settings-cost"><span>{cost.title}</span><strong>{cost.amount}</strong><small>{cost.note}</small></div><div><span>模型调用</span><strong>{integerLabel(report.totals.call_count)}<small> 次</small></strong><small>{usageSummary(report.totals)}</small></div><div><span>输入 / 输出 Token</span><strong>{tokenLabel(report.totals.input_tokens)} / {tokenLabel(report.totals.output_tokens)}</strong><small>{report.totals.usage_status === 'complete' ? '服务端用量已记录' : '部分用量可能未返回'}</small></div></div>
      <p className="settings-note">{dateLabel(report.start_date)} — {dateLabel(report.end_date)} · 按北京时间统计。费用为预估，不是实际扣款。{report.history_status === 'partial' ? ' 部分历史调用没有完整记录。' : ''}</p>
      <div className="settings-periods" aria-label="用量分组"><button aria-pressed={grouping === 'model'} onClick={() => setGrouping('model')}>按模型</button><button aria-pressed={grouping === 'purpose'} onClick={() => setGrouping('purpose')}>按用途</button></div>
      {report.cells.length ? <div className="settings-table-scroll"><table className="settings-data-table"><caption className="settings-visually-hidden">{grouping === 'model' ? '各模型用量' : '各用途用量'}</caption><thead><tr><th>{grouping === 'model' ? '模型' : '用途'}</th><th>调用</th><th>用量</th><th>预估费用</th></tr></thead><tbody>{groupCells(report.cells, grouping).map(group => <tr key={group.id}><td><strong>{group.name}</strong><small>{group.subtitle}</small></td><td>{integerLabel(group.metrics.call_count)} 次</td><td>{usageSummary(group.metrics)}</td><td>{costPresentation(group.metrics).amount}<small>{costPresentation(group.metrics).note}</small></td></tr>)}</tbody></table></div> : <div className="settings-empty">这个时间范围还没有调用记录。</div>}
      <p className="settings-note">覆盖对话、语音转文字、图片理解与资料检索；只展示此服务实际记录的数据。</p>
      <BudgetReminder key={`${report.monthly_reminder.month}:${api.baseUrl}`} api={api} initial={report.monthly_reminder}/>
    </>}
  </>;
}
function BudgetReminder({api, initial}: {api: ApiClient; initial: UsageReminder}) {
  const [enabled, setEnabled] = useState(initial.enabled); const [threshold, setThreshold] = useState(initial.threshold_cny_micros);
  const [saved, setSaved] = useState(initial); const action = useSettingsAction();
  return <section className="settings-subsection"><h4>每月费用提醒</h4><p>达到所选预估金额时，由服务端记录提醒；这是提醒，不会自动限制模型调用。</p><label className="settings-check"><input type="checkbox" checked={enabled} disabled={action.busy} onChange={e => setEnabled(e.target.checked)}/><span>开启每月费用提醒</span></label>
    <div className="settings-periods" role="group" aria-label="费用提醒金额">{reminderThresholds.map(value => <button key={value} disabled={!enabled || action.busy} aria-pressed={threshold === value} onClick={() => setThreshold(value)}>{moneyLabel(value)}</button>)}</div>
    <p className="settings-note">{saved.month} 已知预估 {moneyLabel(saved.known_cost_cny_micros)}{saved.cost_status === 'complete' ? '' : '，部分费用尚不完整'}{saved.reached ? ' · 已达到提醒金额' : ''}。</p>
    <button className="secondary" disabled={action.busy || enabled === saved.enabled && threshold === saved.threshold_cny_micros} onClick={() => void action.run(async signal => readReminder(await api.request('/usage/reminder', 'PATCH', {enabled, threshold_cny_micros: threshold}, signal)), value => {setSaved(value); setEnabled(value.enabled); setThreshold(value.threshold_cny_micros);}, '费用提醒已保存。')}>{action.busy ? '正在保存…' : '保存费用提醒'}</button>
    {action.error && <Notice>{action.error}</Notice>}{action.notice && <Notice tone="success">{action.notice}</Notice>}
  </section>;
}
