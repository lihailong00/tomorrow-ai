import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {createMapPicker, osmAttribution, osmCopyrightUrl, pixelRadius, screenPoint, visibleTiles, type ApiClient, type MapPlace} from '@tada/client-core';
import type {useChatLocation} from './useChatLocation';

export function LocationMap({api, location}: {api: ApiClient; location: ReturnType<typeof useChatLocation>}) {
  const [map] = useState(() => createMapPicker(api, location.currentForMap, location.state.input));
  const state = useSyncExternalStore(map.subscribe, map.getSnapshot);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{id: number; x: number; y: number; moved: boolean} | null>(null);
  useEffect(() => map.start(), [map]);
  useEffect(() => {
    const target = surface.current;
    if (!target) return;
    const measure = () => map.size({width: target.clientWidth, height: target.clientHeight});
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const resize = new ResizeObserver(measure);
      resize.observe(target);
      return () => resize.disconnect();
    }
  }, [map]);
  useEffect(() => {
    const target = surface.current;
    if (!target) return;
    let lastZoom = 0;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.deltaY || Date.now() - lastZoom < 100) return;
      lastZoom = Date.now();
      map.zoom(event.deltaY < 0 ? 1 : -1);
    };
    target.addEventListener('wheel', wheel, {passive: false});
    return () => target.removeEventListener('wheel', wheel);
  }, [map]);

  const position = state.fix && screenPoint(state.fix, state.viewport, state.size);
  const radius = state.fix ? pixelRadius(state.fix, state.viewport.zoom, state.fix.accuracy_m) : 0;
  const pin = state.selected && screenPoint(state.selected, state.viewport, state.size);
  const backdrop = state.image && screenPoint(state.image.viewport, state.viewport, state.size);
  const scale = state.image ? 2 ** (state.viewport.zoom - state.image.viewport.zoom) : 1;
  function choose(place: MapPlace) {map.select(place);}
  return <form className="location-manual" onSubmit={event => {event.preventDefault(); if (!state.resolving) location.saveManual(map.selection());}}>
    <label htmlFor="chat-manual-location">城市、地标或地址</label>
    <input id="chat-manual-location" value={state.query} onChange={event => {
      map.setQuery(event.target.value); location.setInput(event.target.value);
    }} placeholder="搜索附近的地标、街道或地址" maxLength={200} autoComplete="off"/>
    <div className="location-map-toolbar">
      <small>{state.fix && !state.areaSearch ? '当前位置附近' : '地图选区附近'} · {state.radius / 1000} 公里内</small>
      <button type="button" disabled={state.locating} onClick={() => void map.locate()}>{state.locating ? '正在定位…' : '重新定位'}</button>
    </div>
    {state.locationStatus && <small role="status">{state.locationStatus}</small>}
    <div className="location-map" ref={surface} role="group" aria-label="出发地地图"
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button,a')) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
      }} onPointerMove={event => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        map.move(dx, dy, false);
        drag.current = {id: start.id, x: event.clientX, y: event.clientY, moved: true};
      }} onPointerUp={event => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        drag.current = null;
        if (start.moved) map.settle();
        else {
          const bounds = event.currentTarget.getBoundingClientRect();
          map.tap(event.clientX - bounds.left, event.clientY - bounds.top);
        }
      }} onPointerCancel={() => {drag.current = null; map.settle();}}>
      {state.provider === 'osm' && visibleTiles(state.viewport, state.size).map(tile =>
        <img key={tile.key} className="location-map-tile" src={tile.uri} alt="" draggable={false}
          style={{left: tile.x, top: tile.y, width: 256, height: 256}}/>)}
      {state.image && backdrop && <img className="location-map-tile" alt="高德地图" draggable={false} src={state.image.uri}
        style={{left: backdrop.x - state.image.size.width * scale / 2, top: backdrop.y - state.image.size.height * scale / 2,
          width: state.image.size.width * scale, height: state.image.size.height * scale}}/>}
      {position && <div className="location-device" aria-label="当前位置" style={{left: position.x, top: position.y, width: 2 * radius, height: 2 * radius}}/>}
      {pin && <div className="location-pin" aria-label="已选出发地" style={{left: pin.x, top: pin.y}}/>}
      <div className="location-map-zoom"><button type="button" aria-label="放大地图" onClick={() => map.zoom(1)}>+</button>
        <button type="button" aria-label="缩小地图" onClick={() => map.zoom(-1)}>−</button></div>
      {state.provider === 'osm' && <a className="location-map-credit" href={osmCopyrightUrl} target="_blank" rel="noreferrer">{osmAttribution}</a>}
      {state.provider === 'amap' && <span className="location-map-credit">© 高德地图</span>}
      {(!state.provider || state.provider === 'amap' && !state.image) && <small className="location-map-loading">正在载入地图…</small>}
    </div>
    <small>{state.notice || '拖动查看周边，点击地图放置出发地图钉。'}</small>
    {state.provider === 'osm' && <small>开源地点查询由 Photon 提供，搜索词和地图区域会发送给该服务。</small>}
    <div className="location-map-toolbar"><button type="button" onClick={map.searchHere}>搜索此区域</button>
      <select aria-label="附近搜索范围" value={state.radius} onChange={event => map.setRadius(Number(event.target.value) as 5000 | 20000 | 50000)}>
        <option value="5000">5 公里</option><option value="20000">20 公里</option><option value="50000">50 公里</option>
      </select>
    </div>
    {state.searching && <small role="status">正在搜索附近…</small>}
    {state.searchStatus && <small role="status">{state.searchStatus}</small>}
    {state.results.length > 0 && <ul className="location-map-results">{state.results.map((place, index) =>
      <li key={index}><button type="button" onClick={() => choose(place)}><strong>{place.label}</strong>
        <small>{place.address}{place.distance !== undefined && ` · ${(place.distance / 1000).toFixed(1)} 公里`}</small></button>
        {!!place.children?.length && <div>{place.children.map((child, index) => <button key={index} type="button" onClick={() => choose(child)}>{child.label}</button>)}</div>}
      </li>)}</ul>}
    {state.selected && <small role="status">{state.resolving ? '正在识别地图位置…' : `已选中 ${state.selected.label}`}</small>}
    <div className="location-map-toolbar"><button type="button" className="secondary" onClick={location.backToChoices}>返回</button>
      <button type="submit" className="primary" disabled={state.resolving || !state.selected && !state.query.trim()}>使用这个位置</button></div>
  </form>;
}
