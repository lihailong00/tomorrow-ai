import {useEffect, useState} from 'react';
import type {ApiClient, ChatStreamState} from '@tada/client-core';

type Order = NonNullable<ChatStreamState['didiOrder']>;

export function DidiOrderCard({card, api, acted}: {card: Order; api: ApiClient; acted: Set<string>}) {
  const key = `${card.run_id}:${card.id}`;
  const [feedback, setFeedback] = useState('');
  const [expired, setExpired] = useState(() => card.expires_at * 1000 <= Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, card.expires_at * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [card.expires_at]);

  async function answer(kind: 'confirm_didi_order' | 'cancel') {
    if (acted.has(key) || card.expires_at * 1000 <= Date.now()) return;
    acted.add(key);
    setFeedback('正在提交…');
    try {
      await api.request(`/chat/interactions/${card.run_id}/${card.id}`, 'POST', {kind});
      setFeedback(kind === 'cancel' ? '已取消叫车' : '已提交确认，正在等待滴滴返回结果。');
    } catch {
      setFeedback(kind === 'cancel' ? '未能确认取消结果。' : '下单结果暂未确认，请先在滴滴查看订单状态。');
    }
  }

  return <section className="location-picker" aria-label="滴滴叫车确认">
    <strong>{card.sandbox ? '滴滴测试叫车' : '确认滴滴叫车'}</strong>
    <dl><dt>出发地</dt><dd>{card.from}</dd><dt>目的地</dt><dd>{card.to}</dd>
      {card.phone_suffix && <><dt>乘车人手机尾号</dt><dd>{card.phone_suffix}</dd></>}
    </dl>
    <ul>{card.products.map((product, index) => <li key={index}>{product.name} · {product.price}</li>)}</ul>
    <p>{card.sandbox ? '模拟环境，不会呼叫真实车辆。' : '确认后将向滴滴发起叫车，车费以滴滴实际结算为准。'}</p>
    <div className="location-picker-footer">
      <button type="button" disabled={expired || acted.has(key)} onClick={() => void answer('cancel')}>取消叫车</button>
      <button type="button" disabled={expired || acted.has(key)} onClick={() => void answer('confirm_didi_order')}>确认叫车</button>
    </div>
    <div role="status">{feedback || (expired ? '本次预估已过期，请重新查询。' : acted.has(key) ? '已提交，正在等待结果。' : '')}</div>
  </section>;
}
