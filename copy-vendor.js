// ============================================================
// 拷贝 Three.js 到本地 vendor/ 目录，使应用可离线运行
// 在 npm install 后自动执行（postinstall）
//
// 说明：
//   - 只拷贝前端实际用到的依赖闭包（weather-renderer.js import 的
//     postprocessing + 其 shader 依赖），不再全量拷贝
//     three/examples/jsm（556 个文件 / 21.7MB）。
//   - 依赖闭包由脚本扫描各文件的 import 语句自动推导，新增依赖不会漏拷。
//   - vendor/three.module.js 优先使用压缩版 three.module.min.js，
//     因此 index.html 的 importmap（"three" -> "./vendor/three.module.js"）无需改动。
//   - 每次执行先清空 vendor/，保证幂等（可重复运行，不残留旧文件）。
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const THREE_BUILD_DIR = path.join(ROOT, 'node_modules', 'three', 'build');
const SRC_THREE_MIN = path.join(THREE_BUILD_DIR, 'three.module.min.js');
const SRC_THREE_FULL = path.join(THREE_BUILD_DIR, 'three.module.js');
const SRC_ADDONS = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const DST_VENDOR = path.join(ROOT, 'vendor');
const DST_THREE = path.join(DST_VENDOR, 'three.module.js');
const DST_ADDONS = path.join(DST_VENDOR, 'addons');

// 前端 weather-renderer.js 直接 import 的入口文件；
// 其余依赖（Pass.js / MaskPass.js / CopyShader.js / LuminosityHighPassShader.js 等）
// 由 collectAddonClosure() 扫描 import 自动补全。
const ADDON_ENTRIES = [
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/ShaderPass.js',
];

// 提取 import / export-from 的模块说明符
const FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s+['"]([^'"]+)['"]/g;

function copyFileSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function extractImports(source) {
  const specs = [];
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(source)) !== null) specs.push(m[1]);
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_IMPORT_RE.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/**
 * 从入口文件出发，递归收集 addons 内部的相对依赖闭包。
 * 返回相对 examples/jsm 的 POSIX 风格路径数组（已排序）。
 */
function collectAddonClosure() {
  const visited = new Set();
  const missing = [];
  const queue = ADDON_ENTRIES.slice();

  while (queue.length > 0) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    const abs = path.join(SRC_ADDONS, rel);
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    visited.add(rel);

    const source = fs.readFileSync(abs, 'utf8');
    for (const spec of extractImports(source)) {
      if (!spec.startsWith('.')) continue; // 'three' 等裸模块由 three.module.js 提供
      let resolvedRel = path.relative(SRC_ADDONS, path.resolve(path.dirname(abs), spec))
        .split(path.sep).join('/');
      if (!resolvedRel.endsWith('.js')) resolvedRel += '.js';
      if (resolvedRel.startsWith('..')) continue; // 越界依赖不拷贝
      queue.push(resolvedRel);
    }
  }

  if (missing.length > 0) {
    throw new Error('缺少依赖文件: ' + missing.join(', '));
  }
  return Array.from(visited).sort();
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

try {
  // 优先级：压缩版 three.module.min.js > 未压缩版 three.module.js
  const threeSrc = fs.existsSync(SRC_THREE_MIN) ? SRC_THREE_MIN
    : (fs.existsSync(SRC_THREE_FULL) ? SRC_THREE_FULL : null);
  if (!threeSrc) {
    console.warn('[vendor] three.module(.min).js 未找到，跳过（npm install three 后再次运行）');
    process.exit(0);
  }
  if (!fs.existsSync(SRC_ADDONS)) {
    console.warn('[vendor] node_modules/three/examples/jsm 未找到，只能拷贝 three 主文件');
  }

  const addonFiles = fs.existsSync(SRC_ADDONS) ? collectAddonClosure() : [];

  // 幂等：先清空 vendor/，避免旧的全量拷贝残留
  fs.rmSync(DST_VENDOR, { recursive: true, force: true });
  fs.mkdirSync(DST_VENDOR, { recursive: true });

  copyFileSync(threeSrc, DST_THREE);
  const copied = [DST_THREE];
  for (const rel of addonFiles) {
    const dst = path.join(DST_ADDONS, rel);
    copyFileSync(path.join(SRC_ADDONS, rel), dst);
    copied.push(dst);
  }

  const totalBytes = copied.reduce((sum, f) => sum + fs.statSync(f).size, 0);

  console.log('[vendor] Three.js 已拷贝到 vendor/');
  console.log(`  文件数: ${copied.length}  总体积: ${formatSize(totalBytes)} (${totalBytes} bytes)`);
  console.log(`  - vendor/three.module.js ← ${path.basename(threeSrc)} (${formatSize(fs.statSync(threeSrc).size)})`);
  for (const rel of addonFiles) {
    console.log(`  - vendor/addons/${rel}`);
  }
} catch (e) {
  console.error('[vendor] 拷贝失败:', e.message);
  process.exit(0); // 不阻断构建
}
