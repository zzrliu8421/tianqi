// 测 · 多模式回溯(B 方案:真实数据)
// Open-Meteo 存档了多个数值模式「过去实际发布的预报」(Previous Runs API + models 参数)。
// 本脚本对 6 城回溯 5 个全球模式(含中国 GRAPES)提前 1/3 天的预报误差,
// 实况参照 = 已有回填数据(tracker/data/backfill/)中 best_match 的 day-0 分析值,
// 与 backfill.js 方法论完全一致。全部为真实历史数据,可直接用于研究报告。
//
//   node tracker/backfill-models.js
//
// 输出:tracker/data/backfill-models/<city>.json(逐日明细,含各模式预报与统一实况)

const fs = require('fs');
const path = require('path');

const MODELS = [
  { id: 'ecmwf_ifs025', name: 'ECMWF IFS 0.25°(欧洲中期天气预报中心)' },
  { id: 'gfs_seamless', name: 'NCEP GFS(美国)' },
  { id: 'icon_seamless', name: 'DWD ICON(德国)' },
  { id: 'jma_seamless', name: 'JMA GSM(日本)' },
  { id: 'cma_grapes_global', name: 'CMA GRAPES Global(中国)' },
];

const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const SRC_DIR = path.join(__dirname, 'data', 'backfill');
const OUT_DIR = path.join(__dirname, 'data', 'backfill-models');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 小时数组 → 各日期 {max,min,precip}(只保留 24 小时整日,与 backfill.js 一致)
function dailyStats(times, values, precs) {
  const byDate = new Map();
  for (let i = 0; i < times.length; i++) {
    const v = values[i], p = precs[i];
    if (v == null) continue;
    const d = times[i].slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, { max: -Infinity, min: Infinity, precip: 0, hours: 0 });
    const s = byDate.get(d);
    if (v > s.max) s.max = v;
    if (v < s.min) s.min = v;
    s.precip += (p || 0);
    s.hours++;
  }
  const out = {};
  for (const [d, s] of byDate) if (s.hours >= 24) out[d] = { tmax: +s.max.toFixed(1), tmin: +s.min.toFixed(1), precip: +s.precip.toFixed(1) };
  return out;
}

async function fetchModelRuns(city, model, start, end) {
  const url = 'https://previous-runs-api.open-meteo.com/v1/forecast' +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    '&hourly=temperature_2m,temperature_2m_previous_day1,temperature_2m_previous_day3' +
    ',precipitation,precipitation_previous_day1,precipitation_previous_day3' +
    `&models=${model}&start_date=${start}&end_date=${end}&timezone=${encodeURIComponent(city.tz)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.hourly) throw new Error(j.reason ? String(j.reason).slice(0, 90) : '无 hourly');
  const h = j.hourly;
  return {
    f1: dailyStats(h.time, h.temperature_2m_previous_day1, h.precipitation_previous_day1),
    f3: dailyStats(h.time, h.temperature_2m_previous_day3, h.precipitation_previous_day3),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const city of CITIES) {
    const srcFile = path.join(SRC_DIR, `${city.id}.json`);
    if (!fs.existsSync(srcFile)) { console.error(`缺 ${srcFile},先运行 node tracker/backfill.js`); process.exit(1); }
    const src = JSON.parse(fs.readFileSync(srcFile, 'utf-8'));
    const { start, end } = src.window;
    // 统一实况参照 = best_match day-0(来自既有回填)
    const actual = {};
    for (const r of src.rows) actual[r.date] = r.actual;

    const perModel = {};
    for (const m of MODELS) {
      try {
        const runs = await fetchModelRuns(city, m.id, start, end);
        perModel[m.id] = runs;
        const n1 = Object.keys(runs.f1).length, n3 = Object.keys(runs.f3).length;
        console.log(`  ${city.city} ${m.id.padEnd(18)} D+1 ${n1} 天 | D+3 ${n3} 天`);
      } catch (e) {
        console.log(`  ${city.city} ${m.id.padEnd(18)} 失败:${e.message}(跳过该模式)`);
      }
      await sleep(400);
    }

    // 组装逐日矩阵:date → { actual, models: { model: {f1, f3} } }
    const dates = Object.keys(actual).sort();
    const rows = dates.map(d => {
      const entry = { date: d, actual: actual[d], models: {} };
      for (const m of MODELS) {
        const r = perModel[m.id];
        if (!r) continue;
        if (r.f1[d]) entry.models[m.id] = { f1: r.f1[d] };
        if (r.f3[d]) (entry.models[m.id] = entry.models[m.id] || {}).f3 = r.f3[d];
      }
      return entry;
    }).filter(r => Object.keys(r.models).length);

    const payload = {
      city: city.city, id: city.id, lat: city.lat, lon: city.lon, timezone: city.tz,
      source: 'Open-Meteo Previous Runs API(指定 models 参数)',
      reference: 'best_match day-0 分析值(与 backfill.js 同一参照)',
      models: MODELS, window: { start, end }, days: rows.length, rows,
    };
    const out = path.join(OUT_DIR, `${city.id}.json`);
    fs.writeFileSync(out, JSON.stringify(payload, null, 1));
    console.log(`${city.city}: ${rows.length} 天 × ${Object.keys(perModel).length} 模式 → ${path.relative(process.cwd(), out)}`);
  }
  console.log('多模式回填完成');
}

main().catch(e => { console.error('多模式回填失败:', e.message); process.exit(1); });
