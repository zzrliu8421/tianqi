/**
 * SkyWeather 构建脚本
 *
 * 从系统环境变量或 .env 文件读取 API Key 等配置，生成 config.js。
 *
 * 来源优先级（覆盖模式）：
 *   1. 系统环境变量（process.env）— 适配 EdgeOne Pages / Vercel 等 CI/CD 平台
 *   2. .env 文件 — 适配本地开发
 *
 * 用法：
 *   node build.js              # 生成 config.js
 *   node build.js check        # 检查配置状态（不生成文件）
 */
const fs = require('fs');
const path = require('path');

// ===================== 配置项 =====================
const STATIC_CONFIG = {
    PROVIDER_ORDER: ['qweather', 'amap', 'openmeteo'],
    // IP定位降级顺序（仅当 GeoDB 完全失败时使用；正常流程由 locateIP 分流逻辑控制）
    IP_PROVIDER_ORDER: ['amap', 'geodb'],
    STORAGE_KEY: 'weather_search_history_v2',
    MAX_HISTORY: 8,
    QUICK_CITIES: ['北京', '上海', '广州', '深圳', '杭州', '成都', '纽约', '伦敦', '东京'],
};

// ===================== 环境变量映射 =====================
// 键名含义：系统环境变量名 → CONFIG 属性名
const ENV_KEY_MAP = {
    AMAP_KEY: 'AMAP_KEY',
    QWEATHER_KEY: 'QWEATHER_KEY',
    IPNEWS_KEY: 'IPNEWS_KEY',
};

// ===================== 工具函数 =====================
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

/**
 * 合并配置来源：系统环境变量优先，.env 文件兜底
 */
function resolveConfig() {
    const fileEnv = parseEnvFile(path.join(__dirname, '.env'));
    const resolved = {};
    for (const envKey of Object.keys(ENV_KEY_MAP)) {
        // process.env 优先（CI/CD 平台注入），.env 文件作为本地兜底
        resolved[envKey] = process.env[envKey] !== undefined ? process.env[envKey] : (fileEnv[envKey] || '');
    }
    return resolved;
}

function generateConfigJS(env) {
    const lines = [];
    lines.push('// 此文件由 build.js 自动生成，请勿手动修改');
    lines.push('// 如需修改配置，请编辑 .env 文件或系统环境变量后重新运行: node build.js\n');
    lines.push('const CONFIG = {');
    lines.push('    // ---------- API 密钥 ----------');
    for (const [envKey, configKey] of Object.entries(ENV_KEY_MAP)) {
        const value = env[envKey] !== undefined ? env[envKey] : '';
        const comments = {
            AMAP_KEY: '高德 Web 服务 Key（用于中国地区天气与地理编码）',
            QWEATHER_KEY: '和风天气 Web API Key（可选，填写后可获得 AQI 等数据）',
            IPNEWS_KEY: 'IPnews API Key（用于 IPv6 网络 IP 定位）',
        };
        const comment = comments[envKey] || '';
        lines.push(`    // ${comment}`);
        lines.push(`    ${configKey}: '${escapeJS(value)}',`);
    }
    lines.push('');
    lines.push('    // ---------- 静态配置 ----------');
    for (const [key, value] of Object.entries(STATIC_CONFIG)) {
        lines.push(`    ${key}: ${formatJSValue(value)},`);
    }
    lines.push('};\n');
    return lines.join('\n');
}

function escapeJS(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function formatJSValue(value) {
    if (Array.isArray(value)) {
        return '[' + value.map(v => `'${escapeJS(String(v))}'`).join(', ') + ']';
    }
    if (typeof value === 'string') {
        return `'${escapeJS(value)}'`;
    }
    if (typeof value === 'number') {
        return String(value);
    }
    return JSON.stringify(value);
}

// ===================== 主函数 =====================
function main() {
    const mode = process.argv[2];
    const outputPath = path.join(__dirname, 'config.js');

    const env = resolveConfig();

    // check 模式
    if (mode === 'check') {
        console.log('当前配置状态：');
        let hasAny = false;
        for (const envKey of Object.keys(ENV_KEY_MAP)) {
            const val = env[envKey] || '';
            const displayVal = val
                ? `${val.substring(0, 4)}****${val.substring(val.length - 4)}`
                : '(空)';
            const source = process.env[envKey] !== undefined
                ? '系统环境变量'
                : '.env 文件';
            console.log(`   ${envKey}: ${displayVal} (来源: ${source})`);
            if (val) hasAny = true;
        }
        console.log('');
        console.log('高德天气: ' + (env.AMAP_KEY ? '可用' : '未配置'));
        console.log('和风天气: ' + (env.QWEATHER_KEY ? '可用' : '未配置'));
        console.log('IPnews: ' + (env.IPNEWS_KEY ? '可用（IPv6 定位）' : '未配置'));
        console.log('Open-Meteo: 始终可用（免 Key 兜底）');
        if (!hasAny) {
            console.log('');
            console.log('提示：所有 API Key 均为空。请配置环境变量或 .env 文件。');
        }
        return;
    }

    // 生成 config.js
    const content = generateConfigJS(env);
    fs.writeFileSync(outputPath, content, 'utf8');
    console.log('config.js 已生成');

    // 摘要
    for (const envKey of Object.keys(ENV_KEY_MAP)) {
        const val = env[envKey] || '';
        const displayVal = val
            ? `${val.substring(0, 4)}****${val.substring(val.length - 4)}`
            : '(空)';
        const source = process.env[envKey] !== undefined
            ? '系统环境变量'
            : '.env 文件';
        console.log(`   ${envKey}: ${displayVal} (${source})`);
    }
}

main();
