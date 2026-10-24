// 测 · 日常预报记录脚本
// 每天把「各数据源当天对 D+1(明天)与 D+3(提前 3 天)的预报」原样存档,一天一文件,
// 供日后 compare.js 用 Open-Meteo day-0 分析值做逐源次日对比。零依赖,Node 18+。
//
//   node tracker/record.js
//
// 数据源(缺 Key 自动跳过,单源失败只记 error 不影响整体):
//   openmeteo  Open-Meteo forecast API,免 Key,必抓
//   amap       高德 weatherInfo extensions=all,需 AMAP_KEY 且城市有 adcode(仅国内)
//   caiyun     彩云 v2.6 daily,需 CAIYUN_TOKEN(URL 里经度在前)
//   qweather   和风 v7/weather/7d,需 QWEATHER_KEY;配了专属 QWEATHER_HOST 则用之,否则 devapi
//
// 输出:tracker/data/live/<YYYY-MM-DD>.json(重跑同一天覆盖,幂等)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const OUT_DIR = path.join(__dirname, 'data', 'live');
const BASE_TZ = 'Asia/Shanghai'; // 记录日期统一取北京日期,与高德/和风/彩云的国内口径对齐
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 手工解析根目录 .env(不引依赖;进程环境变量优先,便于 CI 用 Secrets 注入)----
function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      const h = v.indexOf(' #'); // 去掉行内注释
      if (h > 0) v = v.slice(0, h).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[k] = v;
    }
  }
  for (const k of ['AMAP_KEY', 'CAIYUN_TOKEN', 'QWEATHER_KEY', 'QWEATHER_HOST'])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}

// ---- 日期工具:BASE_TZ 的「今天」与日期加减 ----
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
function addDays(dateStr, n) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 HTTP ${res.status}: ${text.slice(0, 80)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
  return json;
}
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---- 各数据源:返回 { source, d1, d3 },d1/d3 = { date, tmax, tmin, precipProb, precipMM } 或 null ----

async function fetchOpenMeteo(city, d1Date, d3Date) {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&forecast_days=5&timezone=${encodeURIComponent(city.tz)}`; // 多要 1 天,兜底纽约等时区落后的城市
  const j = await getJSON(url);
  const d = j.daily;
  if (!d || !Array.isArray(d.time)) throw new Error(`无 daily 数据: ${JSON.stringify(j).slice(0, 100)}`);
  const pick = (date) => {
    const i = d.time.indexOf(date);
    if (i < 0) return null;
    return { date, tmax: toNum(d.temperature_2m_max[i]), tmin: toNum(d.temperature_2m_min[i]),
      precipProb: toNum(d.precipitation_probability_max[i]), precipMM: null }; // OM 此接口给概率不给量
  };
  return { source: 'openmeteo', d1: pick(d1Date), d3: pick(d3Date) };
}

async function fetchAmap(city, key, d1Date, d3Date) {
  if (!key || !city.adcode) return null; // 无 Key 或海外城市(纽约)直接跳过
  const url = `https://restapi.amap.com/v3/weather/weatherInfo?extensions=all&city=${city.adcode}&key=${key}`;
  const j = await getJSON(url);
  if (j.status !== '1' || !j.forecasts || !j.forecasts.length)
    throw new Error(`高德返回异常: ${j.info || JSON.stringify(j).slice(0, 100)}`);
  const casts = j.forecasts[0].casts || [];
  const pick = (date) => {
    const c = casts.find(x => x.date === date);
    if (!c) return null;
    return { date, tmax: toNum(c.daytemp_float != null ? c.daytemp_float : c.daytemp),
      tmin: toNum(c.nighttemp_float != null ? c.nighttemp_float : c.nighttemp),
      precipProb: null, precipMM: null }; // 高德 extensions=all 不提供降水概率/量
  };
  return { source: 'amap', d1: pick(d1Date), d3: pick(d3Date) };
}

async function fetchCaiyun(city, token, d1Date, d3Date) {
  if (!token) return null;
  // 注意:彩云 URL 坐标是「经度,纬度」;dailysteps 多要一点,免费档实际常只回 3 天(D+3 可能为 null)
  const url = `https://api.caiyunapp.com/v2.6/${token}/${city.lon},${city.lat}/daily?dailysteps=5`;
  const j = await getJSON(url);
  if (j.status !== 'ok' || !j.result || !j.result.daily)
    throw new Error(`彩云返回异常: ${j.status || JSON.stringify(j).slice(0, 100)}`);
  const daily = j.result.daily;
  const temps = daily.temperature || [];
  const precs = daily.precipitation || daily.precip || []; // v2.6 字段为 precipitation,兼容旧 precip
  const pick = (date) => {
    const t = temps.find(x => String(x.date || '').slice(0, 10) === date);
    if (!t) return null;
    const p = precs.find(x => String(x.date || '').slice(0, 10) === date) || {};
    // probability 历史上是 0~1 小数,现为 0~100,统一折成百分比
    const prob = p.probability == null ? null : (p.probability <= 1 ? Math.round(p.probability * 100) : Math.round(p.probability));
    return { date, tmax: toNum(t.max), tmin: toNum(t.min), precipProb: prob,
      precipMM: toNum(p.intensity != null ? p.intensity : p.avg) };
  };
  return { source: 'caiyun', d1: pick(d1Date), d3: pick(d3Date) };
}

async function fetchQWeather(city, key, host, d1Date, d3Date) {
  if (!key) return null;
  // 专属 API Host 与 Key 绑定:配了 QWEATHER_HOST 必须用它,没配走公共 devapi
  const base = host ? (String(host).startsWith('http') ? host : `https://${host}`) : 'https://devapi.qweather.com';
  const url = `${base}/v7/weather/7d?location=${city.lon},${city.lat}&key=${key}`;
  const j = await getJSON(url);
  if (j.error) throw new Error(`和风返回异常: ${(j.error.title || '')} ${(j.error.detail || '').slice(0, 80)}`);
  if (j.code !== '200' || !Array.isArray(j.daily)) throw new Error(`和风返回异常 code=${j.code}`);
  const pick = (date) => {
    const d = j.daily.find(x => x.fxDate === date);
    if (!d) return null;
    return { date, tmax: toNum(d.tempMax), tmin: toNum(d.tempMin), precipProb: null,
      precipMM: d.precip != null ? toNum(d.precip) : null }; // 7d 无降水概率,新版本有 precip 日量(mm)
  };
  return { source: 'qweather', d1: pick(d1Date), d3: pick(d3Date) };
}

const fmtFc = (d) => d ? `${d.tmax}/${d.tmin}°C${d.precipProb != null ? ` ${d.precipProb}%` : ''}` : '无';

// 单源失败自动重试一次:CI 出口网络偶发抖动(如 Actions 到高德 restapi 的连接),
// 间隔 1.5s 重试常能救回;两次都失败才记 error。幂等请求,重试无副作用。
async function withRetry(fn, label) {
  try { return await fn(); }
  catch (e) {
    console.log(`  ↻ ${label} 首次失败(${String(e.message || e).slice(0, 60)}),1.5s 后重试`);
    await sleep(1500);
    return fn();
  }
}

async function main() {
  const env = loadEnv();
  const date = todayIn(BASE_TZ);
  const d1Date = addDays(date, 1), d3Date = addDays(date, 3);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`记录日 ${date}(北京时区)· 目标日 D+1=${d1Date} D+3=${d3Date}`);
  console.log(`数据源:Open-Meteo(免 Key)` +
    `${env.AMAP_KEY ? ' · 高德' : ''}${env.CAIYUN_TOKEN ? ' · 彩云' : ''}${env.QWEATHER_KEY ? ' · 和风' : ''}`);

  const cities = [];
  for (const city of CITIES) {
    const sources = [];
    const tasks = [
      ['openmeteo', () => fetchOpenMeteo(city, d1Date, d3Date)],
      ['amap', () => fetchAmap(city, env.AMAP_KEY, d1Date, d3Date)],
      ['caiyun', () => fetchCaiyun(city, env.CAIYUN_TOKEN, d1Date, d3Date)],
      ['qweather', () => fetchQWeather(city, env.QWEATHER_KEY, env.QWEATHER_HOST, d1Date, d3Date)],
    ];
    for (const [name, fn] of tasks) {
      try {
        const r = await withRetry(fn, name);
        if (r) {
          sources.push(r.d3 ? r : { ...r, note: '该源未覆盖 D+3' });
          console.log(`  ${city.city} ${name.padEnd(9)} D+1 ${fmtFc(r.d1)} | D+3 ${fmtFc(r.d3)}`);
        } else {
          console.log(`  ${city.city} ${name.padEnd(9)} 跳过(无 Key 或城市不在该源覆盖范围)`);
        }
      } catch (e) {
        sources.push({ source: name, error: String(e.message || e) }); // 单源失败不影响其他源
        console.log(`  ${city.city} ${name.padEnd(9)} 失败:${e.message}`);
      }
      await sleep(400); // 每源之间歇 400ms,礼貌请求
    }
    const okCount = sources.filter(s => !s.error).length;
    cities.push({ id: city.id, city: city.city, lat: city.lat, lon: city.lon, tz: city.tz,
      ...(okCount ? {} : { error: '全部数据源失败' }), sources });
  }

  const payload = {
    date, fetchedAt: new Date().toISOString(),
    targetDays: { d1: d1Date, d3: d3Date },
    keys: { amap: !!env.AMAP_KEY, caiyun: !!env.CAIYUN_TOKEN, qweather: !!env.QWEATHER_KEY },
    note: '各源「当天」对 D+1/D+3 的预报原样存档;温度 °C,precipProb 降水概率(%),precipMM 降水量(mm),无则为 null',
    cities,
  };
  const file = path.join(OUT_DIR, `${date}.json`); // 重跑同一天覆盖
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  console.log(`完成 → ${path.relative(process.cwd(), file)}`);
}

main().catch(e => { console.error('记录失败:', e.message); process.exit(1); });
