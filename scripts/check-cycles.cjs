/**
 * check-cycles.cjs — 静态循环依赖守卫。
 *
 * 只统计**静态** import/export-from 形成的环：动态 `await import()` 是历史上
 * 用来打断环的补丁，虽然不理想，但不会造成模块初始化顺序问题。静态环必须清零，
 * 否则任何一次 import 调整都可能让某个模块在初始化阶段拿到 undefined。
 *
 * 预算写在 scripts/cycle-budget.json；清理后请同步下调。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const budget = JSON.parse(fs.readFileSync(path.join(__dirname, 'cycle-budget.json'), 'utf8'));
const maxCycles = budget.maxCycles ?? 0;
const maxRuntimeCycles = budget.maxRuntimeCycles ?? Number.MAX_SAFE_INTEGER;
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  'dist',
  'dist-electron',
  'release',
  'coverage',
  'vendor',
  'packages',
  'python',
]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// 区分值导入与 `import type`：类型导入会被 TS 擦除，不参与运行时模块初始化，
// 因此只对「值环」设预算；类型环单独统计（理想也清零，但不是阻塞项）。
const STATIC_IMPORT_RE = /(?:^|\n)\s*(?:import|export)(\s+type)?\b[^;\n]*?from\s+'([^']+)'/g;
// 动态 import 是历史上用来打断环的补丁：不会造成初始化顺序问题，但依赖图依然纠缠；
// 单独计量并设预算，逐条降到 0（P0-b 收尾项）。
const DYNAMIC_IMPORT_RE = /(?:await\s+)?import\(\s*'([^']+)'\s*\)/g;

const files = [...sourceFiles(path.join(root, 'electron')), ...sourceFiles(path.join(root, 'src'))];
const graph = new Map();
const typeGraph = new Map();
const dynamicGraph = new Map();
for (const file of files) {
  const targets = new Set();
  const typeTargets = new Set();
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(STATIC_IMPORT_RE)) {
    const resolved = resolveImport(file, match[2]);
    if (!resolved) continue;
    if (match[1]) typeTargets.add(resolved);
    else targets.add(resolved);
  }
  graph.set(file, [...targets]);
  typeGraph.set(file, [...typeTargets]);
  const dynamicTargets = new Set();
  for (const match of text.matchAll(DYNAMIC_IMPORT_RE)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) dynamicTargets.add(resolved);
  }
  dynamicGraph.set(file, [...dynamicTargets]);
}

/** Tarjan 强连通分量：>1 个节点即为环。 */
function findCycles(edges) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  function strongConnect(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }

    if (low.get(node) === indices.get(node)) {
      const group = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        group.push(member);
      } while (member !== node);
      if (group.length > 1) cycles.push(group);
    }
  }

  for (const file of edges.keys()) if (!indices.has(file)) strongConnect(file);
  return cycles;
}

const valueCycles = findCycles(graph);
const combined = new Map(
  [...graph.keys()].map((file) => [file, [...(graph.get(file) ?? []), ...(typeGraph.get(file) ?? [])]]),
);
const allCycles = findCycles(combined);
const runtimeCycles = findCycles(
  new Map([...graph.keys()].map((file) => [file, [...(graph.get(file) ?? []), ...(dynamicGraph.get(file) ?? [])]])),
);

const relative = (file) => path.relative(root, file).replace(/\\/g, '/');
console.log(
  `静态值循环: ${valueCycles.length} (budget ${maxCycles})｜运行时环(含动态 import): ${runtimeCycles.length} (budget ${maxRuntimeCycles})｜含类型导入: ${allCycles.length}`,
);

if (valueCycles.length > maxCycles || runtimeCycles.length > maxRuntimeCycles) {
  console.error('静态循环超出预算，新增的静态环会导致模块初始化顺序问题：');
  for (const group of [...valueCycles, ...runtimeCycles].slice(0, 5)) {
    console.error(`  ${group.map(relative).join(' → ')}`);
  }
  console.error('修好后请下调 scripts/cycle-budget.json 的 maxCycles。');
  process.exit(1);
}
