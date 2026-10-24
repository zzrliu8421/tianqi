// 测 · 预报准确性回填脚本
// 用 Open-Meteo Previous Runs API 取「过去实际发布的预报」(提前 1 天 / 3 天),
// 与「当日分析值」(day-0,实况的最佳近似)逐日对比,回溯生成准确率证据。
// 数据自 2024 年起可用,延迟约 3 天。零依赖,Node 18+。
//
//   node tracker/backfill.js             # 默认回填最近 8 周
//   node tracker/backfill.js 2026-09-01 2026-10-21
//
// 输出:tracker/data/backfill/<city>.json(逐日明细,原始证据)

const fs = require('fs');
const path = require('path');

const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const OUT_DIR = path.join(__dirname, 'data', 'backfill');

function fmt(d) { return d.toISOString().slice(0, 10); }

async function fetchCity(city, start, end) {
  const url = 'https://previous-runs-api.open-meteo.com/v1/forecast' +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    '&hourly=temperature_2m,temperature_2m_previous_day1,temperature_2m_previous_day3' +
    ',precipitation,precipitation_previous_day1,precipitation_previous_day3' +
    `&start_date=${start}&end_date=${end}&timezone=${encodeURIComponent(city.tz)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${city.city}`);
  const json = await res.json();
  if (!json.hourly) throw new Error(`无 hourly 数据 ${city.city}: ${JSON.stringify(json).slice(0, 120)}`);
  return json.hourly;
}

// 按“小时数组 → 各日期 {max,min,precip}”聚合
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
  // 只保留数据完整的日期(24 小时),避免末日半天数据污染极值
  const out = {};
  for (const [d, s] of byDate) if (s.hours >= 24) out[d] = { tmax: +s.max.toFixed(1), tmin: +s.min.toFixed(1), precip: +s.precip.toFixed(1) };
  return out;
}

async function main() {
  let [start, end] = process.argv.slice(2);
  if (!start || !end) {
    end = fmt(new Date(Date.now() - 3 * 86400000));   // 数据延迟 3 天
    start = fmt(new Date(Date.now() - 3 * 86400000 - 55 * 86400000)); // 近 8 周
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`回填窗口 ${start} ~ ${end}(${CITIES.length} 个城市)`);

  for (const city of CITIES) {
    const h = await fetchCity(city, start, end);
    const actual = dailyStats(h.time, h.temperature_2m, h.precipitation);
    const f1 = dailyStats(h.time, h.temperature_2m_previous_day1, h.precipitation_previous_day1);
    const f3 = dailyStats(h.time, h.temperature_2m_previous_day3, h.precipitation_previous_day3);

    const days = Object.keys(actual).filter(d => f1[d] && f3[d]).sort();
    const rows = days.map(d => ({ date: d, actual: actual[d], f1: f1[d], f3: f3[d] }));
    const payload = {
      city: city.city, id: city.id, lat: city.lat, lon: city.lon, timezone: city.tz,
      source: 'Open-Meteo Previous Runs API',
      reference: 'day-0 分析值(实况最佳近似)', window: { start, end }, days: rows.length, rows,
    };
    const file = path.join(OUT_DIR, `${city.id}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 1));
    console.log(`  ${city.city}: ${rows.length} 天 → ${path.relative(process.cwd(), file)}`);
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('回填完成');
}

main().catch(e => { console.error('回填失败:', e.message); process.exit(1); });
