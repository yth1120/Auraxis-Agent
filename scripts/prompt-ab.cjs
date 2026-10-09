#!/usr/bin/env node
/**
 * prompt-ab.cjs — 提示词变体的 A/B 对比（评测驱动，不自动改产品）。
 *
 * 用法：
 *   node scripts/prompt-ab.cjs                    # 跑 evals/prompts/*.txt 全部变体 + 基线臂
 *   node scripts/prompt-ab.cjs --case=coding-008   # 只跑一个用例（快速验证机制）
 *   node scripts/prompt-ab.cjs --repeat=3          # 每臂重复 3 次（噪声大时必须重复）
 *
 * 做法：每个变体作为一"臂"，用 `AURAXIS_PROMPT_VARIANT_FILE` 注入，跑完整评测，
 * 汇总通过率与 token 消耗后打印对比表。
 *
 * **为什么不自动采纳胜者**：数据集只有十来个用例，自动择优必然过拟合；真正的收益
 * 要用更大的任务集和多次重复才能区分开噪声。这里只做"把候选跑成可比的数据"，
 * 采纳与否由人决定。
 *
 * 需要 DEEPSEEK_API_KEY（未设置时明确失败，不产生假数据）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const variantsDir = path.join(root, 'evals', 'prompts');
const reportsDir = path.join(root, 'evals', 'reports');

const args = process.argv.slice(2);
const onlyCase = args.find((a) => a.startsWith('--case='))?.slice('--case='.length);
const repeat = Math.max(1, Number(args.find((a) => a.startsWith('--repeat='))?.slice('--repeat='.length)) || 1);

function variantFiles() {
  if (!fs.existsSync(variantsDir)) return [];
  return fs
    .readdirSync(variantsDir)
    .filter((f) => f.endsWith('.txt'))
    .map((f) => path.join(variantsDir, f))
    .sort();
}

/** 跑一臂：变体文件为 null 表示基线（不注入任何变体）。 */
function runArm(name, variantFile) {
  const outPath = path.join(reportsDir, `arm-${name}.json`);
  const env = { ...process.env, AURAXIS_EVAL_ARM: name };
  if (variantFile) env.AURAXIS_PROMPT_VARIANT_FILE = variantFile;
  else delete env.AURAXIS_PROMPT_VARIANT_FILE;

  const cliArgs = ['scripts/agent-eval.cjs', `--out=${outPath}`];
  if (onlyCase) cliArgs.push(`--case=${onlyCase}`);
  if (repeat > 1) cliArgs.push(`--repeat=${repeat}`);

  console.log(`\n── 臂 ${name}${variantFile ? `（${path.basename(variantFile)}）` : '（基线）'} ──`);
  const run = spawnSync(process.execPath, cliArgs, { cwd: root, env, stdio: 'inherit', encoding: 'utf8' });
  if (!fs.existsSync(outPath)) return { name, error: `评测没有产出报告（exit=${run.status}）` };

  const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const cases = report.cases;
  const passed = cases.filter((c) => c.passed).length;
  const tokensIn = cases.reduce((n, c) => n + (c.tokensIn || 0), 0);
  const tokensOut = cases.reduce((n, c) => n + (c.tokensOut || 0), 0);
  return { name, passed, total: cases.length, tokensIn, tokensOut, outPath };
}

function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('缺少 DEEPSEEK_API_KEY：提示词 A/B 需要真实运行，无法离线完成。');
    process.exit(1);
  }
  const files = variantFiles();
  if (files.length === 0) {
    console.error(`没有候选变体：请在 ${path.relative(root, variantsDir)}/ 下放置 *.txt（一行文本即可）。`);
    process.exit(1);
  }

  const arms = [runArm('baseline', null), ...files.map((f) => runArm(path.basename(f, '.txt'), f))];
  const ok = arms.filter((a) => !a.error);

  console.log('\n臂                 通过        输入token   输出token');
  for (const arm of arms) {
    if (arm.error) {
      console.log(`${arm.name.padEnd(18)} ${arm.error}`);
      continue;
    }
    console.log(
      `${arm.name.padEnd(18)} ${`${arm.passed}/${arm.total}`.padEnd(10)} ${String(arm.tokensIn).padEnd(11)} ${arm.tokensOut}`,
    );
  }
  console.log('\n提示：这只是一次采样，不构成统计结论。要采纳某个变体，请提高 --repeat 再跑一遍。');
  if (ok.length === 0) process.exit(1);
}

main();
