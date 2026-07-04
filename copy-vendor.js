// ============================================================
// 拷贝 Three.js 到本地 vendor/ 目录，使应用可离线运行
// 在 npm install 后自动执行（postinstall）
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_THREE = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
const SRC_ADDONS = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const DST_VENDOR = path.join(ROOT, 'vendor');
const DST_THREE = path.join(DST_VENDOR, 'three.module.js');
const DST_ADDONS = path.join(DST_VENDOR, 'addons');

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
  if (!fs.existsSync(SRC_THREE)) {
    console.warn('[vendor] three.module.js 未找到，跳过（npm install three 后再次运行）');
    process.exit(0);
  }
  fs.mkdirSync(DST_VENDOR, { recursive: true });
  copyFileSync(SRC_THREE, DST_THREE);
  copyDirSync(SRC_ADDONS, DST_ADDONS);
  console.log('[vendor] Three.js 已拷贝到 vendor/');
  console.log('  - vendor/three.module.js');
  console.log('  - vendor/addons/ (含 postprocessing 等)');
} catch (e) {
  console.error('[vendor] 拷贝失败:', e.message);
  process.exit(0); // 不阻断构建
}
