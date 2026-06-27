/**
 * SkyWeather 代理服务器
 *
 * 作用：把高德 / 和风 / IPnews 等 API Key 收敛在服务端，前端不再持有任何密钥。
 *
 * 工作原理：
 *   1. 从系统环境变量或 .env 文件读取 AMAP_KEY / QWEATHER_KEY / IPNEWS_KEY
 *   2. 暴露以下代理端点（前端不传 key，由服务端补齐）：
 *      - GET /api/amap/<path>           → https://restapi.amap.com/<path>?<query>&key=AMAP_KEY
 *      - GET /api/qweather/geo/<path>   → https://geoapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/qweather/dev/<path>   → https://devapi.qweather.com/<path>?<query>&key=QWEATHER_KEY
 *      - GET /api/ipnews/<path>         → https://ipnews.io/<path>?<query>&api-key=IPNEWS_KEY
 *   3. 同时托管项目根目录的静态文件（index.html / config.js 等）
 *   4. 启动时自动生成 config.js（不含真实 Key，仅含布尔标志）
 *
 * 零依赖：仅使用 Node 原生 http / https / fs / path / url 模块。
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
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 上游 API 基地址映射
const UPSTREAM = {
    amap: 'restapi.amap.com',
    qweather_geo: 'geoapi.qweather.com',
    qweather_dev: 'devapi.qweather.com',
    ipnews: 'ipnews.io',
};

// 请求超时（毫秒）
const UPSTREAM_TIMEOUT = 10000;

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
        IPNEWS_KEY: process.env.IPNEWS_KEY !== undefined ? process.env.IPNEWS_KEY : (fileEnv.IPNEWS_KEY || ''),
    };
}

const ENV = loadEnv();

// ===================== 工具函数 =====================
function sendJSON(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function safeJoinPath(base, sub) {
    // 防止路径穿越：把 ../ 之类的非法片段过滤掉
    const cleaned = sub.split('/').filter(seg => seg && seg !== '..' && seg !== '.').join('/');
    return path.join(base, cleaned);
}

// ===================== 上游代理 =====================
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
            console.error(`[proxy] 解压 ${host}${fullPath} 失败:`, err.message);
            if (!res.writableEnded) res.end();
        });
        stream.pipe(res);
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        if (!res.headersSent) sendJSON(res, 504, { error: 'upstream timeout' });
    });
    upstreamReq.on('error', err => {
        console.error(`[proxy] ${host}${fullPath} 失败:`, err.message);
        if (!res.headersSent) sendJSON(res, 502, { error: 'upstream error', detail: err.message });
    });
    upstreamReq.end();
}

// ===================== 代理路由 =====================
function handleApi(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // 仅支持 GET（这些上游 API 都是 GET）
    if (req.method !== 'GET') {
        return sendJSON(res, 405, { error: 'method not allowed' });
    }

    // /api/amap/<path> → https://restapi.amap.com/<path>
    if (pathname.startsWith('/api/amap/')) {
        if (!ENV.AMAP_KEY) return sendJSON(res, 503, { error: 'AMAP_KEY not configured on server' });
        const sub = pathname.slice('/api/amap/'.length);
        return proxyGet(req, res, UPSTREAM.amap, '/' + sub, { key: ENV.AMAP_KEY });
    }

    // /api/qweather/geo/<path> → https://geoapi.qweather.com/<path>
    if (pathname.startsWith('/api/qweather/geo/')) {
        if (!ENV.QWEATHER_KEY) return sendJSON(res, 503, { error: 'QWEATHER_KEY not configured on server' });
        const sub = pathname.slice('/api/qweather/geo/'.length);
        return proxyGet(req, res, UPSTREAM.qweather_geo, '/' + sub, { key: ENV.QWEATHER_KEY });
    }

    // /api/qweather/dev/<path> → https://devapi.qweather.com/<path>
    if (pathname.startsWith('/api/qweather/dev/')) {
        if (!ENV.QWEATHER_KEY) return sendJSON(res, 503, { error: 'QWEATHER_KEY not configured on server' });
        const sub = pathname.slice('/api/qweather/dev/'.length);
        return proxyGet(req, res, UPSTREAM.qweather_dev, '/' + sub, { key: ENV.QWEATHER_KEY });
    }

    // /api/ipnews/<path> → https://ipnews.io/<path>
    if (pathname.startsWith('/api/ipnews/')) {
        if (!ENV.IPNEWS_KEY) return sendJSON(res, 503, { error: 'IPNEWS_KEY not configured on server' });
        const sub = pathname.slice('/api/ipnews/'.length);
        return proxyGet(req, res, UPSTREAM.ipnews, '/' + sub, { 'api-key': ENV.IPNEWS_KEY });
    }

    // /api/status → 返回服务端已配置的 provider 列表（不暴露 Key）
    if (pathname === '/api/status') {
        return sendJSON(res, 200, {
            amap: !!ENV.AMAP_KEY,
            qweather: !!ENV.QWEATHER_KEY,
            ipnews: !!ENV.IPNEWS_KEY,
        });
    }

    return sendJSON(res, 404, { error: 'api not found' });
}

// ===================== 静态文件服务 =====================
function serveStatic(req, res) {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // 禁止访问敏感文件
    const basename = path.basename(pathname);
    if (basename === '.env' || basename.startsWith('.env.')) {
        return sendJSON(res, 403, { error: 'forbidden' });
    }

    const filePath = safeJoinPath(ROOT, pathname);
    if (!filePath.startsWith(ROOT)) {
        return sendJSON(res, 403, { error: 'forbidden' });
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            // SPA 风格回退到 index.html（避免刷新 404）
            const fallback = path.join(ROOT, 'index.html');
            fs.stat(fallback, (e2, s2) => {
                if (e2 || !s2.isFile()) return sendJSON(res, 404, { error: 'not found' });
                serveFile(res, fallback, '.html');
            });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        serveFile(res, filePath, ext);
    });
}

function serveFile(res, filePath, ext) {
    fs.readFile(filePath, (err, data) => {
        if (err) return sendJSON(res, 500, { error: 'read error' });
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        });
        res.end(data);
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
        // 简单 CORS（如需跨域访问可放开）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        if (parsed.pathname.startsWith('/api/')) {
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
        console.log(`  AMAP_KEY     : ${mask(ENV.AMAP_KEY)}`);
        console.log(`  QWEATHER_KEY : ${mask(ENV.QWEATHER_KEY)}`);
        console.log(`  IPNEWS_KEY   : ${mask(ENV.IPNEWS_KEY)}`);
        console.log('------------------------------------------------------');
        console.log('  代理端点:');
        console.log('    /api/amap/*           → restapi.amap.com');
        console.log('    /api/qweather/geo/*   → geoapi.qweather.com');
        console.log('    /api/qweather/dev/*   → devapi.qweather.com');
        console.log('    /api/ipnews/*         → ipnews.io');
        console.log('    /api/status           → 服务端已配置的 provider');
        console.log('======================================================');
    });

    server.on('error', err => {
        console.error('[server] 启动失败:', err.message);
        process.exit(1);
    });
}

main();
