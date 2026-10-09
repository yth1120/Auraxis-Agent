#!/usr/bin/env node
/**
 * eval-diff.cjs — 把"这次评测有没有变差"变成一个退出码。
 *
 * 为什么需要它：评测报告一直在写，`baseline.json` 也一直在，但**没有任何代码读它** ——
 * "改了工具装载 / 路由 / 循环之后有没有变差"只能靠人眼看两份 JSON。人眼不会盯着
 * 137k → 62k 这种数字看，于是回归可以无声地发生。
 *
 * 用法：
 *   node scripts/eval-diff.cjs                                  # 基线=evals/baseline/coding.json，本次=reports/latest.json
 *   node scripts/eval-diff.cjs --baseline=… --current=…
 *   node scripts/eval-diff.cjs --tokens=0.3 --no-new-cases
 *   node scripts/eval-diff.cjs --check-meta                     # 只比工具 schema 指纹（无 Key 可跑）
 *
 * 判定逻辑在 `electron/agent-eval/regression.ts`（纯函数、有单测）；这里只负责
 * 读文件、打印、决定退出码。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { diffReports, toolSchemaHash } = require(path.join(root, 'dist-electron', 'agent-eval', 'regression.js'));
const { projectForBaseline } = require(path.join(root, 'dist-electron', 'agent-eval', 'report.js'));
const { TOOL_DEFINITIONS } = require(path.join(root, 'dist-electron', 'tool-defs', 'index.js'));

const DEFAULT_BASELINE = path.join(root, 'evals', 'baseline', 'coding.json');
const HASH_FILE = path.join(root, 'evals', 'baseline', 'tool-schema.hash');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const checkMetaOnly = args.includes('--check-meta');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function currentToolSchemaHash() {
  return toolSchemaHash([...TOOL_DEFINITIONS]);
}

/**
 * 工具 schema 指纹校验。
 *
 * 工具 schema 是**缓存前缀的一部分**，它一变，基线里的 token 数字就不再可比 ——
 * 所以这里必须挡一下，而不是让人拿一个过期的基线去比较。没有指纹文件时给出**明确指引**
 * 而不是静默通过。
 */
function checkMeta() {
  const now = currentToolSchemaHash();
  if (!fs.existsSync(HASH_FILE)) {
    console.error(`缺少 ${path.relative(root, HASH_FILE)}：先跑一次 live 评测并冻结基线（见 evals/README.md）`);
    return 1;
  }
  const recorded = fs.readFileSync(HASH_FILE, 'utf8').trim();
  if (recorded === now) {
    console.log(`工具 schema 指纹一致: ${now}`);
    return 0;
  }
  console.error(
    `工具 schema 已变: ${recorded} → ${now}\n` +
      '这意味着基线里的 token 数字不再可比。请重跑一次 live 评测并重提基线：\n' +
      '  npm run eval:agent -- --out=evals/baseline/coding.json\n' +
      `  node -e "…" > ${path.relative(root, HASH_FILE)}   # 或跑 scripts/eval-diff.cjs --write-meta`,
  );
  return 1;
}

/**
 * 冻结基线：把一份报告投影成**可入库**的形状（去轨迹、去临时绝对路径，见 report.ts），
 * 再写指纹。基线只能人工重跑、人工提交 —— 自动改写基线等于把"回归"洗掉。
 */
function freezeReport() {
  const src = arg('from', path.join(root, 'evals', 'reports', 'latest.json'));
  const dst = arg('baseline', DEFAULT_BASELINE);
  if (!fs.existsSync(src)) {
    console.error(`缺少源报告: ${src}`);
    return 1;
  }
  const report = readJson(src);
  if (report.mode !== 'live') {
    console.error(`拒绝冻结 ${report.mode} 报告：基线必须是 live 评测（dry 全是 passed=false）。`);
    return 1;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(
    dst,
    `${JSON.stringify(projectForBaseline(report), null, 2)}
`,
  );
  fs.writeFileSync(
    HASH_FILE,
    `${currentToolSchemaHash()}
`,
  );
  console.log(`已冻结基线: ${path.relative(root, dst)}（${report.cases.length} 个用例，工具 schema 指纹已同步）`);
  return 0;
}

function writeMeta() {
  const hash = currentToolSchemaHash();
  fs.mkdirSync(path.dirname(HASH_FILE), { recursive: true });
  fs.writeFileSync(HASH_FILE, `${hash}\n`);
  console.log(`已写入工具 schema 指纹: ${hash} → ${path.relative(root, HASH_FILE)}`);
  return 0;
}

function main() {
  if (args.includes('--freeze')) return freezeReport();
  if (args.includes('--write-meta')) return writeMeta();
  if (checkMetaOnly) return checkMeta();

  const baselinePath = arg('baseline', DEFAULT_BASELINE);
  const currentPath = arg('current', path.join(root, 'evals', 'reports', 'latest.json'));
  for (const p of [baselinePath, currentPath]) {
    if (!fs.existsSync(p)) {
      console.error(`缺少报告: ${p}\n先跑 npm run eval:agent（需要 DEEPSEEK_API_KEY）或 --dry（不需要）`);
      return 1;
    }
  }

  let result;
  try {
    result = diffReports(readJson(baselinePath), readJson(currentPath), {
      maxTokenIncreaseRatio: arg('tokens') ? Number(arg('tokens')) : undefined,
      allowNewCases: !args.includes('--no-new-cases'),
    });
  } catch (err) {
    console.error(String(err.message || err));
    return 2;
  }

  const fmt = ({ passed, total, tokensIn }) => `${passed}/${total} 通过 · 输入 token ${tokensIn}`;
  console.log(`基线: ${fmt(result.baseline)}   (${path.relative(root, baselinePath)})`);
  console.log(`本次: ${fmt(result.matches)}   (${path.relative(root, currentPath)})`);

  // 跳过的对比必须**说出来**：不打印的话，"没有 tokens_increased" 会被读成"token 没涨"。
  if (!result.tokensCompared) {
    console.log(`\n⚠ token 对比已跳过：${result.tokensSkippedReason ?? '两份报告不可比'}`);
  }
  if (result.newCases.length > 0) console.log(`\n新增用例 ${result.newCases.length} 个: ${result.newCases.join(', ')}`);
  if (result.improvements.length > 0) {
    console.log(`\n改进 ${result.improvements.length} 项:`);
    for (const i of result.improvements) console.log(`  ✓ ${i.caseId}: ${i.detail}`);
  }
  if (result.regressions.length === 0) {
    console.log('\n回归: 无');
    return 0;
  }
  console.error(`\n回归 ${result.regressions.length} 项:`);
  for (const r of result.regressions) console.error(`  ✗ [${r.kind}] ${r.caseId}: ${r.detail}`);
  return 1;
}

process.exit(main());
