/**
 * check-runtime-boundary.cjs — agent-runtime 边界守卫（P2）。
 *
 * electron/agent-runtime/ 是纯引擎模块：它只能依赖 electron/ 根级基础设施
 * （errors / types / dev-log / utils…）和自身的 ports 契约，**不得**出现指向
 * electron/ipc/** 的**值**导入（import / export-from / 动态 import）。
 *
 * 类型导入（`import type`）允许存在：它们会被 TypeScript 擦除，不会在运行时
 * 把宿主实现拖进引擎。宿主实现必须通过 ports.ts 注入，见 electron/ipc/runtime-ports.ts。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, 'electron', 'agent-runtime');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of sourceFiles(runtimeDir)) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');

  // 动态 import(...)：永远是值导入。
  for (const match of text.matchAll(/(?:await\s+)?import\(\s*'([^']+)'\s*\)/g)) {
    const resolved = resolveTarget(file, match[1]);
    if (resolved) {
      violations.push({ file: rel, line: lineOf(text, match.index), spec: match[1], kind: 'dynamic' });
    }
  }

  // 静态 import/export-from：跳过 `import type`。
  for (const match of text.matchAll(/(?:^|\n)\s*(import|export)(\s+type)?\b[^;\n]*?from\s+'([^']+)'/g)) {
    if (match[2]) continue; // import type / export type — 擦除后不产生运行时依赖
    const spec = match[3];
    const resolved = resolveTarget(file, spec);
    if (resolved) violations.push({ file: rel, line: lineOf(text, match.index), spec, kind: 'value' });
  }
}

function resolveTarget(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const rel = path.relative(path.join(root, 'electron', 'ipc'), candidate);
    const insideIpc = !rel.startsWith('..') && !path.isAbsolute(rel);
    return insideIpc ? candidate : null;
  }
  return null;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

if (violations.length > 0) {
  console.error('agent-runtime 边界被破坏：引擎出现指向 electron/ipc/** 的运行时依赖。');
  console.error('请改为在 ports.ts 声明能力，并在 electron/ipc/runtime-ports.ts 里装配实现。');
  for (const v of violations) console.error(`  [${v.kind}] ${v.file}:${v.line} → ${v.spec}`);
  process.exit(1);
}

console.log('agent-runtime 边界: OK（无指向 electron/ipc 的值依赖）');
