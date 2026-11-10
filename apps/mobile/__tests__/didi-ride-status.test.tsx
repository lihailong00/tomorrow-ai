import React from 'react';
import { AppState, Modal, StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { DidiRideStatus } from '../src/features/personal-mcp/DidiRideStatus';
import { deviceLocation } from '../src/platform/deviceLocation';
import { platform } from '../src/platform/ports';

jest.setTimeout(30_000);

jest.mock('../src/platform/ports', () => ({
  platform: { updateRideNotification: jest.fn().mockResolvedValue(undefined),
    notificationPermissionStatus: jest.fn().mockResolvedValue('granted') },
}));

test('only confirmed orders poll, a temporary failure pauses matching animation, and completion clears the notification', async () => {
  const previous = AppState.currentState;
  AppState.currentState = 'active';
  const pending = new Map<number, () => void>();
  const realSetTimeout = globalThis.setTimeout;
  const timer = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
    if (delay !== 30_000 && delay !== 60_000 && delay !== 120_000) return realSetTimeout(callback, delay);
    pending.set(delay, callback);
    return delay;
  }) as typeof setTimeout);
  const advance = async (delay: number) => {
    const callback = pending.get(delay);
    expect(callback).toBeDefined();
    pending.delete(delay);
    await act(async () => { callback?.(); });
  };
  let tree: ReactTestRenderer | undefined;
  try {
    const receipt = { id: 'real', provider: 'didi', tool: 'taxi_create_order', status: 'completed',
      result: { structuredContent: { orderId: 'fixture-order' } } };
    const request = jest.fn<Promise<unknown>, [string]>();
    const status = { status: 0, environment: 'sandbox', to: '示例机场' };
    request.mockImplementation(async path => {
      if (path === '/personal-mcp/actions') return { items: [{ ...receipt, id: 'draft', status: 'pending' }, receipt] };
      if (path !== '/personal-mcp/actions/real/ride-status') throw new Error('unexpected request');
      const polls = request.mock.calls.filter(([value]) => value.endsWith('/ride-status')).length;
      if (polls === 2) throw new Error('offline');
      return { ...status, status: polls === 1 ? 0 : 5 };
    });
    const context = { api: { request }, revision: 0 } as unknown as AppContextValue;
    await act(async () => { tree = create(<AppProvider value={context}><DidiRideStatus /></AppProvider>); });
    await act(async () => {});
    expect(platform.updateRideNotification).toHaveBeenLastCalledWith('模拟行程 · 正在呼叫', true);
    await advance(30_000);
    expect(platform.updateRideNotification).toHaveBeenLastCalledWith('模拟行程 · 上次同步 · 正在呼叫', false);
    await advance(60_000);
    expect(platform.updateRideNotification).toHaveBeenLastCalledWith('', false);
    expect(pending.size).toBe(0);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/ride-status'))).toHaveLength(3);
  } finally {
    await act(async () => tree?.unmount());
    timer.mockRestore();
    AppState.currentState = previous;
  }
});

test.each([true, false, 'offline'] as const)('ride map handles current or missing location and cancellation reflects provider result %s', async success => {
  const previous = AppState.currentState;
  AppState.currentState = 'active';
  const locate = jest.spyOn(deviceLocation, 'requestCurrentLocation');
  if (success === true) {
    locate.mockResolvedValue({
      longitude: 121.18, latitude: 31.16, accuracy_m: 12, observed_at: new Date().toISOString(),
      coordinate_system: 'wgs84', source: 'current', age_ms: 0, stale: false,
    });
  } else if (success === false) {
    locate.mockRejectedValue(new Error('permission denied'));
  } else {
    locate.mockResolvedValue({
      longitude: 121.18, latitude: 31.16, accuracy_m: 12, observed_at: new Date().toISOString(),
      coordinate_system: 'wgs84', source: 'last_known', age_ms: 0, stale: true,
    });
  }
  let tree: ReactTestRenderer | undefined;
  try {
    const receipt = { id: 'ride', provider: 'didi', tool: 'taxi_create_order', status: 'completed',
      result: { structuredContent: { orderId: 'fixture-order' } } };
    const action = { id: 'cancel', provider: 'didi', tool: 'taxi_cancel_order', status: 'pending', arguments: { order_id: 'fixture-order' } };
    const ride = { status: 1, from: '示例公园北门', to: '示例机场', eta: 3, plate: '测试车牌' };
    let mapReads = 0;
    const request = jest.fn<Promise<unknown>, [string, string?, { operation?: string; tool?: string }?, AbortSignal?]>(async (path, _, body) => {
      switch (path) {
        case '/personal-mcp/actions': return { items: [receipt] };
        case '/personal-mcp/actions/ride/ride-status': return ride;
        case '/personal-mcp/actions/ride/ride-status?include_vehicle=true':
          if (mapReads >= 2) throw new Error('offline');
          return { ...ride, vehicle: { longitude: 121.17, latitude: 31.15 } };
        case '/integrations/amap/read':
          if (body?.operation === 'route') throw new Error('route unavailable');
          mapReads++;
          return { image: 'data:image/png;base64,AAAA' };
        case '/personal-mcp/didi/call': return { action };
        case '/personal-mcp/actions/cancel/confirm':
          if (success === 'offline') throw new Error('offline');
          return { ...action, status: 'completed', result: { structuredContent: { success } } };
        default: throw new Error('unexpected request');
      }
    });
    const context = { api: { request }, revision: 0 } as unknown as AppContextValue;
    await act(async () => { tree = create(<AppProvider value={context}><DidiRideStatus /></AppProvider>); });
    await act(async () => {});
    const root = tree!.root;
    const labelled = (label: string) => root.findAll(node =>
      node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
    const press = async (label: string) => {
      const button = labelled(label);
      expect(button).toBeDefined();
      await act(async () => { button!.props.onPress(); });
    };
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/personal-mcp/actions', '/personal-mcp/actions/ride/ride-status']);
    await press('查看滴滴行程，司机已接单');
    const sheet = root.findAllByProps({ testID: 'didi-ride-sheet' })[0];
    expect(StyleSheet.flatten(sheet.props.style).backgroundColor).toBe('#FFFFFF');
    expect(labelled('关闭行程详情')).toBeDefined();
    const details = JSON.stringify(tree!.toJSON());
    expect(details).toContain('车牌号');
    expect(details).toContain('预计接驾');
    expect(details).toContain('示例公园北门');
    expect(locate).not.toHaveBeenCalled();
    await press('使用手机位置');
    expect(request).toHaveBeenCalledWith('/personal-mcp/actions/ride/ride-status?include_vehicle=true', 'GET', undefined, expect.anything());
    const mapLabel = success === true ? '我和车辆的位置地图' : '司机车辆位置地图';
    const mapRequest = request.mock.calls.filter(([path, , body]) => path === '/integrations/amap/read' && body?.operation === 'map_view').at(-1)?.[2] as { location: string; zoom: number };
    if (success === true) {
      expect(mapRequest.location).not.toBe('121.170000,31.150000');
      expect(mapRequest.zoom).toBeLessThan(17);
      expect(JSON.stringify(tree!.toJSON())).toContain('预计路线暂不可用');
    } else {
      expect(mapRequest).toMatchObject({ location: '121.170000,31.150000', zoom: 15 });
      expect(JSON.stringify(tree!.toJSON())).toContain('暂未获取订单上车点，仅显示车辆');
    }
    await press(success === true ? '刷新地图位置' : '使用手机位置');
    expect(root.findAllByProps({ accessibilityLabel: mapLabel }).length).toBeGreaterThan(0);
    expect(JSON.stringify(tree!.toJSON())).toContain('当前显示上次的位置');
    // Allow the next refresh to complete before checking cancellation.
    mapReads = 1;
    await press(success === true ? '刷新地图位置' : '使用手机位置');
    await press('取消行程');
    expect(labelled('取消行程')?.props.accessibilityState.expanded).toBe(true);
    await press('继续乘车');
    expect(labelled('确认取消行程')).toBeUndefined();
    expect(request.mock.calls.some(([path]) => path.endsWith('/didi/call'))).toBe(false);
    await press('取消行程');
    await press('确认取消行程');
    expect(request).toHaveBeenCalledWith('/personal-mcp/didi/call', 'POST', { tool: 'taxi_cancel_order', arguments: { order_id: 'fixture-order' } }, expect.anything());
    expect(request.mock.calls.filter(([path]) => path.endsWith('/confirm'))).toHaveLength(1);
    const expected = success === true ? '行程已取消' : success === false ? '取消未成功，请在滴滴查看行程。' : '暂未确认取消结果，请在滴滴核对行程。';
    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain(expected);
    if (success !== true) expect(rendered).not.toContain('行程已取消');
    expect(labelled('取消行程')).toBeUndefined();
    await press('关闭行程详情');
    expect(root.findAllByType(Modal).every(modal => !modal.props.visible)).toBe(true);
  } finally {
    await act(async () => tree?.unmount());
    locate.mockRestore();
    AppState.currentState = previous;
  }
});

test('the map opens automatically, uses DiDi geometry, and falls back if DiDi cannot route from the new position', async () => {
  const previous = AppState.currentState;
  AppState.currentState = 'active';
  const locate = jest.spyOn(deviceLocation, 'requestCurrentLocation').mockResolvedValue({
    longitude: 121.18, latitude: 31.16, accuracy_m: 12, observed_at: new Date().toISOString(),
    coordinate_system: 'wgs84', source: 'current', age_ms: 0, stale: false,
  });
  let tick: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  const timer = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
    if (delay !== 15_000) return realSetTimeout(callback, delay);
    tick = callback;
    return delay;
  }) as typeof setTimeout);
  const realClearTimeout = globalThis.clearTimeout;
  const clear = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(value => {
    if (value === 15_000) tick = undefined;
    else realClearTimeout(value);
  });
  let tree: ReactTestRenderer | undefined;
  try {
    const receipt = { id: 'ride', provider: 'didi', tool: 'taxi_create_order', status: 'completed',
      result: { structuredContent: { orderId: 'fixture-order', from: { longitude: 121.18, latitude: 31.16 },
        to: { longitude: 121.26, latitude: 31.19 } } } };
    const pickup = { status: 1, from: '示例公园北门', to: '示例机场', eta: 3,
      vehicle: { longitude: 121.17, latitude: 31.15 } };
    let trip = false;
    let step = 0;
    type RequestBody = { operation?: string; tool?: string; arguments?: { origin: string; destination: string } };
    const request = jest.fn<Promise<unknown>, [string, string?, RequestBody?, AbortSignal?]>(async (path, _, body) => {
      if (path === '/personal-mcp/actions') return { items: [receipt] };
      if (path.endsWith('/ride-status')) return pickup;
      if (path.endsWith('include_vehicle=true')) return trip
        ? { ...pickup, status: 4, eta: 12, distance_km: 6.3, vehicle: { longitude: 121.2 + step++ * 0.01, latitude: 31.16 } } : pickup;
      if (path.endsWith('/didi/call') && body?.tool === 'maps_direction_driving') {
        const toPoint = (value: string) => {
          const [longitude, latitude] = value.split(',').map(Number);
          return { longitude, latitude };
        };
        const args = body.arguments!;
        const geo_list = step > 1 ? [] : [toPoint(args.origin), toPoint(args.destination)];
        return { status: 'completed', result: { content: [{ text: JSON.stringify({ status: 'success', geo_list }) }] } };
      }
      if (body?.operation === 'route') return { geometry: [[121.21, 31.16], [121.23, 31.17], [121.26, 31.19]] };
      if (body?.operation === 'map_view' && step === 1) throw new Error('no basemap');
      if (body?.operation === 'map_view') return { image: 'data:image/png;base64,AAAA' };
      throw new Error('unexpected request');
    });
    const context = { api: { request }, revision: 0 } as unknown as AppContextValue;
    await act(async () => { tree = create(<AppProvider value={context}><DidiRideStatus /></AppProvider>); });
    const press = async (label: string) => {
      const button = tree!.root.findAll(node =>
        node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
      expect(button).toBeDefined();
      await act(async () => { button.props.onPress(); });
    };
    const advance = async () => {
      const callback = tick;
      expect(callback).toBeDefined();
      tick = undefined;
      await act(async () => { callback?.(); });
    };
    await press('查看滴滴行程，司机已接单');
    expect(JSON.stringify(tree!.toJSON())).toContain('车辆与上车点');

    trip = true;
    await advance();
    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain('车辆与目的地');
    expect(rendered).not.toContain('车辆与上车点');
    expect(rendered).toContain('剩余 6.3 公里');
    expect(rendered).toContain('滴滴预计路线');
    expect(rendered).toContain('路线示意');
    await advance();
    expect(JSON.stringify(tree!.toJSON())).toContain('高德预计路线');
    expect(request.mock.calls.filter(([, , body]) => body?.tool === 'maps_direction_driving').map(([, , body]) => body?.arguments))
      .toEqual([
        { origin: '121.170000,31.150000', destination: '121.180000,31.160000' },
        { origin: '121.200000,31.160000', destination: '121.260000,31.190000' },
        { origin: '121.210000,31.160000', destination: '121.260000,31.190000' },
      ]);
    expect(request.mock.calls.filter(([, , body]) => body?.operation === 'route')).toHaveLength(1);
    expect(locate).not.toHaveBeenCalled();
    await press('关闭行程详情');
    expect(tick).toBeUndefined();
  } finally {
    await act(async () => tree?.unmount());
    timer.mockRestore();
    clear.mockRestore();
    locate.mockRestore();
    AppState.currentState = previous;
  }
});
