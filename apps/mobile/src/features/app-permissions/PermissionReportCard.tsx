import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { openDeviceSettings, permissionLabels, type PermissionFinding, type PermissionReport } from './inspection';

export function PermissionReportCard({ report, review, recheck }: { report: PermissionReport;
  review: (finding: PermissionFinding, source: PermissionReport) => Promise<'requested' | 'system_settings' | undefined>;
  recheck: (finding?: PermissionFinding) => Promise<boolean> }) {
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState<PermissionFinding>();
  const openSettings = async (finding?: PermissionFinding) => {
    setBusy(true); setFeedback('');
    if (finding) setFocused(finding);
    const opened = finding ? await review(finding, report) : await openDeviceSettings('privacy');
    setFeedback(opened === 'requested' ? (finding ? '修改后回到这里，点「重新检查此 App」。' : '')
      : opened === 'system_settings' ? '已打开系统设置首页，可搜索应用名称或「隐私中心」。'
      : '暂时无法打开系统设置，请手动进入设置核对。');
    setBusy(false);
  };
  const refresh = async () => {
    setBusy(true); setFeedback('');
    const ok = await recheck(focused);
    setFeedback(ok ? '' : '重新检查未完成，仍显示上次结果。');
    setBusy(false);
  };
  const visible = expanded ? report.findings : report.findings.slice(0, 5);
  const summary = report.scope === 'selected_app' ? '已重新读取这个 App 的当前授权。'
    : report.permission ? `检查了 ${report.scanned} 个系统可见的第三方 App，${report.matched ?? report.findings.length} 个已获「${permissionLabels[report.permission]}」权限。`
    : `检查了 ${report.scanned} 个系统可见的第三方 App。已标记 ${report.flagged} 个建议核查的应用。`;
  return <Card>
    <View style={{ gap: 10 }} testID="app-permission-report">
      <Text style={{ fontWeight: '700' }}>应用权限检查</Text>
      <Text>{summary}</Text>
      {!!report.checkedAt && <Text>{`检查时间 ${new Date(report.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</Text>}
      {report.unavailable.length > 0 && <Text>{`未能核实：${report.unavailable.join('、')}。`}</Text>}
      {visible.map(finding => <View key={finding.packageName} style={{ gap: 4, paddingVertical: 6 }}>
        <Text style={{ fontWeight: '700' }}>{finding.name}</Text>
        {finding.reasons.length > 0 && <Text>{finding.reasons.join('；')}</Text>}
        <Text>{finding.grants.length > 0 ? `已授予：${finding.grants.join('、')}` : '未发现已授予的受检权限'}</Text>
        <Button disabled={busy} variant="secondary" onPress={() => void openSettings(finding)}>查看权限设置</Button>
      </View>)}
      {report.findings.length > 5 && <Button variant="ghost" onPress={() => setExpanded(!expanded)}>
        {expanded ? '收起' : `展开其余 ${report.findings.length - 5} 项`}
      </Button>}
      {(report.matched ?? report.flagged) > report.findings.length && <Text>这里只显示前 40 项。</Text>}
      {!!report.removed?.length && <Text>{`复查后已不再授予：${report.removed.join('、')}`}</Text>}
      {!!report.added?.length && <Text>{`复查后新增授权：${report.added.join('、')}`}</Text>}
      {report.added?.length === 0 && report.removed?.length === 0 && <Text>和上次相比，受检权限未变。</Text>}
      <Text>这些是权限线索。实际使用时间请在系统隐私记录核对。</Text>
      {!report.permission && report.scope !== 'selected_app' && report.flagged === 0 && <Text>此次未发现需优先核查的权限线索，单靠权限检查无法排除监控。</Text>}
      <Button disabled={busy} variant="secondary" onPress={() => void openSettings()}>打开隐私设置</Button>
      <Button disabled={busy} variant="secondary" onPress={() => void refresh()}>{focused || report.scope === 'selected_app' ? '重新检查此 App' : '重新检查'}</Button>
      <Text>{report.inspection === 'access_history' ? '在系统设置中搜索「隐私中心」查看所问时段的访问记录。' : '可在系统设置搜索「隐私中心」。'}</Text>
      {!!feedback && (feedback.includes('无法') || feedback.includes('未完成') ? <ErrorNotice message={feedback} /> : <Text>{feedback}</Text>)}
    </View>
  </Card>;
}
