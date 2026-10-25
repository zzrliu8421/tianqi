/**
 * SkyWeather 边缘函数代理（EdgeOne Pages Edge Function）
 *
 * 作用：把高德 / 和风 / IPnews 的 API Key 收敛在边缘函数运行时中，
 *      前端不持有任何密钥，由本函数统一补齐 Key 后转发到上游。
 *
 * 触发规则：catch-all 路由 edge-functions/api/[[path]].js
 *           匹配所有 /api/* 子路径（/api/status、/api/amap/v3/ip 等）
 *
 * 工作原理：
 *   1. 从 context.env 读取 AMAP_KEY / QWEATHER_KEY / QWEATHER_HOST / IPNEWS_KEY / CAIYUN_TOKEN
 *      / AGNES_API_KEY（AI 首选供应商 Agnes）/ ZHIPU_API_KEY（AI 次选供应商智谱）/ AI_BASE_URL / AI_MODEL
 *      （环境变量需在 EdgeOne Pages 控制台 → 项目 → 环境变量 中配置）
 *   2. 按前端请求路径分流，附加对应 Key 后用 fetch 转发到上游
 *   3. 透传上游响应（含 Content-Type / Cache-Control），自动附加 CORS 头
 *
 * 安全加固（与 server.js 路由表一致）：
 *   - 上游路径白名单：只放行前端实际调用的固定路径，其余返回 403 path not allowed
 *   - Origin 校验：带 Origin 头且其 host 与请求 Host 不一致时返回 403
 *   - 限流：若运行时能拿到客户端 IP（X-Forwarded-For / X-Real-IP），每 IP 每分钟 90 次，
 *     超限 429 + Retry-After；拿不到客户端 IP 时跳过限流（边缘侧以平台 WAF 为主）；
 *     POST /api/ai/advice 单独收紧为 10 次/分/IP（独立计数桶，同样"尽力而为"）
 *   - 安全响应头：X-Content-Type-Options: nosniff
 *
 * 路由表（与 server.js 保持一致）：
 *   GET /api/status               → 返回服务端已配置的 provider 布尔值
 *   GET /api/amap/<path>          → https://restapi.amap.com/<path>?<query>&key=AMAP_KEY
 *   GET /api/qweather/geo/<path>  → https://geoapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *   GET /api/qweather/dev/<path>  → https://devapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *   GET /api/ipnews/<path>        → https://ipnews.io/<path>?<query>&api-key=IPNEWS_KEY
 *   GET /api/caiyun/<path>        → https://api.caiyunapp.com/<path>，CAIYUN_TOKEN 注入路径段：
 *                                   /api/caiyun/v2.6/<lon>,<lat>/weather → /v2.6/<token>/<lon>,<lat>/weather
 *   POST /api/ai/advice           → AI 天气生活建议：按模型链依次 POST <baseUrl>/chat/completions
 *                                   （首选 Agnes：agnes-2.5-flash → agnes-3.0-flash；次选智谱：
 *                                   glm-4.7-flash → glm-4-flash，Bearer 对应供应商 Key）。
 *                                   输出做"接地校验"：响应文本中的每个数字必须来自请求 data 的
 *                                   数值集合，未通过则沿链换下一个模型；全部失败 / 未配置 Key /
 *                                   上游异常 → 规则降级（mode:"rule"）。结果按 city+hour 缓存 1 小时
 *
 *   和风天气：配置 QWEATHER_HOST（专属 API Host）后，geo 与天气统一走
 *   https://<QWEATHER_HOST>/...，且 GeoAPI 路径带 /geo 服务前缀。
 *   官方通用域名 geoapi/devapi.qweather.com 已宣布将逐步停用，推荐配置专属 Host。
 *
 * 运行时：EdgeOne Edge Functions（Web 标准 API，非 Node.js）
 *   仅使用 fetch / Request / Response / URL / URLSearchParams / Headers
 *
 * 本地调试：
 *   npm install -g edgeone
 *   edgeone pages dev          # 在项目根目录执行
 */

// ===================== 上游 API 配置 =====================
const UPSTREAM = {
    amap: 'https://restapi.amap.com',
    qweather_geo: 'https://geoapi.qweather.com',
    qweather_dev: 'https://devapi.qweather.com',
    ipnews: 'https://ipnews.io',
    caiyun: 'https://api.caiyunapp.com',
};

// 上游 API 接收 Key 时的 query 参数名
const KEY_PARAM = {
    amap: 'key',
    qweather_geo: 'key',
    qweather_dev: 'key',
    ipnews: 'api-key',
};

// 对应的环境变量名
const KEY_ENV = {
    amap: 'AMAP_KEY',
    qweather_geo: 'QWEATHER_KEY',
    qweather_dev: 'QWEATHER_KEY',
    ipnews: 'IPNEWS_KEY',
    caiyun: 'CAIYUN_TOKEN',
};

// ===================== 安全策略 =====================

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

// 彩云天气路径形如 v2.6/<经度>,<纬度>/weather（token 注入到 v2.6 与坐标之间）。
// 坐标段限数字格式（范围在 matchRoute 内校验），端点只放行前端实际调用的 /weather 综合接口。
const CAIYUN_PATH_RE = /^v2\.6\/(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)\/weather$/;
// 彩云 token 只允许 URL 路径安全字符，防止注入破坏上游路径结构
const CAIYUN_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// 限流：每客户端 IP 每分钟 90 次（边缘实例内存计数，尽力而为）
const RATE_LIMIT_MAX = 90;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

// ===================== AI 天气生活建议配置 =====================
// AI 建议端点（POST /api/ai/advice）收紧限流：每 IP 每分钟 10 次（独立计数桶，
// 与全局 90 次桶隔离，避免互相挤占；沿用"拿不到客户端 IP 则跳过"的尽力而为模式）
const AI_RATE_LIMIT_MAX = 10;
const aiRateBuckets = new Map();

// 结果缓存：按 city+hour 维度缓存 LLM 成功结果，TTL 1 小时，条目上限 200（近似 LRU）。
// 仅用边缘实例内存 Map（与 server.js 各自独立），实例重启/多节点间不共享，属尽力而为
const AI_CACHE_TTL_MS = 60 * 60 * 1000;
const AI_CACHE_MAX = 200;
const aiCache = new Map();

// 智 · 人群标签(可选,与 server.js 同白名单):白名单外一律忽略(向后兼容旧客户端)
const AI_GROUPS = {
    elderly: '老年人',
    child: '儿童家庭',
    respiratory: '呼吸道敏感人群',
    commuter: '通勤族',
};

// 智 · 运行统计(边缘 isolate 内存,重启/重新部署清零,跨 isolate 不聚合——
// 数字为局部样本而非全网口径;仅聚合计数,不含任何请求内容/明文)
const aiStats = { startedAt: new Date().toISOString(), requests: 0, cacheHits: 0, aiOk: 0, ruleFallback: 0 };
const aiStatByProvider = {};
function aiStatProvider(provider, model, field) {
    const o = aiStatByProvider[`${provider}/${model}`] = aiStatByProvider[`${provider}/${model}`]
        || { calls: 0, ok: 0, groundingFail: 0, upstreamFail: 0 };
    o[field]++;
}

// system prompt（与 server.js 保持一致）：约束 LLM 只能引用输入数值、输出严格 JSON；
// 写作定位是"有生活温度的天气伙伴"——条数与字数不做硬性限制（校验只守宽松
// 上限），靠一对"套话 vs 想要的"风格示例（刻意不含数字，防被照抄）把文风
// 拉向具体时段、体感与惦记，避免公文腔与卡片结论的复述
const AI_SYSTEM_PROMPT = [
    '你是天气伙伴，像关心朋友一样，基于给定的真实天气数据给用户写今日提醒。',
    '硬性规则：',
    '1. 只能使用输入数据中出现的数值，严禁编造；也不要做任何推算或换算——不写"比实际高出3度"这类算出来的差值，不把 17:15 说成"下午5点15分"，保留数值原有的单位与写法；',
    '2. 不要提及"数据来源"；文案里不要出现英文字段名或缩写（uv、aqi、pop、tmax、sunset 之类；PM2.5、PM10 这类标准术语除外）；不要用"建议您""请注意"等公文腔，也不要以"建议"开头，用"你"的自然口吻。',
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

// AI 建议模型链（与 server.js 保持一致，依次尝试，全部失败走规则降级 mode:"rule"）：
// 首选供应商 Agnes（OpenAI 兼容中转）：agnes-2.5-flash → agnes-3.0-flash
// （2026-10-25 A/B 实测 2.5 文风更活且接地通过率高，升首选）；次选供应商智谱：
// glm-4.7-flash → glm-4-flash。
// 未配置对应 Key 的供应商整段跳过；一个 Key 都没配时直接规则降级。
function buildAIProviderChain(env) {
    const zhipuBase = String((env && env.AI_BASE_URL) || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
    const agnesKey = String((env && env.AGNES_API_KEY) || '');
    const zhipuKey = String((env && env.ZHIPU_API_KEY) || '');
    return [
        { provider: 'agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: agnesKey, model: 'agnes-2.5-flash' },
        { provider: 'agnes', baseUrl: 'https://api.agnes-ai.cn/v1', apiKey: agnesKey, model: 'agnes-3.0-flash' },
        { provider: 'zhipu', baseUrl: zhipuBase, apiKey: zhipuKey, model: String((env && env.AI_MODEL) || 'glm-4.7-flash') },
        { provider: 'zhipu', baseUrl: zhipuBase, apiKey: zhipuKey, model: String((env && env.AI_FALLBACK_MODEL) || 'glm-4-flash') },
    ].filter(p => p.apiKey);
}

// 数字提取（含小数、负数；"18.5°C" 这类带单位形式取 18.5）
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

// 安全响应头
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
};

// 上游请求超时（毫秒）—— EdgeOne fetch 支持的 eo.timeoutSetting
const UPSTREAM_TIMEOUT_MS = 10000;

// 边缘缓存 TTL（秒）：天气/地理编码数据可短期共享缓存，减少上游压力
// IP 定位接口不缓存（每用户 IP 不同）
const CACHE_TTL = 120; // 2 分钟

/**
 * 判断请求路径是否可缓存
 * - IP 定位（/api/amap/v3/ip、/api/ipnews/）不缓存
 * - 天气、地理编码、AQI 可缓存
 */
function isCacheable(pathname) {
    if (pathname.includes('/v3/ip')) return false;
    if (pathname.startsWith('/api/ipnews/')) return false;
    return true;
}

/**
 * 构造边缘缓存 key（带区域隔离，避免不同地区命中同一缓存）
 */
function cacheKey(url) {
    return 'skyweather:' + url;
}

/**
 * 从 Cache API 读取缓存
 */
async function cacheGet(key) {
    try {
        const cache = await caches.open('skyweather-v1');
        const res = await cache.match(key);
        if (!res) return null;
        // 检查 TTL
        const cachedAt = res.headers.get('x-cached-at');
        if (!cachedAt) return null;
        const age = (Date.now() - parseInt(cachedAt, 10)) / 1000;
        if (age > CACHE_TTL) return null;
        return res;
    } catch { return null; }
}

/**
 * 写入边缘缓存（克隆响应并标记时间戳）
 */
async function cachePut(key, res) {
    try {
        const cache = await caches.open('skyweather-v1');
        const cloned = res.clone();
        const headers = new Headers(cloned.headers);
        headers.set('x-cached-at', String(Date.now()));
        const cached = new Response(cloned.body, {
            status: cloned.status,
            statusText: cloned.statusText,
            headers,
        });
        await cache.put(key, cached);
    } catch { /* 缓存写入失败不影响主流程 */ }
}

// ===================== 工具函数 =====================

/**
 * 返回 JSON 响应，统一附加安全头
 */
function json(status, obj, extraHeaders) {
    const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    }
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(JSON.stringify(obj), { status, headers });
}

/**
 * Origin 校验：无 Origin 放行（非浏览器/服务端调用），有 Origin 则必须与请求 Host 同源
 */
function isOriginAllowed(request, env) {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    const allowed = String((env && env.ALLOWED_ORIGINS) || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    if (allowed.includes(origin.toLowerCase())) return true;
    let originHost = null;
    let requestHost = null;
    try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = null; }
    try { requestHost = new URL(request.url).host.toLowerCase(); } catch { requestHost = null; }
    return !!originHost && !!requestHost && originHost === requestHost;
}

/**
 * 把 IPv4-mapped / 带 zone 的地址归一化；IPv6 折叠到 /64，避免单用户占满多个计数键
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
 * 尽力获取客户端 IP：Edge 运行时可能不提供，拿不到则返回 null（跳过限流）
 */
function getClientIp(request) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0].trim();
        if (first) return first;
    }
    const realIp = request.headers.get('x-real-ip');
    if (realIp && realIp.trim()) return realIp.trim();
    return null;
}

/**
 * 固定窗口限流：返回 { allowed, retryAfter }
 * opts.max / opts.store 缺省时使用全局 90 次/分配置；
 * AI 建议端点传入收紧的 10 次/分与独立计数桶
 */
function checkRateLimit(request, opts) {
    const max = (opts && opts.max) || RATE_LIMIT_MAX;
    const store = (opts && opts.store) || rateBuckets;
    const ip = normalizeClientIp(getClientIp(request));
    if (!ip) return { allowed: true };
    const now = Date.now();
    // 清理过期计数，防止内存无限增长
    if (store.size > 10000) {
        for (const [key, bucket] of store) {
            if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) store.delete(key);
        }
    }
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

/**
 * 把前端路径映射为上游配置
 * @param {string} pathname 例如 /api/amap/v3/ip
 * @returns {{type:'status'} | {type:'forbidden'} | {type:'proxy', upstream:string, sub:string} | null}
 */
function matchRoute(pathname) {
    if (pathname === '/api/status') return { type: 'status' };

    if (pathname.startsWith('/api/amap/')) {
        const sub = pathname.slice('/api/amap/'.length);
        if (!ALLOWED_PATHS.amap.has('/' + sub)) return { type: 'forbidden' };
        return { type: 'proxy', upstream: 'amap', sub };
    }
    if (pathname.startsWith('/api/qweather/geo/')) {
        const sub = pathname.slice('/api/qweather/geo/'.length);
        if (!ALLOWED_PATHS.qweather_geo.has('/' + sub)) return { type: 'forbidden' };
        return { type: 'proxy', upstream: 'qweather_geo', sub };
    }
    if (pathname.startsWith('/api/qweather/dev/')) {
        const sub = pathname.slice('/api/qweather/dev/'.length);
        if (!ALLOWED_PATHS.qweather_dev.has('/' + sub)) return { type: 'forbidden' };
        return { type: 'proxy', upstream: 'qweather_dev', sub };
    }
    if (pathname.startsWith('/api/ipnews/')) {
        const sub = pathname.slice('/api/ipnews/'.length);
        if (sub.length > IPNEWS_MAX_PATTERN_LENGTH || !IPNEWS_PATH_RE.test(sub)) return { type: 'forbidden' };
        return { type: 'proxy', upstream: 'ipnews', sub };
    }
    if (pathname.startsWith('/api/caiyun/')) {
        const sub = pathname.slice('/api/caiyun/'.length);
        const m = CAIYUN_PATH_RE.exec(sub);
        // 经度在前、纬度在后；范围校验与 server.js 保持一致
        if (!m || parseFloat(m[2]) < -90 || parseFloat(m[2]) > 90 ||
            parseFloat(m[1]) < -180 || parseFloat(m[1]) > 180) {
            return { type: 'forbidden' };
        }
        return { type: 'proxy', upstream: 'caiyun', sub };
    }
    return null;
}

/**
 * 构造上游 URL：保留前端传入的 query，并附加 Key 参数。
 * opts.base / opts.pathPrefix：和风专属 API Host 场景下覆盖默认基地址并附加服务前缀
 */
function buildUpstreamUrl(upstream, sub, searchParams, keyValue, opts) {
    const base = (opts && opts.base) || UPSTREAM[upstream];
    const prefix = (opts && opts.pathPrefix) || '';
    const subPath = prefix + '/' + sub.replace(/^\/+/, ''); // 防止开头多斜杠
    const params = new URLSearchParams(searchParams);
    // 彩云 token 走路径段注入（见 handleGet），KEY_PARAM 中无对应项则不追加 query 参数
    if (keyValue && KEY_PARAM[upstream]) params.set(KEY_PARAM[upstream], keyValue);
    const query = params.toString();
    return query ? `${base}${subPath}?${query}` : `${base}${subPath}`;
}

// ===================== 核心：GET 处理 =====================
async function handleGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const matched = matchRoute(url.pathname);

    if (!matched) {
        return json(404, { error: 'api not found' });
    }

    // 路径不在白名单内 → 403
    if (matched.type === 'forbidden') {
        return json(403, { error: 'path not allowed' });
    }

    // /api/status —— 返回服务端已配置的 provider（不暴露 Key）
    if (matched.type === 'status') {
        return json(200, {
            amap: !!env.AMAP_KEY,
            qweather: !!env.QWEATHER_KEY,
            caiyun: !!env.CAIYUN_TOKEN,
            ipnews: !!env.IPNEWS_KEY,
        });
    }

    // 代理转发
    const envKey = KEY_ENV[matched.upstream];
    const keyValue = env[envKey];
    if (!keyValue) {
        return json(503, { error: `${envKey} not configured on server` });
    }

    // 和风专属 API Host：配置后 geo 与天气统一走同一域名，GeoAPI 路径加 /geo 服务前缀；
    // 未配置则回退通用域名（官方将逐步停用）。容错：允许带 https:// 前缀或结尾斜杠。
    // 注意：base 覆盖只允许作用于和风两个上游——无条件传入会劫持高德/彩云/ipnews
    // 的基地址（线上曾因此导致这三家全部 404：请求被发到和风域名下的不存在路径）。
    const qwHost = String(env.QWEATHER_HOST || '')
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .trim()
        .toLowerCase();
    const isQwUpstream = matched.upstream === 'qweather_geo' || matched.upstream === 'qweather_dev';
    const qwOpts = qwHost && isQwUpstream
        ? {
            base: `https://${qwHost}`,
            pathPrefix: matched.upstream === 'qweather_geo' ? '/geo' : '',
        }
        : undefined;

    const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : null;

    // 彩云：token 在上游 URL 路径中，注入到 v2.6 与坐标之间（v2.6/<token>/<lon>,<lat>/weather）
    let sub = matched.sub;
    if (matched.upstream === 'caiyun') {
        if (!CAIYUN_TOKEN_RE.test(String(keyValue))) {
            return json(503, { error: 'CAIYUN_TOKEN malformed on server' });
        }
        sub = sub.replace(/^v2\.6\//, `v2.6/${keyValue}/`);
    }

    const upstreamUrl = buildUpstreamUrl(matched.upstream, sub, url.searchParams, keyValue, qwOpts);

    // 边缘缓存：天气/地理编码数据 2 分钟内多用户共享，减少上游压力
    const canCache = isCacheable(url.pathname);
    const cKey = cacheKey(upstreamUrl);
    if (canCache) {
        const cached = await cacheGet(cKey);
        if (cached) {
            // 命中缓存：附加 CORS / 安全头后透传
            const headers = new Headers(cached.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
            headers.set('Access-Control-Allow-Headers', 'Content-Type');
            headers.set('X-Edge-Cache', 'HIT');
            for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
            return new Response(cached.body, { status: cached.status, headers });
        }
    }

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'SkyWeather-Proxy/1.0',
                'Accept': 'application/json, text/plain, */*',
            },
            // EdgeOne 特有：超时控制
            eo: {
                timeoutSetting: {
                    connectTimeout: UPSTREAM_TIMEOUT_MS,
                    readTimeout: UPSTREAM_TIMEOUT_MS,
                    writeTimeout: UPSTREAM_TIMEOUT_MS,
                },
            },
        });

        // 透传响应 body + 关键 header，附加 CORS / 安全头
        const headers = new Headers();
        const contentType = upstreamRes.headers.get('content-type');
        const cacheControl = upstreamRes.headers.get('cache-control');
        if (contentType) headers.set('Content-Type', contentType);
        headers.set('Cache-Control', cacheControl || 'public, max-age=60');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type');
        headers.set('X-Edge-Cache', 'MISS');
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

        const response = new Response(upstreamRes.body, {
            status: upstreamRes.status,
            headers,
        });

        // 写入边缘缓存（仅缓存成功响应）
        if (canCache && upstreamRes.ok) {
            // 不阻塞响应，异步写入（EdgeOne waitUntil）
            if (waitUntil) waitUntil(cachePut(cKey, response));
            else cachePut(cKey, response).catch(() => {});
        }

        return response;
    } catch (err) {
        return json(502, { error: 'upstream error', detail: err && err.message ? err.message : String(err) });
    }
}

// ===================== AI 建议:校验 / 接地 / 降级(与 server.js 同逻辑)=====================

/** 请求体校验:city 非空字符串(≤20 字符),data 为一层扁平键值(数值或短字符串) */
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

/** 输入数值集合:data 中所有数值 + 字符串值里出现的数字("东北风3级" 里的 3) */
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

/** 从 LLM 文本解析 JSON:剥离 markdown 围栏,截取首个 { 到最后一个 } */
function parseAdviceText(text) {
    if (typeof text !== 'string') return null;
    let t = text.trim();
    const fenced = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
    if (fenced) t = fenced[1].trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

/**
 * 找出文本中不在输入数值集合里的数字（接地校验与失败日志共用）。
 * 先剔除 PM2.5 / PM25 / PM10 —— 专有名词而非数值主张，不剔除会把规范
 * 写法"PM2.5"误判成编造数字 2.5（与 server.js 保持一致）。
 */
function findUngroundedNumbers(text, inputNumbers) {
    const cleaned = String(text).replace(/PM2\.5|PM25|PM10/gi, '');
    const found = cleaned.match(NUMBER_RE) || [];
    return found.filter(raw => !inputNumbers.has(String(Number(raw))));
}

/**
 * 接地校验:结构合法 + 响应中每个数字必须来自输入数值集合。
 * 字数只守宽松上限（summary≤80 / 单条 tip≤150，条数 1~6），与 server.js 一致。
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

/** 规则降级:阈值规则生成同结构结果,只引用输入 data 中的原始数值 */
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

// city+hour 缓存读写(近似 LRU;仅缓存 LLM 成功结果)
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

/** 调用 OpenAI 兼容 chat/completions(Web fetch 版),返回首个 choice 文本 */
async function callLLMOnce(city, data, provider, group, timeoutMs) {
    // 每次尝试的中止时限由调用方按剩余预算给出（下限 3s），用 AbortController 硬性兜底
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(3000, timeoutMs || 10000));
    let res;
    try {
        res = await fetch(provider.baseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`,
                'User-Agent': 'SkyWeather-Proxy/1.0',
            },
            signal: ctrl.signal,
            body: JSON.stringify({
            model: provider.model,
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: `城市：${city}\n当前时段：${data.month}月 ${data.hour != null ? data.hour + '点' : ''}\n天气数据：${JSON.stringify(data)}\n\n请写出有生活温度的今日提醒。穿衣、带伞、防晒这类话题页面卡片已有基础结论，可以谈，但要更深一层——讲清原因、落到具体时段或场景、给出卡片没有的关照，不要只复述卡片结论。${group ? `\n本条提醒面向人群：${AI_GROUPS[group]}——请从这一人群的切身场景出发（出行安全、健康防护、作息安排等），数值规则不变。` : ''}` },
            ],
            temperature: 0.7,
            max_tokens: 800,
        }),
        });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`LLM upstream HTTP ${res.status}`);
    const parsed = await res.json().catch(() => null);
    const content = parsed && parsed.choices && parsed.choices[0] &&
        parsed.choices[0].message && parsed.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM upstream returned empty content');
    return content;
}

/** POST /api/ai/advice 主逻辑:校验 → 查缓存 → 沿模型链 LLM(接地校验,失败换下一模型)→ 规则降级 */
async function handleAiAdvice(context) {
    const { request, env } = context;
    let body;
    try {
        const text = await request.text();
        if (text.length > 8192) return json(413, { error: 'request body too large' });
        body = JSON.parse(text);
    } catch {
        return json(400, { error: 'invalid JSON body' });
    }
    const payload = validateAdvicePayload(body);
    if (!payload) {
        return json(400, { error: 'invalid payload: need {city: string<=20, data: flat object of numbers/short strings}' });
    }
    const { city, data } = payload;
    const group = payload.group || null;

    // 缓存 key:city+hour+人群(人群标签改变建议内容,必须参与键)
    const hourRaw = data.hour;
    const hour = typeof hourRaw === 'number' && Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23
        ? hourRaw
        : new Date().getHours();
    const cacheKey = `${city}|${hour}|${group || ''}`;

    aiStats.requests++;
    const hit = adviceCacheGet(cacheKey);
    if (hit) { aiStats.cacheHits++; return json(200, Object.assign({ cached: true }, hit)); }

    // 沿模型链依次尝试（供应商内主→备、供应商间首选→次选），全部失败再走规则降级。
    // 链路总预算 11s（与 server.js 一致）：预算耗尽不再发起新尝试；每次尝试的
    // 中止时限与剩余预算取小（下限 3s），最坏总耗时 ≈ 14s 内必有响应
    const chain = buildAIProviderChain(env);
    if (chain.length) {
        const inputNumbers = collectInputNumbers(data);
        const chainDeadline = Date.now() + 11000;
        for (const p of chain) {
            if (Date.now() >= chainDeadline) {
                console.warn(`[ai] 模型链 11s 预算耗尽（city=${city}），提前转入规则降级`);
                break;
            }
            let content = null;
            try {
                content = await callLLMOnce(city, data, p, group, chainDeadline - Date.now());
            } catch (e) {
                console.error(`[ai] LLM 调用失败（${p.provider}/${p.model}，city=${city}）:`, e && e.message);
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
                    return json(200, Object.assign({ cached: false }, value));
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

    // 规则降级(无 Key / 校验失败 / 上游异常),不缓存
    aiStats.ruleFallback++;
    return json(200, Object.assign({ cached: false }, buildRuleAdvice(city, data)));
}

// ===================== Handler 导出 =====================
// 统一使用 onRequest（官方推荐写法：export default function onRequest）处理所有方法。
//
// 注意：EdgeOne Pages 中 onRequest 匹配全部 HTTP 方法（GET/POST/OPTIONS/...），
//   当它与 onRequestGet / onRequestOptions 同时导出时会接管所有请求，
//   导致方法特定的 handler 永远不被分发（线上曾因此导致全部接口返回 405）。
//   因此这里不再拆分 onRequestGet / onRequestOptions，改为在 onRequest 内部按 method 分发。
export default async function onRequest(context) {
    const { request } = context;
    const method = request.method.toUpperCase();

    // Origin 校验：同源 / 白名单放行；无 Origin 的非浏览器请求放行；不一致 403
    if (!isOriginAllowed(request, context.env)) {
        return json(403, { error: 'origin not allowed' });
    }

    // OPTIONS → CORS 预检(AI 建议端点为 POST,需放行)
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    }

    // GET → 主处理逻辑（带尽力而为的 IP 限流）
    if (method === 'GET') {
        const pathname = new URL(request.url).pathname;
        // 智 · AI 建议运行统计(isolate 局部口径,聚合计数不含请求内容)
        if (pathname === '/api/ai/stats') {
            return json(200, {
                ...aiStats,
                byProvider: aiStatByProvider,
                cacheSize: aiCache.size,
                scope: 'edge-isolate(单隔离实例局部统计,不代表全网)',
                generatedAt: new Date().toISOString(),
            });
        }
        const limit = checkRateLimit(request);
        if (!limit.allowed) {
            return json(429, { error: 'too many requests' }, {
                'Retry-After': String(limit.retryAfter),
            });
        }
        return handleGet(context);
    }

    // POST /api/ai/advice → AI 天气生活建议(独立收紧限流:10 次/分/IP)
    if (method === 'POST' && new URL(request.url).pathname === '/api/ai/advice') {
        const aiLimit = checkRateLimit(request, { max: AI_RATE_LIMIT_MAX, store: aiRateBuckets });
        if (!aiLimit.allowed) {
            return json(429, { error: 'too many requests' }, {
                'Retry-After': String(aiLimit.retryAfter),
            });
        }
        try {
            return await handleAiAdvice(context);
        } catch (err) {
            console.error('[ai] 处理异常:', err && err.message);
            return json(500, { error: 'internal error' });
        }
    }

    // 其它方法统一 405
    return json(405, { error: 'method not allowed' });
}
