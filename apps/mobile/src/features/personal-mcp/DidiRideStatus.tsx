import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, G, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { displayPoint, distanceMeters, screenPoint, type Point } from '../../../../../packages/client-core/src/mapPicker';
import { useApp } from '../../app/context';
import { deviceLocation } from '../../platform/deviceLocation';
import { platform } from '../../platform/ports';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { personalMcpApi } from './api';
import type { PersonalMcpAction } from './types';

type RideStatus = {
  status: number; status_text: string; from: string; to: string;
  driver: string; car: string; plate: string; eta: number | null;
  environment: string;
  vehicle: Point | null;
  destination?: Point | null;
  distance_km?: number | null;
};

const rideMapSize = { width: 500, height: 320 };
const vehicleColor = '#3A61C2';
const targetColor = '#258472';
const mapRefreshMs = 15_000;
type RideMap = {
  image?: string;
  vehicle: ReturnType<typeof screenPoint>;
  target?: ReturnType<typeof screenPoint>;
  targetLabel: '目的地' | '上车点' | '我的位置';
  route?: string;
  routeSource?: 'didi' | 'amap';
  routeKm?: number;
  inTrip: boolean;
  at: number;
};

function validPoint(point?: Point | null): point is Point {
  return !!point && Number.isFinite(point.longitude) && Number.isFinite(point.latitude) &&
    Math.abs(point.longitude) <= 180 && Math.abs(point.latitude) <= 90 && (point.longitude !== 0 || point.latitude !== 0);
}

function coordinate(point: Point) {
  return `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;
}

function providerPoint(value: unknown): Point | undefined {
  const point = value as Point | null;
  return validPoint(point) ? { longitude: point.longitude, latitude: point.latitude } : undefined;
}

function didiGeometry(text: unknown, origin: Point, destination: Point): Point[] {
  if (typeof text !== 'string' || text.length > 96 * 1024) return [];
  try {
    const payload = JSON.parse(text) as { status?: unknown; geo_list?: unknown };
    if (payload?.status !== 'success' || !Array.isArray(payload.geo_list)) return [];
    const points = payload.geo_list.map(providerPoint).filter((point: Point | undefined): point is Point => !!point);
    if (points.length < 2 || distanceMeters(origin, points[0]) > 500 ||
        distanceMeters(destination, points[points.length - 1]) > 500) return [];
    // Keep both endpoints even for long trips.
    return points.length <= 512 ? points : Array.from({ length: 512 }, (_, i) =>
      points[Math.floor(i * (points.length - 1) / 511)]);
  } catch { return []; }
}

type RideOrder = { id: string; orderId: string; pickup?: Point; destination?: Point };

function rideMapViewport(vehicle: Point, target?: Point, route: Point[] = []): {
  location: string; zoom: number; vehicle: ReturnType<typeof screenPoint>; target?: ReturnType<typeof screenPoint>;
  center: Point;
} {
  const stops = target ? [vehicle, target, ...route] : [vehicle];
  const middle = (axis: keyof Point) => {
    const values = stops.map(point => point[axis]);
    return (Math.min(...values) + Math.max(...values)) / 2;
  };
  const center = { longitude: middle('longitude'), latitude: middle('latitude') };
  const location = coordinate(center);
  // Use the same rounded center in the overlay and the static map request.
  const [longitude, latitude] = location.split(',').map(Number);
  for (let zoom = target ? 17 : 15; zoom >= 3; zoom--) {
    const viewport = { longitude, latitude, zoom };
    const carPin = screenPoint(vehicle, viewport, rideMapSize);
    const targetPin = target && screenPoint(target, viewport, rideMapSize);
    const inside = ({ x, y }: typeof carPin) =>
      x >= 30 && x <= rideMapSize.width - 30 && y >= 30 && y <= rideMapSize.height - 30;
    if (stops.every(point => inside(screenPoint(point, viewport, rideMapSize)))) {
      return { location, zoom, vehicle: carPin, target: targetPin, center: { longitude, latitude } };
    }
  }
  return rideMapViewport(vehicle);
}

async function readMapPart<T>(signal: AbortSignal, read: (requestSignal: AbortSignal) => Promise<T>) {
  if (signal.aborted) return undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel);
  const timer = setTimeout(cancel, 5_000);
  try { return await read(controller.signal); }
  catch { return undefined; }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

async function readRideMap(
  api: ReturnType<typeof useApp>['api'], status: RideStatus, order: RideOrder,
  signal: AbortSignal, locationMode?: 'prompt' | 'granted',
): Promise<RideMap> {
  const vehicle = status.vehicle;
  if (!validPoint(vehicle)) throw new Error('Vehicle location unavailable');
  const at = Date.now();
  const inTrip = status.status === 4;
  let target = inTrip ? providerPoint(status.destination) ?? order.destination : order.pickup;
  let targetLabel: RideMap['targetLabel'] = inTrip ? '目的地' : '上车点';
  if (!target && !inTrip && locationMode && status.environment !== 'sandbox') {
    const allowed = locationMode === 'prompt' || (await deviceLocation.status().catch(() => undefined))?.permission === 'granted';
    const fix = allowed && await deviceLocation.requestCurrentLocation(signal).catch(() => undefined);
    if (fix && !fix.stale && Date.now() - Date.parse(fix.observed_at) <= 30_000 && validPoint(fix)) {
      target = displayPoint(fix, 'amap');
      targetLabel = '我的位置';
    }
  }
  if (signal.aborted) throw new Error('Ride map refresh cancelled');
  const readRoute = async (endpoint: Point): Promise<{ points: Point[]; source?: RideMap['routeSource'] }> => {
    const origin = coordinate(vehicle);
    const destination = coordinate(endpoint);
    if (targetLabel !== '我的位置') {
      const reply = await readMapPart(signal, requestSignal =>
        personalMcpApi(api, () => requestSignal).didiDrivingRoute(origin, destination));
      const points = reply?.status === 'completed'
        ? didiGeometry(reply.result?.content?.[0]?.text, vehicle, endpoint) : [];
      if (points.length >= 2) return { points, source: 'didi' };
    }
    const reply = await readMapPart(signal, requestSignal =>
      api.request<{ geometry?: [number, number][] }>('/integrations/amap/read', 'POST', {
        operation: 'route', mode: 'driving', origin, destination, limit: 1, include_geometry: true,
      }, requestSignal));
    const points = Array.isArray(reply?.geometry) ? reply.geometry.slice(0, 512)
      .flatMap(pair => Array.isArray(pair) && validPoint({ longitude: pair[0], latitude: pair[1] })
        ? [{ longitude: pair[0], latitude: pair[1] }] : []) : [];
    return { points, source: points.length >= 2 ? 'amap' : undefined };
  };
  const plan = target ? await readRoute(target) : undefined;
  const viewport = rideMapViewport(vehicle, target, plan?.points);
  const map = await readMapPart(signal, requestSignal =>
    api.request<{ image?: string }>('/integrations/amap/read', 'POST', {
      operation: 'map_view', location: viewport.location, zoom: viewport.zoom, ...rideMapSize,
    }, requestSignal));
  const image = map?.image && /^data:image\/(?:png|jpeg);base64,[a-z\d+/=]+$/i.test(map.image) ? map.image : undefined;
  if (!image && !plan?.source) throw new Error('Ride map unavailable');
  const pixels = plan?.points.map(point => screenPoint(point, { ...viewport.center, zoom: viewport.zoom }, rideMapSize)) ?? [];
  const route = pixels.length >= 2 ? pixels.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') : undefined;
  const routeKm = route && plan ? plan.points.slice(1)
    .reduce((sum, point, i) => sum + distanceMeters(plan.points[i], point), 0) / 1000 : undefined;
  return { image, vehicle: viewport.vehicle, target: viewport.target, targetLabel,
    route, routeSource: plan?.source, routeKm, inTrip, at };
}

function RideMapPin({ point, label, car = false }: {
  point: ReturnType<typeof screenPoint>; label: string; car?: boolean;
}) {
  const fill = car ? vehicleColor : targetColor;
  const labelWidth = label.length * 15 + 14;
  const labelX = Math.max(6, Math.min(rideMapSize.width - labelWidth - 6, point.x - labelWidth / 2));
  const labelY = Math.max(4, Math.min(rideMapSize.height - 28, point.y + (car ? 17 : -41)));
  return <>
    <Rect x={labelX} y={labelY} width={labelWidth} height={24} rx={9} fill="#FFF" />
    <SvgText x={labelX + labelWidth / 2} y={labelY + 17} textAnchor="middle" fill={fill}
      fontSize={15} fontWeight="bold">{label}</SvgText>
    <G x={point.x} y={point.y}>
      <Circle r={13} fill={fill} stroke="#FFF" strokeWidth={3} />
      {car ? <Path d="M-8 4V0l2.5-5h11L8 0v4M-8 0H8M-8 2.5H8M-5 4V6M5 4V6"
        fill="none" stroke="#FFF" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        : <Circle r={3.5} fill="#FFF" />}
    </G>
  </>;
}

const states: Record<number, string> = {
  0: '正在呼叫', 1: '司机已接单', 2: '司机已到达', 4: '行程中', 5: '行程已完成',
};
const activeStatuses = [0, 1, 2, 4];
const cancellableStatuses = [0, 1, 2];
const vehicleStatuses = [1, 2, 4];

function rideOrderId(action: PersonalMcpAction) {
  const result = action.result as { structuredContent?: { orderId?: unknown } } | undefined;
  const id = result?.structuredContent?.orderId;
  if (action.provider === 'didi' && action.tool === 'taxi_create_order' && action.status === 'completed' && typeof id === 'string' && id) return id;
}

function matchesCancellation(action: PersonalMcpAction, orderId: string) {
  return action.provider === 'didi' && action.tool === 'taxi_cancel_order' && action.arguments?.order_id === orderId;
}

function cancellationOutcome(action: PersonalMcpAction) {
  const result = action.result as { structuredContent?: { success?: unknown } } | undefined;
  if (action.status === 'completed' && result?.structuredContent?.success === true) return 'success';
  if (action.status === 'failed' || action.status === 'expired' || action.status === 'cancelled' ||
      (action.status === 'completed' && result?.structuredContent?.success === false)) return 'failed';
  return 'unknown';
}

export function DidiRideStatus() {
  const { api, revision } = useApp();
  const { width, fontScale } = useWindowDimensions();
  const stackDetails = Math.min(width, 560) / Math.max(fontScale, 1) < 320;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [order, setOrder] = useState<RideOrder>();
  const [snapshot, setSnapshot] = useState<{ id: string; status: RideStatus; at: number }>();
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  const [notificationTapped, setNotificationTapped] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancellation, setCancellation] = useState<{ id: string; state: 'submitting' | 'success' | 'failed' | 'unknown' | 'retry' }>();
  const [mapRefresh, setMapRefresh] = useState(0);
  const [map, setMap] = useState<{ id: string; result?: RideMap; loading?: boolean; error?: boolean }>();
  const cancelRequest = useRef<AbortController | null>(null);
  const locationAccess = useRef<{ id: string; prompt: boolean } | undefined>(undefined);
  const detailsScroll = useRef<ScrollView>(null);
  const actionId = order?.id;
  const current = snapshot?.id === actionId ? snapshot : undefined;
  const ride = current?.status;
  const cancelState = cancellation?.id === actionId ? cancellation?.state : undefined;
  const active = Boolean(actionId && cancelState !== 'success' && (!ride || activeStatuses.includes(ride.status)));
  const title = cancelState === 'success' ? '行程已取消' : ride ? states[ride.status] ?? (ride.status_text || '行程已结束') : '正在同步行程';
  const matching = active && ride?.status === 0 && !stale && foreground;
  const sandbox = ride?.environment === 'sandbox';
  const canCancel = active && !!ride && cancellableStatuses.includes(ride.status) && !stale && foreground &&
    (!cancelState || cancelState === 'retry');
  const canSeeMap = active && !!ride && vehicleStatuses.includes(ride.status) && foreground;
  const tracking = open && active;
  const currentMap = map?.id === actionId ? map : undefined;
  const inTrip = ride?.status === 4;
  const mapResult = currentMap?.result?.inTrip === inTrip ? currentMap?.result : undefined;

  useEffect(() => {
    let mounted = true;
    const handle = (url: string | null) => {
      if (mounted && url === 'tada://ride') setNotificationTapped(true);
    };
    void Linking.getInitialURL().then(handle).catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (!notificationTapped || !actionId) return;
    setNotificationTapped(false);
    setOpen(true);
  }, [notificationTapped, actionId]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => {
      setForeground(value === 'active');
      if (value !== 'active') setStale(true);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!foreground) return;
    const controller = new AbortController();
    const client = personalMcpApi(api, () => controller.signal);
    void client.actions().then(({ items }) => {
      if (controller.signal.aborted) return;
      const receipt = items.find(rideOrderId);
      const orderId = receipt && rideOrderId(receipt);
      const stops = (receipt?.result as { structuredContent?: { from?: unknown; to?: unknown } } | undefined)?.structuredContent;
      setOrder(receipt && orderId ? { id: receipt.id, orderId, pickup: providerPoint(stops?.from),
        destination: providerPoint(stops?.to) } : undefined);
      if (!receipt || !orderId) return;
      const cancellation = items.find(action => matchesCancellation(action, orderId) && action.status !== 'pending');
      if (cancellation) {
        setCancellation(previous => {
          if (previous?.id === receipt.id && (previous.state === 'submitting' || previous.state === 'success')) return previous;
          return { id: receipt.id, state: cancellationOutcome(cancellation) };
        });
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [api, foreground, revision]);
  useEffect(() => {
    if (!foreground || !order || !actionId || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let next = 30_000;
    const poll = async () => {
      try {
        const path = '/personal-mcp/actions/' + encodeURIComponent(actionId) + '/ride-status';
        const status = await api.request<RideStatus>(
          tracking ? path + '?include_vehicle=true' : path, 'GET', undefined, controller.signal,
        );
        if (controller.signal.aborted) return;
        setSnapshot({ id: actionId, status, at: Date.now() });
        setStale(false);
        failures = 0;
        if (!activeStatuses.includes(status.status)) return;
        next = tracking && vehicleStatuses.includes(status.status) ? mapRefreshMs : status.status === 0 || status.status === 1 ? 30_000 : 60_000;
        if (tracking && vehicleStatuses.includes(status.status)) {
          const access = locationAccess.current?.id === actionId ? locationAccess.current : undefined;
          const locationMode = access ? access.prompt ? 'prompt' : 'granted' : undefined;
          if (access) access.prompt = false;
          try {
            const result = await readRideMap(api, status, order, controller.signal, locationMode);
            if (controller.signal.aborted) return;
            setMap({ id: actionId, result });
          } catch {
            if (controller.signal.aborted) return;
            setMap(previous => ({ id: actionId, result: previous?.id === actionId ? previous.result : undefined, error: true }));
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = (error as { status?: number; code?: string })?.status;
        if (code === 404 || (error as { code?: string })?.code === 'not_found') {
          setOrder(undefined);
          setOpen(false);
          return;
        }
        setStale(true);
        if (tracking) setMap(previous => ({ id: actionId, result: previous?.id === actionId ? previous.result : undefined, error: true }));
        failures++;
        next = Math.min(120_000, 30_000 * 2 ** Math.min(failures, 2));
      }
      timer = setTimeout(() => { void poll(); }, next);
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, foreground, order, actionId, active, tracking, mapRefresh]);
  useEffect(() => {
    const prefix = sandbox ? '模拟行程 · ' : '';
    const status = active && ride ? prefix + (foreground && !stale ? title : '上次同步 · ' + title) : '';
    void platform.updateRideNotification(status, matching).catch(() => {});
  }, [active, foreground, stale, title, matching, ride, sandbox, notificationPermission]);
  useEffect(() => {
    if (!open || !foreground || Platform.OS !== 'android') return;
    let current = true;
    void platform.notificationPermissionStatus().then(status => {
      if (current) setNotificationPermission(status);
    }).catch(() => {});
    return () => { current = false; };
  }, [open, foreground]);
  useEffect(() => () => { void platform.updateRideNotification('').catch(() => {}); }, []);
  useEffect(() => {
    setConfirmingCancel(false);
    return () => {
      cancelRequest.current?.abort();
      cancelRequest.current = null;
    };
  }, [api, actionId]);
  useEffect(() => {
    setMap(undefined);
    locationAccess.current = undefined;
  }, [api, actionId, active]);

  const close = () => {
    if (cancelState === 'submitting') return;
    setOpen(false);
    setConfirmingCancel(false);
    locationAccess.current = undefined;
  };

  const cancelRide = async () => {
    if (!order || !confirmingCancel || !canCancel || cancelRequest.current) return;
    const controller = new AbortController();
    cancelRequest.current = controller;
    const client = personalMcpApi(api, () => controller.signal);
    setConfirmingCancel(false);
    setCancellation({ id: order.id, state: 'submitting' });
    let submitted = false;
    try {
      const { action } = await client.prepareRideCancellation(order.orderId);
      if (controller.signal.aborted) return;
      if (!action || !matchesCancellation(action, order.orderId)) throw new Error('Mismatched cancellation');
      let outcome = action;
      if (action.status === 'pending') {
        submitted = true;
        outcome = await client.confirm(action.id);
      }
      if (!controller.signal.aborted) {
        setCancellation({ id: order.id, state: outcome.id === action.id && matchesCancellation(outcome, order.orderId)
          ? cancellationOutcome(outcome) : 'unknown' });
      }
    } catch {
      if (!controller.signal.aborted) setCancellation({ id: order.id, state: submitted ? 'unknown' : 'retry' });
    } finally {
      if (cancelRequest.current === controller) cancelRequest.current = null;
    }
  };

  const showVehicle = () => {
    if (!actionId || !canSeeMap || currentMap?.loading) return;
    if (!inTrip && !order?.pickup && !sandbox) locationAccess.current = { id: actionId, prompt: true };
    setMap({ id: actionId, result: mapResult, loading: true });
    setMapRefresh(value => value + 1);
  };

  const live = foreground && !stale;
  const etaMinutes = active && live && ride?.eta != null && Number.isFinite(ride.eta) ? Math.round(ride.eta) : 0;
  const eta = etaMinutes > 0 ? `约 ${etaMinutes} 分钟` : '';
  const barSubtitle = [sandbox ? '模拟行程' : '',
    stale ? '同步中断 · 保留上次状态' : ride?.to || '滴滴出行'].filter(Boolean).join(' · ');
  const syncTime = current && new Date(current.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const distanceKm = ride?.distance_km ?? mapResult?.routeKm;
  const mapTime = mapResult && new Date(mapResult.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const mapTitle = mapResult?.target
    ? mapResult.targetLabel === '我的位置' ? '我和车辆的位置' : `车辆与${mapResult.targetLabel}` : '车辆位置';
  const mapAction = !inTrip && !order?.pickup && !sandbox && !mapResult?.target
    ? '使用手机位置' : mapResult ? '刷新地图位置' : '重试地图';
  const routeLabel = mapResult?.routeSource === 'didi' ? '滴滴预计路线'
    : mapResult?.routeSource === 'amap' ? '高德预计路线' : '预计路线暂不可用';
  const vehicleDescription = [ride?.driver, ride?.car].filter(Boolean).join(' · ');
  const cancellationMessage = cancelState === 'submitting' ? '正在向滴滴确认取消…'
    : cancelState === 'unknown' && active ? '暂未确认取消结果，请在滴滴核对行程。'
    : cancelState === 'failed' && active ? '取消未成功，请在滴滴查看行程。'
    : cancelState === 'retry' && active ? '暂时无法发起取消，请稍后重试。' : '';
  if (!active && !open) return null;
  return <>
    {active && <Pressable accessibilityRole="button" accessibilityLabel={`查看滴滴行程，${title}`}
      accessibilityHint="打开行程详情" accessibilityValue={{ text: eta ? `${barSubtitle} · ${eta}` : barSubtitle }}
      accessibilityLiveRegion="polite"
      onPress={() => setOpen(true)} style={({ pressed }) => [styles.bar, pressed && styles.pressed]}>
      <View style={styles.barIcon}>
        {matching ? <ActivityIndicator size="small" color={colors.action} /> : <Icon name="car" size={19} color={colors.action} />}
      </View>
      <View style={styles.copy}>
        <Text style={styles.barTitle}>{title}</Text>
        <Text numberOfLines={1} style={styles.secondary}>{barSubtitle}</Text>
      </View>
      {eta ? <Text style={styles.barEta}>{eta}</Text> : null}
      <Icon name="chevronRight" size={15} color={colors.secondary} />
    </Pressable>}
    <Modal visible={open} transparent animationType="slide"
      onRequestClose={() => { if (confirmingCancel) setConfirmingCancel(false); else close(); }}
      statusBarTranslucent navigationBarTranslucent>
      <View style={styles.overlay}>
        <Pressable style={styles.scrim} accessible={false} importantForAccessibility="no" onPress={close} />
        <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.sheet}
          accessibilityViewIsModal testID="didi-ride-sheet">
          <View style={styles.header}>
            <View style={styles.copy}>
              <Text style={styles.eyebrow}>{sandbox ? '滴滴出行 · 模拟行程' : '滴滴出行'}</Text>
              <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>{title}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭行程详情"
              disabled={cancelState === 'submitting'} onPress={close}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <Icon name="close" size={20} color={colors.secondary} />
            </Pressable>
          </View>
          <ScrollView ref={detailsScroll} style={styles.details} contentContainerStyle={styles.content} bounces={false}
            onContentSizeChange={() => { if (canCancel && confirmingCancel) detailsScroll.current?.scrollToEnd(); }}>
            {stale && active && <Text accessibilityLiveRegion="polite" style={styles.syncWarning}>
              同步暂时中断，以下为上次收到的行程信息。
            </Text>}
            {cancelState !== 'success' && Boolean(ride?.plate || vehicleDescription || eta) &&
              <View style={[styles.vehicle, stackDetails && styles.vehicleStack]}>
              {Boolean(ride?.plate || vehicleDescription) && <View style={stackDetails ? undefined : styles.copy}>
                {ride?.plate ? <>
                  <Text style={styles.secondary}>车牌号</Text>
                  <Text selectable style={styles.plate}>{ride.plate}</Text>
                </> : null}
                {vehicleDescription ? <Text style={styles.vehicleInfo}>{vehicleDescription}</Text> : null}
              </View>}
              {eta ? <View accessibilityLiveRegion="polite" style={[styles.etaBadge, stackDetails && styles.etaStack]}>
                <Text style={styles.secondary}>{inTrip ? '预计到达' : '预计接驾'}</Text>
                <Text style={styles.etaUnit}><Text style={styles.etaNumber}>{etaMinutes}</Text> 分钟</Text>
              </View> : null}
            </View>}
            {canSeeMap && <View style={styles.mapSection}>
              {mapResult && <View style={styles.mapCard}>
                <View style={styles.mapCaption}>
                  <Text style={[styles.copy, styles.mapTitle]}>{mapTitle}</Text>
                  <Text style={styles.secondary}>{mapResult.image ? '高德底图' : '路线示意'}</Text>
                </View>
                <View style={styles.map} accessible accessibilityLabel={mapResult.target ? mapTitle + '地图' : '司机车辆位置地图'}>
                  {mapResult.image && <Image source={{ uri: mapResult.image }} resizeMode="stretch" style={StyleSheet.absoluteFill} />}
                  <Svg width="100%" height="100%" viewBox="0 0 500 320" style={StyleSheet.absoluteFill}>
                    {mapResult.route ? <>
                      <Polyline points={mapResult.route} fill="none" stroke="#FFF" strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" />
                      <Polyline points={mapResult.route} fill="none" stroke={vehicleColor} strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
                    </> : null}
                    {mapResult.target && <RideMapPin point={mapResult.target} label={mapResult.targetLabel} />}
                    <RideMapPin point={mapResult.vehicle} label="车辆" car />
                  </Svg>
                </View>
                <View style={styles.mapLegend}>
                  {mapResult.target && <View style={styles.legendItem}>
                    <View style={[styles.legendDot, { backgroundColor: targetColor }]} />
                    <Text style={styles.secondary}>{mapResult.targetLabel}</Text>
                  </View>}
                  <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: vehicleColor }]} />
                    <Text style={styles.secondary}>车辆位置</Text></View>
                  {mapResult.target && <Text style={styles.secondary}>{routeLabel}</Text>}
                </View>
                {!mapResult.target && (inTrip || !sandbox) && <Text style={styles.secondary}>
                  {inTrip ? '暂未获取订单的目的地坐标，仅显示车辆。' : '暂未获取订单上车点，仅显示车辆。'}
                </Text>}
                <View style={styles.mapLegend}>
                  {inTrip && typeof distanceKm === 'number' && Number.isFinite(distanceKm) &&
                    <Text style={styles.secondary}>{`剩余 ${distanceKm < 1 ? `${Math.round(distanceKm * 1000)} 米` : `${distanceKm.toFixed(1)} 公里`}`}</Text>}
                  <Text style={styles.secondary}>位置更新于 {mapTime}</Text>
                </View>
              </View>}
              {currentMap?.error && <Text style={styles.secondary} accessibilityLiveRegion="polite">
                {mapResult ? '地图暂未更新，当前显示上次的位置。' : '暂时无法显示车辆地图，可稍后再试或在滴滴查看。'}
              </Text>}
              {!mapResult && !currentMap?.error && <View style={styles.mapCard} accessibilityLiveRegion="polite">
                <ActivityIndicator size="small" color={colors.action} />
                <Text style={styles.secondary}>正在加载行程地图…</Text>
              </View>}
              {(mapResult || currentMap?.error) && <Pressable accessibilityRole="button"
                accessibilityLabel={mapAction}
                accessibilityState={{ busy: Boolean(currentMap?.loading) }}
                disabled={currentMap?.loading} onPress={showVehicle}
                style={({ pressed }) => [styles.mapButton, pressed && styles.pressed]}>
                {currentMap?.loading ? <ActivityIndicator size="small" color={colors.surface} />
                  : <Icon name="mapPin" size={19} color={colors.surface} />}
                <Text style={styles.mapButtonText}>
                  {currentMap?.loading ? '正在更新位置…' : mapAction}
                </Text>
                {!currentMap?.loading && <View pointerEvents="none" style={styles.mapArrow}>
                  <Icon name="arrowRight" size={17} color={colors.surface} />
                </View>}
              </Pressable>}
            </View>}
            {Boolean(ride?.from || ride?.to) && <View style={styles.route}>
              {!!ride?.from && <View style={styles.routeRow}>
                <View style={styles.stopColumn}>
                  <View style={styles.stop} />
                  {!!ride.to && <View style={styles.connector} />}
                </View>
                <View style={[styles.copy, ride.to ? styles.routeSpacing : null]}>
                  <Text style={styles.secondary}>上车点</Text>
                  <Text style={styles.address}>{ride.from}</Text>
                </View>
              </View>}
              {!!ride?.to && <View style={styles.routeRow}>
                <View style={styles.stopColumn}><View style={[styles.stop, styles.endStop]} /></View>
                <View style={styles.copy}>
                  <Text style={styles.secondary}>目的地</Text>
                  <Text style={styles.address}>{ride.to}</Text>
                </View>
              </View>}
            </View>}
            {active && notificationPermission && notificationPermission !== 'granted' &&
              <Pressable accessibilityRole="button" accessibilityLabel="开启系统行程通知" style={styles.notification}
                onPress={() => { void platform.manageNotificationPermission().then(setNotificationPermission).catch(() => {}); }}>
                <Icon name="bell" size={17} color={colors.action} />
                <Text style={[styles.copy, styles.notificationText]}>开启系统行程通知</Text>
                <Icon name="chevronRight" size={15} color={colors.secondary} />
              </Pressable>}
            {cancellationMessage ? <Text accessibilityLiveRegion="polite" style={styles.syncWarning}>{cancellationMessage}</Text> : null}
            {(syncTime || canCancel) && <View style={styles.footer}>
              <View style={[styles.copy, styles.syncNote]}>
                {!!syncTime && <>
                  <Icon name="clock" size={14} color={colors.secondary} />
                  <Text style={styles.syncLabel}>更新于 {syncTime}</Text>
                </>}
              </View>
              {canCancel && <Pressable accessibilityRole="button" accessibilityLabel="取消行程"
                accessibilityState={{ expanded: confirmingCancel }}
                onPress={() => setConfirmingCancel(value => !value)} style={styles.cancelLink}>
                <Text style={styles.cancelText}>取消行程</Text>
              </Pressable>}
            </View>}
            {canCancel && confirmingCancel && <View style={styles.cancelPanel}>
              <Text style={styles.confirmTitle}>确定取消这趟行程吗？</Text>
              <Text style={styles.secondary}>是否产生取消费用以滴滴为准。</Text>
              <View style={[styles.cancelActions, stackDetails && styles.cancelActionsStack]}>
                <Pressable accessibilityRole="button" accessibilityLabel="继续乘车"
                  onPress={() => setConfirmingCancel(false)}
                  style={({ pressed }) => [styles.cancelAction, styles.keepRide, pressed && styles.pressed]}>
                  <Text style={styles.keepRideText}>继续乘车</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="确认取消行程"
                  onPress={() => { void cancelRide(); }}
                  style={({ pressed }) => [styles.cancelAction, styles.confirmCancel, pressed && styles.pressed]}>
                  <Text style={styles.confirmCancelText}>确认取消</Text>
                </Pressable>
              </View>
            </View>}
            {cancelState === 'success' && <Text accessibilityLiveRegion="polite" style={styles.cancelledNote}>
              这趟行程已取消。
            </Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  bar: { marginHorizontal: 18, marginBottom: 8, minHeight: 58, paddingHorizontal: 11, paddingVertical: 8,
    borderRadius: 16, backgroundColor: '#E7EFFE', flexDirection: 'row', alignItems: 'center', gap: 9 },
  barIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#DFE9FC',
    alignItems: 'center', justifyContent: 'center' },
  barTitle: { fontSize: 14, fontWeight: '700', color: colors.ink },
  barEta: { fontSize: 12, fontWeight: '600', color: colors.action, maxWidth: '29%', textAlign: 'right' },
  copy: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.74 },
  overlay: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(27,41,72,0.36)' },
  sheet: { alignSelf: 'center', width: '100%', maxWidth: 560, maxHeight: '90%', backgroundColor: colors.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  eyebrow: { fontSize: 12, color: colors.secondary, marginBottom: 2 },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F1F5FC',
    alignItems: 'center', justifyContent: 'center' },
  details: { flexGrow: 0, flexShrink: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 14, gap: 10 },
  secondary: { fontSize: 12, color: colors.secondary },
  syncWarning: { fontSize: 13, color: colors.amber, backgroundColor: colors.amberLight, padding: 12, borderRadius: 12 },
  vehicle: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 11,
    borderRadius: 16, backgroundColor: '#F1F5FC' },
  vehicleStack: { flexDirection: 'column', alignItems: 'stretch' },
  plate: { fontSize: 24, fontWeight: '700', letterSpacing: 0.4, color: colors.ink, marginBottom: 2 },
  vehicleInfo: { fontSize: 12, color: colors.secondary },
  etaBadge: { flexShrink: 1, maxWidth: '44%', borderRadius: 12, backgroundColor: colors.surface, padding: 8,
    minWidth: 76, alignItems: 'center' },
  etaStack: { alignSelf: 'flex-start', maxWidth: '100%' },
  etaUnit: { fontSize: 12, color: '#385FC1', textAlign: 'center' },
  etaNumber: { fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
  route: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  routeRow: { flexDirection: 'row', gap: 10 },
  stopColumn: { width: 14, alignItems: 'center', paddingTop: 4 },
  stop: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: '#25816A', backgroundColor: colors.surface },
  endStop: { borderColor: colors.action, backgroundColor: colors.action },
  connector: { flex: 1, width: 1, backgroundColor: '#D1DBED' },
  routeSpacing: { paddingBottom: 10 },
  address: { fontSize: 14, fontWeight: '600', color: colors.ink, marginTop: 2 },
  mapSection: { gap: 8 },
  mapCard: { padding: 10, gap: 8, borderRadius: 14, backgroundColor: '#F1F5FC' },
  mapCaption: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mapTitle: { fontSize: 14, fontWeight: '600', color: colors.ink },
  map: { aspectRatio: 500 / 320, overflow: 'hidden', borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  mapLegend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  mapButton: { minHeight: 46, borderRadius: 14, backgroundColor: '#3A61C2',
    flexDirection: 'row', gap: 8, paddingHorizontal: 37, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  mapButtonText: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: colors.surface },
  mapArrow: { position: 'absolute', right: 13 },
  notification: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  notificationText: { fontSize: 13, color: colors.action },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36, borderTopWidth: 1, borderTopColor: colors.line },
  syncNote: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  syncLabel: { flexShrink: 1, fontSize: 12, color: colors.secondary },
  cancelLink: { minHeight: 44, justifyContent: 'center', paddingLeft: 8 },
  cancelText: { fontSize: 13, fontWeight: '600', color: '#A2374C' },
  cancelPanel: { padding: 12, borderRadius: 14, gap: 5, backgroundColor: '#FFF1F3' },
  confirmTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  cancelActions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  cancelActionsStack: { flexDirection: 'column' },
  cancelAction: { flexGrow: 1, flexBasis: 0, minHeight: 44, padding: 8, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center' },
  keepRide: { backgroundColor: colors.surface },
  keepRideText: { fontSize: 14, fontWeight: '600', color: colors.ink, textAlign: 'center' },
  confirmCancel: { backgroundColor: '#A2374C' },
  confirmCancelText: { fontSize: 14, fontWeight: '600', color: colors.surface, textAlign: 'center' },
  cancelledNote: { fontSize: 13, color: colors.secondary, backgroundColor: '#F1F5FC', padding: 12, borderRadius: 12 },
});
