/**
 * 侧栏天气数据源
 *
 * 页面 SSR 不直接请求第三方：侧栏只渲染空容器，前端再请求
 * /5iblog/api?routeType=weather。这里负责读配置、请求接口、标准化字段，
 * 并用 KV 做 10 分钟缓存（失败缓存 60 秒），避免每次访问都打第三方。
 *
 * 默认接口：UApiPro（https://uapis.cn/docs/api-reference/get-misc-weather）
 * 免费、无需注册，返回中文天气描述。自定义接口只要返回兼容字段即可。
 */

export const WEATHER_CACHE_KEY = 'weather:cache:v1';
const CACHE_TTL = 10 * 60 * 1000;
const FAIL_TTL = 60 * 1000;
const MAX_BODY = 64 * 1024;
const MAX_DAYS = 7;

export const DEFAULT_WEATHER_API =
  'https://uapis.cn/api/v1/misc/weather?city={city}&lang=zh&extended=true&forecast=true';

const WEATHER_CN = {
  clear: '晴',
  sunny: '晴',
  'mostly clear': '晴',
  'partly cloudy': '多云',
  cloudy: '多云',
  'mostly cloudy': '多云',
  overcast: '阴',
  rain: '雨',
  shower: '阵雨',
  'light rain': '小雨',
  'moderate rain': '中雨',
  'heavy rain': '大雨',
  thunder: '雷阵雨',
  thunderstorm: '雷阵雨',
  snow: '雪',
  'light snow': '小雪',
  'moderate snow': '中雪',
  'heavy snow': '大雪',
  sleet: '雨夹雪',
  fog: '雾',
  mist: '雾',
  haze: '霾',
  sand: '沙尘',
};

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 读主题设置并做边界处理；JWeather_Status 默认 off */
export function weatherConfig(options) {
  const blog = options?.blog || {};
  const rawDays = parseInt(blog.JWeather_Days || '4', 10);
  const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(rawDays) ? rawDays : 4));
  return {
    enabled: blog.JWeather_Status === 'on',
    // auto：不传城市，交给接口按请求 IP 自动定位；manual：使用 JWeather_City
    mode: blog.JWeather_Mode === 'manual' ? 'manual' : 'auto',
    city: String(blog.JWeather_City || '北京').trim() || '北京',
    api: String(blog.JWeather_Api || DEFAULT_WEATHER_API).trim() || DEFAULT_WEATHER_API,
    key: String(blog.JWeather_Key || '').trim(),
    days,
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 构造请求地址：支持 {city} / {adcode} 占位符，也支持直接填完整 URL */
export function buildWeatherUrl(config, geo = null) {
  if (config.mode !== 'manual') {
    const hasGeo =
      geo && (geo.cityName || (Number.isFinite(Number(geo.latitude)) && Number.isFinite(Number(geo.longitude))));
    return hasGeo ? buildGeoWeatherUrl(config.api, geo) : buildAutoLocateUrl(config.api);
  }
  const city = config.city;
  const isAdcode = /^\d{6}$/.test(city);
  let url = config.api;
  const hasToken = url.includes('{city}') || url.includes('{adcode}');

  if (hasToken) {
    url = url
      .replaceAll('{city}', encodeURIComponent(city))
      .replaceAll('{adcode}', isAdcode ? city : '');
    return url;
  }

  const parsed = new URL(url);
  if (isAdcode) parsed.searchParams.set('adcode', city);
  else parsed.searchParams.set('city', city);
  if (!parsed.searchParams.has('lang')) parsed.searchParams.set('lang', 'zh');
  if (!parsed.searchParams.has('extended')) parsed.searchParams.set('extended', 'true');
  if (!parsed.searchParams.has('forecast')) parsed.searchParams.set('forecast', 'true');
  return parsed.toString();
}

/** 优先用 EdgeOne GEO（访客城市/经纬度）查询，回退到接口 IP 定位 */
function buildGeoWeatherUrl(api, geo) {
  let url = String(api || DEFAULT_WEATHER_API);
  const cityName = geo.cityName ? String(geo.cityName).trim() : '';
  const lat = Number(geo.latitude);
  const lon = Number(geo.longitude);
  const hasLatLon = Number.isFinite(lat) && Number.isFinite(lon);
  if (url.includes('{city}') || url.includes('{adcode}')) {
    if (cityName) return url.replaceAll('{city}', encodeURIComponent(cityName)).replaceAll('{adcode}', '');
    if (hasLatLon) return url.replaceAll('{city}', '').replaceAll('{adcode}', '');
    return buildAutoLocateUrl(api);
  }
  if (!isHttpUrl(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete('city');
  parsed.searchParams.delete('adcode');
  parsed.searchParams.delete('lat');
  parsed.searchParams.delete('lon');
  if (cityName) parsed.searchParams.set('city', cityName);
  else if (hasLatLon) {
    parsed.searchParams.set('lat', String(lat));
    parsed.searchParams.set('lon', String(lon));
  }
  if (!parsed.searchParams.has('lang')) parsed.searchParams.set('lang', 'zh');
  if (!parsed.searchParams.has('extended')) parsed.searchParams.set('extended', 'true');
  if (!parsed.searchParams.has('forecast')) parsed.searchParams.set('forecast', 'true');
  return parsed.toString();
}

/**
 * 自动定位：删除 city / adcode 参数，让天气接口按请求来源 IP 定位。
 * 兼容 {city} / {adcode} 模板与直接写死的城市参数。
 */
function buildAutoLocateUrl(api) {
  let url = String(api || DEFAULT_WEATHER_API);
  if (url.includes('{city}') || url.includes('{adcode}')) {
    url = url.replaceAll('{city}', '').replaceAll('{adcode}', '');
  }
  if (!isHttpUrl(url)) return url;

  const parsed = new URL(url);
  parsed.searchParams.delete('city');
  parsed.searchParams.delete('adcode');
  if (!parsed.searchParams.has('lang')) parsed.searchParams.set('lang', 'zh');
  if (!parsed.searchParams.has('extended')) parsed.searchParams.set('extended', 'true');
  if (!parsed.searchParams.has('forecast')) parsed.searchParams.set('forecast', 'true');
  return parsed.toString();
}

function roundTemp(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toChineseWeather(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return WEATHER_CN[text.toLowerCase()] || text;
}

function toWeekCn(value) {
  const text = String(value || '').trim();
  if (/^周[一二三四五六日天]$/.test(text)) return text.replace('周天', '周日');
  if (/^星期[一二三四五六日天]$/.test(text)) return text.replace('星期', '周').replace('周天', '周日');
  const lower = text.toLowerCase();
  const en = {
    sunday: '周日', monday: '周一', tuesday: '周二', wednesday: '周三',
    thursday: '周四', friday: '周五', saturday: '周六',
  };
  if (en[lower]) return en[lower];
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : WEEK_CN[date.getDay()];
}

/**
 * 把不同接口的返回压成前端固定结构。
 * 兼容 UApiPro 的 weather / temperature / forecast（weather_day、temp_max…），
 * 也兼容常见的 weather.text / main.temp 结构。
 */
export function normalizeWeather(raw, config) {
  const source = raw || {};
  const main = source.main && typeof source.main === 'object' ? source.main : {};
  const description = source.weather?.description || source.condition?.text || source.weather;
  const forecastSource = Array.isArray(source.forecast) ? source.forecast : [];
  const forecast = forecastSource.slice(0, config.days).map((item) => ({
    date: String(item.date || ''),
    week: toWeekCn(item.week || item.date),
    weather: toChineseWeather(item.weather_day || item.weather || item.text || ''),
    tempMax: roundTemp(item.temp_max ?? item.tempMax ?? item.max),
    tempMin: roundTemp(item.temp_min ?? item.tempMin ?? item.min),
  }));
  const weather = toChineseWeather(description || forecast[0]?.weather || '');
  const temperature = roundTemp(source.temperature ?? main.temp);
  const tempMax = roundTemp(source.temp_max ?? forecast[0]?.tempMax);
  const tempMin = roundTemp(source.temp_min ?? forecast[0]?.tempMin);

  return {
    city: String(source.city || source.district || config.city || '').trim(),
    province: String(source.province || '').trim(),
    weather,
    weatherIcon: String(source.weather_icon || source.icon || ''),
    temperature,
    tempMax,
    tempMin,
    humidity: roundTemp(source.humidity ?? main.humidity),
    wind: [source.wind_direction, source.wind_power].filter(Boolean).join(' '),
    reportTime: String(source.report_time || ''),
    aqi: source.aqi_category
      ? `${String(source.aqi_category).trim()}${Number.isFinite(Number(source.aqi)) ? ` ${Number(source.aqi)}` : ''}`
      : '',
    days: forecast,
  };
}

async function requestWeather(url, key) {
  if (!isHttpUrl(url)) throw new Error('invalid weather api url');
  // 优先用标准 AbortSignal.timeout；边缘运行时没有 setTimeout 时退化为平台默认超时
  let signal;
  let timer;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(4500);
  } else if (typeof AbortController !== 'undefined' && typeof setTimeout === 'function') {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 4500);
    signal = controller.signal;
  }
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`weather http ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('weather response too large');
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 按访客位置生成缓存键；无 GEO 时沿用旧单键，兼容原有缓存与测试 */
function weatherCacheKey(geo) {
  if (!geo) return WEATHER_CACHE_KEY;
  const lat = Number(geo.latitude);
  const lon = Number(geo.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `${WEATHER_CACHE_KEY}:geo:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  }
  if (geo.cityName) {
    return `${WEATHER_CACHE_KEY}:city:${encodeURIComponent(String(geo.cityName)).slice(0, 60)}`;
  }
  return WEATHER_CACHE_KEY;
}

/** 读取缓存 / 请求接口；任何失败都返回 null，由前端隐藏天气块 */
export async function getWeather({ db, options, geo = null }) {
  const config = weatherConfig(options);
  if (!config.enabled) return null;
  const cacheKey = weatherCacheKey(geo);

  const cached = await db.kv.getJSON(cacheKey).catch(() => null);
  if (cached && cached.at && Date.now() - Number(cached.at) < (cached.error ? FAIL_TTL : CACHE_TTL)) {
    return cached.error ? null : cached.data || null;
  }

  try {
    const raw = await requestWeather(buildWeatherUrl(config, geo), config.key);
    const data = normalizeWeather(raw, config);
    if (!data.weather && data.temperature === null && !data.days.length) {
      throw new Error('empty weather response');
    }
    await db.kv.putJSON(cacheKey, { at: Date.now(), data }).catch(() => {});
    return data;
  } catch {
    await db.kv.putJSON(cacheKey, { at: Date.now(), error: true }).catch(() => {});
    return null;
  }
}

export async function clearWeatherCache(db) {
  await db.kv.delete(WEATHER_CACHE_KEY).catch(() => {});
  try {
    const keys = await db.kv.listKeys(`${WEATHER_CACHE_KEY}:`, 500);
    await Promise.all(keys.map((key) => db.kv.delete(key).catch(() => {})));
  } catch {}
}