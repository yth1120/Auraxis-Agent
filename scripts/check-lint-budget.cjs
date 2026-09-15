/**
 * check-lint-budget.cjs — 让代码卫生债务只减不增。
 *
 * eslint 里的复杂度/规模规则以 warning 形式常驻（见 eslint.config.mjs），
 * 这里把 warning 总数与 scripts/lint-budget.cjs 里的上限比较：超过就失败，
 * 并打印规则分布，方便定位是谁把债务堆高了。重构降低告警后，请同时下调上限。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { maxWarnings } = JSON.parse(fs.readFileSync(path.join(__dirname, 'lint-budget.json'), 'utf8'));

let report = [];
try {
  // 直接调用本地 eslint CLI：避免经 shell 传参（Node 24 会告警，也不安全）。
  const eslintBin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const raw = execFileSync(process.execPath, [eslintBin, '.', '-f', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  report = JSON.parse(raw);
} catch (err) {
  // eslint 在有 error 时也会返回非零退出码，但 stdout 仍是完整 JSON。
  if (typeof err.stdout === 'string' && err.stdout.trim().startsWith('[')) {
    report = JSON.parse(err.stdout);
  } else {
    console.error('无法解析 eslint 输出:', err.message);
    process.exit(1);
  }
}

const warnings = [];
for (const file of report) {
  for (const message of file.messages) {
    if (message.severity === 1) {
      warnings.push({ file: path.relative(root, file.filePath), rule: message.ruleId ?? 'unknown' });
    }
  }
}

const byRule = {};
for (const warning of warnings) byRule[warning.rule] = (byRule[warning.rule] ?? 0) + 1;
const distribution = Object.entries(byRule)
  .sort((a, b) => b[1] - a[1])
  .map(([rule, count]) => `${rule}=${count}`)
  .join(', ');

console.log(`lint warnings: ${warnings.length} (budget ${maxWarnings}) — ${distribution || '无'}`);

if (warnings.length > maxWarnings) {
  console.error(`代码卫生债务超出预算：${warnings.length} > ${maxWarnings}`);
  for (const warning of warnings.slice(-10)) console.error(`  ${warning.file}  ${warning.rule}`);
  console.error('修复后请下调 scripts/lint-budget.json 的 maxWarnings。');
  process.exit(1);
}
