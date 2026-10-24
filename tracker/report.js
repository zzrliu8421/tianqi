// 测 · 准确性指标汇总
// 读取 tracker/data/backfill/*.json,计算温度 MAE(提前1天/3天)、系统性偏差、
// 降水命中率(POD)与空报率(FAR),输出:
//   tracker/data/summary.json   —— 供前端“误差带”与研究报告引用
//   tracker/report/*.csv        —— 明细表(附件证据)
//
//   node tracker/report.js

const fs = require('fs');
const path = require('path');

const IN_DIR = path.join(__dirname, 'data', 'backfill');
const SUM_FILE = path.join(__dirname, 'data', 'summary.json');
const REP_DIR = path.join(__dirname, 'reports');
const RAIN_MM = 0.2; // 日降水量阈值(mm),≥ 此值记为“有雨”

const round2 = (x) => Math.round(x * 100) / 100;
const mae = (arr) => (arr.length ? round2(arr.reduce((s, v) => s + Math.abs(v), 0) / arr.length) : null);
const mean = (arr) => (arr.length ? round2(arr.reduce((s, v) => s + v, 0) / arr.length) : null);

function metrics(rows) {
  const e1 = [], e3 = [], e1min = [], e3min = [], bias1 = [];
  let hit = 0, miss = 0, fa = 0, cn = 0;
  for (const r of rows) {
    e1.push(r.f1.tmax - r.actual.tmax);
    e3.push(r.f3.tmax - r.actual.tmax);
    e1min.push(r.f1.tmin - r.actual.tmin);
    e3min.push(r.f3.tmin - r.actual.tmin);
    bias1.push(r.f1.tmax - r.actual.tmax);
    const rainA = r.actual.precip >= RAIN_MM, rainF = r.f1.precip >= RAIN_MM;
    if (rainA) { rainF ? hit++ : miss++; cn++; } else if (rainF) fa++;
  }
  const pod = cn ? Math.round((hit / cn) * 100) : null;
  const far = (hit + fa) ? Math.round((fa / (hit + fa)) * 100) : null;
  return { maeTmaxF1: mae(e1), maeTminF1: mae(e1min), maeTmaxF3: mae(e3), maeTminF3: mae(e3min),
    biasTmaxF1: mean(bias1), pod, far, rainDays: cn, falseAlarms: fa, days: rows.length };
}

function main() {
  const files = fs.readdirSync(IN_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.error('没有回填数据,先运行 node tracker/backfill.js'); process.exit(1); }
  fs.mkdirSync(REP_DIR, { recursive: true });

  const perCity = {}, allRows = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(IN_DIR, f), 'utf-8'));
    perCity[d.city] = metrics(d.rows);
    allRows.push(...d.rows.map(r => ({ city: d.city, ...r })));
    // 城市逐日明细 CSV(附件证据)
    const csv = ['date,实况最高,提前1天预报,提前3天预报,最高温误差F1,实况降水,预报降水F1',
      ...d.rows.map(r => `${r.date},${r.actual.tmax},${r.f1.tmax},${r.f3.tmax},${round2(r.f1.tmax - r.actual.tmax)},${r.actual.precip},${r.f1.precip}`)].join('\n');
    fs.writeFileSync(path.join(REP_DIR, `${d.id}-daily.csv`), '\ufeff' + csv);
  }

  // 逐日(跨城市平均)误差序列 —— 趋势图数据
  const byDate = new Map();
  for (const r of allRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, { a1: [], a3: [] });
    byDate.get(r.date).a1.push(Math.abs(r.f1.tmax - r.actual.tmax));
    byDate.get(r.date).a3.push(Math.abs(r.f3.tmax - r.actual.tmax));
  }
  const daily = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([date, v]) => ({ date, maeTmaxF1: mae(v.a1), maeTmaxF3: mae(v.a3) }));

  const summary = {
    generatedAt: new Date().toISOString(),
    source: 'Open-Meteo Previous Runs API(过去实际发布的预报)vs day-0 分析值',
    rainThresholdMM: RAIN_MM,
    cityCount: files.length,
    totalCityDays: allRows.length,
    overall: metrics(allRows),
    perCity, daily,
  };
  fs.writeFileSync(SUM_FILE, JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(REP_DIR, 'daily-mae.csv'),
    '\ufeff' + 'date,城市平均MAE_提前1天,城市平均MAE_提前3天\n' + daily.map(d => `${d.date},${d.maeTmaxF1},${d.maeTmaxF3}`).join('\n'));

  console.log(`总样本:${allRows.length} 城市日(${files.length} 城)`);
  console.log(`整体:MAE 最高温 提前1天=${summary.overall.maeTmaxF1}°C 提前3天=${summary.overall.maeTmaxF3}°C | 偏差=${summary.overall.biasTmaxF1}°C | 降水 POD=${summary.overall.pod}% FAR=${summary.overall.far}%`);
  for (const [c, m] of Object.entries(perCity))
    console.log(`  ${c}: MAE ${m.maeTmaxF1}/${m.maeTmaxF3}°C, POD=${m.pod}%, FAR=${m.far}% (${m.days}天)`);
  console.log(`输出:${path.relative(process.cwd(), SUM_FILE)} 与 ${path.relative(process.cwd(), REP_DIR)}\\*.csv`);
}

main();
