/**
 * SkyWeather 代理服务器
 *
 * 作用：把高德 / 和风 / IPnews 等 API Key 收敛在服务端，前端不再持有任何密钥。
 *
 * 工作原理：
 *   1. 从系统环境变量或 .env 文件读取 AMAP_KEY / QWEATHER_KEY / QWEATHER_HOST / IPNEWS_KEY / CAIYUN_TOKEN
 *   2. 暴露以下代理端点（前端不传 key，由服务端补齐）：
 *      - GET /api/amap/<path>           → https://restapi.amap.com/<path>?<query>&key=AMAP_KEY
 *      - GET /api/qweather/geo/<path>   → https://geoapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/qweather/dev/<path>   → https://devapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/ipnews/<path>         → https://ipnews.io/<path>?<query>&api-key=IPNEWS_KEY
 *      - GET /api/caiyun/<path>         → https://api.caiyunapp.com/<path>，token 注入路径段：
 *        /api/caiyun/v2.6/<lon>,<lat>/weather → /v2.6/<CAIYUN_TOKEN>/<lon>,<lat>/weather
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
 *   - 单 IP 限流：/api/* 每客户端 IP 每分钟 90 次；超限 429 + Retry-After；IPv6 按 /64 归一化
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
 */
function checkRateLimit(req) {
    const ip = normalizeClientIp(req.socket && req.socket.remoteAddress);
    if (!ip) return { allowed: true };
    const now = Date.now();
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

// 定期清理过期计数，防止内存无限增长（unref 不阻塞进程退出）
const rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
        if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) rateBuckets.delete(ip);
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

// ===================== 代理路由 =====================
function pathNotAllowed(res) {
    return sendJSON(res, 403, { error: 'path not allowed' });
}

function handleApi(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // 仅支持 GET（这些上游 API 都是 GET）
    if (req.method !== 'GET') {
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
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
        console.log('------------------------------------------------------');
        console.log('  代理端点:');
        console.log('    /api/amap/*           → restapi.amap.com');
        console.log(`    /api/qweather/geo/*   → ${UPSTREAM.qweather_geo}${QWEATHER_GEO_PREFIX}`);
        console.log(`    /api/qweather/dev/*   → ${UPSTREAM.qweather_dev}`);
        console.log('    /api/ipnews/*         → ipnews.io');
        console.log('    /api/caiyun/*         → api.caiyunapp.com（token 注入路径段）');
        console.log('    /api/status           → 服务端已配置的 provider');
        console.log('------------------------------------------------------');
        console.log(`  安全策略: 路径白名单 / 限流 ${RATE_LIMIT_MAX} 次每分钟每 IP / Origin 校验 / gzip`);
        console.log('======================================================');
    });

    server.on('error', err => {
        console.error('[server] 启动失败:', err.message);
        process.exit(1);
    });
}

main();
