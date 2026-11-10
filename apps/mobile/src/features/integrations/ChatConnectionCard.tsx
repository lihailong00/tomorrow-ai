import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { platform } from '../../platform/ports';
import { Text } from '../../ui/Text';
import { Button, Card } from '../../ui/components';
import { HealthScreen } from '../health/HealthScreen';
import { ChatAppSource } from './ChatAppSource';
import { AlipayWalletConnection } from '../personal-mcp/AlipayWalletConnection';
import { PersonalMcpConnections } from '../personal-mcp/PersonalMcpConnections';
import { personalMcpApi } from '../personal-mcp/api';
import type { PersonalMcpConnection } from '../personal-mcp/types';
import { CloudConnection } from './IntegrationsScreen';
import { integrationsApi } from './api';
import { matchingConnections, type ConnectionChoice, type ConnectionIntent } from './chatConnectionIntent';

export function ChatConnectionCard({ api, message, intent, onContinue, onClose }: {
  api: ApiClient;
  message: string;
  intent: ConnectionIntent;
  onContinue: () => void;
  onClose: (completed?: boolean) => void;
}) {
  const [matches, setMatches] = useState<ConnectionChoice[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [updatedMcp, setUpdatedMcp] = useState<PersonalMcpConnection>();
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = controller.signal;
    setBusy(true);
    const [mcp, cloud] = await Promise.allSettled([
      personalMcpApi(api, () => signal).list(),
      integrationsApi(api, signal).list(),
    ]);
    if (signal.aborted) return;
    active.current = null;
    setBusy(false);
    setIncomplete(mcp.status === 'rejected' || cloud.status === 'rejected');
    setMatches(matchingConnections(
      message, intent,
      mcp.status === 'fulfilled' ? mcp.value.items : [],
      cloud.status === 'fulfilled' ? cloud.value.items : [],
    ));
  }, [api, message, intent]);

  useEffect(() => {
    void load();
    return () => active.current?.abort();
  }, [load]);

  const selected = matches?.length === 1 ? matches[0] : matches?.find(item => item.id === selectedId);
  const cloud = selected?.kind === 'cloud' ? selected.item : undefined;
  const cloudConnected = cloud?.status === 'connected' &&
    (cloud.mode !== 'map' || cloud.credential_scope === 'user');

  useEffect(() => {
    if (cloud?.mode === 'oauth' && !cloudConnected)
      return platform.onForeground?.(() => { void load(); });
  }, [cloud?.mode, cloudConnected, load]);

  const mcpConnected = selected?.kind === 'mcp' &&
    (updatedMcp?.id === selected.id ? updatedMcp.status : selected.item.status) === 'connected';
  const canResume = mcpConnected && intent === 'private-query';
  const noConnectionMatch = matches !== null && matches.length === 0 && !incomplete;
  const continued = useRef(false);
  useEffect(() => {
    if ((canResume || noConnectionMatch) && !continued.current) {
      continued.current = true;
      onContinue();
    }
  }, [canResume, noConnectionMatch, onContinue]);

  return (
    <Card testID="chat-connection-card" style={{ marginBottom: 8, gap: 8 }}>
      {!matches ? <Text accessibilityLiveRegion="polite">正在检查可连接的服务…</Text> : null}
      {matches && !matches.length ? (
        <Text>{incomplete ? '暂时无法确认是否支持这个连接。' : '没有在当前连接目录中找到这项服务。'}</Text>
      ) : null}
      {matches && matches.length > 1 && !selected ? <>
        <Text accessibilityRole="header">你想连接哪个服务？</Text>
        {matches.map(item => <Button key={item.id} variant="secondary"
          onPress={() => setSelectedId(item.id)}>{item.name}</Button>)}
      </> : null}
      {selected?.kind === 'mcp' ? (
        <PersonalMcpConnections key={selected.id} providerId={selected.id}
          initialConnection={selected.item} onConnectionChange={setUpdatedMcp} />
      ) : null}
      {selected?.kind === 'wallet' ? <AlipayWalletConnection api={api} showUnavailable /> : null}
      {selected?.kind === 'health' ? <HealthScreen connectionOnlyProvider={selected.id} /> : null}
      {selected?.kind === 'unavailable' ? (
        <Text>{incomplete ? '暂时无法确认 GitHub 连接状态。' : '当前服务器暂未开通 GitHub 连接。'}</Text>
      ) : null}
      {cloud ? <>
        <Text accessibilityRole="header" style={{ fontWeight: '700' }}>
          {cloud.name}{cloudConnected ? '已连接' : ''}
        </Text>
        <Text>{cloud.detail}</Text>
        {cloud.mode === 'import' ? (
          <ChatAppSource key={cloud.id} item={cloud} />
        ) : cloud.status === 'not_configured' ? (
          <Text>当前服务器尚未开通此服务。</Text>
        ) : !cloudConnected ? (
          <CloudConnection key={cloud.id} item={cloud} connectOnly onChanged={load} onNotice={setNotice} />
        ) : null}
        {notice && !cloudConnected ? <Text accessibilityLiveRegion="polite">{notice}</Text> : null}
      </> : null}
      {intent === 'private-query' && selected?.kind === 'mcp' && !mcpConnected && selected.item.status !== 'not_configured'
        ? <Text>连接成功后会继续处理这条消息。</Text> : null}
      {canResume ? <Button onPress={onContinue}>继续查询</Button> : null}
      {(!selected && !!matches && !matches.length) || selected?.kind === 'unavailable' ? <>
        <Button variant="secondary" loading={busy} onPress={() => { void load(); }}>刷新状态</Button>
        {intent === 'connect' && <Button variant="ghost" onPress={onContinue}>继续向妥啦提问</Button>}
      </> : null}
      {cloud?.mode === 'oauth' && !cloudConnected ? (
        <Button variant="ghost" loading={busy} onPress={() => { void load(); }}>刷新连接状态</Button>
      ) : null}
      {selected && matches && matches.length > 1 ? (
        <Button variant="ghost" onPress={() => {
          setSelectedId(undefined);
          setUpdatedMcp(undefined);
          setNotice('');
        }}>换一个服务</Button>
      ) : null}
      <Button variant="ghost" onPress={() => onClose(mcpConnected || cloudConnected)}>
        {mcpConnected || cloudConnected ? '完成' : '关闭'}
      </Button>
    </Card>
  );
}
