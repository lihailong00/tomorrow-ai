import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Image, Linking, Pressable, StyleSheet, Switch, TextInput, View, type GestureResponderEvent } from 'react-native';
import { createMapPicker, osmAttribution, osmCopyrightUrl, pixelRadius, screenPoint, visibleTiles } from '../../../../../packages/client-core/src/mapPicker';
import type { ApiClient } from '../../api/client';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import type { LocationSession } from './session';

const tileHeaders = { 'User-Agent': 'Tada/1 (+https://github.com/lihailong00/tomorrow-ai)' };

function separation(event: GestureResponderEvent) {
  const [a, b] = event.nativeEvent.touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

export function LocationMap({ api, session, initialQuery, rememberManual }: {
  api: Pick<ApiClient, 'request'>; session: LocationSession; initialQuery: string; rememberManual: boolean;
}) {
  const [map] = useState(() => createMapPicker(api, session.currentForMap, initialQuery));
  const state = useSyncExternalStore(map.subscribe, map.getSnapshot);
  const drag = useRef({x: 0, y: 0, moved: false, pinch: 0});
  useEffect(() => map.start(), [map]);
  const position = state.fix && screenPoint(state.fix, state.viewport, state.size);
  const radius = state.fix ? pixelRadius(state.fix, state.viewport.zoom, state.fix.accuracy_m) : 0;
  const pin = state.selected && screenPoint(state.selected, state.viewport, state.size);
  const backdrop = state.image && screenPoint(state.image.viewport, state.viewport, state.size);
  const scale = state.image ? 2 ** (state.viewport.zoom - state.image.viewport.zoom) : 1;
  const button = (text: string, onPress: () => void, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={text} disabled={disabled}
      style={[styles.button, disabled && styles.disabled]} onPress={onPress}><Text style={styles.buttonText}>{text}</Text></Pressable>;
  return <View style={styles.body}>
    <TextInput accessibilityLabel="位置地址" placeholder="搜索附近的地标、街道或地址" value={state.query}
      onChangeText={query => {map.setQuery(query); session.setInput(query);}} maxLength={200} style={styles.input} />
    <View style={styles.toolbar}>
      <Text style={styles.note}>{state.fix && !state.areaSearch ? '当前位置附近' : '地图选区附近'} · {state.radius / 1000} 公里内</Text>
      {button(state.locating ? '正在定位…' : '重新定位', () => { void map.locate(); }, state.locating)}
    </View>
    {!!state.locationStatus && <Text style={styles.note}>{state.locationStatus}</Text>}
    <View style={styles.surface} onLayout={event => map.size(event.nativeEvent.layout)}>
      <View style={StyleSheet.absoluteFill} accessibilityLabel="出发地地图"
        onStartShouldSetResponder={() => true} onResponderTerminationRequest={() => false}
        onResponderGrant={event => {
          drag.current = {x: event.nativeEvent.pageX, y: event.nativeEvent.pageY, moved: false, pinch: separation(event)};
        }} onResponderMove={event => {
          const current = drag.current;
          const pinch = separation(event);
          const {pageX, pageY} = event.nativeEvent;
          if (pinch) {
            current.moved = true;
            if (!current.pinch) current.pinch = pinch;
            else if (pinch / current.pinch > 1.35 || pinch / current.pinch < 0.74) {
              map.zoom(pinch > current.pinch ? 1 : -1);
              current.pinch = pinch;
            }
          } else if (!current.pinch) {
            const dx = pageX - current.x;
            const dy = pageY - current.y;
            if (!current.moved && Math.hypot(dx, dy) < 5) return;
            map.move(dx, dy, false);
            current.moved = true;
          } else {
            current.pinch = 0;
          }
          current.x = pageX;
          current.y = pageY;
        }} onResponderRelease={event => {
          if (drag.current.moved) map.settle();
          else map.tap(event.nativeEvent.locationX, event.nativeEvent.locationY);
        }} onResponderTerminate={map.settle}>
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {state.provider === 'osm' && visibleTiles(state.viewport, state.size).map(tile =>
            <Image key={tile.key} source={{uri: tile.uri, headers: tileHeaders}}
              fadeDuration={0} style={[styles.tile, {left: tile.x, top: tile.y, width: 256, height: 256}]}/>)}
          {state.image && backdrop && <Image source={{uri: state.image.uri}} fadeDuration={0} resizeMode="stretch"
            style={[styles.tile, {left: backdrop.x - state.image.size.width * scale / 2,
              top: backdrop.y - state.image.size.height * scale / 2,
              width: state.image.size.width * scale, height: state.image.size.height * scale}]}/>}
          {position && <View accessibilityLabel="当前位置" style={[styles.halo, {width: radius * 2, height: radius * 2,
            borderRadius: radius, left: position.x - radius, top: position.y - radius}]}><View style={styles.dot}/></View>}
          {pin && <View accessibilityLabel="已选出发地" style={[styles.pin, {left: pin.x - 8, top: pin.y - 15}]}/>}
        </View>
      </View>
      <View style={styles.zoom}>
        <Pressable accessibilityLabel="放大地图" accessibilityRole="button" style={styles.zoomButton} onPress={() => map.zoom(1)}><Text>＋</Text></Pressable>
        <Pressable accessibilityLabel="缩小地图" accessibilityRole="button" style={styles.zoomButton} onPress={() => map.zoom(-1)}><Text>－</Text></Pressable>
      </View>
      {state.provider === 'osm' && <Pressable style={styles.credit} accessibilityRole="link"
        onPress={() => { void Linking.openURL(osmCopyrightUrl).catch(() => {}); }}><Text style={styles.creditText}>{osmAttribution}</Text></Pressable>}
      {state.provider === 'amap' && <View style={styles.credit}><Text style={styles.creditText}>© 高德地图</Text></View>}
      {(!state.provider || state.provider === 'amap' && !state.image) && <Text pointerEvents="none" style={styles.mapLoading}>正在载入地图…</Text>}
    </View>
    <Text style={styles.note}>{state.notice || '拖动、双指缩放，点击地图放置出发地图钉。'}</Text>
    {state.provider === 'osm' && <Text style={styles.note}>开源地点查询由 Photon 提供，搜索词和地图区域会发送给该服务。</Text>}
    <View style={styles.toolbar}>{button('搜索此区域', map.searchHere)}
      {([5000, 20000, 50000] as const).map(radiusOption => <Pressable key={radiusOption} accessibilityRole="button"
        accessibilityState={{selected: state.radius === radiusOption}} style={[styles.button, state.radius === radiusOption && styles.radius]}
        onPress={() => map.setRadius(radiusOption)}><Text style={styles.buttonText}>{radiusOption / 1000} 公里</Text></Pressable>)}
    </View>
    {state.searching && <Text style={styles.note}>正在搜索附近…</Text>}
    {!!state.searchStatus && <Text style={styles.note}>{state.searchStatus}</Text>}
    {state.results.slice(0, 6).map((place, index) => <View key={index} style={styles.result}>
      <Pressable accessibilityRole="button" onPress={() => map.select(place)}>
        <Text style={styles.resultLabel}>{place.label}</Text>
        <Text style={styles.note}>{place.address}{place.distance !== undefined && ` · ${(place.distance / 1000).toFixed(1)} 公里`}</Text>
      </Pressable>
      {!!place.children?.length && <View style={styles.children}>{place.children.map((child, index) =>
        <Pressable key={index} accessibilityRole="button" style={styles.button} onPress={() => map.select(child)}>
          <Text style={styles.buttonText}>{child.label}</Text>
        </Pressable>)}</View>}
    </View>)}
    {state.selected && <Text style={styles.note}>{state.resolving ? '正在识别地图位置…' : `已选中 ${state.selected.label}`}</Text>}
    <View style={styles.toolbar}><Text style={styles.note}>保存为常用出发地（仅本机）</Text>
      <Switch accessibilityLabel="保存为常用出发地" value={rememberManual} onValueChange={session.rememberManual} /></View>
    <View style={styles.toolbar}>{button('返回', session.backToChoices)}
      {button('使用这个位置', () => session.saveManual(map.selection()), state.resolving || !state.selected && !state.query.trim())}</View>
  </View>;
}

const styles = StyleSheet.create({
  body: {gap: 7}, input: {borderRadius: 11, minHeight: 44, backgroundColor: '#EDF2FC', color: '#24304B', paddingHorizontal: 12},
  toolbar: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap'},
  note: {color: '#57637A', fontSize: 12, lineHeight: 18},
  button: {paddingHorizontal: 8, paddingVertical: 9, borderRadius: 8},
  buttonText: {color: colors.action, fontSize: 13}, disabled: {opacity: 0.45}, radius: {backgroundColor: '#DFE9FC'},
  surface: {height: 220, overflow: 'hidden', borderRadius: 12, backgroundColor: '#EDF2F5'},
  tile: {position: 'absolute'}, zoom: {position: 'absolute', top: 8, left: 8, backgroundColor: '#FFF', borderRadius: 8},
  zoomButton: {width: 40, height: 40, alignItems: 'center', justifyContent: 'center'},
  credit: {position: 'absolute', bottom: 0, right: 0, backgroundColor: '#FFFFFFF5', paddingHorizontal: 4},
  creditText: {color: '#28597E', fontSize: 10},
  mapLoading: {position: 'absolute', top: '45%', alignSelf: 'center', padding: 6, borderRadius: 6, backgroundColor: '#FFF'},
  halo: {position: 'absolute', backgroundColor: '#448AFF29', borderWidth: 1, borderColor: '#448AFF55', alignItems: 'center', justifyContent: 'center'},
  dot: {width: 16, height: 16, borderWidth: 3, borderColor: '#FFF', borderRadius: 8, backgroundColor: '#2388FF', elevation: 2},
  pin: {position: 'absolute', width: 16, height: 16, borderTopLeftRadius: 8, borderTopRightRadius: 8,
    borderBottomRightRadius: 8, borderWidth: 2, borderColor: '#FFF', backgroundColor: '#D6415A', transform: [{rotate: '-45deg'}]},
  result: {backgroundColor: '#EDF2FC', borderRadius: 8, padding: 8},
  resultLabel: {fontWeight: '600', color: '#24304B'}, children: {flexDirection: 'row', flexWrap: 'wrap'},
});
