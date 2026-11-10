import {useEffect, useRef, useState} from 'react';
import type {ApiClient, ChatLocationContext, InputRequest} from '@tada/client-core';
import type {LocationBridge} from './bridge';
import {LocationPicker} from './LocationPicker';
import {useChatLocation} from './useChatLocation';

type Answer = {kind: 'cancel'} | {kind: 'location'; location: ChatLocationContext} | {kind: 'choice'; index: number};

export function ServerInputCard({api, card, bridge}: {api: ApiClient; card: InputRequest; bridge?: LocationBridge}) {
  const location = useChatLocation(bridge, card.id);
  const controller = useRef<AbortController | null>(null);
  const [status, setStatus] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [choosing, setChoosing] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  async function answer(value: Answer) {
    if (submitted || controller.current) return;
    if (card.expires_at * 1000 <= Date.now()) {setStatus('这次选择已过期，请重新发起查询。'); return;}
    const request = new AbortController();
    controller.current = request;
    setStatus('正在提交…');
    try {
      await api.request(`/chat/interactions/${card.run_id}/${card.id}`, 'POST', value, request.signal);
      if (!request.signal.aborted) {setSubmitted(true); setStatus('已提交，正在继续查询。');}
    } catch {
      if (!request.signal.aborted) setStatus('提交未完成，可以重试。');
    } finally {if (controller.current === request) controller.current = null;}
  }
  async function chooseLocation() {
    setChoosing(true);
    const choice = await location.requestForServer();
    setChoosing(false);
    if (choice.kind === 'selected') await answer({kind: 'location', location: choice.location});
    if (choice.kind === 'skip') await answer({kind: 'cancel'});
  }
  if (choosing && location.state.open) return <LocationPicker location={location} api={api} inReply/>;
  return <section className="location-picker" aria-label="补充查询信息">
    <strong>{card.kind === 'location' ? '这次查询用哪个位置？' : card.question}</strong>
    <div className="location-picker-footer">
      {card.kind === 'location'
        ? <button type="button" disabled={submitted} onClick={() => void chooseLocation()}>选择位置</button>
        : card.options.map((option, index) => <button type="button" key={index} disabled={submitted}
          onClick={() => void answer({kind: 'choice', index})}>{option}</button>)}
      <button type="button" disabled={submitted} onClick={() => void answer({kind: 'cancel'})}>暂不提供</button>
    </div>
    {status && <p role="status">{status}</p>}
  </section>;
}
