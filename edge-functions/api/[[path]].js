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
 *   1. 从 context.env 读取 AMAP_KEY / QWEATHER_KEY / IPNEWS_KEY
 *      （环境变量需在 EdgeOne Pages 控制台 → 项目 → 环境变量 中配置）
 *   2. 按前端请求路径分流，附加对应 Key 后用 fetch 转发到上游
 *   3. 透传上游响应（含 Content-Type / Cache-Control），自动附加 CORS 头
 *
 * 路由表（与 server.js 保持一致）：
 *   GET /api/status               → 返回服务端已配置的 provider 布尔值
 *   GET /api/amap/<path>          → https://restapi.amap.com/<path>?<query>&key=AMAP_KEY
 *   GET /api/qweather/geo/<path>  → https://geoapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *   GET /api/qweather/dev/<path>  → https://devapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *   GET /api/ipnews/<path>        → https://ipnews.io/<path>?<query>&api-key=IPNEWS_KEY
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
function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}

/**
 * 把前端路径映射为上游配置
 * @param {string} pathname 例如 /api/amap/v3/ip
 * @returns {{type:'status'} | {type:'proxy', upstream:string, sub:string} | null}
 */
function matchRoute(pathname) {
    if (pathname === '/api/status') return { type: 'status' };

    if (pathname.startsWith('/api/amap/')) {
        return { type: 'proxy', upstream: 'amap', sub: pathname.slice('/api/amap/'.length) };
    }
    if (pathname.startsWith('/api/qweather/geo/')) {
        return { type: 'proxy', upstream: 'qweather_geo', sub: pathname.slice('/api/qweather/geo/'.length) };
    }
    if (pathname.startsWith('/api/qweather/dev/')) {
        return { type: 'proxy', upstream: 'qweather_dev', sub: pathname.slice('/api/qweather/dev/'.length) };
    }
    if (pathname.startsWith('/api/ipnews/')) {
        return { type: 'proxy', upstream: 'ipnews', sub: pathname.slice('/api/ipnews/'.length) };
    }
    return null;
}

/**
 * 构造上游 URL：保留前端传入的 query，并附加 Key 参数
 */
function buildUpstreamUrl(upstream, sub, searchParams, keyValue) {
    const base = UPSTREAM[upstream];
    const subPath = '/' + sub.replace(/^\/+/, ''); // 防止开头多斜杠
    const params = new URLSearchParams(searchParams);
    if (keyValue) params.set(KEY_PARAM[upstream], keyValue);
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

    // /api/status —— 返回服务端已配置的 provider（不暴露 Key）
    if (matched.type === 'status') {
        return json(200, {
            amap: !!env.AMAP_KEY,
            qweather: !!env.QWEATHER_KEY,
            ipnews: !!env.IPNEWS_KEY,
        });
    }

    // 代理转发
    const envKey = KEY_ENV[matched.upstream];
    const keyValue = env[envKey];
    if (!keyValue) {
        return json(503, { error: `${envKey} not configured on server` });
    }

    const waitUntil = context.waitUntil ? context.waitUntil.bind(context) : null;

    const upstreamUrl = buildUpstreamUrl(matched.upstream, matched.sub, url.searchParams, keyValue);

    // 边缘缓存：天气/地理编码数据 2 分钟内多用户共享，减少上游压力
    const canCache = isCacheable(url.pathname);
    const cKey = cacheKey(upstreamUrl);
    if (canCache) {
        const cached = await cacheGet(cKey);
        if (cached) {
            // 命中缓存：附加 CORS 头后透传
            const headers = new Headers(cached.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
            headers.set('Access-Control-Allow-Headers', 'Content-Type');
            headers.set('X-Edge-Cache', 'HIT');
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

        // 透传响应 body + 关键 header，附加 CORS
        const headers = new Headers();
        const contentType = upstreamRes.headers.get('content-type');
        const cacheControl = upstreamRes.headers.get('cache-control');
        if (contentType) headers.set('Content-Type', contentType);
        headers.set('Cache-Control', cacheControl || 'public, max-age=60');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type');
        headers.set('X-Edge-Cache', 'MISS');

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
    const method = context.request.method.toUpperCase();

    // OPTIONS → CORS 预检
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    // GET → 主处理逻辑
    if (method === 'GET') {
        return handleGet(context);
    }

    // 其它方法统一 405
    return json(405, { error: 'method not allowed' });
}
