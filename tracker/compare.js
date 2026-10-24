// 测 · 次日对比脚本
// 「实况参照」= Open-Meteo Previous Runs API 的 day-0 值(当日分析值,与 backfill.js 方法论一致),
// 对比对象 = record.js 存档里「对准被对比日 D」的各源预报:
//   提前 1 天 ← data/live/<D-1>.json 里各源的 d1;提前 3 天 ← data/live/<D-3>.json 里各源的 d3
//   (实现上向前扫描最近 7 天的 live 文件,某源在某天缺失/出错就跳过该源)
//
//   node tracker/compare.js             # 对比昨天
//   node tracker/compare.js 2026-10-22  # 对比指定日期
//
// 输出:tracker/data/live-compare/<日期>.json(重跑合并覆盖当天结果),并在控制台打印一表

const fs = require('fs');
const path = require('path');

const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const LIVE_DIR = path.join(__dirname, 'data', 'live');
const OUT_DIR = path.join(__dirname, 'data', 'live-compare');
const BASE_TZ = 'Asia/Shanghai';
const LOOKBACK = 7;    // 向前扫描最近 7 天的 live 记录(容忍漏跑一两天)
const RAIN_MM = 0.2;   // 与 report.js 一致:日降水 ≥ 0.2mm 记为「有雨」
const round2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}
function addDays(dateStr, n) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

// 从最近 LOOKBACK 天的 live 文件里,挑出「对准 target 日」的预报
// 返回 Map<cityId, Map<source, { d1: {recordedOn, fc}, d3: {...} }>>
function collectForecasts(target) {
  const byCity = new Map();
  for (let back = 1; back <= LOOKBACK; back++) {
    const recDate = addDays(target, -back);
    const payload = readJson(path.join(LIVE_DIR, `${recDate}.json`));
    if (!payload || !Array.isArray(payload.cities)) continue;
    for (const city of payload.cities) {
      for (const src of city.sources || []) {
        if (src.error) continue; // 该源当天出错,跳过
        for (const lead of ['d1', 'd3']) {
          const fc = src[lead];
          if (!fc || fc.date !== target) continue; // 只收对准 target 的那一条
          if (!byCity.has(city.id)) byCity.set(city.id, new Map());
          const m = byCity.get(city.id);
          if (!m.has(src.source)) m.set(src.source, {});
          m.get(src.source)[lead] = { recordedOn: recDate, fc };
        }
      }
    }
  }
  return byCity;
}

// Previous Runs API 的 day-0 = 当日分析值,作为统一实况参照
async function fetchActual(city, date) {
  const url = 'https://previous-runs-api.open-meteo.com/v1/forecast' +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
    `&start_date=${date}&end_date=${date}&timezone=${encodeURIComponent(city.tz)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const d = j.daily;
  if (!d || !Array.isArray(d.time) || !d.time.length || d.temperature_2m_max[0] == null)
    throw new Error(`无 day-0 分析值: ${JSON.stringify(j).slice(0, 100)}`);
  return { tmax: d.temperature_2m_max[0], tmin: d.temperature_2m_min[0],
    precip: d.precipitation_sum[0] == null ? null : round2(d.precipitation_sum[0]) };
}

// 单条预报 vs 实况:温度算带符号误差;降水只记概率/量与是否命中(量纲不同不强算误差)
function evalLead(entry, actual) {
  if (!entry) return null;
  const fc = entry.fc;
  const out = {
    recordedOn: entry.recordedOn, forecast: fc,
    errTmax: (fc.tmax == null || actual.tmax == null) ? null : round2(fc.tmax - actual.tmax),
    errTmin: (fc.tmin == null || actual.tmin == null) ? null : round2(fc.tmin - actual.tmin),
  };
  out.forecastRain = fc.precipProb != null ? fc.precipProb >= 50
    : (fc.precipMM != null ? fc.precipMM >= RAIN_MM : null);
  out.actualRain = actual.precip == null ? null : actual.precip >= RAIN_MM;
  out.rainHit = (out.forecastRain != null && out.actualRain != null) ? out.forecastRain === out.actualRain : null;
  return out;
}

const sgn = (v) => v == null ? '  —  ' : (v >= 0 ? '+' : '') + v.toFixed(1);
const cell = (e) => e ? `${e.forecast.tmax ?? '?'}°C(${sgn(e.errTmax)})` : '  无记录  ';

async function main() {
  const today = todayIn(BASE_TZ);
  const date = process.argv[2] || addDays(today, -1); // 默认对比昨天
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('日期格式应为 YYYY-MM-DD'); process.exit(1); }
  if (date >= today) { console.log(`只能对比今天之前的日期(${today}),${date} 还没有完整实况。`); return; }

  // 友好提示:昨天的记录文件(live/<昨日>.json)还不存在
  const yesterdayFile = path.join(LIVE_DIR, `${date}.json`);
  if (!fs.existsSync(LIVE_DIR) || !fs.readdirSync(LIVE_DIR).some(f => f.endsWith('.json'))) {
    console.log(`还没有任何日常记录(tracker/data/live/ 为空)。`);
    console.log(`先运行:node tracker/record.js   # 连续运行几天后即可对比`);
    return;
  }

  const byCity = collectForecasts(date);
  if (!byCity.size) {
    if (fs.existsSync(yesterdayFile)) {
      console.log(`${date} 的记录已有,但最近 ${LOOKBACK} 天里没有能对到 ${date} 的提前 1 天 / 3 天预报存档。`);
      console.log(`提前 1 天预报来自 live/${addDays(date, -1)}.json 的 d1,提前 3 天来自 live/${addDays(date, -3)}.json 的 d3。`);
      console.log(`继续每天运行 node tracker/record.js,过几天再来对比即可。`);
    } else {
      console.log(`没有 ${date} 的日常记录(缺 ${path.relative(process.cwd(), yesterdayFile)})。`);
      console.log(`先运行:node tracker/record.js   # 连续运行几天后即可对比`);
    }
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`对比日 ${date} · 实况参照 = Open-Meteo Previous Runs API day-0(当日分析值)\n`);

  const results = [], agg = {}; // agg: 源 → { d1: [absErr...], d3: [...] } 汇总 MAE
  for (const city of CITIES) {
    const srcMap = byCity.get(city.id);
    if (!srcMap || !srcMap.size) continue;
    let actual;
    try {
      actual = await fetchActual(city, date);
    } catch (e) {
      results.push({ id: city.id, city: city.city, error: `实况获取失败:${e.message}` });
      console.log(`${city.city}:实况获取失败(${e.message}),跳过`);
      await sleep(400);
      continue;
    }
    const sources = [];
    console.log(`${city.city}  实况 最高 ${actual.tmax}°C / 最低 ${actual.tmin}°C / 降水 ${actual.precip ?? '—'}mm`);
    for (const [source, leads] of srcMap) {
      const d1 = evalLead(leads.d1, actual), d3 = evalLead(leads.d3, actual);
      sources.push({ source, d1, d3 });
      agg[source] = agg[source] || { d1: [], d3: [] };
      if (d1 && d1.errTmax != null) agg[source].d1.push(Math.abs(d1.errTmax));
      if (d3 && d3.errTmax != null) agg[source].d3.push(Math.abs(d3.errTmax));
      console.log(`  ${source.padEnd(9)} 提前1天 ${cell(d1)}  |  提前3天 ${cell(d3)}`);
    }
    results.push({ id: city.id, city: city.city, timezone: city.tz, actual, sources });
    await sleep(400);
  }

  // 汇总各源最高温绝对误差(MAE)
  const maeLine = Object.entries(agg).map(([src, v]) => {
    const mae = (arr) => arr.length ? (arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1) + `°C(${arr.length}城)` : '无';
    return `${src} 提前1天 ${mae(v.d1)} / 提前3天 ${mae(v.d3)}`;
  }).join(' | ');
  if (maeLine) console.log(`\n汇总(最高温绝对误差):${maeLine}`);

  // 追加/合并进 live-compare/<date>.json:同城市以本次结果为准
  const outFile = path.join(OUT_DIR, `${date}.json`);
  const prev = readJson(outFile);
  const merged = new Map();
  if (prev && Array.isArray(prev.cities)) for (const c of prev.cities) merged.set(c.id, c);
  for (const c of results) merged.set(c.id, c);
  const payload = {
    date, comparedAt: new Date().toISOString(),
    reference: 'Open-Meteo Previous Runs API day-0(当日分析值,与 backfill.js 一致)',
    rainThresholdMM: RAIN_MM,
    note: 'errTmax/errTmin 为「预报 − 实况」(°C,正=报高);rainHit 为降水有无命中;某源当天缺失/出错即缺席',
    cities: [...merged.values()],
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 1));
  console.log(`\n完成 → ${path.relative(process.cwd(), outFile)}`);
}

main().catch(e => { console.error('对比失败:', e.message); process.exit(1); });
