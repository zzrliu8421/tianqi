// 测 · 官方值对照记录(AQI 校准证据链)
// 每日对 6 个追踪城市做「国标 AQI 同屏对照」:
//   自算 = 彩云六项浓度 → HJ 633-2012 分段插值(与前端 calcCNAQI 同一套断点,
//         CO 单位 µg/m³ 入口换算 mg/m³,口径一致才可比)
//   彩云上报 = realtime.air_quality.aqi.chn(中国国标)
//   和风上报 = v7/air/now 的 aqi
//   中国天气网 = 人工同屏补录列(无公开 API)
// 缺 Key 的源自动跳过(记 —),单城市失败不影响整体;重跑同一天覆盖当日小节。
//
//   node tracker/official-aqi.js
//
// 输出:tracker/data/official-check.md

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'cities.json'), 'utf-8'));
const OUT_FILE = path.join(__dirname, 'data', 'official-check.md');
const BASE_TZ = 'Asia/Shanghai';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;

// ---- 手工解析根目录 .env(与 record.js 相同约定;进程环境变量优先,便于 CI 注入)----
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
      const h = v.indexOf(' #');
      if (h > 0) v = v.slice(0, h).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[k] = v;
    }
  }
  for (const k of ['CAIYUN_TOKEN', 'QWEATHER_KEY', 'QWEATHER_HOST'])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 HTTP ${res.status}: ${text.slice(0, 80)}`); }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
  return json;
}

// ---- 国标 AQI 自算(断点表与前端 calcCNAQI 完全一致)----
const CN_AQI_BREAKPOINTS = {
  pm25: [[0, 0], [35, 50], [75, 100], [115, 150], [150, 200], [250, 300], [350, 400], [500, 500]],
  pm10: [[0, 0], [50, 50], [150, 100], [250, 150], [350, 200], [420, 300], [500, 400], [600, 500]],
  so2:  [[0, 0], [50, 50], [150, 100], [475, 150], [800, 200], [1600, 300], [2100, 400], [2620, 500]],
  no2:  [[0, 0], [40, 50], [80, 100], [180, 150], [280, 200], [565, 300], [750, 400], [940, 500]],
  co:   [[0, 0], [2, 50], [4, 100], [14, 150], [24, 200], [36, 300], [48, 400], [60, 500]],
  o3:   [[0, 0], [100, 50], [160, 100], [215, 150], [265, 200], [800, 300]],
};
function iaqiOf(bps, c) {
  if (c == null || !isFinite(c) || c < 0) return null;
  if (c >= bps[bps.length - 1][0]) return bps[bps.length - 1][1];
  for (let i = 1; i < bps.length; i++) {
    const [cLo, iLo] = bps[i - 1], [cHi, iHi] = bps[i];
    if (c <= cHi) return Math.round(((iHi - iLo) / (cHi - cLo)) * (c - cLo) + iLo);
  }
  return null;
}
// 六项浓度(µg/m³;CO 由调用方传 mg/m³)→ { aqi, primary }
function calcCNAQI(items) {
  let aqi = null, primaryKey = null;
  for (const [key, iaqi] of items) {
    if (iaqi == null) continue;
    if (aqi == null || iaqi > aqi) { aqi = iaqi; primaryKey = key; }
  }
  if (aqi == null) return null;
  return { aqi, primary: aqi > 50 ? primaryKey.toUpperCase() : null };
}

// ---- 数据源 ----

// 彩云 realtime:air_quality 含六项浓度与国标 aqi.chn
async function fetchCaiyun(env, city) {
  const url = `https://api.caiyunapp.com/v2.6/${env.CAIYUN_TOKEN}/${city.lon},${city.lat}/realtime`;
  const j = await getJSON(url);
  const aq = j.result && j.result.realtime && j.result.realtime.air_quality;
  if (!aq) throw new Error('无 air_quality 字段');
  return {
    reported: aq.aqi && aq.aqi.chn != null ? aq.aqi.chn : null,
    conc: { pm25: aq.pm25, pm10: aq.pm10, so2: aq.so2, no2: aq.no2, co: aq.co, o3: aq.o3 },
  };
}

// 和风 v7/air/now(配了专属 Host 则走专属域名,key 以查询串注入,与 record.js 一致)
async function fetchQWeather(env, city) {
  const base = env.QWEATHER_HOST
    ? (String(env.QWEATHER_HOST).startsWith('http') ? env.QWEATHER_HOST : `https://${env.QWEATHER_HOST}`)
    : 'https://devapi.qweather.com';
  const url = `${base}/v7/air/now?location=${city.lon},${city.lat}&key=${env.QWEATHER_KEY}`;
  const j = await getJSON(url);
  const now = j.now;
  if (!now) throw new Error('无 now 字段');
  return now.aqi != null ? Number(now.aqi) : null;
}

// 彩云免费档有限流(429),失败后等 2.5s 重试一次
async function fetchCaiyunRetry(env, city) {
  try { return await fetchCaiyun(env, city); }
  catch (e) {
    if (!/429|Rate limit/.test(e.message)) throw e;
    await sleep(2500);
    return fetchCaiyun(env, city);
  }
}

async function main() {
  const env = loadEnv();
  const today = todayIn(BASE_TZ);
  if (!env.CAIYUN_TOKEN && !env.QWEATHER_KEY) {
    console.log('未配置任何 AQI 数据源 Key(CAIYUN_TOKEN/QWEATHER_KEY),跳过');
    return;
  }

  // 和风空气接口探测:v7/air/now 已在专属 API Host 废弃(403 Deprecated,新版空气
  // API 需 JWT 认证)。整轮只探一次,失败则本轮全部跳过该列——待迁移 JWT 后自动恢复。
  let qwOk = false, qwNote = '';
  if (env.QWEATHER_KEY) {
    try { await fetchQWeather(env, CITIES[0]); qwOk = true; }
    catch (e) {
      qwNote = `和风空气接口不可用(${String(e.message).slice(0, 60)}…),v7/air/now 已在专属 Host 废弃,待迁新版空气 API(JWT)后恢复自动抓取`;
      console.log(qwNote);
    }
  }

  const rows = [];
  for (const city of CITIES) {
    const row = { city: city.city, self: null, selfPrimary: null, caiyun: null, qweather: null, note: '' };
    // 彩云:上报值 + 自算(同一次请求,天然同屏)
    if (env.CAIYUN_TOKEN) {
      try {
        const c = await fetchCaiyunRetry(env, city);
        row.caiyun = c.reported;
        const calc = calcCNAQI([
          ['pm25', iaqiOf(CN_AQI_BREAKPOINTS.pm25, c.conc.pm25)],
          ['pm10', iaqiOf(CN_AQI_BREAKPOINTS.pm10, c.conc.pm10)],
          ['so2', iaqiOf(CN_AQI_BREAKPOINTS.so2, c.conc.so2)],
          ['no2', iaqiOf(CN_AQI_BREAKPOINTS.no2, c.conc.no2)],
          ['co', iaqiOf(CN_AQI_BREAKPOINTS.co, c.conc.co != null ? c.conc.co / 1000 : null)],
          ['o3', iaqiOf(CN_AQI_BREAKPOINTS.o3, c.conc.o3)],
        ]);
        if (calc) { row.self = calc.aqi; row.selfPrimary = calc.primary; }
      } catch (e) { row.note += `彩云失败(${e.message}) `; }
    }
    // 和风:独立上报值(仅探测通过时)
    if (qwOk && env.QWEATHER_KEY) {
      try { row.qweather = await fetchQWeather(env, city); }
      catch (e) { row.note += `和风失败(${e.message}) `; }
    }
    // 差异备注:自算 vs 彩云上报(同一份数据的两种算法,应高度一致);
    // 彩云 vs 和风(不同供应商实测差,供评估第三方离散度)
    const nums = [row.self, row.caiyun, row.qweather].filter(v => v != null);
    if (nums.length >= 2) {
      const d1 = (row.self != null && row.caiyun != null) ? Math.abs(row.self - row.caiyun) : null;
      const d2 = (row.caiyun != null && row.qweather != null) ? Math.abs(row.caiyun - row.qweather) : null;
      const parts = [];
      if (d1 != null && d1 > 5) parts.push(`自算vs彩云差${d1}`);
      if (d2 != null && d2 > 20) parts.push(`彩云vs和风差${d2}`);
      if (parts.length) row.note += parts.join(';') + ' ';
    }
    rows.push(row);
    console.log(`${row.city}: 自算 ${row.self ?? '—'}${row.selfPrimary ? '(' + row.selfPrimary + ')' : ''} | 彩云 ${row.caiyun ?? '—'} | 和风 ${row.qweather ?? '—'} ${row.note ? '| ' + row.note.trim() : ''}`);
    await sleep(600);
  }

  // 同步一份机器可读 JSON(前端 AQI 卡悬停与研究视图消费):维护逐城历史并算滚动统计
  const histFile = path.join(__dirname, 'data', 'official-check.json');
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(histFile, 'utf-8')).history || {}; } catch { /* 首次生成 */ }
  for (const r of rows) {
    if (r.self == null && r.caiyun == null) continue;
    const arr = hist[r.city] = (hist[r.city] || []).filter(h => h.date !== today); // 同日幂等
    arr.push({ date: today, self: r.self, caiyun: r.caiyun, qweather: r.qweather });
    arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (arr.length > 90) arr.splice(0, arr.length - 90); // 滚动窗口 90 天
  }
  const stats = {};
  for (const [city, arr] of Object.entries(hist)) {
    const pairs = arr.filter(h => h.self != null && h.caiyun != null);
    if (!pairs.length) continue;
    const last = pairs[pairs.length - 1];
    const diffs = pairs.map(h => Math.abs(h.self - h.caiyun));
    stats[city] = {
      nDays: pairs.length,
      meanAbsDiff: round2(diffs.reduce((s, v) => s + v, 0) / diffs.length),
      lastDiff: round2(Math.abs(last.self - last.caiyun)),
    };
  }
  fs.writeFileSync(histFile, JSON.stringify({ updatedAt: new Date().toISOString(), latestDate: today, rows, stats, history: hist }, null, 1));

  // 幂等写入 markdown:替换/追加当日小节
  const qwLine = qwNote ? `> 注:${qwNote}\n\n` : '';
  const section = `## ${today}\n\n${qwLine}| 城市 | 自算AQI(彩云六项→国标) | 彩云上报(chn) | 和风上报 | 中国天气网(人工) | 备注 |\n|---|---|---|---|---|---|\n` +
    rows.map(r => `| ${r.city} | ${r.self ?? '—'}${r.selfPrimary ? '(' + r.selfPrimary + ')' : ''} | ${r.caiyun ?? '—'} | ${r.qweather ?? '—'} | (待人工) | ${r.note.trim() || '—'} |`).join('\n') +
    `\n\n(彩云/和风为 ${new Date().toISOString().slice(0, 16)}Z 自动抓取;中国天气网 http://www.weather.com.cn 同屏人工核对后补录)\n`;

  const header = `# 测 · 官方值对照记录(AQI 校准证据链)\n\n方法论:自算 AQI 用 HJ 633-2012 分段线性插值(与前端 calcCNAQI 同一套断点,CO 按 µg/m³→mg/m³ 换算);彩云 aqi.chn 与和风 v7/air/now 为各自上报的国标 AQI;中国天气网为人工同屏抽查位。注意方法学差异:自算输入是**实时浓度**(与页面展示同口径,非官方逐日 24h 均值),与上报值的差值本身即记录对象——持续同向偏离说明自算实现或输入口径有系统性问题,偶发小差值属预期。彩云 vs 和风的差值反映供应商间实测离散度,是「多源交叉验证」必要性的又一实证。\n\n生成:node tracker/official-aqi.js(CI 每日自动,重跑覆盖当日)。\n\n---\n\n`;
  let content = '';
  if (fs.existsSync(OUT_FILE)) {
    content = fs.readFileSync(OUT_FILE, 'utf-8');
    const cut = content.indexOf(`## ${today}`);
    content = cut >= 0 ? content.slice(0, cut).replace(/\s+$/, '') + '\n\n' : content.trimEnd() + '\n\n';
  } else {
    content = header;
  }
  fs.writeFileSync(OUT_FILE, content + section, 'utf-8');
  console.log(`\n完成 → ${path.relative(process.cwd(), OUT_FILE)}(${today} 小节)`);
}

main().catch(e => { console.error('官方值对照失败:', e.message); process.exit(1); });
