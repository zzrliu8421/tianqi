/**
 * SkyWeather 构建脚本
 * 从 .env 文件读取 API Key 等配置，生成 config.js
 *
 * 用法：
 *   node build.js          # 生成 config.js
 *   node build.js check    # 检查配置是否有效（不生成文件）
 */
const fs = require('fs');
const path = require('path');

// ===================== 配置项 =====================
const STATIC_CONFIG = {
    // 天气数据源优先级：优先使用有 key 的源，Open-Meteo 作为免 key 全球/IPv6 兜底
    PROVIDER_ORDER: ['qweather', 'amap', 'openmeteo'],
    // IP 定位优先级：高德IP对中国最准确且国内访问快；腾讯IP返回坐标可作为备选；ipapi.co 支持 IPv6 与海外 IP
    IP_PROVIDER_ORDER: ['amap', 'qqip', 'ipapi'],
    // 搜索历史存储键
    STORAGE_KEY: 'weather_search_history_v2',
    MAX_HISTORY: 8,
    QUICK_CITIES: ['北京', '上海', '广州', '深圳', '杭州', '成都', '纽约', '伦敦', '东京'],
};

// ===================== 环境变量密钥映射 =====================
// 从 .env 读取的键名 → CONFIG 中的键名
const ENV_KEY_MAP = {
    AMAP_KEY: 'AMAP_KEY',
    QWEATHER_KEY: 'QWEATHER_KEY',
};

// ===================== 工具函数 =====================
function parseEnv(filePath) {
    const env = {};
    if (!fs.existsSync(filePath)) {
        return env;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    content.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) return;
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // 移除可选的外层引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) env[key] = value;
    });
    return env;
}

function generateConfigJS(env) {
    // 构建 CONFIG 对象字符串
    const configLines = [];
    configLines.push('// 此文件由 build.js 自动生成，请勿手动修改');
    configLines.push('// 如需修改配置，请编辑 .env 文件后重新运行: node build.js\n');
    configLines.push('const CONFIG = {');
    configLines.push('    // ---------- API 密钥（来自 .env） ----------');
    for (const [envKey, configKey] of Object.entries(ENV_KEY_MAP)) {
        const value = env[envKey] !== undefined ? env[envKey] : '';
        const comment = envKey === 'AMAP_KEY'
            ? '高德 Web 服务 Key（用于中国地区天气与地理编码）'
            : '和风天气 Web API Key（可选，填写后可获得 AQI 等数据）';
        configLines.push(`    // ${comment}`);
        configLines.push(`    ${configKey}: '${escapeJS(value)}',`);
    }
    configLines.push('');
    configLines.push('    // ---------- 静态配置 ----------');
    for (const [key, value] of Object.entries(STATIC_CONFIG)) {
        configLines.push(`    ${key}: ${formatJSValue(value)},`);
    }
    configLines.push('};\n');
    return configLines.join('\n');
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
    const envPath = path.join(__dirname, '.env');
    const outputPath = path.join(__dirname, 'config.js');

    // 检查 .env 是否存在
    if (!fs.existsSync(envPath)) {
        console.error('❌ 未找到 .env 文件！');
        console.error('');
        console.error('请按以下步骤操作：');
        console.error('  1. 复制模板文件: copy .env.example .env');
        console.error('  2. 编辑 .env 填入你的 API Key');
        console.error('  3. 重新运行: node build.js');
        process.exit(1);
    }

    const env = parseEnv(envPath);

    // check 模式：仅检查配置
    if (mode === 'check') {
        console.log('📋 当前配置状态：');
        for (const envKey of Object.keys(ENV_KEY_MAP)) {
            const val = env[envKey] || '';
            const displayVal = val ? `${val.substring(0, 4)}****${val.substring(val.length - 4)}` : '(空)';
            console.log(`   ${envKey}: ${displayVal}`);
        }
        const amapExists = !!(env.AMAP_KEY && env.AMAP_KEY.length > 0);
        const qweatherExists = !!(env.QWEATHER_KEY && env.QWEATHER_KEY.length > 0);
        console.log('');
        console.log('📊 数据源可用性：');
        console.log(`   高德天气: ${amapExists ? '✅ 可用' : '❌ 未配置'}`);
        console.log(`   和风天气: ${qweatherExists ? '✅ 可用' : '❌ 未配置'}`);
        console.log(`   Open-Meteo: ✅ 始终可用（免 Key 兜底）`);
        return;
    }

    // 生成 config.js
    const content = generateConfigJS(env);
    fs.writeFileSync(outputPath, content, 'utf8');
    console.log('✅ config.js 已生成');

    // 显示配置摘要
    const amapKey = env.AMAP_KEY || '';
    const displayKey = amapKey ? `${amapKey.substring(0, 4)}****${amapKey.substring(amapKey.length - 4)}` : '(空)';
    console.log(`   AMAP_KEY: ${displayKey}`);
    console.log(`   QWEATHER_KEY: ${env.QWEATHER_KEY || '(空)'}`);
    console.log('');
    console.log('💡 提示：用 node build.js check 可随时查看配置状态');
}

main();
