import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import { platform } from '../../platform/ports';
import { Button, Card, ErrorNotice, Pill } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';
import { walletDocumentationUrl } from './walletLinks';

export interface WalletConnectionStatus {
  id: 'alipay';
  name: string;
  kind: 'wallet';
  status: 'not_configured';
  description: string;
  reason: string;
  help_url: string;
  qualification_url: string;
  binding_available: false;
  payment_available: false;
}

/** The official mobile wallet channel is not enabled; this is a truthful entry only. */
export function AlipayWalletConnection({ api }: { api: ApiClient }) {
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
      const metadata = await api.request<WalletConnectionStatus>(
        '/personal-wallet/alipay',
        'GET',
        undefined,
        scope.controller.signal,
      );
      if (!scope.active || sequence !== scope.sequence) return;
      if (
        !metadata ||
        typeof metadata !== 'object' ||
        typeof metadata.description !== 'string' ||
        typeof metadata.reason !== 'string' ||
        typeof metadata.help_url !== 'string' ||
        typeof metadata.qualification_url !== 'string'
      ) {
        throw new Error('暂时无法识别支付宝接入状态，请确认服务器已升级。');
      }
      if (
        metadata.id !== 'alipay' ||
        metadata.kind !== 'wallet' ||
        metadata.status !== 'not_configured' ||
        metadata.binding_available !== false ||
        metadata.payment_available !== false
      ) {
        throw new Error(
          '当前版本尚未支持此服务器提供的钱包绑定流程，请更新客户端后重试。',
        );
      }
      setState({ scope, metadata, error: '', loading: false });
    } catch (failure) {
      if (scope.active && sequence === scope.sequence)
        setState({ scope, error: errorMessage(failure), loading: false });
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
  return (
    <Card testID="alipay-wallet-connection">
      <View style={s.between}>
        <Text style={s.cardTitle}>支付宝</Text>
        <Pill tone="neutral">
          {current.loading ? '检查中' : metadata ? '待配置' : '状态未知'}
        </Pill>
      </View>
      {metadata ? (
        <>
          <Text style={s.body}>{metadata.description}</Text>
          <Text style={s.small}>{metadata.reason}</Text>
          <Text style={s.small}>开通前不会请求你的绑定码或付款信息。</Text>
          <Button
            variant="secondary"
            disabled
            onPress={() => undefined}
            accessibilityLabel="支付宝待配置"
          >
            连接账号（待配置）
          </Button>
          {walletDocumentationUrl(metadata.help_url) ? (
            <Button
              variant="ghost"
              accessibilityLabel="支付宝官方钱包说明"
              onPress={() => {
                void openDocumentation(metadata.help_url);
              }}
            >
              官方钱包说明 ↗
            </Button>
          ) : null}
          {walletDocumentationUrl(metadata.qualification_url) ? (
            <Button
              variant="ghost"
              accessibilityLabel="支付宝开通要求"
              onPress={() => {
                void openDocumentation(metadata.qualification_url);
              }}
            >
              查看开通要求 ↗
            </Button>
          ) : null}
        </>
      ) : !current.loading ? (
        <Text style={s.small}>
          暂时无法检查支付宝接入状态，请刷新或确认服务器已升级。
        </Text>
      ) : null}
      <ErrorNotice message={current.error} />
      <Button
        variant="ghost"
        disabled={current.loading}
        accessibilityLabel="刷新支付宝接入状态"
        onPress={() => {
          void refresh();
        }}
      >
        刷新状态
      </Button>
    </Card>
  );
}
