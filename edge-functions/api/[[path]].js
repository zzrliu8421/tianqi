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
 *      （环境变量需在 EdgeOne Pages 控制台 → 项目 → 环境变量 中配置）
 *   2. 按前端请求路径分流，附加对应 Key 后用 fetch 转发到上游
 *   3. 透传上游响应（含 Content-Type / Cache-Control），自动附加 CORS 头
 *
 * 安全加固（与 server.js 路由表一致）：
 *   - 上游路径白名单：只放行前端实际调用的固定路径，其余返回 403 path not allowed
 *   - Origin 校验：带 Origin 头且其 host 与请求 Host 不一致时返回 403
 *   - 限流：若运行时能拿到客户端 IP（X-Forwarded-For / X-Real-IP），每 IP 每分钟 90 次，
 *     超限 429 + Retry-After；拿不到客户端 IP 时跳过限流（边缘侧以平台 WAF 为主）
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
 */
function checkRateLimit(request) {
    const ip = normalizeClientIp(getClientIp(request));
    if (!ip) return { allowed: true };
    const now = Date.now();
    // 清理过期计数，防止内存无限增长
    if (rateBuckets.size > 10000) {
        for (const [key, bucket] of rateBuckets) {
            if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) rateBuckets.delete(key);
        }
    }
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
        bucket = { windowStart: now, count: 0 };
        rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= RATE_LIMIT_MAX) return { allowed: true };
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
    const qwHost = String(env.QWEATHER_HOST || '')
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .trim()
        .toLowerCase();
    const qwOpts = qwHost
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

    // OPTIONS → CORS 预检
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    }

    // GET → 主处理逻辑（带尽力而为的 IP 限流）
    if (method === 'GET') {
        const limit = checkRateLimit(request);
        if (!limit.allowed) {
            return json(429, { error: 'too many requests' }, {
                'Retry-After': String(limit.retryAfter),
            });
        }
        return handleGet(context);
    }

    // 其它方法统一 405
    return json(405, { error: 'method not allowed' });
}
