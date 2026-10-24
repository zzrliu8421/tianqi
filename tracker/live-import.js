// 测 · 历史回溯数据 → live 日常记录格式转换
// 把回溯窗口(sources/ 的彩云、高德+和风 与 backfill/ 的 Open-Meteo)按「记录日 R:
// 对 R+1 的 d1 预报 / 对 R+3 的 d3 预报」还原成 record.js 的 live 文件格式,
// 使 data/live/ 形成自窗口起点起的连续序列。
// 已存在的记录文件一律不覆盖(--force 可强制)。
//
//   node tracker/live-import.js [--force]
//
// 输出:tracker/data/live/<R>.json(仅缺失日期)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const SRC_DIR = path.join(__dirname, 'data', 'sources');
const OM_DIR = path.join(__dirname, 'data', 'backfill');
const LIVE_DIR = path.join(__dirname, 'data', 'live');
const FORCE = process.argv.includes('--force');

function addDays(s, n) {
  return new Date(new Date(s + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// 统一成 live 条目格式:{date, tmax, tmin, precipProb, precipMM}
function toLive(date, e) {
  if (!e) return null;
  const out = { date };
  if (e.tmax != null) out.tmax = round1(e.tmax);
  if (e.tmin != null) out.tmin = round1(e.tmin);
  out.precipProb = e.precipProb != null ? e.precipProb : null;
  out.precipMM = e.precip != null ? round1(e.precip) : null;
  return out;
}

function main() {
  const citySrc = new Map(), cityOm = new Map();
  for (const f of fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
    citySrc.set(d.id, { city: d.city, window: d.window, rows: new Map(d.rows.map(r => [r.date, r])) });
  }
  for (const f of fs.readdirSync(OM_DIR).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(OM_DIR, f), 'utf-8'));
    cityOm.set(d.id, new Map(d.rows.map(r => [r.date, r])));
  }
  if (!citySrc.size) { console.error('缺 data/sources/,先放入回溯多源数据'); process.exit(1); }

  const window = [...citySrc.values()][0].window;
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  let written = 0, skipped = 0, lastR = null;

  // 记录日 R 从窗口起点到 end-1(d1 目标日 ≤ end;d3 目标日越界则该条缺省)
  for (let R = window.start; ; R = addDays(R, 1)) {
    if (R >= window.end) break;
    const file = path.join(LIVE_DIR, `${R}.json`);
    if (fs.existsSync(file) && !FORCE) { skipped++; continue; }

    const cities = [];
    for (const c of CITIES) {
      const src = citySrc.get(c.id), om = cityOm.get(c.id);
      if (!src && !om) continue;
      const sources = [];
      const push = (name, d1, d3, note) => {
        if (!d1 && !d3) return;
        sources.push(note ? { source: name, note, d1, d3 } : { source: name, d1, d3 });
      };
      if (om) push('openmeteo', toLive(addDays(R, 1), om.get(addDays(R, 1))?.f1), toLive(addDays(R, 3), om.get(addDays(R, 3))?.f3));
      if (src) {
        const r1 = src.rows.get(addDays(R, 1)), r3 = src.rows.get(addDays(R, 3));
        push('caiyun', toLive(addDays(R, 1), r1?.sources?.caiyun?.f1), toLive(addDays(R, 3), r3?.sources?.caiyun?.f3));
        push('amap_qweather', toLive(addDays(R, 1), r1?.sources?.amap_qweather?.f1), toLive(addDays(R, 3), r3?.sources?.amap_qweather?.f3),
          '高德/和风逐日数值一致,合并记录(见 README 已知事项)');
      }
      if (sources.length) cities.push({ id: c.id, city: c.city, lat: c.lat, lon: c.lon, tz: c.tz, sources });
    }
    if (!cities.length) continue;

    fs.writeFileSync(file, JSON.stringify({
      date: R,
      targetDays: { d1: addDays(R, 1), d3: addDays(R, 3) },
      window: { start: window.start, end: window.end },
      cities,
    }, null, 1));
    written++; lastR = R;
  }

  console.log(`转换完成:新增 ${written} 个 live 文件(${window.start} ~ ${lastR}),跳过已存在真实记录 ${skipped} 个`);
  console.log('后续可运行 node tracker/compare.js <日期> 生成逐日对比(实况由 OM day-0 在线获取)');
}

main();
