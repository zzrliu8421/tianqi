/**
 * SkyWeather 代理服务器
 *
 * 作用：把高德 / 和风 / IPnews 等 API Key 收敛在服务端，前端不再持有任何密钥。
 *
 * 工作原理：
 *   1. 从系统环境变量或 .env 文件读取 AMAP_KEY / QWEATHER_KEY / QWEATHER_HOST / IPNEWS_KEY / CAIYUN_TOKEN
 *      以及 AI 建议模型链的 AGNES_API_KEY（首选 Agnes）与 ZHIPU_API_KEY（次选智谱）
 *   2. 暴露以下代理端点（前端不传 key，由服务端补齐）：
 *      - GET /api/amap/<path>           → https://restapi.amap.com/<path>?<query>&key=AMAP_KEY
 *      - GET /api/qweather/geo/<path>   → https://geoapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/qweather/dev/<path>   → https://devapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/ipnews/<path>         → https://ipnews.io/<path>?<query>&api-key=IPNEWS_KEY
 *      - GET /api/caiyun/<path>         → https://api.caiyunapp.com/<path>，token 注入路径段：
 *        /api/caiyun/v2.6/<lon>,<lat>/weather → /v2.6/<CAIYUN_TOKEN>/<lon>,<lat>/weather
 *      - POST /api/ai/advice            → AI 天气生活建议：按模型链依次 POST <baseUrl>/chat/completions
 *        （首选 Agnes：agnes-2.5-flash → agnes-3.0-flash；次选智谱：glm-4.7-flash → glm-4-flash，
 *        Bearer 对应供应商 Key）。输出做"接地校验"：响应文本中的每个数字必须来自请求 data 的
 *        数值集合，未通过则沿链换下一个模型；全部失败 / 未配置 Key / 上游异常 →
 *        规则降级（mode:"rule"）。结果按 city+hour 缓存 1 小时；限流收紧为 10 次/分/IP
 *
 *      和风天气：配置 QWEATHER_HOST（专属 API Host）后，geo 与天气统一走
 *      https://<QWEATHER_HOST>/...，且 GeoAPI 路径带 /geo 服务前缀
 *      （专属 Host：/geo/v2/city/lookup；通用域名：geoapi.qweather.com/v2/city/lookup）。
 *      官方通用域名 geoapi/devapi.qweather.com 已宣布将逐步停用，推荐配置专属 Host。
 *   3. 同时托管项目根目录的静态文件（index.html / config.js 等）
 *   4. 启动时自动生成 config.js（不含真实 Key，仅含布尔标志）
 *
 * 安全加固（与 edge-functions/api/[[path]].js 的路由表保持一致）：
 *   - 上游路径白名单：只放行前端实际调用的固定路径，其余返回 403 path not allowed
 *   - 单 IP 限流：/api/* 每客户端 IP 每分钟 90 次；超限 429 + Retry-After；IPv6 按 /64 归一化；
 *     POST /api/ai/advice 单独收紧为 10 次/分/IP（独立计数桶）
 *   - Origin 校验：带 Origin 头且其 host 与请求 Host 不一致时返回 403
 *   - 安全响应头：X-Content-Type-Options / Referrer-Policy；CORS 按 Origin 回显（无 Origin 不发该头）
 *   - 静态文件：拒绝点开头的路径段（.git / .env 等，其中 .env 显式 403）、node_modules；realpath 必须落在 ROOT 内
 *   - 压缩与缓存：html/js/css/json/svg/map 支持 gzip（内存缓存按 path+mtime，条目数有上限）
 *
 * 零依赖：仅使用 Node 原生 http / https / fs / path / zlib / child_process 模块。
 *
 * 用法：
 *   node server.js                # 默认监听 0.0.0.0:8787
 *   PORT=9000 node server.js      # 自定义端口
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

// ===================== 配置 =====================
const ROOT = __dirname;
const ROOT_REAL = (() => {
    try { return fs.realpathSync(ROOT); } catch (e) { return ROOT; }
})();
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 跨域部署白名单（"方式 B：前端静态托管 + 独立代理" 时使用，逗号分隔完整 Origin）
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

// 请求超时（毫秒）
const UPSTREAM_TIMEOUT = 10000;

// ===================== 安全策略常量 =====================

// 上游路径白名单：只放行前端实际使用的路径（防止代理被当作开放跳板刷第三方额度）
const ALLOWED_PATHS = {
    amap: new Set([
        '/v3/ip',
        '/v3/geocode/geo',
        '/v3/geocode/regeo',
        '/v3/weather/weatherInfo',
    ]),
    qweather_geo: new Set([
        '/v2/city/lookup',
    ]),
    qweather_dev: new Set([
        '/v7/weather/now',
        '/v7/weather/24h',
        '/v7/weather/7d',
        '/v7/air/now',
    ]),
};

// ipnews 路径形如 api/v1/json/<ip>，只允许 IP 字符（十六进制、点、冒号）
const IPNEWS_PATH_RE = /^api\/v1\/json\/[0-9a-fA-F:.]+$/;
const IPNEWS_MAX_PATTERN_LENGTH = 128;

// 彩云天气路径形如 v2.6/<经度>,<纬度>/weather（token 由代理注入到 v2.6 与坐标之间）。
// 坐标段限数字格式（范围在路由内校验），端点只放行前端实际调用的 /weather 综合接口。
const CAIYUN_PATH_RE = /^v2\.6\/(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)\/weather$/;

// 限流：每客户端 IP 每分钟 90 次
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// AI 建议端点（POST /api/ai/advice）收紧限流：每 IP 每分钟 10 次（独立计数桶）
const AI_RATE_LIMIT_MAX = 10;

// 静态文件 MIME 映射
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

// 可 gzip 压缩的扩展名
const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.map']);

// gzip 内存缓存（key = 文件绝对路径，按 path+mtime 失效，条目数上限防止内存膨胀）
const GZIP_CACHE_MAX = 64;
const gzipCache = new Map();

// 限流计数桶（key = 归一化后的客户端 IP）
const rateBuckets = new Map();

// ===================== 环境变量加载 =====================
function parseEnvFile(filePath) {
    const env = {};
    if (!fs.existsSync(filePath)) return env;
    const content = fs.readFileSync(filePath, 'utf8');
    content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) return;
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) env[key] = value;
    });
    return env;
}

function loadEnv() {
    const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
    return {
        AMAP_KEY: process.env.AMAP_KEY !== undefined ? process.env.AMAP_KEY : (fileEnv.AMAP_KEY || ''),
        QWEATHER_KEY: process.env.QWEATHER_KEY !== undefined ? process.env.QWEATHER_KEY : (fileEnv.QWEATHER_KEY || ''),
        QWEATHER_HOST: process.env.QWEATHER_HOST !== undefined ? process.env.QWEATHER_HOST : (fileEnv.QWEATHER_HOST || ''),
        IPNEWS_KEY: process.env.IPNEWS_KEY !== undefined ? process.env.IPNEWS_KEY : (fileEnv.IPNEWS_KEY || ''),
        CAIYUN_TOKEN: process.env.CAIYUN_TOKEN !== undefined ? process.env.CAIYUN_TOKEN : (fileEnv.CAIYUN_TOKEN || ''),
        ZHIPU_API_KEY: process.env.ZHIPU_API_KEY !== undefined ? process.env.ZHIPU_API_KEY : (fileEnv.ZHIPU_API_KEY || ''),
        AGNES_API_KEY: process.env.AGNES_API_KEY !== undefined ? process.env.AGNES_API_KEY : (fileEnv.AGNES_API_KEY || ''),
        AI_BASE_URL: process.env.AI_BASE_URL !== undefined ? process.env.AI_BASE_URL : (fileEnv.AI_BASE_URL || ''),
        AI_MODEL: process.env.AI_MODEL !== undefined ? process.env.AI_MODEL : (fileEnv.AI_MODEL || ''),
        AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL !== undefined ? process.env.AI_FALLBACK_MODEL : (fileEnv.AI_FALLBACK_MODEL || ''),
    };
}

const ENV = loadEnv();

// ===================== 上游 API 基地址 =====================
// 和风天气专属 API Host（控制台「设置」页查看，形如 abcxyz.xy.qweatherapi.com）。
// 容错：允许带 https:// 前缀或结尾斜杠；留空则回退通用域名（官方将逐步停用）。
const QWEATHER_HOST = (ENV.QWEATHER_HOST || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();

const UPSTREAM = {
    amap: 'restapi.amap.com',
    qweather_geo: QWEATHER_HOST || 'geoapi.qweather.com',
    qweather_dev: QWEATHER_HOST || 'devapi.qweather.com',
    ipnews: 'ipnews.io',
    caiyun: 'api.caiyunapp.com',
};

// 彩云 token 只允许 URL 路径安全字符；不合规视为未配置，防止注入破坏上游路径结构
const CAIYUN_TOKEN_OK = /^[A-Za-z0-9_-]+$/.test(ENV.CAIYUN_TOKEN || '');

// 专属 Host 下 geo 与天气共用同一域名，GeoAPI 路径需带 /geo 服务前缀；
// 通用 geoapi 域名的服务前缀在域名里，路径本身不带。
const QWEATHER_GEO_PREFIX = QWEATHER_HOST ? '/geo' : '';

// ===================== AI 天气生活建议配置 =====================
// AI 建议模型链（依次尝试，全部失败走规则降级 mode:"rule"）：
// 首选供应商 Agnes（OpenAI 兼容中转）：agnes-2.5-flash → agnes-3.0-flash。
// 2026-10-25 A/B 实测：3.0 约四成输出编造输入外数值被接地校验拦下、通过时文风偏硬；
// 2.5 文风最活且通过率高，故 2.5 升首选、3.0 退居备选。
// 次选供应商智谱：glm-4.7-flash → glm-4-flash（免费档高峰期常见 429）。
// 未配置对应 Key 的供应商整段跳过；一个 Key 都没配时直接规则降级。
const ZHIPU_BASE_URL = (ENV.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const AI_PROVIDER_CHAIN = [
    { provider: 'agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: ENV.AGNES_API_KEY, model: 'agnes-2.5-flash' },
    { provider: 'agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: ENV.AGNES_API_KEY, model: 'agnes-3.0-flash' },
    { provider: 'zhipu', baseUrl: ZHIPU_BASE_URL, apiKey: ENV.ZHIPU_API_KEY, model: ENV.AI_MODEL || 'glm-4.7-flash' },
    { provider: 'zhipu', baseUrl: ZHIPU_BASE_URL, apiKey: ENV.ZHIPU_API_KEY, model: ENV.AI_FALLBACK_MODEL || 'glm-4-flash' },
];

// 智 · 人群标签(可选):建议的面向人群,白名单校验,白名单外一律忽略(向后兼容旧客户端)
const AI_GROUPS = {
    elderly: '老年人',
    child: '儿童家庭',
    respiratory: '呼吸道敏感人群',
    commuter: '通勤族',
};

// system prompt：约束 LLM 只能引用输入数值、输出严格 JSON；
// 写作定位是"有生活温度的天气伙伴"——条数与字数不做硬性限制（校验只守宽松
// 上限），靠一对"套话 vs 想要的"风格示例（刻意不含数字，防被照抄）把文风
// 拉向具体时段、体感与惦记，避免公文腔与卡片结论的复述
const AI_SYSTEM_PROMPT = [
    '你是天气伙伴，像关心朋友一样，基于给定的真实天气数据给用户写今日提醒。',
    '硬性规则：',
    '1. 只能使用输入数据中出现的数值，严禁编造；也不要做任何推算或换算——不写"比实际高出3度"这类算出来的差值，不把 17:15 说成"下午5点15分"，保留数值原有的单位与写法；',
    '2. 不要提及"数据来源"；文案里不要出现英文字段名或缩写（uv、aqi、pop、tmax、sunset 之类），一律用中文名词（紫外线指数、空气质量指数、降水概率、最高气温、日落时间）；不要用"建议您""请注意"等公文腔，也不要以"建议"开头，用"你"的自然口吻。',
    '页面已有指数卡片交代穿衣、带伞、防晒这类基础结论。这些话题可以写，但要么讲得更深（结合具体数值说清"为什么"、落到时段或场景说"什么时候该怎么做"），要么带出身体与心情层面的关照；原样复述卡片结论等于没写。',
    '条数与字数不设硬性限制：建议 2~4 条，每条几句话说透就好，长短跟着内容走，不为凑数注水。可以从这些角度找感觉：',
    '- 早高峰、午休、傍晚、夜间等时间节点，出门、通勤、回家路上的具体留意点；',
    '- 昼夜温差的疲惫、阴雨天的沉闷、大风天的干燥，给一点身体和心情上的宽慰；',
    '- 开窗通风、晾晒收衣、接送孩子、遛狗散步、夜间开车这类具体场景，细节里带点淡淡的幽默。',
    '风格示例（同一份提醒的对比，感受差别即可，不要照抄内容）：',
    '× 套话："今日温差较大，建议适时增减衣物，注意保暖，出门携带雨具。"——换个城市换一天都成立，谁都能写；',
    '√ 想要的："太阳傍晚就下班了，风一吹，体感比预报里的数字更诚实。回家那段路记得把衣领立起来，进门前在楼道里缓一缓，别让温差扑个满怀。"——有具体时间、有体感、有一点点惦记。',
    '写完自查：任何一条如果换个城市、换一天也成立，那就是套话，重写；结论也不得与数据矛盾（紫外线很强就不能说不用防晒，空气优良就别让人戴口罩）。',
    '输出严格的 JSON：{"summary":"一两句有温度的天气速览","tips":["提醒1","提醒2"]}，语气像朋友发来的问候，不要感叹号轰炸。最后再强调一次：所有数值只能原样引用输入，禁止加减差值、禁止时间换算（17:15 就是 17:15）。',
].join('\n');

// 数字提取（含小数、负数；"18.5°C" 这类带单位形式取 18.5）
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

// 结果缓存：按 city+hour 维度缓存 LLM 成功结果，TTL 1 小时，条目上限 200（近似 LRU 淘汰）
const AI_CACHE_TTL_MS = 60 * 60 * 1000;
const AI_CACHE_MAX = 200;

// POST 请求体大小上限（JSON 文本）
const AI_MAX_BODY_BYTES = 16 * 1024;

const aiCache = new Map();

// 智 · 运行统计(进程内存累计,重启清零;只聚合计数,不含任何请求内容/明文)。
// 供 GET /api/ai/stats 输出"可核查的运行数据"——缓存命中即省下的上游调用量,
// 各链路成员的调用/通过/拦截计数即接地校验拦截率的直接证据(成本与合规复核)。
const aiStats = {
    startedAt: new Date().toISOString(),
    requests: 0, cacheHits: 0, aiOk: 0, ruleFallback: 0,
};
const aiStatByProvider = {}; // provider/model → { calls, ok, groundingFail, upstreamFail }
function aiStatProvider(provider, model, field) {
    const o = aiStatByProvider[`${provider}/${model}`] = aiStatByProvider[`${provider}/${model}`]
        || { calls: 0, ok: 0, groundingFail: 0, upstreamFail: 0 };
    o[field]++;
}
const aiRateBuckets = new Map();

// ===================== 工具函数 =====================
function sendJSON(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    const headers = Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    }, extraHeaders || {});
    res.writeHead(status, headers);
    res.end(body);
}

// 追加 Vary（避免覆盖已有的 Vary 值，如 Origin + Accept-Encoding 并存）
function appendVary(res, value) {
    const current = res.getHeader('Vary');
    if (!current) {
        res.setHeader('Vary', value);
        return;
    }
    const parts = String(current).split(',').map(s => s.trim().toLowerCase());
    if (!parts.includes(value.toLowerCase())) {
        res.setHeader('Vary', String(current) + ', ' + value);
    }
}

/**
 * 判断请求的 Origin 是否与 Host 同源。
 * - 无 Origin（curl / 服务端调用）→ 放行，保持可测试
 * - 有 Origin 但 host 不一致 → 拒绝
 */
function isSameOriginRequest(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (ALLOWED_ORIGINS.includes(String(origin).toLowerCase())) return true;
    const host = String(req.headers.host || '').toLowerCase();
    let originHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch (e) { originHost = null; }
    return !!originHost && !!host && originHost === host;
}

/**
 * 把 IPv4-mapped / 带 zone 的地址归一化。
 * IPv6 统一折叠到 /64 前缀，避免单个用户拥有海量计数键。
 */
function normalizeClientIp(rawIp) {
    if (!rawIp) return null;
    let ip = String(rawIp).trim();
    const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) ip = mapped[1];
    const zoneIndex = ip.indexOf('%');
    if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
    if (!ip.includes(':')) return ip;
    const groups = expandIPv6(ip);
    if (!groups) return ip;
    return groups.slice(0, 4).join(':') + '::/64';
}

function expandIPv6(ip) {
    if (ip === '::') return ['0', '0', '0', '0', '0', '0', '0', '0'];
    const doubleIdx = ip.indexOf('::');
    const leftRaw = doubleIdx === -1 ? ip : ip.slice(0, doubleIdx);
    const rightRaw = doubleIdx === -1 ? '' : ip.slice(doubleIdx + 2);
    const left = leftRaw ? leftRaw.split(':') : [];
    const right = rightRaw ? rightRaw.split(':') : [];
    if (left.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    if (right.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    if (doubleIdx === -1) {
        if (left.length !== 8) return null;
        return left;
    }
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    return left.concat(new Array(missing).fill('0'), right).map(g => g.toLowerCase());
}

/**
 * 简单的固定窗口限流：返回 { allowed, retryAfter }
 * opts.max / opts.store 缺省时使用全局 90 次/分配置；
 * AI 建议端点传入收紧的 10 次/分与独立计数桶（避免与全局计数互相挤占）
 */
function checkRateLimit(req, opts) {
    const max = (opts && opts.max) || RATE_LIMIT_MAX;
    const store = (opts && opts.store) || rateBuckets;
    const ip = normalizeClientIp(req.socket && req.socket.remoteAddress);
    if (!ip) return { allowed: true };
    const now = Date.now();
    let bucket = store.get(ip);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
        bucket = { windowStart: now, count: 0 };
        store.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) return { allowed: true };
    const retryAfter = Math.max(1, Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfter };
}

// 定期清理过期计数，防止内存无限增长（unref 不阻塞进程退出）
const rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const store of [rateBuckets, aiRateBuckets]) {
        for (const [ip, bucket] of store) {
            if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) store.delete(ip);
        }
    }
}, Math.floor(RATE_LIMIT_WINDOW_MS / 2));
if (typeof rateCleanupTimer.unref === 'function') rateCleanupTimer.unref();

/**
 * 防止路径穿越：过滤空段 / . / ..，并保证解析结果在 ROOT_REAL 内。
 * 返回绝对路径；越界返回 null。
 */
function isPathInsideRoot(target) {
    const rel = path.relative(ROOT_REAL, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function safeJoinPath(base, sub) {
    const cleaned = sub.split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
    const resolved = path.resolve(base, cleaned);
    return isPathInsideRoot(resolved) ? resolved : null;
}

// 判断客户端是否接受 gzip
function acceptsGzip(header) {
    if (!header) return false;
    return String(header).split(',').some(part => {
        const pieces = part.trim().split(';');
        if (pieces[0].trim().toLowerCase() !== 'gzip') return false;
        for (let i = 1; i < pieces.length; i++) {
            const p = pieces[i].trim();
            if (/^q=/i.test(p)) {
                const q = parseFloat(p.slice(2));
                return !Number.isNaN(q) && q > 0;
            }
        }
        return true;
    });
}

/**
 * 取 gzip 结果：优先命中 path+mtime+size 的内存缓存，未命中则压缩并按上限淘汰。
 */
function getGzipped(filePath, mtimeMs, size, data, cb) {
    const cached = gzipCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        // 命中后重新插入，近似 LRU
        gzipCache.delete(filePath);
        gzipCache.set(filePath, cached);
        return cb(null, cached.gzip);
    }
    zlib.gzip(data, { level: 6 }, (err, gz) => {
        if (err) return cb(err);
        if (gzipCache.size >= GZIP_CACHE_MAX) {
            const oldest = gzipCache.keys().next();
            if (!oldest.done) gzipCache.delete(oldest.value);
        }
        gzipCache.set(filePath, { mtimeMs, size, gzip: gz });
        cb(null, gz);
    });
}

// ===================== 上游代理 =====================
// 日志脱敏：key/api-key query 参数与彩云 token 路径段不进错误日志
function maskSensitivePath(fullPath) {
    return fullPath
        .replace(/([?&])(key|api-key)=[^&]*/g, '$1$2=****')
        .replace(/^\/v2\.6\/[^/?]+\//, '/v2.6/****/');
}

/**
 * 透传 GET 请求到 https://host/path?query，并附加额外 query 参数
 */
function proxyGet(req, res, host, upstreamPath, extraQuery) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const params = new URLSearchParams(parsed.searchParams);
    if (extraQuery) {
        for (const [k, v] of Object.entries(extraQuery)) {
            if (v !== undefined && v !== null && v !== '') params.set(k, v);
        }
    }
    const search = params.toString();
    const fullPath = search ? `${upstreamPath}?${search}` : upstreamPath;
    const logPath = `${host}${maskSensitivePath(fullPath)}`;

    const options = {
        hostname: host,
        port: 443,
        path: fullPath,
        method: 'GET',
        headers: {
            'User-Agent': 'SkyWeather-Proxy/1.0',
            'Accept': 'application/json, text/plain, */*',
        },
        timeout: UPSTREAM_TIMEOUT,
    };

    const upstreamReq = https.request(options, upstreamRes => {
        const contentType = upstreamRes.headers['content-type'] || 'application/json; charset=utf-8';
        const cacheControl = upstreamRes.headers['cache-control'] || 'public, max-age=60';
        const encoding = (upstreamRes.headers['content-encoding'] || '').toLowerCase();

        // 主动解压上游响应，让浏览器总是收到原始 JSON
        let stream = upstreamRes;
        if (encoding === 'gzip') {
            stream = upstreamRes.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate' || encoding === 'deflate-raw') {
            stream = upstreamRes.pipe(zlib.createInflate());
        } else if (encoding === 'br') {
            stream = upstreamRes.pipe(zlib.createBrotliDecompress());
        }

        const headers = {
            'Content-Type': contentType,
            'Cache-Control': cacheControl,
        };
        res.writeHead(upstreamRes.statusCode || 502, headers);
        stream.on('error', err => {
            console.error(`[proxy] 解压 ${logPath} 失败:`, err.message);
            if (!res.writableEnded) res.end();
        });
        stream.pipe(res);
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        if (!res.headersSent) sendJSON(res, 504, { error: 'upstream timeout' });
    });
    upstreamReq.on('error', err => {
        console.error(`[proxy] ${logPath} 失败:`, err.message);
        if (!res.headersSent) sendJSON(res, 502, { error: 'upstream error', detail: err.message });
    });
    upstreamReq.end();
}

// ===================== AI 天气生活建议 =====================
/**
 * 请求体校验：city 为非空字符串（≤20 字符），data 为一层扁平键值（数值或短字符串）。
 * 校验失败返回 null（路由层回 400）。
 */
function validateAdvicePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (typeof body.city !== 'string') return null;
    const city = body.city.trim();
    if (!city || city.length > 20) return null;
    const data = body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const keys = Object.keys(data);
    if (keys.length === 0 || keys.length > 30) return null;
    for (const k of keys) {
        if (!k || k.length > 32) return null;
        const v = data[k];
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) return null;
        } else if (typeof v === 'string') {
            if (v.length > 32) return null;
        } else {
            return null;
        }
    }
    // 智 · 人群标签(可选)
    const group = typeof body.group === 'string' && AI_GROUPS[body.group] ? body.group : null;
    return { city, data, group };
}

/**
 * 输入数值集合：data 中所有数值 + 字符串值里出现的数字（"东北风3级" 里的 3）。
 * 统一经 Number 规整后字符串化，供接地校验做成员比较。
 */
function collectInputNumbers(data) {
    const set = new Set();
    const add = v => set.add(String(Number(v)));
    for (const v of Object.values(data)) {
        if (typeof v === 'number') add(v);
        else if (typeof v === 'string') {
            const m = v.match(NUMBER_RE);
            if (m) m.forEach(add);
        }
    }
    return set;
}

/**
 * 从 LLM 文本解析 JSON：容错剥离 markdown 代码围栏（```json ... ```），
 * 再截取首个 { 到最后一个 } 之间的内容解析。
 */
function parseAdviceText(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim();
    const fenced = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    if (fenced) t = fenced[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(t.slice(start, end + 1));
    } catch (e) {
        return null;
    }
}

/**
 * 找出文本中不在输入数值集合里的数字（接地校验与失败日志共用）。
 */
function findUngroundedNumbers(text, inputNumbers) {
    const found = text.match(NUMBER_RE) || [];
    return found.filter(raw => !inputNumbers.has(String(Number(raw))));
}

/**
 * 接地校验（核心）：结构合法 + 响应文本里出现的每个数字（含小数，允许
 * "18.5°C" 这类带单位形式）都必须能在输入 data 的数值集合中找到。
 * 字数只守宽松上限（summary≤80 / 单条 tip≤150，条数 1~6），细粒度的
 * 条数与文风交给 prompt 约束，不做硬卡。
 */
function isGroundedAdvice(advice, inputNumbers) {
    if (!advice || typeof advice !== 'object' || Array.isArray(advice)) return false;
    if (typeof advice.summary !== 'string' || !advice.summary.trim() || advice.summary.length > 80) return false;
    if (!Array.isArray(advice.tips) || advice.tips.length === 0 || advice.tips.length > 6) return false;
    for (const tip of advice.tips) {
        if (typeof tip !== 'string' || !tip.trim() || tip.length > 150) return false;
    }
    const text = advice.summary + '\n' + advice.tips.join('\n');
    return findUngroundedNumbers(text, inputNumbers).length === 0;
}

/**
 * 规则降级：按简单阈值规则生成同结构结果（温度→穿衣、pop≥50→带伞、
 * aqi≥100→戴口罩减少外出、uv≥6→防晒），只引用输入 data 中的原始数值。
 */
function buildRuleAdvice(city, data) {
    const n = k => (typeof data[k] === 'number' && Number.isFinite(data[k]) ? data[k] : null);
    const temp = n('temp') !== null ? n('temp') : n('feelsLike');
    const tmax = n('tmax');
    const tmin = n('tmin');
    const pop = n('pop');
    const aqi = n('aqi');
    const uv = n('uv');
    const humidity = n('humidity');
    const weather = typeof data.weather === 'string' ? data.weather.trim() : '';

    const tips = [];
    if (temp !== null) {
        if (temp >= 28) tips.push('气温较高，建议穿轻薄透气的浅色衣物，注意补水防暑');
        else if (temp >= 21) tips.push('温度舒适，短袖或薄长袖即可，适合户外活动');
        else if (temp >= 14) tips.push('早晚偏凉，建议长袖加薄外套，方便随时增减衣物');
        else if (temp >= 5) tips.push('气温较低，建议穿夹克或风衣，早晚适当添衣');
        else tips.push('气温很低，建议厚外套配围巾手套，注意防寒保暖');
    } else if (tmin !== null && tmax !== null) {
        tips.push(`今日气温${tmin}~${tmax}°C，建议按最低气温准备衣物`);
    } else {
        tips.push('建议根据体感温度灵活增减衣物');
    }
    if (pop !== null && pop >= 50) tips.push(`降水概率${pop}%，出门建议随身携带雨伞`);
    else if (pop !== null) tips.push(`降水概率仅${pop}%，基本无需带伞，适合出行`);
    if (aqi !== null && aqi >= 100) tips.push(`空气质量指数${aqi}，建议佩戴口罩、减少户外剧烈运动`);
    else if (aqi !== null && aqi >= 50) tips.push(`空气质量指数${aqi}，一般人群可正常户外活动`);
    if (uv !== null && uv >= 6) tips.push(`紫外线指数${uv}，外出注意防晒，戴帽子或涂防晒霜`);
    if (humidity !== null && humidity <= 30) tips.push(`湿度仅${humidity}%，空气干燥，注意补水保湿`);
    if (tips.length > 4) tips.length = 4;
    if (tips.length < 3) tips.push('出行前关注最新天气变化，合理安排行程');

    const bits = [];
    if (weather) bits.push(weather);
    if (temp !== null) bits.push(`气温${temp}°C`);
    else if (tmin !== null && tmax !== null) bits.push(`${tmin}~${tmax}°C`);
    let summary = bits.length ? `${city}：${bits.join('，')}` : `${city}：天气平稳`;
    if (summary.length > 30) summary = summary.slice(0, 30);
    return { mode: 'rule', summary, tips };
}

// city+hour 维度缓存（仅缓存 LLM 成功结果；近似 LRU，TTL 1 小时，上限 200 条）
function adviceCacheGet(key) {
    const entry = aiCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > AI_CACHE_TTL_MS) {
        aiCache.delete(key);
        return null;
    }
    aiCache.delete(key);
    aiCache.set(key, entry);
    return entry.value;
}

function adviceCacheSet(key, value) {
    if (aiCache.has(key)) aiCache.delete(key);
    if (aiCache.size >= AI_CACHE_MAX) {
        const oldest = aiCache.keys().next();
        if (!oldest.done) aiCache.delete(oldest.value);
    }
    aiCache.set(key, { at: Date.now(), value });
}

/**
 * 读取 POST JSON 请求体（带上限，超限 413 / 解析失败 400）
 */
function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let overflow = false;
        const chunks = [];
        req.on('data', chunk => {
            if (overflow) return;
            size += chunk.length;
            if (size > maxBytes) {
                overflow = true;
                chunks.length = 0;
                req.pause();
                const err = new Error('request body too large');
                err.statusCode = 413;
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (overflow) return;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                const err = new Error('invalid JSON body');
                err.statusCode = 400;
                reject(err);
            }
        });
        req.on('error', err => { if (!overflow) reject(err); });
    });
}

/**
 * 调用 OpenAI 兼容的 chat/completions（Bearer 供应商 API Key），返回首个 choice 的文本。
 * 日志只记错误消息，绝不打印 Authorization 头 / Key（遵循现有脱敏模式）。
 */
function callLLMOnce(city, data, provider, group) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(provider.baseUrl + '/chat/completions');
        } catch (e) {
            return reject(new Error('invalid AI base url: ' + provider.baseUrl));
        }
        const payload = JSON.stringify({
            model: provider.model,
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: `城市：${city}\n当前时段：${data.month}月 ${data.hour != null ? data.hour + '点' : ''}\n天气数据：${JSON.stringify(data)}\n\n请写出有生活温度的今日提醒。穿衣、带伞、防晒这类话题页面卡片已有基础结论，可以谈，但要更深一层——讲清原因、落到具体时段或场景、给出卡片没有的关照，不要只复述卡片结论。${group ? `\n本条提醒面向人群：${AI_GROUPS[group]}——请从这一人群的切身场景出发（出行安全、健康防护、作息安排等），数值规则不变。` : ''}` },
            ],
            temperature: 0.7,
            max_tokens: 800,
        });
        const upstreamReq = https.request({
            hostname: target.hostname,
            port: target.port ? parseInt(target.port, 10) : 443,
            path: target.pathname + target.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
                'User-Agent': 'SkyWeather-Proxy/1.0',
            },
            timeout: UPSTREAM_TIMEOUT,
        }, upstreamRes => {
            let text = '';
            upstreamRes.setEncoding('utf8');
            upstreamRes.on('data', chunk => { text += chunk; });
            upstreamRes.on('end', () => {
                const status = upstreamRes.statusCode || 502;
                if (status !== 200) return reject(new Error(`LLM upstream HTTP ${status}`));
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch (e) {
                    return reject(new Error('LLM upstream returned invalid JSON'));
                }
                const content = parsed && parsed.choices && parsed.choices[0] &&
                    parsed.choices[0].message && parsed.choices[0].message.content;
                if (typeof content !== 'string' || !content.trim()) {
                    return reject(new Error('LLM upstream returned empty content'));
                }
                resolve(content);
            });
        });
        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
            reject(new Error('LLM upstream timeout'));
        });
        upstreamReq.on('error', err => reject(err));
        upstreamReq.end(payload);
    });
}

/**
 * POST /api/ai/advice 主逻辑：校验 → 查缓存 → 沿模型链 LLM（接地校验，失败换下一模型）→ 规则降级。
 * 统一响应：{mode:"ai"|"rule", summary, tips:[...], cached:boolean}
 */
async function handleAiAdvice(req, res) {
    let body;
    try {
        body = await readJsonBody(req, AI_MAX_BODY_BYTES);
    } catch (e) {
        return sendJSON(res, e.statusCode || 400, { error: e.message || 'bad request' });
    }
    const payload = validateAdvicePayload(body);
    if (!payload) {
        return sendJSON(res, 400, { error: 'invalid payload: need {city: string<=20, data: flat object of numbers/short strings}' });
    }
    const city = payload.city;
    const data = payload.data;
    const group = payload.group || null;

    // 缓存 key：city+hour+人群(人群标签改变建议内容,必须参与键)
    const hourRaw = data.hour;
    const hour = typeof hourRaw === 'number' && Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23
        ? hourRaw
        : new Date().getHours();
    const cacheKey = `${city}|${hour}|${group || ''}`;

    aiStats.requests++;
    const hit = adviceCacheGet(cacheKey);
    if (hit) { aiStats.cacheHits++; return sendJSON(res, 200, Object.assign({ cached: true }, hit)); }

    // 沿模型链依次尝试（供应商内主→备、供应商间首选→次选），全部失败再走规则降级。
    // 链路总预算 12s（< 前端 15s 超时）：预算耗尽不再发起新尝试，直接规则降级，
    // 保证服务端总能及时响应；成功结果会进缓存，下一次同城市同时段秒回
    const chain = AI_PROVIDER_CHAIN.filter(p => p.apiKey);
    if (chain.length) {
        const inputNumbers = collectInputNumbers(data);
        const chainDeadline = Date.now() + 12000;
        for (const p of chain) {
            if (Date.now() >= chainDeadline) {
                console.warn(`[ai] 模型链 12s 预算耗尽（city=${city}），提前转入规则降级`);
                break;
            }
            let content = null;
            try {
                content = await callLLMOnce(city, data, p, group);
            } catch (e) {
                // 日志只记错误消息（不含 Authorization / Key，遵循现有脱敏模式）
                console.error(`[ai] LLM 调用失败（${p.provider}/${p.model}，city=${city}）:`, e.message);
                aiStatProvider(p.provider, p.model, 'upstreamFail');
            }
            if (content) {
                aiStatProvider(p.provider, p.model, 'calls');
                const advice = parseAdviceText(content);
                if (advice && isGroundedAdvice(advice, inputNumbers)) {
                    aiStatProvider(p.provider, p.model, 'ok');
                    aiStats.aiOk++;
                    const value = {
                        mode: 'ai',
                        summary: advice.summary.trim(),
                        tips: advice.tips.map(t => String(t).trim()),
                    };
                    adviceCacheSet(cacheKey, value);
                    return sendJSON(res, 200, Object.assign({ cached: false }, value));
                }
                aiStatProvider(p.provider, p.model, 'groundingFail');
                // 记录越界数字与原文开头（脱敏：不含请求/密钥信息），便于诊断模型在编造什么
                if (advice && typeof advice.summary === 'string') {
                    const badNums = findUngroundedNumbers(advice.summary + '\n' + (Array.isArray(advice.tips) ? advice.tips.join('\n') : ''), inputNumbers);
                    console.warn(`[ai] ${p.provider}/${p.model} 输出未通过接地校验（city=${city}），越界数字: [${badNums.join(', ')}] 原文:`,
                        content.slice(0, 120).replace(/\s+/g, ' '));
                } else {
                    console.warn(`[ai] ${p.provider}/${p.model} 输出无法解析为约定 JSON（city=${city}）:`,
                        content.slice(0, 120).replace(/\s+/g, ' '));
                }
            }
        }
    }

    // 规则降级（无 Key / 校验失败 / 上游异常），不缓存
    aiStats.ruleFallback++;
    return sendJSON(res, 200, Object.assign({ cached: false }, buildRuleAdvice(city, data)));
}

// ===================== 代理路由 =====================
function pathNotAllowed(res) {
    return sendJSON(res, 403, { error: 'path not allowed' });
}

function handleApi(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // 仅支持 GET（这些上游 API 都是 GET；/api/ai/advice 是唯一 POST 端点，在下方路由分支内校验）
    if (req.method !== 'GET' && pathname !== '/api/ai/advice') {
        return sendJSON(res, 405, { error: 'method not allowed' });
    }

    // 限流：按客户端 IP 每分钟 90 次
    const limit = checkRateLimit(req);
    if (!limit.allowed) {
        return sendJSON(res, 429, { error: 'too many requests' }, {
            'Retry-After': String(limit.retryAfter),
        });
    }

    // /api/status → 返回服务端已配置的 provider 列表（不暴露 Key）
    if (pathname === '/api/status') {
        return sendJSON(res, 200, {
            amap: !!ENV.AMAP_KEY,
            qweather: !!ENV.QWEATHER_KEY,
            caiyun: !!ENV.CAIYUN_TOKEN,
            ipnews: !!ENV.IPNEWS_KEY,
        });
    }

    // /api/ai/stats → 智 · AI 建议运行统计(聚合计数,不含请求内容;进程内存,重启清零)。
    // 缓存命中数即省下的上游调用量,各链路成员的 通过/拦截 计数即接地校验拦截率证据
    if (pathname === '/api/ai/stats') {
        return sendJSON(res, 200, {
            ...aiStats,
            byProvider: aiStatByProvider,
            cacheSize: aiCache.size,
            uptimeSec: Math.round(process.uptime()),
            generatedAt: new Date().toISOString(),
        });
    }

    // /api/amap/<path> → https://restapi.amap.com/<path>
    if (pathname.startsWith('/api/amap/')) {
        const sub = pathname.slice('/api/amap/'.length);
        if (!ALLOWED_PATHS.amap.has('/' + sub)) return pathNotAllowed(res);
        if (!ENV.AMAP_KEY) return sendJSON(res, 503, { error: 'AMAP_KEY not configured on server' });
        return proxyGet(req, res, UPSTREAM.amap, '/' + sub, { key: ENV.AMAP_KEY });
    }

    // /api/qweather/geo/<path> → geoapi.qweather.com/<path>；配置 QWEATHER_HOST 后
    // 统一走专属 Host，路径带 /geo 服务前缀：<host>/geo/<path>
    if (pathname.startsWith('/api/qweather/geo/')) {
        const sub = pathname.slice('/api/qweather/geo/'.length);
        if (!ALLOWED_PATHS.qweather_geo.has('/' + sub)) return pathNotAllowed(res);
        if (!ENV.QWEATHER_KEY) return sendJSON(res, 503, { error: 'QWEATHER_KEY not configured on server' });
        return proxyGet(req, res, UPSTREAM.qweather_geo, QWEATHER_GEO_PREFIX + '/' + sub, { key: ENV.QWEATHER_KEY });
    }

    // /api/qweather/dev/<path> → devapi.qweather.com/<path>；配置 QWEATHER_HOST 后
    // 统一走专属 Host，路径不变
    if (pathname.startsWith('/api/qweather/dev/')) {
        const sub = pathname.slice('/api/qweather/dev/'.length);
        if (!ALLOWED_PATHS.qweather_dev.has('/' + sub)) return pathNotAllowed(res);
        if (!ENV.QWEATHER_KEY) return sendJSON(res, 503, { error: 'QWEATHER_KEY not configured on server' });
        return proxyGet(req, res, UPSTREAM.qweather_dev, '/' + sub, { key: ENV.QWEATHER_KEY });
    }

    // /api/caiyun/<path> → https://api.caiyunapp.com/<path>；token 注入 v2.6 与坐标之间：
    // /api/caiyun/v2.6/<lon>,<lat>/weather → 上游 /v2.6/<CAIYUN_TOKEN>/<lon>,<lat>/weather
    if (pathname.startsWith('/api/caiyun/')) {
        const sub = pathname.slice('/api/caiyun/'.length);
        const m = CAIYUN_PATH_RE.exec(sub);
        if (!m) return pathNotAllowed(res);
        if (!CAIYUN_TOKEN_OK) return sendJSON(res, 503, { error: 'CAIYUN_TOKEN not configured on server' });
        const lon = parseFloat(m[1]);
        const lat = parseFloat(m[2]);
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return pathNotAllowed(res);
        return proxyGet(req, res, UPSTREAM.caiyun, `/v2.6/${ENV.CAIYUN_TOKEN}/${m[1]},${m[2]}/weather`);
    }

    // /api/ipnews/<path> → https://ipnews.io/<path>（path 形如 api/v1/json/<ip>）
    if (pathname.startsWith('/api/ipnews/')) {
        const sub = pathname.slice('/api/ipnews/'.length);
        if (sub.length > IPNEWS_MAX_PATTERN_LENGTH || !IPNEWS_PATH_RE.test(sub)) return pathNotAllowed(res);
        if (!ENV.IPNEWS_KEY) return sendJSON(res, 503, { error: 'IPNEWS_KEY not configured on server' });
        return proxyGet(req, res, UPSTREAM.ipnews, '/' + sub, { 'api-key': ENV.IPNEWS_KEY });
    }

    // POST /api/ai/advice → AI 天气生活建议（LLM 接地生成，失败自动降级规则建议）
    // 限流收紧：独立计数桶，每 IP 每分钟 10 次，超限 429 + Retry-After
    if (pathname === '/api/ai/advice') {
        if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' });
        const aiLimit = checkRateLimit(req, { max: AI_RATE_LIMIT_MAX, store: aiRateBuckets });
        if (!aiLimit.allowed) {
            return sendJSON(res, 429, { error: 'too many requests' }, {
                'Retry-After': String(aiLimit.retryAfter),
            });
        }
        return handleAiAdvice(req, res).catch(err => {
            console.error('[ai] 处理异常:', err && err.message);
            if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' });
        });
    }

    return sendJSON(res, 404, { error: 'api not found' });
}

// ===================== 静态文件服务 =====================
function cacheControlFor(ext, pathname) {
    if (ext === '.html') return 'no-cache';
    return 'public, max-age=3600';
}

function serveStatic(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
        pathname = decodeURIComponent(parsed.pathname);
    } catch (e) {
        return sendJSON(res, 400, { error: 'bad request' });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    if (pathname.indexOf('\0') !== -1) return sendJSON(res, 404, { error: 'not found' });

    const segments = pathname.split('/').filter(seg => seg.length > 0);
    const basename = segments.length ? segments[segments.length - 1] : '';

    // .env / .env.* 显式 403（保留原有语义）
    if (basename === '.env' || basename.startsWith('.env.')) {
        return sendJSON(res, 403, { error: 'forbidden' });
    }

    // 禁止点开头的路径段（.git / .uploads 等）与 node_modules，以及反斜杠绕过
    for (const seg of segments) {
        if (seg.indexOf('\\') !== -1) return sendJSON(res, 404, { error: 'not found' });
        if (seg.startsWith('.')) return sendJSON(res, 404, { error: 'not found' });
        if (seg.toLowerCase() === 'node_modules') return sendJSON(res, 404, { error: 'not found' });
    }

    const filePath = safeJoinPath(ROOT, segments.join('/'));
    if (!filePath) return sendJSON(res, 403, { error: 'forbidden' });

    fs.stat(filePath, (err, stat) => {
        if (err || !stat || !stat.isFile()) {
            // SPA 风格回退到 index.html（避免刷新 404）
            const fallback = path.join(ROOT, 'index.html');
            fs.stat(fallback, (e2, s2) => {
                if (e2 || !s2 || !s2.isFile()) return sendJSON(res, 404, { error: 'not found' });
                serveFile(req, res, fallback, '.html', s2, '/index.html');
            });
            return;
        }
        // 强化：真实路径（解引用符号链接后）必须仍在 ROOT 内
        fs.realpath(filePath, (rerr, realPath) => {
            if (rerr || !isPathInsideRoot(realPath)) return sendJSON(res, 404, { error: 'not found' });
            const ext = path.extname(filePath).toLowerCase();
            serveFile(req, res, filePath, ext, stat, pathname);
        });
    });
}

function serveFile(req, res, filePath, ext, stat, pathname) {
    const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': cacheControlFor(ext, pathname),
    };
    const compressible = COMPRESSIBLE_EXT.has(ext);
    if (compressible) appendVary(res, 'Accept-Encoding');
    const useGzip = compressible && acceptsGzip(req.headers['accept-encoding']);

    fs.readFile(filePath, (err, data) => {
        if (err) return sendJSON(res, 500, { error: 'read error' });
        if (!useGzip || data.length === 0) {
            headers['Content-Length'] = data.length;
            res.writeHead(200, headers);
            return res.end(data);
        }
        getGzipped(filePath, stat.mtimeMs, data.length, data, (gzErr, gz) => {
            if (gzErr || !gz) {
                headers['Content-Length'] = data.length;
                res.writeHead(200, headers);
                return res.end(data);
            }
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = gz.length;
            res.writeHead(200, headers);
            res.end(gz);
        });
    });
}

// ===================== 主入口 =====================
function ensureConfigJS() {
    // 启动时自动生成 config.js（不含真实 Key）
    try {
        execSync('node build.js', { cwd: ROOT, stdio: 'inherit', env: process.env });
    } catch (e) {
        console.warn('[server] 生成 config.js 失败，将使用前端默认配置:', e.message);
    }
}

function main() {
    ensureConfigJS();

    const server = http.createServer((req, res) => {
        const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // 安全响应头（全局，包括 4xx/5xx）
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Origin 校验：同源前端放行；无 Origin 的非浏览器请求放行；不一致 403
        if (!isSameOriginRequest(req)) {
            return sendJSON(res, 403, { error: 'origin not allowed' });
        }

        const isApi = parsed.pathname.startsWith('/api/');

        // CORS：按 Origin 回显（无 Origin 时不发 Access-Control-Allow-Origin）
        if (isApi) {
            const origin = req.headers.origin;
            if (origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                appendVary(res, 'Origin');
            }
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        if (isApi) {
            return handleApi(req, res);
        }
        return serveStatic(req, res);
    });

    server.listen(PORT, HOST, () => {
        const mask = v => v ? `${v.slice(0, 4)}****${v.slice(-4)}` : '(未配置)';
        console.log('======================================================');
        console.log(`  SkyWeather 代理服务器已启动`);
        console.log(`  监听: http://${HOST}:${PORT}`);
        console.log('------------------------------------------------------');
        console.log(`  AMAP_KEY      : ${mask(ENV.AMAP_KEY)}`);
        console.log(`  QWEATHER_KEY  : ${mask(ENV.QWEATHER_KEY)}`);
        console.log(`  QWEATHER_HOST : ${QWEATHER_HOST || '(未配置，回退通用域名)'}`);
        console.log(`  IPNEWS_KEY    : ${mask(ENV.IPNEWS_KEY)}`);
        console.log(`  CAIYUN_TOKEN  : ${mask(ENV.CAIYUN_TOKEN)}`);
        console.log(`  AI 模型链     : ${AI_PROVIDER_CHAIN.filter(p => p.apiKey).map(p => `${p.provider}/${p.model}`).join(' → ') || '（未配置 Key，AI 建议走规则降级）'}`);
        console.log('------------------------------------------------------');
        console.log('  代理端点:');
        console.log('    /api/amap/*           → restapi.amap.com');
        console.log(`    /api/qweather/geo/*   → ${UPSTREAM.qweather_geo}${QWEATHER_GEO_PREFIX}`);
        console.log(`    /api/qweather/dev/*   → ${UPSTREAM.qweather_dev}`);
        console.log('    /api/ipnews/*         → ipnews.io');
        console.log('    /api/caiyun/*         → api.caiyunapp.com（token 注入路径段）');
        console.log('    POST /api/ai/advice   → AI 天气生活建议（LLM，失败降级规则）');
        console.log('    /api/status           → 服务端已配置的 provider');
        console.log('------------------------------------------------------');
        console.log(`  安全策略: 路径白名单 / 限流 ${RATE_LIMIT_MAX} 次每分钟每 IP（AI 建议 ${AI_RATE_LIMIT_MAX} 次）/ Origin 校验 / gzip`);
        console.log('======================================================');
    });

    server.on('error', err => {
        console.error('[server] 启动失败:', err.message);
        process.exit(1);
    });
}

main();
