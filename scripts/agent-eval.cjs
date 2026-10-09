#!/usr/bin/env node
/**
 * agent-eval.cjs — 最小 Agent Eval Runner（任务 → 真实 Agent 运行 → 判分 → 回归报告）。
 *
 * 用法：
 *   node scripts/agent-eval.cjs --dry              # 只校验数据集 + 跑 grader 自检（不需要 API Key）
 *   node scripts/agent-eval.cjs                    # 真实运行（需要 DEEPSEEK_API_KEY）
 *   node scripts/agent-eval.cjs --case=coding-001  # 只跑一个用例
 *
 * 真实运行走无头 CLI（electron dist-electron/main.js --run "<task>"），在 fixture 的
 * 临时副本里执行；随后用 electron/agent-eval/graders.ts 的同一套判分逻辑打分。
 * 没有 API Key 时**明确失败**，不用假数据冒充结果。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const evalsDir = path.join(root, 'evals');
const reportPath = path.join(evalsDir, 'reports', 'latest.json');
const graders = require(path.join(root, 'dist-electron', 'agent-eval', 'graders.js'));
const verifier = require(path.join(root, 'dist-electron', 'agent-eval', 'verifier.js'));
const toolMetrics = require(path.join(root, 'dist-electron', 'agent-eval', 'tool-metrics.js'));
const processGates = require(path.join(root, 'dist-electron', 'agent-eval', 'process-gates.js'));
const mining = require(path.join(root, 'dist-electron', 'agent-eval', 'mining.js'));
const judge = require(path.join(root, 'dist-electron', 'agent-eval', 'judge.js'));
const reportSchema = require(path.join(root, 'dist-electron', 'agent-eval', 'report.js'));
const { toolSchemaHash } = require(path.join(root, 'dist-electron', 'agent-eval', 'regression.js'));
const { TOOL_DEFINITIONS } = require(path.join(root, 'dist-electron', 'tool-defs', 'index.js'));
const { projectAgentTraceFromSessionEvents } = require(path.join(root, 'dist-electron', 'agent-trace.js'));
const { llmClientInvoke } = require(path.join(root, 'dist-electron', 'agent-runtime', 'llm-provider.js'));
const { getDeepSeekBaseUrl } = require(path.join(root, 'dist-electron', 'api-config.js'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const onlyCase = args.find((a) => a.startsWith('--case='))?.slice('--case='.length);
/** 数据集目录（`evals/<dataset>/`）。默认 coding；memory 等维度用 `--dir=` 选。 */
const dataset = args.find((a) => a.startsWith('--dir='))?.slice('--dir='.length) ?? 'coding';
/** A/B 用：--out 指定报告路径，环境变量注入档位（fast/strong）+ 臂名。 */
const outPath = args.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? reportPath;
const arm = process.env.AURAXIS_EVAL_ARM || 'baseline';
const repeat = Math.max(1, Number(args.find((a) => a.startsWith('--repeat='))?.slice('--repeat='.length)) || 1);
const tiers = {
  fast: process.env.AURAXIS_EVAL_FAST_MODEL || '',
  strong: process.env.AURAXIS_EVAL_STRONG_MODEL || '',
  base: process.env.AURAXIS_EVAL_DEFAULT_MODEL || '',
};

function loadCases() {
  const dir = path.join(evalsDir, dataset);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((c) => !onlyCase || c.id === onlyCase);
}

/** 读取工作区文本快照（跳过 node_modules/.git）。 */
function snapshot(dir) {
  const files = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      // 应用自身的工作区产物（undo 快照等）不算 Agent 的改动。
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.name === '.auraxis-snapshots' || entry.name === '.auraxis') continue;
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else files[next.split(path.sep).join('/')] = fs.readFileSync(path.join(dir, next), 'utf8');
    }
  };
  walk('.');
  return files;
}

function runAgentInWorkspace(workdir, task, sessionLogDir) {
  const cli = path.join(root, 'dist-electron', 'main.js');
  const tracePath = path.join(path.dirname(sessionLogDir), 'trace.json');
  const toolProfile = process.env.AURAXIS_EVAL_TOOLS || '';
  // 无头 CLI 必须用 Electron 二进制 + ELECTRON_RUN_AS_NODE（与 npm run cli 一致）。
  const electronBin = require('electron');
  // 档位臂：把 fast/strong 写进该次运行的 settings（基线臂不写 = 行为不变）。
  if (tiers.fast || tiers.strong || tiers.base) {
    const settingsDir = path.dirname(sessionLogDir);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'auraxis-settings.json'),
      `${JSON.stringify({ ...(tiers.base ? { defaultModel: tiers.base } : {}), ...(tiers.fast ? { fastModel: tiers.fast } : {}), ...(tiers.strong ? { strongModel: tiers.strong } : {}) }, null, 2)}\n`,
      'utf8',
    );
  }
  // cwd 留在仓库根：沙箱脚本（electron/sandbox-windows.ps1）按 cwd/appPath 解析，
  // 任务真正作用的目录通过 --project 指定（仍受沙箱 workspace-write 约束）。
  // --sandbox full：评测衡量的是 Agent 的工具使用能力，不把「原生沙箱能否启动」算进分数；
  // 任务只在临时 fixture 副本里执行，用完即弃。
  const result = spawnSync(
    electronBin,
    [
      cli,
      '--run',
      task,
      '--project',
      workdir,
      '--sandbox',
      'full',
      '--auto-approve',
      '--verbose',
      ...(toolProfile ? [`--tools=${toolProfile}`] : []),
      '--trace-out',
      tracePath,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      env: {
        ...process.env,
        AURAXIS_USER_DATA_DIR: path.dirname(sessionLogDir),
        AURAXIS_SESSION_LOG_DIR: sessionLogDir,
        // 显式给出沙箱脚本绝对路径，避免依赖 cwd 解析。
        AURAXIS_SANDBOX_PS1: path.join(root, 'electron', 'sandbox-windows.ps1'),
        AURAXIS_APPCONTAINER_PS1: path.join(root, 'electron', 'sandbox-appcontainer.ps1'),
        // 无头 CLI 仍跑在真实 Electron 运行时里（ipcMain 等需要它）：必须清掉这个开关。
        ELECTRON_RUN_AS_NODE: undefined,
      },
    },
  );
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', tracePath };
}

/**
 * 语义判分器（LLM-as-judge）。判分器**不可用即判失败**（fail-closed）：
 * 用例既然声明了 answer_judge，拿不到结论就不能算过。
 * 设 AURAXIS_EVAL_JUDGE=0 可显式关闭（此时声明了语义检查的用例会判失败，而不是被静默忽略）。
 */
function makeJudgeInvoker() {
  if (process.env.AURAXIS_EVAL_JUDGE === '0') return undefined;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return undefined;
  const model = process.env.AURAXIS_EVAL_JUDGE_MODEL || process.env.AURAXIS_EVAL_DEFAULT_MODEL || 'deepseek-v4-flash';
  const apiBase = getDeepSeekBaseUrl();
  return async ({ system, user }) => {
    const result = await llmClientInvoke({
      model,
      apiKey,
      apiBase,
      systemPrompt: system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      temperature: 0,
      signal: new AbortController().signal,
    });
    return result?.rawText ?? null;
  };
}

/**
 * 跑一个用例里声明的全部语义检查。
 *
 * 回答文本取自无头 CLI 的 stdout（它把助手流式文本原样打到 stdout）。
 * 判分器不可用时逐条判失败 —— 声明了语义标准却"跳过"，等于把用例悄悄放宽。
 */
async function runJudgeChecks(judgeChecks, evalCase, stdout) {
  if (judgeChecks.length === 0) return [];
  const invoke = makeJudgeInvoker();
  const answer = stdout
    .split('\n')
    .filter((line) => !line.startsWith('['))
    .join('\n');
  const results = [];
  for (const check of judgeChecks) {
    const result = await judge.judgeAnswer({ task: evalCase.task, answer, rubric: check.rubric }, invoke);
    if (result.error) console.log(`  ⚠ ${check.id}: ${result.error}`);
    results.push(...judge.judgeCheckToResults(check, result));
  }
  return results;
}

/** 优先读取 CLI 导出的轨迹（--trace-out），拿不到再退回会话日志。 */
function readTrace(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 本次运行写下的会话事件流 → 轨迹（真实运行数据，不是重放报告）。 */
function traceFromSessionLog(sessionLogDir, meta) {
  try {
    const file = fs
      .readdirSync(sessionLogDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(sessionLogDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!file) return null;
    const events = fs
      .readFileSync(path.join(sessionLogDir, file.f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return projectAgentTraceFromSessionEvents(events, meta);
  } catch {
    return null;
  }
}

/** 失败挖掘：把没通过的运行固化成候选数据集（通过的运行不产出）。 */
function mineFailedCases(report) {
  if (report.mode === 'dry') {
    console.error('当前报告是 dry-run（没有真实模型运行），不产出候选用例。');
    process.exit(1);
  }
  const dir = path.join(evalsDir, 'candidates');
  fs.mkdirSync(dir, { recursive: true });
  let mined = 0;
  for (const c of report.cases) {
    if (c.passed) continue;
    const candidate = mining.mineCandidate({
      id: `${c.id}-mined`,
      task: c.task,
      category: c.category,
      checks: c.checksSpec ?? [],
      results: c.checks,
      changedFiles: c.changedFiles ?? [],
      trace: c.trace ?? null,
    });
    if (!candidate) continue;
    fs.writeFileSync(path.join(dir, `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    mined += 1;
  }
  console.log(`失败挖掘: 生成 ${mined} 个候选用例 → ${dir}`);
}

async function main() {
  const cases = loadCases();
  if (cases.length === 0) {
    console.error('没有匹配的评测用例');
    process.exit(1);
  }
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.AURAXIS_API_KEY;
  if (args.includes('--mine')) {
    if (!fs.existsSync(reportPath)) {
      console.error('还没有评测报告，先跑一次 eval:agent');
      process.exit(1);
    }
    mineFailedCases(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
    return;
  }
  if (!dryRun && !apiKey) {
    console.error('缺少 DEEPSEEK_API_KEY：真实评测无法运行（--dry 只做数据集与判分自检）。');
    process.exit(1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: dryRun ? 'dry' : 'live',
    cases: [],
    meta: {
      schemaVersion: reportSchema.EVAL_REPORT_SCHEMA_VERSION,
      // 内置工具 schema 的指纹：它一变，基线里的 token 数字就不再可比
      // （见 scripts/eval-diff.cjs --check-meta）。
      toolSchemaHash: toolSchemaHash([...TOOL_DEFINITIONS]),
      dataset,
      arm,
    },
  };
  for (const evalCase of cases) {
    for (let rep = 1; rep <= repeat; rep += 1) {
      const record = await runCase(evalCase, dryRun);
      report.cases.push({ ...record, rep });
      const mark = dryRun ? '·' : record.passed ? '✔' : '✘';
      console.log(
        `${mark} ${evalCase.id}${repeat > 1 ? ` #${rep}` : ''} — ${record.checks.filter((r) => r.passed).length}/${record.checks.length} checks`,
      );
      if (!dryRun && !record.agentExitOk) console.log(`  agent exit != 0: ${record.agentStderr.slice(0, 400)}`);
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  finishReport(report, dryRun);
}

/** 跑一个用例：fixture 副本 → 真实运行 → 目标判分 + 过程门槛 + 语义判分 + 验证器。 */
async function runCase(evalCase, dryRun) {
  const fixture = path.join(evalsDir, 'fixtures', evalCase.fixture);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `auraxis-eval-${evalCase.id}-`));
  fs.cpSync(fixture, workdir, { recursive: true });
  const before = snapshot(workdir);
  const sessionLogDir = path.join(os.tmpdir(), `auraxis-eval-${evalCase.id}-userdata`, 'session-logs');
  const run = dryRun
    ? { ok: true, stdout: '(dry-run：未调用模型)', stderr: '' }
    : runAgentInWorkspace(workdir, evalCase.task, sessionLogDir);
  const after = snapshot(workdir);
  // 目标断言与语义判分分开走：前者看工作区快照（同步、确定性），后者看**回答文本**
  // （异步、需要模型）。dry 模式没有真实回答，语义判分整体不参与（与过程门槛同一约定）。
  const structuralChecks = (evalCase.checks || []).filter((c) => !judge.isJudgeCheck(c));
  const judgeChecks = (evalCase.checks || []).filter((c) => judge.isJudgeCheck(c));
  const results = graders.runChecks(structuralChecks, { files: after, baseline: before });
  const trace = dryRun
    ? null
    : (readTrace(run.tracePath) ??
      traceFromSessionLog(sessionLogDir, { sessionId: evalCase.id, status: run.ok ? 'completed' : 'error' }));
  // 过程门槛：dry 模式没有轨迹，不参与判定（自检只看目标断言）。
  const processResults = dryRun ? [] : processGates.evaluateProcessGates(evalCase.process ?? {}, trace);
  const judgeResults = dryRun ? [] : await runJudgeChecks(judgeChecks, evalCase, run.stdout);
  const allResults = [...results, ...processResults, ...judgeResults];
  const verification = verifier.verifyTask(allResults, trace);
  const metrics = trace ? toolMetrics.computeToolMetrics(trace, evalCase.tools ?? {}) : null;
  const changedFiles = Object.keys(after).filter((p) => after[p] !== before[p]);
  // CLI 会打印 `[运行] model=… difficulty=… route=…`，记进报告以便对比路由效果。
  const routeMatch = /\[运行\] model=(\S+) difficulty=(\S+) route=(\S+)/.exec(run.stderr || '');
  // verbose 会打印 `[用量] in=… out=… cacheHit=… cacheMiss=…`：真实 token 成本，供 A/B 对比。
  const usage = [...(run.stderr || '').matchAll(/\[用量\] in=(\d+) out=(\d+)/g)].pop();
  // `[工具集] n=… hash=…`：注入了多少工具、工具表指纹（P1 起用于对比动态装载的效果）。
  const toolSet = [...(run.stderr || '').matchAll(/\[工具集\] n=(\d+) hash=(\S+)/g)].pop();

  return {
    id: evalCase.id,
    category: evalCase.category,
    task: evalCase.task,
    passed: !dryRun && graders.taskPassed(allResults),
    score: dryRun ? null : graders.scoreOf(allResults),
    checks: allResults,
    checksSpec: evalCase.checks,
    processGates: evalCase.process ?? null,
    tools: evalCase.tools ?? null,
    toolMetrics: metrics,
    verification,
    changedFiles,
    trace,
    traceUnavailable: !dryRun && !trace ? '缺少运行轨迹（--trace-out 未产出）' : null,
    agentExitOk: run.ok,
    routedModel: routeMatch ? routeMatch[1] : null,
    difficulty: routeMatch ? routeMatch[2] : null,
    routeReason: routeMatch ? routeMatch[3] : null,
    agentStderr: run.stderr.slice(-2000),
    arm,
    tokensIn: usage ? Number(usage[1]) : null,
    tokensOut: usage ? Number(usage[2]) : null,
    toolCount: toolSet ? Number(toolSet[1]) : null,
    toolTableHash: toolSet ? toolSet[2] : null,
  };
}

function finishReport(report, dryRun) {
  const passed = report.cases.filter((c) => c.passed).length;
  if (dryRun) {
    // dry 模式只证明「数据集可加载 + grader 有判别力（未修改的 fixture 应当判失败）」。
    const checks = report.cases.reduce((n, c) => n + c.checks.length, 0);
    console.log(`\n数据集自检: ${report.cases.length} 个用例 / ${checks} 项检查可加载 → ${outPath}`);
    return;
  }
  console.log(`\n回归结果: ${passed}/${report.cases.length} 通过 → ${outPath}`);
  if (!dryRun && passed < report.cases.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
