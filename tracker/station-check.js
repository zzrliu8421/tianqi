// 校 · 观测站实况对照(打破"模式检验模式"质疑)
// 项目所有精度指标都以 Open-Meteo Previous Runs 的 day-0 分析值作"实况参照",
// 它本质仍是模式分析场。本脚本用 NOAA GHCN-Daily **国家级地面观测站逐日实测**
// 与同一窗口的 day-0 参照对比,量化"参照自身的不确定性":
//   若参照与站点实测平均差很小(如 <0.5°C)→ 全部指标的解读不受参照选择影响;
//   若某城偏差明显 → 该城指标需保守解读,并在报告中如实注明。
//
//   node tracker/station-check.js
//
// 站点选择:下载 GHCN 全站清单,自动取距城市坐标最近的站(缓存到 data/station-map.json);
// 数据:NCEI Data Service(免 Key)。对比窗口 = data/backfill/ 的回溯窗口,
// 与 summary.json 的所有头条指标同口径。输出 data/station-check.{json,md}(整窗重算,幂等覆盖)。

const fs = require('fs');
const path = require('path');

const IN_DIR = path.join(__dirname, 'data', 'backfill');
const MAP_FILE = path.join(__dirname, 'data', 'station-map.json');
const OUT_JSON = path.join(__dirname, 'data', 'station-check.json');
const OUT_MD = path.join(__dirname, 'data', 'station-check.md');
const MAX_STATION_KM = 150;   // 站点距城市超过此距离视为低可信,只提示不出指标
const round2 = (x) => Math.round(x * 100) / 100;

async function fetchText(url, timeoutMs = 30000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function fetchJson(url, timeoutMs = 30000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  // 浮点误差可能让近似对跖点的 s 略超 1,asin(sqrt(s>1)) = NaN
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, s)));
}

// 从全站清单(fixed-width)找距城市最近的至多 maxCount 个站(≤maxKm),
// 按距离升序——中国站国际交换有滞后,最近的站未必有窗口内数据,逐个候选回退
async function nearestStations(city, allStations, maxCount = 15, maxKm = MAX_STATION_KM) {
  const scored = [];
  for (const st of allStations) {
    const d = haversineKm(city.lat, city.lon, st.lat, st.lon);
    if (d <= maxKm) scored.push({ id: st.id, name: st.name, lat: st.lat, lon: st.lon, distKm: round2(d) });
  }
  scored.sort((a, b) => a.distKm - b.distKm);
  return scored.slice(0, maxCount);
}

async function getStationMap(cities) {
  if (fs.existsSync(MAP_FILE)) {
    try {
      const m = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'));
      if (cities.every(c => Array.isArray(m[c.id]) && m[c.id].length)) return m;
    } catch { /* 坏缓存重算 */ }
  }
  console.log('下载 GHCN 全站清单(约 1MB,仅首次)…');
  const txt = await fetchText('https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt', 60000);
  const all = [];
  for (const line of txt.split('\n')) {
    if (line.length < 31) continue;
    const lat = parseFloat(line.slice(12, 20)), lon = parseFloat(line.slice(21, 30));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    all.push({ id: line.slice(0, 11), lat, lon, name: line.slice(41, 71).trim() });
  }
  const map = {};
  for (const c of cities) {
    const cands = await nearestStations(c, all);
    map[c.id] = cands;
    console.log(`  ${c.city} → 候选 ${cands.length} 个: ${cands.slice(0, 3).map(s => `${s.id}(${s.distKm}km)`).join(', ')}…`);
  }
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 1));
  return map;
}

// 取单站窗口内逐日 TMAX/TMIN(-9999 视为缺测)
async function fetchStationDaily(st, windowStart, windowEnd) {
  const obs = await fetchJson('https://www.ncei.noaa.gov/access/services/data/v1' +
    `?dataset=daily-summaries&stations=${st.id}&startDate=${windowStart}&endDate=${windowEnd}` +
    '&dataTypes=TMAX,TMIN&units=metric&format=json');
  const byDate = new Map();
  for (const o of (Array.isArray(obs) ? obs : [])) {
    const tmax = o.TMAX != null && Number(o.TMAX) > -900 ? Number(o.TMAX) : null;
    const tmin = o.TMIN != null && Number(o.TMIN) > -900 ? Number(o.TMIN) : null;
    if (tmax != null || tmin != null) byDate.set(o.DATE, { tmax, tmin });
  }
  return byDate;
}

async function main() {
  const files = fs.readdirSync(IN_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.error('没有回填数据,先运行 node tracker/backfill.js'); process.exit(1); }

  // 回溯窗口 = backfill 明细的日期范围(与 summary.json 指标同口径)
  const rows = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(IN_DIR, f), 'utf-8'));
    for (const r of d.rows) rows.push({ city: d.city, cityId: f.replace('.json', ''), date: r.date, tmax: r.actual.tmax, tmin: r.actual.tmin });
  }
  const dates = rows.map(r => r.date).sort();
  const windowStart = dates[0], windowEnd = dates[dates.length - 1];
  // 城市坐标从 cities.json 取(backfill 明细不含坐标)
  const CITY_META = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
  const usedIds = new Set(rows.map(r => r.cityId));
  const cities = CITY_META.filter(c => usedIds.has(c.id)).map(c => ({ id: c.id, city: c.city, lat: c.lat, lon: c.lon }));

  const map = await getStationMap(cities);

  console.log(`对比窗口 ${windowStart} ~ ${windowEnd}(与 summary.json 同口径)`);
  const results = [];
  for (const c of cities) {
    const cands = map[c.id] || [];
    if (!cands.length) { results.push({ cityId: c.id, city: c.city, note: '未找到 GHCN 站' }); continue; }
    // 按距离顺序试候选站,直到某站与参照窗口重叠 ≥20 天(中国站国际交换滞后,近站常缺近期数据)
    let chosen = null, byDate = null, tried = [], bestEffort = null;
    for (const st of cands) {
      let obs;
      try { obs = await fetchStationDaily(st, windowStart, windowEnd); }
      catch (e) { tried.push({ id: st.id, distKm: st.distKm, note: `获取失败:${e.message}` }); continue; }
      // 与 day-0 参照按日期配对
      const dTmax = [];
      for (const r of rows) {
        if (r.cityId !== c.id) continue;
        const o = obs.get(r.date);
        if (o && o.tmax != null && r.tmax != null) dTmax.push(r.tmax - o.tmax);
      }
      tried.push({ id: st.id, distKm: st.distKm, overlap: dTmax.length });
      if (dTmax.length >= 20) { chosen = st; byDate = obs; break; }
      if (!bestEffort || dTmax.length > bestEffort.n) bestEffort = { st, obs, n: dTmax.length };
    }
    // 没有站达到 20 天时,退而用重叠最多的站(≥8 天才采用,并注明样本不足)
    if (!chosen && bestEffort && bestEffort.n >= 8) {
      chosen = bestEffort.st; byDate = bestEffort.obs;
      console.log(`${c.city}: 无 ≥20 天候选,退用重叠最多的 ${chosen.id}(${bestEffort.n} 天)`);
    }
    if (!chosen) {
      results.push({ cityId: c.id, city: c.city, tried, note: `候选 ${cands.length} 站均无 ≥20 天重叠(站点国际交换滞后)` });
      console.log(`${c.city}: 候选站均无足够重叠,跳过`);
      continue;
    }
    const dTmax = [], dTmin = [];
    for (const r of rows) {
      if (r.cityId !== c.id) continue;
      const o = byDate.get(r.date);
      if (!o) continue;
      if (o.tmax != null && r.tmax != null) dTmax.push(r.tmax - o.tmax);
      if (o.tmin != null && r.tmin != null) dTmin.push(r.tmin - o.tmin);
    }
    const stat = (a) => a.length ? {
      n: a.length,
      meanDiff: round2(a.reduce((s, v) => s + v, 0) / a.length),
      mae: round2(a.reduce((s, v) => s + Math.abs(v), 0) / a.length),
      maxAbs: round2(Math.max(...a.map(Math.abs))),
    } : null;
    const res = {
      cityId: c.id, city: c.city, station: chosen, tried,
      tmax: stat(dTmax), tmin: stat(dTmin),
      note: dTmax.length < 40 ? `重叠 ${dTmax.length} 天,样本偏少` : '',
    };
    results.push(res);
    console.log(`${c.city}(${chosen.id} ${chosen.distKm}km): 重叠 ${dTmax.length} 天, Tmax平均差 ${res.tmax ? res.tmax.meanDiff : '—'}°C MAE ${res.tmax ? res.tmax.mae : '—'}°C`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    reference: 'OM Previous Runs day-0 分析值(项目全部精度指标的实况参照) vs GHCN-Daily 地面站逐日实测',
    interpretation: 'meanDiff 为「参照 − 站点实测」:|meanDiff| 与 MAE 越小,参照越可信,模式检验模式的质疑越弱',
    window: { start: windowStart, end: windowEnd },
    cities: results,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 1));

  const md = [`# 校 · 观测站实况对照(GHCN-Daily vs OM day-0 参照)`, '',
    `窗口 ${windowStart} ~ ${windowEnd}(与 summary.json 指标同口径)。meanDiff = OM day-0 参照 − 站点实测(°C,正=参照偏高)。`, '',
    '| 城市 | GHCN 站 | 距离 | 重叠天 | Tmax 平均差 | Tmax MAE | Tmax 最大差 | Tmin 平均差 | Tmin MAE |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map(r => {
      if (!r.station) return `| ${r.city} | — | — | — | ${r.note || '—'} | | | | |`;
      if (r.note && !r.tmax) return `| ${r.city} | ${r.station.id} | ${r.station.distKm}km | — | ${r.note} | | | | |`;
      const f = (s, k) => s ? `${s.meanDiff}${s.n ? `(${s.n}天)` : ''}` : '—';
      const g = (s) => s ? s.mae : '—';
      const m = (s) => s ? s.maxAbs : '—';
      return `| ${r.city} | ${r.station.id} | ${r.station.distKm}km | ${r.tmax ? r.tmax.n : 0} | ${f(r.tmax)} | ${g(r.tmax)} | ${m(r.tmax)} | ${r.tmin ? r.tmin.meanDiff : '—'} | ${g(r.tmin)} |`;
    }), ''].join('\n');
  fs.writeFileSync(OUT_MD, md, 'utf-8');
  console.log(`\n完成 → ${path.relative(process.cwd(), OUT_JSON)} 与 ${path.relative(process.cwd(), OUT_MD)}`);
}

main().catch(e => { console.error('站点对照失败:', e.message); process.exit(1); });
