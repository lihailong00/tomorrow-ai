import {useEffect, useState} from 'react';
import {Keyboard, LoaderCircle, LocateFixed, MapPin, Settings, X} from 'lucide-react';
import type {ApiClient} from '@tada/client-core';
import type {useChatLocation} from './useChatLocation';
import {LocationMap} from './LocationMap';
import './location.css';

export function LocationPicker({location, api, inReply}: {location: ReturnType<typeof useChatLocation>; api: ApiClient; inReply?: boolean}) {
  const state = location.state;
  const [seconds, setSeconds] = useState(5);
  useEffect(() => {
    setSeconds(5);
    if (!state.countdown) return;
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.max(1, Math.ceil((5000 - (Date.now() - start)) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [state.countdown]);
  if (!state.open) return null;
  return <section className="location-picker" role="dialog" aria-modal="false" aria-label="选择当前位置" aria-busy={state.busy}>
    <div className="location-picker-heading"><span><MapPin size={18}/><strong>{inReply ? '这次查询用哪个位置？' : '从哪里出发？'}</strong></span><button type="button" className="icon-button" aria-label="关闭位置选择" onClick={location.cancel}><X size={17}/></button></div>
    <p className="location-picker-description">提供位置后继续刚才的问题。自动定位需要你授权。</p>
    {state.manual ? <LocationMap api={api} location={location}/> : <div className="location-choices">
      <button type="button" className="location-choice" disabled={state.busy} onClick={() => void location.locate()}>
        {state.countdown && <svg className="location-countdown" viewBox="0 0 200 70" preserveAspectRatio="none" aria-hidden="true"><rect x="1" y="1" width="198" height="68" rx="11" pathLength="100"/></svg>}
        {state.busy ? <LoaderCircle size={21} className="spin"/> : <LocateFixed size={21}/>}<span><strong>{state.busy ? '正在获取位置…' : state.error ? '重新定位' : '自动定位'}</strong><small>{state.busy ? '请在系统或浏览器中允许访问位置' : state.countdown ? `${seconds} 秒后使用当前位置` : '使用设备当前的位置'}</small></span>
      </button>
      <button type="button" className="location-choice" onClick={location.manual}><Keyboard size={21}/><span><strong>手动填写</strong><small>输入城市、地标或出发地</small></span></button>
    </div>}
    {state.error && <div className="location-error" role="alert">{state.error}{state.settings && <button type="button" className="inline-action" onClick={() => void location.openSettings()}><Settings size={14}/>打开系统设置</button>}</div>}
    <div className="location-picker-footer"><small>仅在相关问题中提供给你选择的服务器</small><button type="button" onClick={location.skip}>暂不提供</button>{!inReply && <button type="button" onClick={location.cancel}>继续编辑</button>}</div>
  </section>;
}
