// 测 · 准确性指标汇总
// 1) 读 tracker/data/backfill/*.json,计算温度 MAE(提前1天/3天)、系统性偏差、
//    降水命中率(POD)与空报率(FAR),输出 tracker/data/summary.json
//    (逐日明细等过程性导出已归档至 tracker/archive/,信息由 summary.json
//     与 reports/sources-openmeteo-daily.csv 承载,不再重复生成 CSV)
// 2) 融 · 数据驱动权重:读 tracker/data/live-compare/*.json,按提前期(d1/d3)
//    汇总各源最高温误差 → 逆 MAE 归一化权重 + 融合期望误差 + 分歧角标阈值
//    (该提前期源间分歧 p90),输出 tracker/data/weights.json(前端融合直接消费;
//    样本不足 30 城市日/合格源不足 2 个时跳过,保留旧文件)
//
//   node tracker/report.js

const fs = require('fs');
const path = require('path');

const IN_DIR = path.join(__dirname, 'data', 'backfill');
const SUM_FILE = path.join(__dirname, 'data', 'summary.json');
const LC_DIR = path.join(__dirname, 'data', 'live-compare');
const WEIGHTS_FILE = path.join(__dirname, 'data', 'weights.json');
const RAIN_MM = 0.2; // 日降水量阈值(mm),≥ 此值记为“有雨”
const MIN_CITY_DAYS = 30; // 数据驱动权重的最低样本门槛(城市日/源/提前期)

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

// ===================== 融 · 数据驱动权重 =====================
// 数据来源:live-compare 逐日对比(errTmax = 预报 − OM day-0 实况)。
// 只统计误差非空的源;某源某提前期样本 ≥ MIN_CITY_DAYS 才参与权重。
// 权重 = 逆 MAE 归一(误差越小权重越大),按提前期分列——多源对比的实证
// 结论是“不同源在不同提前期各有所长”(彩云 t+1 最准、高德+和风 t+3 最稳)。
// badge 阈值 = 该提前期“同日各源最高温极差”的 p90,作为分歧角标的自适应门槛。
function generateWeights() {
  if (!fs.existsSync(LC_DIR)) { console.log('没有 live-compare 数据,跳过权重生成'); return; }
  const files = fs.readdirSync(LC_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('没有 live-compare 数据,跳过权重生成'); return; }

  const err = {};   // source → lead → [带符号误差]
  const spread = { d1: [], d3: [] }; // lead → [同日各源最高温极差]
  const days = new Set();
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(LC_DIR, f), 'utf-8')); } catch { continue; }
    if (!d.date) continue;
    days.add(d.date);
    for (const c of d.cities || []) {
      for (const lead of ['d1', 'd3']) {
        const rows = (c.sources || []).filter(s => s[lead] && s[lead].errTmax != null);
        for (const s of rows) {
          (err[s.source] = err[s.source] || { d1: [], d3: [] })[lead].push(s[lead].errTmax);
        }
        const vals = rows.map(s => s[lead].forecast && s[lead].forecast.tmax).filter(v => v != null);
        if (vals.length >= 2) spread[lead].push(Math.max(...vals) - Math.min(...vals));
      }
    }
  }

  // 每源每提前期指标,样本不足的源剔除
  const stats = {};
  for (const [src, leads] of Object.entries(err)) {
    stats[src] = {};
    for (const lead of ['d1', 'd3']) {
      stats[src][lead] = { mae: mae(leads[lead]), bias: mean(leads[lead]), n: leads[lead].length };
    }
  }
  const LEAD_LABEL = { d1: '明日(t+1)', d3: '第三天(t+3)' };
  const weights = {}, fusedMae = {};
  for (const lead of ['d1', 'd3']) {
    const ok = Object.keys(stats).filter(s => stats[s][lead].n >= MIN_CITY_DAYS && stats[s][lead].mae > 0);
    if (ok.length < 2) continue; // 合格源不足 2 个,该提前期不出权重(前端沿用默认)
    const invSum = ok.reduce((s, k) => s + 1 / stats[k][lead].mae, 0);
    for (const s of ok) {
      (weights[s] = weights[s] || { w: {} }).w[lead] = round2((1 / stats[s][lead].mae) / invSum);
    }
    fusedMae[lead] = round2(ok.reduce((s, k) => s + (1 / stats[k][lead].mae / invSum) * stats[k][lead].mae, 0));
  }
  if (!Object.keys(weights).length) {
    console.log(`live-compare 有 ${days.size} 天数据,但合格源不足(需 ≥2 源 × ≥${MIN_CITY_DAYS} 城市日),保留旧权重`);
    return;
  }

  // 分歧角标阈值:各提前期源间极差的 p90(样本太少时不出阈值,前端用默认 2°C)
  const badge = {};
  for (const lead of ['d1', 'd3']) {
    const a = spread[lead].sort((x, y) => x - y);
    if (a.length >= 50) badge[lead] = round2(a[Math.floor(0.9 * (a.length - 1))]);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'tracker/data/live-compare(各源预报 vs Open-Meteo day-0 分析值)',
    windowDays: days.size,
    minCityDays: MIN_CITY_DAYS,
    weightsRule: '逆 MAE 归一化,按提前期分列;badge = 同日各源最高温极差 p90',
    providerMap: { amap_qweather: ['amap', 'qweather'], caiyun: ['caiyun'], openmeteo: ['openmeteo'] },
    sources: stats, weights, fusedMae,
    badge: Object.keys(badge).length ? badge : { note: '分歧样本不足 50,暂用默认阈值' },
  };
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(payload, null, 1));

  console.log(`融 · 权重已生成(${days.size} 天窗口,${path.relative(process.cwd(), WEIGHTS_FILE)})`);
  for (const [src, v] of Object.entries(weights)) {
    const line = ['d1', 'd3'].map(l => v.w[l] != null ? `${LEAD_LABEL[l]} w=${v.w[l]}(MAE ${stats[src][l].mae}°C,n=${stats[src][l].n})` : null).filter(Boolean);
    console.log(`  ${src}: ${line.join(' | ')}`);
  }
  console.log(`  融合期望误差:${Object.entries(fusedMae).map(([l, v]) => `${LEAD_LABEL[l]} ±${v}°C`).join(' | ')} | 分歧阈值:${Object.entries(badge).map(([l, v]) => `${LEAD_LABEL[l]} ${v}°C(p90)`).join(' | ')}`);
}

function main() {
  const files = fs.readdirSync(IN_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.error('没有回填数据,先运行 node tracker/backfill.js'); process.exit(1); }

  const perCity = {}, allRows = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(IN_DIR, f), 'utf-8'));
    perCity[d.city] = metrics(d.rows);
    allRows.push(...d.rows.map(r => ({ city: d.city, ...r })));
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

  console.log(`总样本:${allRows.length} 城市日(${files.length} 城)`);
  console.log(`整体:MAE 最高温 提前1天=${summary.overall.maeTmaxF1}°C 提前3天=${summary.overall.maeTmaxF3}°C | 偏差=${summary.overall.biasTmaxF1}°C | 降水 POD=${summary.overall.pod}% FAR=${summary.overall.far}%`);
  for (const [c, m] of Object.entries(perCity))
    console.log(`  ${c}: MAE ${m.maeTmaxF1}/${m.maeTmaxF3}°C, POD=${m.pod}%, FAR=${m.far}% (${m.days}天)`);
  console.log(`输出:${path.relative(process.cwd(), SUM_FILE)}`);

  generateWeights();
}

main();
