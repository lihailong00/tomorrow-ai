export type Point = {latitude: number; longitude: number};
export type DevicePoint = Point & {accuracy_m: number};
export type MapProvider = 'amap' | 'osm';
export type MapPlace = Point & {label: string; address?: string; distance?: number; children?: MapPlace[]};
export type SelectedPoint = MapPlace & {coordinate_system: 'wgs84' | 'gcj02'};
type Size = {width: number; height: number};
type Pixel = {x: number; y: number};
type Viewport = Point & {zoom: number};
type Api = {request<T>(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<T>};
type Locate = (signal: AbortSignal, explicit: boolean) => Promise<{latitude?: number; longitude?: number; accuracy_m?: number} | null>;
type State = {
  provider: MapProvider | null; notice: string; viewport: Viewport; size: Size; fix: DevicePoint | null;
  locating: boolean; locationStatus: string; anchor: Point; areaSearch: boolean; radius: 5000 | 20000 | 50000;
  query: string; results: MapPlace[]; selected: MapPlace | null; searching: boolean; resolving: boolean;
  searchStatus: string; image?: {uri: string; viewport: Viewport; size: Size};
};

const radians = Math.PI / 180;
const defaultCenter = {latitude: 31.2304, longitude: 121.4737};
const maxLatitude = 85.05112878;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrap = (value: number, size: number) => (value % size + size) % size;
export const osmAttribution = '© OpenStreetMap contributors';
export const osmCopyrightUrl = 'https://www.openstreetmap.org/copyright';
export const osmTileOrigin = 'https://tile.openstreetmap.org';

export function distanceMeters(a: Point, b: Point): number {
  const h = Math.sin((a.latitude - b.latitude) * radians / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) *
    Math.sin((a.longitude - b.longitude) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function project(point: Point, zoom: number): Pixel {
  const world = 256 * 2 ** zoom;
  const lat = clamp(point.latitude, -maxLatitude, maxLatitude);
  return {x: (point.longitude + 180) / 360 * world, y: (1 - Math.asinh(Math.tan(lat * radians)) / Math.PI) / 2 * world};
}
function unproject(pixel: Pixel, zoom: number): Point {
  const world = 256 * 2 ** zoom;
  return {longitude: wrap(pixel.x, world) / world * 360 - 180,
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * clamp(pixel.y, 0, world) / world))) / radians};
}
export function screenPoint(point: Point, viewport: Viewport, size: Size): Pixel {
  const center = project(viewport, viewport.zoom);
  const pixel = project(point, viewport.zoom);
  const world = 256 * 2 ** viewport.zoom;
  return {x: size.width / 2 + wrap(pixel.x - center.x + world / 2, world) - world / 2,
    y: size.height / 2 + pixel.y - center.y};
}
export function pixelRadius(point: Point, zoom: number, meters: number): number {
  return Math.max(7, meters * 256 * 2 ** zoom / (40_075_017 * Math.cos(clamp(point.latitude, -maxLatitude, maxLatitude) * radians)));
}
export function visibleTiles(viewport: Viewport, size: Size) {
  if (!size.width || !size.height) return [];
  const center = project(viewport, viewport.zoom);
  const left = center.x - size.width / 2;
  const top = center.y - size.height / 2;
  const tiles = [];
  const count = 2 ** viewport.zoom;
  for (let y = Math.max(0, Math.floor(top / 256)); y < Math.min(count, Math.ceil((top + size.height) / 256)); y++) {
    for (let x = Math.floor(left / 256); x < Math.ceil((left + size.width) / 256); x++) {
      tiles.push({key: `${viewport.zoom}/${x}/${y}`, uri: `${osmTileOrigin}/${viewport.zoom}/${wrap(x, count)}/${y}.png`,
        x: x * 256 - left, y: y * 256 - top});
    }
  }
  return tiles;
}

// Same GCJ-02 transform used by the chat server. The device fix remains WGS84.
export function displayPoint<T extends Point>(point: T, provider: MapProvider): T {
  const {latitude, longitude} = point;
  if (provider === 'osm' || longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) return point;
  const x = longitude - 105;
  const y = latitude - 35;
  const wave = (v: number, a: number, b: number, c: number, d: number) =>
    (20 * Math.sin(v * Math.PI) + a * Math.sin(v * Math.PI / 3) +
      b * Math.sin(v * Math.PI / 12) + c * Math.sin(v * Math.PI / 30)) * d;
  const common = (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  const latOffset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + common + wave(y, 40, 160, 320, 2 / 3);
  const lonOffset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + common + wave(x, 40, 150, 300, 2 / 3);
  const magic = 1 - 0.00669342162296594323 * Math.sin(latitude * radians) ** 2;
  const root = Math.sqrt(magic);
  return {...point, latitude: latitude + latOffset / (radians * 6378245 * (1 - 0.00669342162296594323) / (magic * root)),
    longitude: longitude + lonOffset / (radians * 6378245 / root * Math.cos(latitude * radians))};
}

function validPoint(latitude: unknown, longitude: unknown): Point | null {
  return typeof latitude === 'number' && typeof longitude === 'number' &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? {latitude, longitude} : null;
}
function label(value: unknown, limit = 200) {
  return typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, limit).join('') : '';
}
type AmapPoi = {title?: unknown; address?: unknown; location?: unknown; children?: AmapPoi[]};
function amapPlace(poi: AmapPoi): MapPlace | null {
  const [lon, lat] = typeof poi?.location === 'string' ? poi.location.split(',') : [];
  const point = lat && lon ? validPoint(Number(lat), Number(lon)) : null;
  const title = label(poi?.title);
  if (!point || !title) return null;
  return {...point, label: title, address: label(poi.address), children: Array.isArray(poi.children)
    ? poi.children.map(amapPlace).filter((item): item is MapPlace => !!item) : undefined};
}
type PhotonFeature = {geometry?: {coordinates?: unknown[]}; properties?: Record<string, unknown>};
function photonPlace(feature: PhotonFeature): MapPlace | null {
  const point = validPoint(feature?.geometry?.coordinates?.[1], feature?.geometry?.coordinates?.[0]);
  const props = feature?.properties ?? {};
  const address = [props.state, props.city, props.district, props.street, props.housenumber]
    .map(value => label(value)).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(' ');
  const title = label(props.name) || label(address);
  return point && title ? {...point, label: title, address} : null;
}
const coordinate = (point: Point) => `${point.longitude.toFixed(6)},${point.latitude.toFixed(6)}`;
const amap = <T>(api: Api, body: unknown, signal: AbortSignal) => api.request<T>('/integrations/amap/read', 'POST', body, signal);
async function photon(path: 'api' | 'reverse', parameters: Record<string, string>, signal: AbortSignal) {
  const query = Object.entries(parameters).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const response = await fetch(`https://photon.komoot.io/${path}/?${query}`, {signal});
  if (!response.ok) throw new Error('开源地点查询暂不可用');
  const result = await response.json() as {features?: PhotonFeature[]};
  return (Array.isArray(result.features) ? result.features : []).map(photonPlace).filter((item): item is MapPlace => !!item);
}
async function search(api: Api, provider: MapProvider, query: string, anchor: Point, radius: number, signal: AbortSignal) {
  let places: MapPlace[];
  if (provider === 'amap') {
    const result = await amap<{items?: AmapPoi[]}>(api, {operation: 'nearby', keywords: query, location: coordinate(anchor), radius_m: radius, limit: 15, map_picker: true}, signal);
    places = (result.items ?? []).map(amapPlace).filter((item): item is MapPlace => !!item);
  } else {
    // Restrict queries to a neighborhood, with a rounded public search focus.
    const lat = Number(anchor.latitude.toFixed(3));
    const lon = Number(anchor.longitude.toFixed(3));
    const dy = (radius + 100) / 111_000;
    const dx = dy / Math.max(0.01, Math.cos(lat * radians));
    const bbox = [Math.max(-180, lon - dx), Math.max(-90, lat - dy), Math.min(180, lon + dx), Math.min(90, lat + dy)].join(',');
    places = await photon('api', {q: query, lat: String(lat), lon: String(lon), bbox, limit: '20', location_bias_scale: '0.1'}, signal);
    // A generic school query can have zero text matches despite nearby school POIs.
    if (!places.length && (query === '中学' || query === '学校') && !signal.aborted) {
      places = await photon('reverse', {include: 'osm.amenity.school', lat: String(lat), lon: String(lon),
        radius: String((radius + 100) / 1000), limit: '20'}, signal);
      if (query === '中学') places = places.filter(place => /中学|高中|初中|附中|女中|secondary school|high school/i.test(place.label));
    }
  }
  return places.map(place => ({...place, distance: distanceMeters(anchor, place)}))
    .filter(place => place.distance <= radius).sort((a, b) => a.distance - b.distance);
}

export function createMapPicker(api: Api, locate: Locate, input: string) {
  let state: State = {
    provider: null, notice: '', viewport: {...defaultCenter, zoom: 12}, size: {width: 0, height: 250},
    fix: null, locating: false, locationStatus: '', anchor: defaultCenter, areaSearch: false, radius: 5000,
    query: input, results: [], selected: null, searching: false, resolving: false, searchStatus: '',
  };
  let wgsFix: DevicePoint | null = null;
  let active = false;
  let moved = false;
  let searchRequested = false;
  const listeners = new Set<() => void>();
  let boot: AbortController | undefined;
  let location: AbortController | undefined;
  let viewport: AbortController | undefined;
  let lookup: AbortController | undefined;
  let reverse: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let imageTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (change: Partial<State>) => {
    if (!active) return;
    state = {...state, ...change};
    listeners.forEach(listener => listener());
  };
  const setProvider = (provider: MapProvider, notice = '') => {
    const fix = wgsFix && displayPoint(wgsFix, provider);
    const center = fix ?? displayPoint(defaultCenter, provider);
    lookup?.abort(); reverse?.abort();
    publish({provider, notice, fix, viewport: {...center, zoom: fix ? 15 : 12}, anchor: center, areaSearch: false,
      selected: null, results: [], resolving: false, image: undefined});
    scheduleImage();
    scheduleSearch();
  };
  function scheduleImage() {
    if (imageTimer !== undefined) clearTimeout(imageTimer);
    viewport?.abort();
    if (state.provider !== 'amap' || state.size.width < 100) return;
    const request = new AbortController(); viewport = request;
    const {viewport: center, size} = state;
    const width = Math.min(800, Math.round(size.width));
    const height = Math.min(800, Math.round(size.height));
    imageTimer = setTimeout(() => {
      void amap<{image?: string}>(api, {operation: 'map_view', location: coordinate(center), zoom: center.zoom, width, height}, request.signal)
        .then(({image}) => {
          if (request.signal.aborted) return;
          if (!image || !/^data:image\/(?:png|jpeg);base64,[a-z\d+/=]+$/i.test(image)) throw new Error('Invalid map image');
          publish({image: {uri: image, viewport: center, size: {width, height}}});
        }).catch(() => {
          if (!request.signal.aborted) setProvider('osm', '高德地图暂不可用，已使用开源地图。');
        });
    }, 250);
  }
  function scheduleSearch() {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    lookup?.abort();
    const {provider, query, anchor, radius} = state;
    if (!provider || !searchRequested || !query.trim() || state.locating) {
      publish({searching: false, results: [], searchStatus: ''});
      return;
    }
    const request = new AbortController(); lookup = request;
    publish({searching: true, results: [], searchStatus: ''});
    searchTimer = setTimeout(() => {
      void search(api, provider, label(query, 80), anchor, radius, request.signal).then(results => {
        if (request.signal.aborted) return;
        publish({results, searching: false, searchStatus: results.length ? '' : '附近没有匹配地点，可以扩大搜索范围。'});
      }).catch(() => {
        if (!request.signal.aborted) publish({searching: false, searchStatus: '地点搜索暂不可用，可以点地图选点或直接使用输入的地址。'});
      });
    }, 550);
  }
  async function locateMap(explicit: boolean) {
    location?.abort();
    const request = new AbortController(); location = request;
    publish({locating: true, locationStatus: '正在定位…'});
    try {
      const result = await locate(request.signal, explicit);
      if (request.signal.aborted) return;
      const point = validPoint(result?.latitude, result?.longitude);
      if (!point || typeof result?.accuracy_m !== 'number' || !Number.isFinite(result.accuracy_m) || result.accuracy_m < 0) {
        publish({locationStatus: '暂未获得当前位置，可以重新定位或按地图选区搜索。'});
        return;
      }
      wgsFix = {...point, accuracy_m: result.accuracy_m};
      const fix = displayPoint(wgsFix, state.provider ?? 'osm');
      const center = explicit || !moved;
      publish({fix, locationStatus: '', ...(center ? {viewport: {...fix, zoom: 15}, anchor: fix, areaSearch: false} : {})});
      if (center) scheduleImage();
    } catch (error) {
      if (request.signal.aborted) return;
      const code = (error as {code?: string})?.code;
      const message = code === 'permission_denied' || code === 'permission_blocked' ? '请在系统或浏览器设置中允许定位。'
        : code === 'services_disabled' ? '系统定位服务已关闭。' : code === 'timeout' ? '定位超时，请重新定位。' : '暂时无法获取当前位置。';
      publish({locationStatus: message});
    } finally {
      if (!request.signal.aborted) {publish({locating: false}); scheduleSearch();}
    }
  }
  return {
    subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
    getSnapshot: () => state,
    start() {
      active = true;
      const request = new AbortController(); boot = request;
      void Promise.resolve().then(() => api.request<{items?: {id: string; status: string}[]}>('/integrations', 'GET', undefined, request.signal))
        .then(result => {
          if (request.signal.aborted) return;
          const amapStatus = result?.items?.find(item => item.id === 'amap')?.status;
          if (amapStatus === 'connected') setProvider('amap');
          else setProvider('osm', amapStatus === 'not_connected' ? '可在妥啦手机版的「能力」中连接自己的高德地图 Key。' : '服务器尚未接入高德地图，可请管理员配置。');
        }).catch(() => {if (!request.signal.aborted) setProvider('osm', '暂无法获取高德连接状态，正在使用开源地图。');});
      void locateMap(false);
      return () => {
        active = false;
        boot?.abort(); location?.abort(); viewport?.abort(); lookup?.abort(); reverse?.abort();
        if (searchTimer !== undefined) clearTimeout(searchTimer);
        if (imageTimer !== undefined) clearTimeout(imageTimer);
      };
    },
    locate: () => locateMap(true),
    size(size: Size) {
      if (Math.round(size.width) === Math.round(state.size.width) && Math.round(size.height) === Math.round(state.size.height)) return;
      publish({size}); scheduleImage();
    },
    move(dx: number, dy: number, settle = true) {
      if (!state.provider || !dx && !dy) return;
      const {viewport} = state;
      const pixel = project(viewport, viewport.zoom);
      moved = true;
      publish({viewport: {...unproject({x: pixel.x - dx, y: pixel.y - dy}, viewport.zoom), zoom: viewport.zoom}});
      if (settle) scheduleImage();
    },
    settle: scheduleImage,
    zoom(step: number) {
      if (!state.provider) return;
      const zoom = clamp(state.viewport.zoom + step, 3, state.provider === 'amap' ? 17 : 19);
      if (zoom === state.viewport.zoom) return;
      moved = true;
      publish({viewport: {...state.viewport, zoom}}); scheduleImage();
    },
    setQuery(query: string) {
      if (query === state.query) return;
      searchRequested = true;
      reverse?.abort();
      publish({query, selected: null, resolving: false});
      scheduleSearch();
    },
    setRadius(radius: State['radius']) {publish({radius}); scheduleSearch();},
    searchHere() {searchRequested = true; publish({anchor: state.viewport, areaSearch: true}); scheduleSearch();},
    select(place: MapPlace) {
      reverse?.abort();
      moved = true;
      publish({selected: place, resolving: false, viewport: {...place, zoom: Math.max(15, state.viewport.zoom)}});
      scheduleImage();
    },
    tap(x: number, y: number) {
      const {provider, viewport, size} = state;
      if (!provider) return;
      moved = true;
      const center = project(viewport, viewport.zoom);
      const point = unproject({x: center.x + x - size.width / 2, y: center.y + y - size.height / 2}, viewport.zoom);
      const place = {...point, label: `地图选点 ${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`};
      reverse?.abort();
      const request = new AbortController(); reverse = request;
      publish({selected: place, resolving: true});
      const address = provider === 'amap'
        ? amap<{address?: string}>(api, {operation: 'reverse_geocode', location: coordinate(point)}, request.signal).then(result => label(result.address))
        : photon('reverse', {lat: String(point.latitude), lon: String(point.longitude), limit: '1'}, request.signal).then(items => label(items[0]?.address || items[0]?.label));
      void address.then(value => {
        if (!request.signal.aborted && value) publish({selected: {...place, label: value}});
      }).catch(() => {}).finally(() => {if (!request.signal.aborted) publish({resolving: false});});
    },
    selection(): SelectedPoint | undefined {
      if (!state.selected || !state.provider) return;
      return {label: state.selected.label, latitude: state.selected.latitude, longitude: state.selected.longitude,
        coordinate_system: state.provider === 'amap' ? 'gcj02' : 'wgs84'};
    },
  };
}
