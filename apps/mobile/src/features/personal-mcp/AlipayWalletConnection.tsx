import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import { platform } from '../../platform/ports';
import { Button, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';
import { walletDocumentationUrl } from './walletLinks';
import { AlipayWalletActions } from './AlipayWalletActions';
import { McpConnectionCard, McpConnectionRow } from './McpConnectionCard';
import { readWalletMetadata, type WalletConnectionStatus } from './walletModel';
import { hasSavedConnection } from '../integrations/connectionVisibility';
export type { WalletConnectionStatus } from './walletModel';

/** Availability and account state are always obtained from this server. */
export function AlipayWalletConnection({ api, showUnavailable = false, hideTitle = false }: {
  api: ApiClient; showUnavailable?: boolean; hideTitle?: boolean;
}) {
  const scope = useMemo(
    () => ({
      api,
      active: false,
      controller: new AbortController(),
      sequence: 0,
      loading: false,
    }),
    [api],
  );
  const [state, setState] = useState<{
    scope: typeof scope;
    metadata?: WalletConnectionStatus;
    error: string;
    loading: boolean;
  }>({ scope, error: '', loading: true });
  const [helpScope, setHelpScope] = useState<typeof scope | null>(null);
  const current =
    state.scope === scope
      ? state
      : { scope, error: '', loading: true, metadata: undefined };

  const refresh = useCallback(async () => {
    if (!scope.active || scope.loading) return;
    scope.loading = true;
    const sequence = ++scope.sequence;
    setState(previous => ({
      scope,
      metadata: previous.scope === scope ? previous.metadata : undefined,
      error: '',
      loading: true,
    }));
    try {
      const metadata = readWalletMetadata(await api.request<unknown>(
        '/personal-wallet/alipay',
        'GET',
        undefined,
        scope.controller.signal,
      ));
      if (!scope.active || sequence !== scope.sequence) return;
      setState({ scope, metadata, error: '', loading: false });
    } catch (failure) {
      if (scope.active && sequence === scope.sequence)
        setState(previous => ({ scope, metadata: previous.scope === scope ? previous.metadata : undefined,
          error: errorMessage(failure), loading: false }));
    } finally {
      if (sequence === scope.sequence) scope.loading = false;
    }
  }, [api, scope]);

  useEffect(() => {
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    scope.active = true;
    void refresh();
    const unsubscribe = platform.onForeground(() => {
      void refresh();
    });
    return () => {
      scope.active = false;
      ++scope.sequence;
      scope.loading = false;
      scope.controller.abort();
      unsubscribe();
    };
  }, [refresh, scope]);

  const openDocumentation = async (input: string) => {
    const url = walletDocumentationUrl(input);
    if (!scope.active || !url) return;
    try {
      await platform.openUrl(url);
    } catch (failure) {
      if (scope.active)
        setState(previous => ({ ...previous, error: errorMessage(failure) }));
    }
  };
  const metadata = current.metadata;
  if (!showUnavailable && (!metadata || (!metadata.binding_available && !hasSavedConnection(metadata)))) return null;
  const title = hideTitle ? undefined : '支付宝';
  const documents = metadata ? <>
    {walletDocumentationUrl(metadata.help_url) ? <Button variant="ghost" accessibilityLabel="支付宝官方钱包说明"
      onPress={() => { void openDocumentation(metadata.help_url); }}>官方钱包说明 ↗</Button> : null}
    {walletDocumentationUrl(metadata.qualification_url) && metadata.qualification_url !== metadata.help_url
      ? <Button variant="ghost" accessibilityLabel="支付宝开通要求"
        onPress={() => { void openDocumentation(metadata.qualification_url); }}>查看开通要求 ↗</Button> : null}
  </> : null;

  if (metadata?.binding_available) return (
    <AlipayWalletActions api={api} metadata={metadata} title={title} details={<>
      <Text style={s.small}>{metadata.reason}</Text>
      {documents}
    </>}
      statusError={current.error} onStatus={value => {
        if (scope.active) {
          // An earlier cached GET must not overwrite a newer native wallet check.
          ++scope.sequence;
          scope.loading = false;
          setState({ scope, metadata: readWalletMetadata(value), error: '', loading: false });
        }
      }} />
  );

  return (
    <McpConnectionCard title={title} status={current.loading ? '检查中' : metadata ? '暂未开通' : '状态未知'}
      description={current.loading ? '正在检查支付宝连接。' : metadata
        ? metadata.reason : '暂时无法获取支付宝连接状态。'}
      action={!current.loading ? <Button accessibilityLabel="刷新支付宝接入状态"
        onPress={() => { void refresh(); }}>重新检查</Button> : undefined}>
      <ErrorNotice message={current.error} />
      {metadata ? <>
        <McpConnectionRow label="开通帮助" expanded={helpScope === scope}
          onPress={() => setHelpScope(helpScope === scope ? null : scope)} />
        {helpScope === scope ? documents : null}
      </> : null}
    </McpConnectionCard>
  );
}
