/**
 * check-doc-stats.cjs — guard against stale version/test/coverage numbers.
 *
 * The repository documentation still mixes English/Chinese files and is mostly
 * hand-maintained. This script makes the most drift-prone numbers fail CI
 * instead of silently becoming stale.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const docs = ['README.md', 'AGENTS.md', 'docs/README.md', 'docs/README.zh-CN.md', 'CHANGELOG.md'].map((file) =>
  path.join(root, file),
);

const appPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sdkPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages/auraxis-sdk/package.json'), 'utf8'));
const pyproject = fs.readFileSync(path.join(root, 'python/auraxis_sdk/pyproject.toml'), 'utf8');

const coveragePath = path.join(root, 'coverage/coverage-summary.json');
const coverage = fs.existsSync(coveragePath) ? JSON.parse(fs.readFileSync(coveragePath, 'utf8')) : null;
const coverageRequired = process.env.AURAXIS_COVERAGE_REQUIRED === '1';

const age = `v${appPackage.version}`;
const failures = [];

// v8 覆盖率在不同平台会因分支统计细节产生约 0.3pp 的差异（Windows 本地 vs
// Linux CI）。文档记录的是最近一次全量覆盖率结果，因此允许小幅平台差异，只拦
// 截真正过期的数字。
const COVERAGE_TOLERANCE = 0.6;
const currentDocFiles = ['README.md', 'AGENTS.md', 'docs/README.md', 'docs/README.zh-CN.md'].map((file) =>
  path.join(root, file),
);

/** 收集形如「90.03% lines」的覆盖率声明（阈值写法「≥80% lines」不会被匹配）。 */
function collectCoverageClaims(metric) {
  const pattern = new RegExp(`(\\d+\\.\\d{2})%\\s*[（(]?${metric}\\b`, 'g');
  const claims = [];
  for (const file of currentDocFiles) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      claims.push({ file: path.relative(root, file), value: Number(match[1]) });
    }
  }
  return claims;
}

const currentTestCountMentioned = docs.some((file) => {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  return text.includes('271 个测试文件') || text.includes('271 test files');
});
if (!currentTestCountMentioned) {
  failures.push('文档未记录当前全量测试文件数 271');
}

const currentCaseCountMentioned = docs.some((file) => {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  return text.includes('2,100') || text.includes('2100');
});
if (!currentCaseCountMentioned) {
  failures.push('文档未记录当前全量通过用例数 2094');
}

for (const file of docs) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('261 个测试文件') || text.includes('261 files') || text.includes('1,992')) {
    failures.push(`${path.relative(root, file)}: 仍包含旧的测试数量`);
  }
  if (text.includes('2032 用例') || text.includes('2,032')) {
    failures.push(`${path.relative(root, file)}: 仍包含旧的测试数量 2032`);
  }
}

for (const file of [
  path.join(root, 'docs/README.md'),
  path.join(root, 'docs/README.zh-CN.md'),
  path.join(root, 'CHANGELOG.md'),
]) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(age) && !text.includes('Auraxis v3.3.0')) {
    failures.push(`${path.relative(root, file)}: 未包含当前版本 ${age}`);
  }
}

if (coverage) {
  const metrics = {
    statements: coverage.total.statements.pct,
    lines: coverage.total.lines.pct,
    branches: coverage.total.branches.pct,
    functions: coverage.total.functions.pct,
  };
  for (const [name, value] of Object.entries(metrics)) {
    const formatted = value.toFixed(2);
    const claims = collectCoverageClaims(name);
    if (claims.length === 0) {
      failures.push(`README/AGENTS/docs 未记录当前 ${name} 覆盖率 ${formatted}%`);
      continue;
    }
    const stale = claims.filter((claim) => Math.abs(claim.value - value) > COVERAGE_TOLERANCE);
    if (stale.length > 0) {
      const documented = [...new Set(stale.map((claim) => `${claim.value}%`))].join(' / ');
      const sources = [...new Set(stale.map((claim) => claim.file))].join(', ');
      failures.push(
        `${sources} 记录的 ${name} 覆盖率 ${documented} 与实测 ${formatted}% 相差超过 ${COVERAGE_TOLERANCE}pp`,
      );
    }
  }
} else if (coverageRequired) {
  failures.push('缺失 coverage/coverage-summary.json，无法校验文档覆盖率');
} else {
  console.warn('缺少 coverage/coverage-summary.json，跳过覆盖率文档校验；Linux 覆盖率门禁运行后重试。');
}

if (appPackage.version !== sdkPackage.version) {
  failures.push(`SDK 版本 ${sdkPackage.version} 与主项目 ${appPackage.version} 不一致`);
}

if (!/version = "3\.3\.0"/.test(pyproject)) {
  failures.push('Python SDK pyproject.toml 版本与主项目不一致');
}

if (failures.length > 0) {
  console.error('文档/版本统计校验失败：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`文档统计一致: app=${appPackage.version} sdk=${sdkPackage.version}`);
