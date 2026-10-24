// 测 · 多模式指标汇总(B 方案配套)
// 读取 tracker/data/backfill-models/*.json,按模式汇总 MAE(t+1/t+3)、偏差、
// 降水 POD/FAR,并输出"城市 × 模式"矩阵。
//   node tracker/report-models.js
// 输出:tracker/data/summary-models.json、tracker/reports/model-*.csv

const fs = require('fs');
const path = require('path');

const IN_DIR = path.join(__dirname, 'data', 'backfill-models');
const SUM_FILE = path.join(__dirname, 'data', 'summary-models.json');
const REP_DIR = path.join(__dirname, 'reports');
const RAIN_MM = 0.2;
const MODEL_IDS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'cma_grapes_global'];

const round2 = (x) => Math.round(x * 100) / 100;
const mae = (a) => (a.length ? round2(a.reduce((s, v) => s + Math.abs(v), 0) / a.length) : null);
const mean = (a) => (a.length ? round2(a.reduce((s, v) => s + v, 0) / a.length) : null);

function metrics(pairs) { // pairs: [{f, actual}]
  const e1 = [], bias = [];
  let hit = 0, miss = 0, fa = 0, cn = 0;
  for (const { f, actual } of pairs) {
    e1.push(f.tmax - actual.tmax);
    bias.push(f.tmax - actual.tmax);
    const rA = actual.precip >= RAIN_MM, rF = f.precip >= RAIN_MM;
    if (rA) { rF ? hit++ : miss++; cn++; } else if (rF) fa++;
  }
  return { maeTmaxF1: mae(e1), biasTmaxF1: mean(bias),
    pod: cn ? Math.round(hit / cn * 100) : null, far: (hit + fa) ? Math.round(fa / (hit + fa) * 100) : null,
    days: pairs.length };
}

function main() {
  const files = fs.readdirSync(IN_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.error('没有多模式数据,先运行 node tracker/backfill-models.js'); process.exit(1); }
  fs.mkdirSync(REP_DIR, { recursive: true });

  const pooled = {};   // model → pairs
  const byCity = {};   // city → model → pairs
  const cities = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(IN_DIR, f), 'utf-8'));
    cities.push({ id: d.id, city: d.city });
    byCity[d.city] = {};
    for (const m of MODEL_IDS) {
      const pairs1 = [], pairs3 = [];
      for (const r of d.rows) {
        const fm = r.models[m];
        if (!fm) continue;
        if (fm.f1) pairs1.push({ f: fm.f1, actual: r.actual });
        if (fm.f3) pairs3.push({ f: fm.f3, actual: r.actual });
      }
      pooled[m] = pooled[m] || { f1: [], f3: [] };
      pooled[m].f1.push(...pairs1);
      pooled[m].f3.push(...pairs3);
      byCity[d.city][m] = { f1: pairs1, f3: pairs3 };
    }
  }

  const perModel = {};
  for (const m of MODEL_IDS) {
    const m1 = metrics(pooled[m].f1), m3 = metrics(pooled[m].f3);
    perModel[m] = { ...m1, maeTmaxF3: m3.maeTmaxF1, daysF3: m3.days };
  }

  const perCityMatrix = {}; // city → model → {maeTmaxF1, maeTmaxF3}
  for (const [city, mm] of Object.entries(byCity)) {
    perCityMatrix[city] = {};
    for (const m of MODEL_IDS) {
      perCityMatrix[city][m] = { maeTmaxF1: metrics(mm[m].f1).maeTmaxF1, maeTmaxF3: metrics(mm[m].f3).maeTmaxF1 };
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    source: 'Open-Meteo Previous Runs API 指定模式(过去实际发布的预报)',
    reference: 'best_match day-0 分析值',
    cityCount: files.length, daysPerCity: 56,
    perModel, perCityMatrix,
  };
  fs.writeFileSync(SUM_FILE, JSON.stringify(summary, null, 1));

  // CSV:城市 × 模式 MAE 矩阵(t+1)
  const csv = ['城市,' + MODEL_IDS.join(','), ...Object.entries(perCityMatrix)
    .map(([c, mm]) => c + ',' + MODEL_IDS.map(m => mm[m].maeTmaxF1).join(','))].join('\n');
  fs.writeFileSync(path.join(REP_DIR, 'model-city-mae.csv'), '\ufeff' + csv);

  console.log(`模式汇总(6 城合并,每模式 ${perModel[MODEL_IDS[0]].days} 个城市日):`);
  for (const m of MODEL_IDS) {
    const v = perModel[m];
    console.log(`  ${m.padEnd(18)} MAE t+1=${v.maeTmaxF1}°C t+3=${v.maeTmaxF3}°C 偏差=${v.biasTmaxF1}°C POD=${v.pod}% FAR=${v.far}%`);
  }
  console.log(`输出:${path.relative(process.cwd(), SUM_FILE)} 与 reports/model-city-mae.csv`);
}

main();
