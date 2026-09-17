/**
 * check-preload-bundle.cjs — 预加载脚本打包守卫。
 *
 * 背景（真实事故）：`npm run electron:compile` = `tsc && vite build --config vite.preload.config.mts`。
 * 一旦 `tsc` 报错，`&&` 会跳过 preload 打包，`dist-electron/preload.js` 就停留在 tsc 的
 * CommonJS 输出（`require("./preload-api")`）。Electron 的沙箱 preload 只能 require
 * `electron`，于是运行时报 "module not found: ./preload-api" → `window.electronAPI` 为
 * undefined → 渲染层所有 IPC 失效（表现为登录页「认证服务不可用」，也就是"登录不进去"）。
 *
 * 这个守卫断言关键的 preload 产物是**已打包**的单文件（不再 require 兄弟模块）。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
// 只检查窗口实际加载的那个 preload（main.ts 的 webPreferences.preload）。
// dist-electron/preload-*.js 是 tsc 的中间产物，不参与运行时加载。
const targets = [{ file: 'dist-electron/preload.js' }];

const problems = [];
for (const target of targets) {
  const full = path.join(root, target.file);
  if (!fs.existsSync(full)) {
    problems.push(`${target.file} 不存在（先运行 npm run electron:compile）`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  // 沙箱 preload 里出现对兄弟模块的 require = 未经过 vite 打包。
  for (const sibling of [
    'preload-api',
    'preload-core',
    'preload-rest',
    'preload-platform',
    'preload-shared',
    'preload-ai',
  ]) {
    if (new RegExp(`require\\((['"])\\./${sibling}\\1\\)`).test(text)) {
      problems.push(
        `${target.file} 仍在 require('./${sibling}')：preload 未被 vite 打包（tsc 可能报错导致打包被跳过）`,
      );
    }
  }
  if (!/contextBridge/.test(text)) {
    problems.push(`${target.file} 里没有 contextBridge：产物不完整`);
  }
}

if (problems.length > 0) {
  console.error('预加载脚本产物不完整，运行时会表现为「登录不进去 / 认证服务不可用」：');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('修复：先让 tsc 通过，再执行 npm run electron:compile（必要时先删除 dist-electron 重跑）。');
  process.exit(1);
}

console.log('preload 打包产物: OK（单文件、含 contextBridge）');
