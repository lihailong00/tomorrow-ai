import type { RunInput } from './runtime.js';
import { verifiedMapPoint } from './tool-inputs.js';

type RecordValue = Record<string, unknown>;
type Point = { lng: number; lat: number };
type Place = { address: string; city: string; district: string; name: string; aliases: string[] };
const MAX_TRANSFER_KM = 5;
const RAIL = /地铁|轨道交通/;
const CAB = /打车|打(?:一|半)?段车|出租车|网约车|叫车/;
const FARE = /多少钱|啥价|什么价|费用|车费|估价|报价|价格/;
const BOOK_RIDE = /(?:帮我|给我|替我|直接|马上)(?:现在|先|就)?(?:叫(?:一[辆部])?车|打[一辆部]*车|下单)|(?:确认|同意)(?:叫车|下单)/;
const MAP_REQUEST = /地铁|轨道交通|公交|步行|走路|路线|导航|附近|周边|接驳|换乘|怎么走|怎么去|多久|用时|距离/;
const FARE_ONLY_EXTRA_TOOLS = new Set(['maps_place_around', 'maps_direction_driving', 'maps_direction_transit', 'maps_direction_walking']);
const FROM_HOME = /从(?:我家|家里|家)(?:到|去|出发|打车)|我家(?:到|去)/;
const NAMED_START = /从(?!我?(?:现在的|当前的)?(?:位置|这里|这儿))[^，。\n]{1,40}?(?:到|去|出发)/;

const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const str = (value: unknown) => typeof value === 'string' ? value : '';
const compact = (value: string) => value.replace(/\s/g, '');
const fail = (message: string) => ({ status: 'failed', error: { code: 'route_location_unverified', message } });
const building = /\d+(?:号楼|号|区|栋|幢|单元|室).*$/;
const districtPrefix = /^(?:[^省市]+省)?(?:[^省市]+市)?([^省市区\d]{1,12}区)/;
function withoutCity(value: string, city: string): string {
  if (value.startsWith(`${city}市`)) return value.slice(city.length + 1);
  return value.startsWith(city) ? value.slice(city.length) : value;
}

function place(address: string, aliases: string[]): Place | undefined {
  const match = /^(?:[^省市]+省)?([^省市]+市)([^省市区\d]{1,12}区)(.+)$/.exec(compact(address));
  if (!match) return undefined;
  const [, city = '', district = '', detail = ''] = match;
  const name = withoutCity(detail.replace(building, ''), city.slice(0, -1));
  return name.length >= 3 ? { address, city, district, name, aliases } : undefined;
}

function namesPlace(query: string, saved: Place): boolean {
  const value = compact(query).replace(building, '');
  const city = saved.city.slice(0, -1);
  return compact(query) === compact(saved.address) || saved.aliases.includes(query.trim()) ||
    [value, value.replace(districtPrefix, '')].some(text => withoutCity(text, city) === saved.name);
}

function inDistrict(item: RecordValue, saved: Place): boolean {
  const addresses = [compact(str(item.address_all)), compact(str(item.address))];
  const city = str(item.city).replace(/市$/, '');
  const addressDistricts = addresses.map(address => districtPrefix.exec(address)?.[1] ?? '')
    .filter(district => district && !/(?:小区|园区|校区|景区)$/.test(district));
  const districts = [str(item.district), ...addressDistricts].filter(Boolean);
  const name = withoutCity(compact(str(item.display_name)), saved.city.slice(0, -1));
  return (!city || city === saved.city.slice(0, -1)) && districts.length > 0 && districts.every(district => district === saved.district) &&
    (name.includes(saved.name) || addresses.some(address => address.includes(saved.name)));
}

function point(lng: unknown, lat: unknown): Point | undefined {
  const parse = (value: unknown) => typeof value === 'number' ? value : /^-?\d+(?:\.\d+)?$/.test(str(value).trim()) ? Number(value) : NaN;
  const x = parse(lng), y = parse(lat);
  return Math.abs(x) <= 180 && Math.abs(y) <= 90 && (x !== 0 || y !== 0) ? { lng: x, lat: y } : undefined;
}

function pair(value: unknown): Point | undefined {
  const parts = str(value).split(',');
  return parts.length === 2 ? point(parts[0], parts[1]) : undefined;
}

function distance(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(h, 1)));
}

function mapPoint(value: unknown): Point | undefined {
  const mapped = verifiedMapPoint(value);
  return mapped && { lng: mapped.longitude, lat: mapped.latitude };
}

// DiDi serializes POI lists inside the MCP text content. A successful but
// unrecognized payload cannot be used as evidence for a guarded search.
function candidates(response: RecordValue): RecordValue[] {
  const result = record(response.result);
  if (!Array.isArray(result?.content)) return [];
  return result.content.flatMap((value): RecordValue[] => {
    const text = str(record(value)?.text);
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(record).filter((item): item is RecordValue => !!item) : [];
    } catch { return []; }
  });
}

function poiPoint(item: RecordValue): Point | undefined {
  const location = record(item.location);
  return point(location?.lng, location?.lat);
}

export function travelGuard(input: RunInput) {
  const runtime = input.runtime_context;
  const recent = input.messages.filter(m => m.role === 'user').slice(-4).reverse();
  const latest = recent[0]?.content ?? '';
  const previous = recent[1]?.content ?? '';
  const transfer = input.scope === 'chat' && RAIL.test(latest) && (CAB.test(latest) || CAB.test(previous));
  const quoteOnly = input.scope === 'chat' && FARE.test(latest) && (CAB.test(latest) || CAB.test(previous)) && !BOOK_RIDE.test(latest);
  const home = place(runtime?.travel_places?.home ?? '', ['家', '我家', '家里', '家庭地址', '住址']);
  const work = place(runtime?.travel_places?.work ?? '', ['公司', '我公司', '工作地址', '公司地址', '上班地点']);
  const savedPlaces = [home, work].filter((item): item is Place => !!item);
  const tripText = latest + (transfer ? `\n${previous}` : '');
  const namedStart = NAMED_START.test(tripText);
  let origin = namedStart ? undefined : mapPoint(runtime?.location);
  const now = Date.parse(runtime?.server_time_utc ?? '');
  const recentlyHome = recent.slice(1).some(message => {
    const age = now - Date.parse(message.created_at ?? '');
    return age >= 0 && age < 15 * 60_000 && /^我(?:现在|目前)?(?:就)?在家(?:[，。！、,！!\s]|$)/.test(message.content);
  });
  let homeOrigin = !!home && (FROM_HOME.test(latest) || (transfer && FROM_HOME.test(previous)) ||
    (!origin && recentlyHome && /上班|去公司|通勤/.test(tripText) && !namedStart));
  if (homeOrigin) origin = undefined;
  const nearby = new Set<string>();
  const geocoded = new Map<string, string>();
  const key = ({ lng, lat }: Point) => `${lng.toFixed(5)},${lat.toFixed(5)}`;
  const remember = (items: RecordValue[]) => {
    for (const item of items) {
      const location = poiPoint(item);
      if (location) geocoded.set(key(location), str(item.display_name));
    }
  };

  return async (name: string, args: unknown, call: (args: unknown) => Promise<unknown>): Promise<unknown> => {
    if (name === 'request_location' && (transfer || homeOrigin)) {
      const result = await call(args);
      const answer = record(result);
      if (answer?.status === 'answered') {
        origin = mapPoint(answer.location);
        homeOrigin = false;
        nearby.clear();
      }
      return result;
    }
    const request = record(args);
    const params = record(request?.arguments);
    if (name !== 'call_mcp_tool' || request?.provider !== 'didi' || !params) return call(args);
    const tool = request.tool;
    if (quoteOnly && (tool === 'taxi_create_order' || (!MAP_REQUEST.test(latest) && typeof tool === 'string' && FARE_ONLY_EXTRA_TOOLS.has(tool)))) {
      return { status: 'failed', error: { code: 'ride_quote_only', message: '用户当前在询问车费。先核实必要地点并用 taxi_estimate 返回实际报价；明确要求叫车后再发起确认。' } };
    }
    const keywords = str(params.keywords);
    if (tool === 'maps_textsearch') {
      const saved = savedPlaces.find(item => namesPlace(keywords, item));
      const explicitDistrict = districtPrefix.exec(compact(keywords))?.[1];
      // A different district explicitly named by the user is a separate place.
      const explicitText = explicitDistrict ? compact(keywords).slice(compact(keywords).indexOf(explicitDistrict)) : '';
      const useSaved = saved && !(explicitDistrict && explicitDistrict !== saved.district && compact(latest).includes(explicitText));
      const response = await call(useSaved ? { ...request, arguments: { keywords: saved.address, city: saved.city } } : args);
      const envelope = record(response);
      if (envelope?.status !== 'completed') return response;
      const items = candidates(envelope);
      if (!useSaved) {
        if (transfer) remember(items);
        return response;
      }
      const matches = items.filter(item => inDistrict(item, saved) && poiPoint(item));
      if (!matches.length) return fail('地图没有返回与已保存地址同区且名称匹配的地点。请核对完整地址，不能使用其他区的地点或沿用旧坐标。');
      remember(matches);
      const verifiedHome = matches[0] && poiPoint(matches[0]);
      if (homeOrigin && saved === home && verifiedHome && (!origin || key(origin) !== key(verifiedHome))) {
        origin = verifiedHome;
        nearby.clear();
      }
      return { status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(matches) }] } };
    }

    if (transfer && tool === 'maps_place_around' && RAIL.test(keywords)) {
      const center = pair(params.location);
      if (!center || (origin ? distance(origin, center) > 0.05 : homeOrigin || !geocoded.has(key(center)))) {
        return fail('请先核对本次实际出发地，再以该地点查询附近地铁站。');
      }
      origin ??= center;
      const response = await call(args);
      const envelope = record(response);
      if (envelope?.status !== 'completed') return response;
      const matches = candidates(envelope).filter(item => {
        const station = poiPoint(item);
        if (!station || distance(center, station) > MAX_TRANSFER_KM) return false;
        nearby.add(key(station));
        return true;
      });
      if (!matches.length) return fail('地图未返回距出发地 5 公里直线范围内的地铁站。请查完整公交路线或说明没有核实到接驳站。');
      return { status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(matches) }] } };
    }

    if ((transfer || homeOrigin) && (tool === 'taxi_estimate' || tool === 'maps_direction_driving' || tool === 'maps_direction_transit')) {
      const from = tool === 'taxi_estimate' ? point(params.from_lng, params.from_lat) : pair(params.origin);
      const to = tool === 'taxi_estimate' ? point(params.to_lng, params.to_lat) : pair(params.destination);
      const fromStation = from && tool === 'maps_direction_transit' && nearby.has(key(from));
      if ((homeOrigin && !origin) || (origin && !fromStation && (!from || distance(origin, from) > 0.05))) {
        return fail('此路线或报价的起点与本次出发地不一致。请用核对后的出发地重新查询。');
      }
      if (transfer && ((!origin && (!from || !geocoded.has(key(from)))) ||
          !to || (!nearby.has(key(to)) && !geocoded.has(key(to))))) {
        return fail('请先查询本次起终点的实际地点，再用取得的坐标查路线和报价。');
      }
      const station = [to && geocoded.get(key(to)), str(params.to_name)].find(label =>
        label && (RAIL.test(label) || /站(?:[A-Z\d]*口)?$/.test(label)));
      const explicitlyNamed = station && station.length > 3 && compact(tripText).includes(compact(station));
      if (transfer && tool !== 'maps_direction_transit' && station && !explicitlyNamed && (!to || !nearby.has(key(to)))) {
        return fail('接驳车费只能使用从本次出发地查到的附近地铁站；请先查询附近车站。');
      }
    }
    return call(args);
  };
}
