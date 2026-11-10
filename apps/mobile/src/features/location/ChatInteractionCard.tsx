import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import type { ChatLocationContext } from '../../domain/types';
import { Button, Card, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { ChatLocationRequest } from './LocationProvider';
import type { ChatInteraction } from './chatInteraction';
import type { LocationSession } from './session';
import { PersonalDetailsCard } from './PersonalDetailsCard';
import { platform } from '../../platform/ports';

type Answer = { kind: 'cancel' } | { kind: 'confirm_didi_order' } | { kind: 'confirm_action' } | { kind: 'check_alipay_payment' } |
  { kind: 'choice'; index: number } | { kind: 'personal_details'; values: Record<string, string> } |
  { kind: 'location'; location: ChatLocationContext };

export function ChatInteractionCard({ card, api, session }: {
  card: ChatInteraction; api: Pick<ApiClient, 'request'>; session: LocationSession | null;
}) {
  const request = useRef<AbortController | null>(null);
  const choosing = useRef(false);
  const [selecting, setSelecting] = useState(card.kind === 'location' && !!session);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openingCheckout, setOpeningCheckout] = useState(false);
  const [failure, setFailure] = useState<{ answer?: Answer; message: string }>();
  const send = async (answer: Answer) => {
    if (request.current || submitted) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.request(`/chat/interactions/${card.run_id}/${card.id}`, 'POST', answer, controller.signal);
      if (!controller.signal.aborted) setSubmitted(true);
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ answer: answer.kind === 'personal_details' ? undefined : answer, message: errorMessage(error) });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const chooseLocation = () => {
    if (!session || choosing.current) return;
    choosing.current = true;
    setSelecting(true);
    void session.request('chat', 'location', undefined, true).then(choice => {
      if (!choosing.current) return;
      choosing.current = false;
      setSelecting(false);
      if (choice.kind === 'selected') void send({ kind: 'location', location: choice.location });
      if (choice.kind === 'skip') void send({ kind: 'cancel' });
    });
  };
  const cancel = () => {
    if (choosing.current) session?.dismiss();
    void send({ kind: 'cancel' });
  };
  useEffect(() => {
    if (card.kind === 'location') chooseLocation();
    return () => {
      const active = request.current;
      request.current = null;
      active?.abort();
      if (choosing.current) {
        choosing.current = false;
        session?.dismiss();
      }
    };
    // A mounted card is keyed by the run and question ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, card.run_id, session, api]);
  if (submitted || (card.kind === 'location' && busy)) return null;
  if (selecting) return <ChatLocationRequest session={session} api={api} onCancel={cancel} />;
  if (card.kind === 'didi_order') return <Card>
    <View style={{ gap: 8 }} testID="didi-order-confirmation">
      <Text style={{ fontWeight: '700' }}>{card.sandbox ? '确认模拟叫车' : '确认滴滴叫车'}</Text>
      <Text>上车点 · {card.from}</Text>
      <Text>目的地 · {card.to}</Text>
      {card.products.map(({ name, price }, index) =>
        <Text key={index}>{name} · 预估 {price}{/^\d+(\.\d+)?$/.test(price) ? ' 元' : ''}</Text>)}
      {card.phone_suffix && <Text>乘车手机号尾号 · {card.phone_suffix}</Text>}
      <Text>{card.sandbox ? '模拟环境，不会呼叫真实车辆。' : '确认后将发起真实叫车，车费以滴滴结算为准。'}</Text>
      {failure && <ErrorNotice message="暂未收到确认回执。请先核实滴滴订单状态。" />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button disabled={busy || Boolean(failure)} onPress={() => send({ kind: 'confirm_didi_order' })}>
          {busy ? '正在提交…' : card.sandbox ? '确认模拟叫车' : '确认叫车'}
        </Button>
        <Button disabled={busy || Boolean(failure)} variant="secondary" onPress={cancel}>暂不叫车</Button>
      </View>
    </View>
  </Card>;
  if (card.kind === 'action_confirmation') return <Card>
    <View style={{ gap: 8 }} testID="chat-action-confirmation">
      <Text style={{ fontWeight: '700' }}>{card.title}</Text>
      <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
        <Text selectable>{card.details}</Text>
      </ScrollView>
      {failure && <ErrorNotice message="暂未收到确认回执，请先核实本次操作状态。" />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button disabled={busy || Boolean(failure)} onPress={() => send({ kind: 'confirm_action' })}>
          {busy ? '正在提交…' : card.button}
        </Button>
        <Button disabled={busy || Boolean(failure)} variant="secondary" onPress={cancel}>放弃操作</Button>
      </View>
    </View>
  </Card>;
  if (card.kind === 'alipay_checkout') return <Card>
    <View style={{ gap: 8 }} testID="chat-alipay-checkout">
      <Text style={{ fontWeight: '700' }}>在支付宝确认这笔付款</Text>
      <Text>在支付宝完成后，回到这里核实结果。</Text>
      {failure && <ErrorNotice message={failure.message} />}
      <Button disabled={busy || openingCheckout} onPress={async () => {
        setOpeningCheckout(true);
        setFailure(undefined);
        try { await platform.openUrl(card.payment_url); }
        catch (error) { setFailure({ message: errorMessage(error) }); }
        finally { setOpeningCheckout(false); }
      }}>打开支付宝</Button>
      <Button disabled={busy || openingCheckout} variant="secondary" onPress={() => send({ kind: 'check_alipay_payment' })}>
        核实付款结果
      </Button>
      <Button disabled={busy || openingCheckout} variant="ghost" onPress={cancel}>稍后核实</Button>
    </View>
  </Card>;
  return <Card>
    <View style={{ gap: 8 }}>
      {card.kind !== 'personal_details' && <Text>{card.kind === 'choice' ? card.question : '这次查询用哪个位置？'}</Text>}
      {failure && <ErrorNotice message={failure.message} />}
      {failure?.answer && <Button disabled={busy} onPress={() => failure.answer && send(failure.answer)}>重试提交</Button>}
      {card.kind === 'personal_details'
        ? <PersonalDetailsCard card={card} busy={busy} submit={values => { void send({ kind: 'personal_details', values }); }} />
        : card.kind === 'choice'
        ? card.options.map((option, index) => <Button key={index} disabled={busy} variant="secondary"
            onPress={() => send({ kind: 'choice', index })}>{option}</Button>)
        : session && <Button disabled={busy} variant="secondary" onPress={chooseLocation}>选择位置</Button>}
      <Button disabled={busy} variant="secondary" onPress={cancel}>取消回答</Button>
    </View>
  </Card>;
}
