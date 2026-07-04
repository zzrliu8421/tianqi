// ============================================================
// 准备 Capacitor 的 www/ 目录
// 把 Web 资源（index.html / weather-renderer.js / vendor 等）拷贝到 www/
// Capacitor 会把 www/ 同步到 Android 工程的 assets/public/
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WWW = path.join(ROOT, 'www');

// 需要拷贝的文件/目录（相对项目根）
const ITEMS = [
  'index.html',
  'weather-renderer.js',
  'mobile-bridge.js',
  'config.js',
  'vendor'
];

function copyFileSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDirSync(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

try {
  // 清空 www/
  if (fs.existsSync(WWW)) {
    fs.rmSync(WWW, { recursive: true, force: true });
  }
  fs.mkdirSync(WWW, { recursive: true });

  // 先生成 config.js（如果不存在）
  try { require('./build.js'); } catch (e) {}

  // 拷贝各项目
  for (const item of ITEMS) {
    const src = path.join(ROOT, item);
    const dst = path.join(WWW, item);
    if (!fs.existsSync(src)) {
      console.warn(`[prepare-cap] 跳过不存在的: ${item}`);
      continue;
    }
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      copyDirSync(src, dst);
      console.log(`[prepare-cap] 目录拷贝: ${item}/`);
    } else {
      copyFileSync(src, dst);
      console.log(`[prepare-cap] 文件拷贝: ${item}`);
    }
  }

  console.log('[prepare-cap] www/ 准备完成');
} catch (e) {
  console.error('[prepare-cap] 失败:', e.message);
  process.exit(1);
}
