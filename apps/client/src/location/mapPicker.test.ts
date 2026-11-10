import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMapPicker, displayPoint, screenPoint, visibleTiles} from '@tada/client-core';

const device = {latitude: 31.2, longitude: 121.45, accuracy_m: 35};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('map picker shared by desktop and mobile', () => {
  it('centers AMap on the converted device position, keeps the search anchor during drag and submits GCJ-02', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_path: string, _method?: string, body?: {operation: string; location: string}, _signal?: AbortSignal) => {
      if (!body) return {items: [{id: 'amap', status: 'connected'}]};
      if (body.operation === 'map_view') return {image: 'data:image/png;base64,aGVsbG8='};
      return {items: [
        {title: '较远的中学', location: '121.475,31.202'},
        {title: '附近的中学', location: '121.456,31.198', children: [{title: '南门', location: '121.455,31.198'}]},
        {title: '超出范围的中学', location: '121.900,31.200'},
      ]};
    });
    const picker = createMapPicker({
      request: <T,>(path: string, method?: string, body?: unknown, signal?: AbortSignal) =>
        request(path, method, body as {operation: string; location: string}, signal) as Promise<T>,
    }, async () => device, '');
    const stop = picker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const expected = displayPoint(device, 'amap');
      expect(picker.getSnapshot()).toMatchObject({provider: 'amap', fix: expected, viewport: expected});
      picker.size({width: 400, height: 248});
      picker.move(300, 50);
      picker.setQuery('中学');
      await vi.advanceTimersByTimeAsync(600);
      expect(request).toHaveBeenCalledWith('/integrations/amap/read', 'POST', expect.objectContaining({
        operation: 'nearby', radius_m: 5000, location: `${expected.longitude.toFixed(6)},${expected.latitude.toFixed(6)}`,
      }), expect.any(AbortSignal));
      const results = picker.getSnapshot().results;
      expect(results.map(place => place.label)).toEqual(['附近的中学', '较远的中学']);
      picker.select(results[0].children![0]);
      expect(picker.selection()).toEqual({label: '南门', longitude: 121.455, latitude: 31.198, coordinate_system: 'gcj02'});
    } finally {stop();}
  });

  it('keeps the OSM device position in WGS84 and reverse geocodes a separately tapped point', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({features: [{geometry: {coordinates: [121.45, 31.2]}, properties: {name: '示例道路'}}]}),
    }));
    vi.stubGlobal('fetch', fetch);
    const picker = createMapPicker({
      request: async <T,>() => ({items: [{id: 'amap', status: 'not_configured'}]} as T),
    }, async () => device, '');
    const stop = picker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const size = {width: 400, height: 240};
      picker.size(size);
      expect(picker.getSnapshot()).toMatchObject({provider: 'osm', fix: device, viewport: device});
      expect(screenPoint(device, picker.getSnapshot().viewport, size)).toEqual({x: 200, y: 120});
      expect(visibleTiles(picker.getSnapshot().viewport, size).length).toBeGreaterThan(0);
      picker.tap(220, 130);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      const selection = picker.selection()!;
      expect(selection).toMatchObject({label: '示例道路', coordinate_system: 'wgs84'});
      expect(selection.longitude).toBeGreaterThan(device.longitude);
      expect(picker.getSnapshot().fix).toEqual(device);
    } finally {stop();}
  });

  it('uses nearby school categories when Photon has no exact text matches for 中学', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string) => ({ok: true, json: async () => ({features: url.includes('/reverse/') ? [
      {geometry: {coordinates: [121.46, 31.2]}, properties: {name: '示例中学'}},
      {geometry: {coordinates: [121.451, 31.2]}, properties: {name: '示例小学'}},
    ] : []})}));
    vi.stubGlobal('fetch', fetch);
    const picker = createMapPicker({request: async <T,>() => ({items: []} as T)}, async () => device, '');
    const stop = picker.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      picker.setQuery('中学');
      await vi.advanceTimersByTimeAsync(600);
      expect(fetch.mock.calls[1][0]).toContain('include=osm.amenity.school');
      expect(picker.getSnapshot().results.map(place => place.label)).toEqual(['示例中学']);
    } finally {stop();}
  });
});
