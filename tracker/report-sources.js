// 测 · 多源准确性汇总(高德+和风 / 彩云 / Open-Meteo)
// 数据来源约定:
//   - openmeteo      → data/backfill/(Open-Meteo Previous Runs 回填,权威 OM 数据)
//   - caiyun         ┐
//   - amap_qweather  ┘ → data/sources/(自行获取的历史预报,其中 om 字段不用)
// 实况参照:两套文件均为 OM day-0 分析值(已抽查一致),按日期对齐后统一计算。
//
//   node tracker/report-sources.js
// 输出:data/summary-sources.json(重生成) + reports/sources-summary.csv + reports/sources-<id>-daily.csv

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'data', 'sources');
const OM_DIR = path.join(__dirname, 'data', 'backfill');
const SUM_FILE = path.join(__dirname, 'data', 'summary-sources.json');
const REP_DIR = path.join(__dirname, 'reports');

const RAIN_MM = 0.2;
const round2 = (x) => Math.round(x * 100) / 100;
const mae = (a) => (a.length ? round2(a.reduce((s, v) => s + Math.abs(v), 0) / a.length) : null);
const mean = (a) => (a.length ? round2(a.reduce((s, v) => s + v, 0) / a.length) : null);

// 外部源名 → 展示名(CSV/图表用)
const NAMES = { openmeteo: 'Open-Meteo', caiyun: '彩云天气', amap_qweather: '高德+和风' };

// 单源逐日序列 → 指标
function metrics(pairs) {
  const e1 = [], e3 = [], e1n = [], e3n = [], bias = [];
  let hit = 0, miss = 0, fa = 0, cn = 0, precipKnown = false;
  for (const { actual, f1, f3 } of pairs) {
    if (f1.tmax != null && actual.tmax != null) { e1.push(f1.tmax - actual.tmax); bias.push(f1.tmax - actual.tmax); }
    if (f3.tmax != null && actual.tmax != null) e3.push(f3.tmax - actual.tmax);
    if (f1.tmin != null && actual.tmin != null) e1n.push(f1.tmin - actual.tmin);
    if (f3.tmin != null && actual.tmin != null) e3n.push(f3.tmin - actual.tmin);
    // 降水指标:仅当源提供降水量(高德+和风 precip 恒为 null → 自动跳过)
    if (f1.precip != null && actual.precip != null) {
      precipKnown = true;
      const ra = actual.precip >= RAIN_MM, rf = f1.precip >= RAIN_MM;
      if (ra) { rf ? hit++ : miss++; cn++; } else if (rf) fa++;
    }
  }
  return {
    maeTmaxF1: mae(e1), maeTmaxF3: mae(e3),
    maeTminF1: mae(e1n), maeTminF3: mae(e3n),
    biasTmaxF1: mean(bias),
    pod: cn ? Math.round((hit / cn) * 100) : null,
    far: (hit + fa) ? Math.round((fa / (hit + fa)) * 100) : null,
    days: pairs.length,
  };
}

function main() {
  const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.error('没有 data/sources/,先放入多源数据'); process.exit(1); }
  fs.mkdirSync(REP_DIR, { recursive: true });

  const all = { openmeteo: [], caiyun: [], amap_qweather: [] };
  const perCityMatrix = {};
  const dailyRows = { openmeteo: [], caiyun: [], amap_qweather: [] };

  for (const f of files) {
    const src = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf-8'));
    const om = JSON.parse(fs.readFileSync(path.join(OM_DIR, f), 'utf-8'));
    // OM 行按日期索引(om 数据一律以 backfill 为准,不用 sources 里的)
    const omMap = new Map();
    for (const r of om.rows) omMap.set(r.date, r);

    perCityMatrix[src.city] = {};
    const cityPairs = { openmeteo: [], caiyun: [], amap_qweather: [] };
    for (const r of src.rows) {
      const omRow = omMap.get(r.date);
      if (omRow) {
        cityPairs.openmeteo.push({ actual: omRow.actual, f1: omRow.f1, f3: omRow.f3 });
        dailyRows.openmeteo.push({ city: src.city, date: r.date, actual: omRow.actual.tmax, f1: omRow.f1.tmax, f3: omRow.f3.tmax });
      }
      for (const key of ['caiyun', 'amap_qweather']) {
        const s = r.sources[key];
        if (!s) continue;
        cityPairs[key].push({ actual: r.actual, f1: s.f1 || {}, f3: s.f3 || {} });
        dailyRows[key].push({ city: src.city, date: r.date, actual: r.actual.tmax, f1: s.f1?.tmax ?? null, f3: s.f3?.tmax ?? null });
      }
    }
    for (const key of Object.keys(all)) {
      all[key].push(...cityPairs[key]);
      const m = metrics(cityPairs[key]);
      perCityMatrix[src.city][key] = { maeTmaxF1: m.maeTmaxF1, maeTmaxF3: m.maeTmaxF3, days: m.days };
    }
  }

  const perSource = {};
  for (const key of Object.keys(all)) perSource[key] = metrics(all[key]);

  const windowInfo = JSON.parse(fs.readFileSync(path.join(SRC_DIR, files[0]), 'utf-8')).window;
  const summary = {
    generatedAt: new Date().toISOString(),
    window: windowInfo,
    note: 'openmeteo 取自 data/backfill(Open-Meteo Previous Runs 回填);caiyun 与 amap_qweather 取自 data/sources;实况参照为 OM day-0 分析值;高德+和风无降水量,POD/FAR 为 null',
    rainThresholdMM: RAIN_MM,
    cityCount: files.length,
    perSource,
    perCityMatrix,
  };
  fs.writeFileSync(SUM_FILE, JSON.stringify(summary, null, 1));

  // 汇总 CSV
  const head = '数据源,天数,MAE最高F1,MAE最高F3,MAE最低F1,MAE最低F3,偏差F1,POD,FAF'.replace('FAF', 'FAR');
  const csvLines = [head];
  for (const [key, m] of Object.entries(perSource)) {
    csvLines.push([NAMES[key], m.days, m.maeTmaxF1, m.maeTmaxF3, m.maeTminF1, m.maeTminF3, m.biasTmaxF1, m.pod ?? '-', m.far ?? '-'].join(','));
  }
  // 分城市矩阵
  csvLines.push('', '分城市 MAE(提前1天):');
  csvLines.push('城市,' + Object.keys(perSource).map(k => NAMES[k]).join(','));
  for (const [city, row] of Object.entries(perCityMatrix)) {
    csvLines.push([city, ...Object.keys(perSource).map(k => row[k]?.maeTmaxF1 ?? '-')].join(','));
  }
  fs.writeFileSync(path.join(REP_DIR, 'sources-summary.csv'), '\ufeff' + csvLines.join('\n'));

  // 各源逐日明细(附件证据)
  for (const [key, rows] of Object.entries(dailyRows)) {
    const lines = ['city,date,实况最高,提前1天,提前3天,误差F1,误差F3'];
    for (const r of rows) lines.push([r.city, r.date, r.actual, r.f1 ?? '-', r.f3 ?? '-',
      r.f1 != null && r.actual != null ? round2(r.f1 - r.actual) : '-', r.f3 != null && r.actual != null ? round2(r.f3 - r.actual) : '-'].join(','));
    fs.writeFileSync(path.join(REP_DIR, `sources-${key}-daily.csv`), '\ufeff' + lines.join('\n'));
  }

  console.log(`窗口 ${windowInfo.start} ~ ${windowInfo.end},${files.length} 城`);
  for (const [key, m] of Object.entries(perSource)) {
    console.log(`  ${NAMES[key].padEnd(11)} MAE 最高 F1=${m.maeTmaxF1}°C F3=${m.maeTmaxF3}°C | 最低 F1=${m.maeTminF1}°C | 偏差=${m.biasTmaxF1}°C | POD=${m.pod ?? '-'}% FAR=${m.far ?? '-'}% (${m.days}天)`);
  }
  console.log(`输出:${path.relative(process.cwd(), SUM_FILE)} 与 ${path.relative(process.cwd(), REP_DIR)}\\sources-*.csv`);
}

main();
