/**
 * regression.ts — 基线 vs 本次的逐用例对比（纯函数）。
 *
 * 存在的理由很具体：评测**能跑但不能比较** —— 报告写出来了，`baseline.json` 也在，
 * 但没有任何代码读它。于是"改了工具装载 / 路由 / 循环之后有没有变差"只能靠人眼看 JSON，
 * 而人眼不会盯着 137k → 62k 这种数字看。
 *
 * 三条设计原则：
 *   1. **宁可漏报，不可误报**：只有确定的变化才算回归（`check_flipped` 这类是逐项比对的
 *      硬事实；token 只比总量且要超过阈值）。
 *   2. **重复采样不当回归**：`--repeat=3` 的报告里同一用例有 3 条记录，比较时取**最差**那次
 *      （保守），避免把抖动当成退步。
 *   3. 只做判定，不写文件、不退出进程（那些是 `scripts/eval-diff.cjs` 的事）。
 */
import { createHash } from 'node:crypto';
import { sumTokensIn, type EvalCaseRecord, type EvalReport } from './report';

/** 过程门槛在报告里就是普通检查项，靠 id 前缀区分（`graders.EvalCheckResult` 没有 source 字段）。 */
const PROCESS_CHECK_PREFIX = 'process:';

export type RegressionKind =
  /** 原本通过的用例现在没过。 */
  | 'case_failed'
  /** 用例整体还过，但某一项检查翻了（更细的定位）。 */
  | 'check_flipped'
  /** 通过数下降（用例被改名/删除后仍能发现整体退步）。 */
  | 'pass_count_dropped'
  /** 输入 token 总量涨幅超过阈值。 */
  | 'tokens_increased'
  /** 任务级验证从 verified 掉到 partial/unverified。 */
  | 'verification_downgraded'
  /** 过程门槛某项翻了。 */
  | 'process_gate_flipped'
  /** 基线里有、本次没有的用例（删用例不该悄悄发生）。 */
  | 'case_missing';

export interface RegressionFinding {
  kind: RegressionKind;
  caseId: string;
  detail: string;
}

export interface DiffOptions {
  /** 输入 token 总量允许的涨幅（默认 25%）。低于它视为噪声，不报。 */
  maxTokenIncreaseRatio?: number;
  /** 允许本次新增基线里没有的用例（默认为"允许"—— 新增用例是好事，但要能看见）。 */
  allowNewCases?: boolean;
}

export interface DiffResult {
  regressions: RegressionFinding[];
  /** 变好的（通过数上升、token 下降、缺失用例被补回）。 */
  improvements: RegressionFinding[];
  /** 新增的用例 id（既不算回归也不算改进，单独列出让人看见）。 */
  newCases: string[];
  /** token 是否真的比过（指纹缺失/不一致时跳过，见下）。 */
  tokensCompared: boolean;
  /** 跳过 token 对比的原因（要打印出来，别让人以为"没报=没涨"）。 */
  tokensSkippedReason?: string;
  matches: { passed: number; total: number; tokensIn: number; tokensInCommon: number };
  baseline: { passed: number; total: number; tokensIn: number; tokensInCommon: number };
}

/** 给定用例集合上的输入 token 之和（只数有值的）。 */
function sumOver(report: EvalReport, ids: readonly string[]): number {
  const want = new Set(ids);
  return report.cases.reduce((n, c) => (want.has(c.id) && typeof c.tokensIn === 'number' ? n + c.tokensIn : n), 0);
}

/** 同一用例的多次采样取**最差**（保守：抖动的下限才算它的真实水平）。 */
function worstByCase(cases: readonly EvalCaseRecord[]): Map<string, EvalCaseRecord> {
  const worst = new Map<string, EvalCaseRecord>();
  for (const c of cases) {
    const prev = worst.get(c.id);
    if (!prev) {
      worst.set(c.id, c);
      continue;
    }
    const better = (a: EvalCaseRecord, b: EvalCaseRecord) =>
      Number(a.passed) > Number(b.passed) || (a.passed === b.passed && (a.score ?? 0) > (b.score ?? 0));
    if (better(prev, c)) worst.set(c.id, c);
  }
  return worst;
}

/** 逐项检查的通过情况（按检查 id 索引；同 id 多条时取最差）。 */
function checkMap(c: EvalCaseRecord): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const check of c.checks ?? []) {
    const key = String(check.id);
    map.set(key, (map.get(key) ?? true) && check.passed === true);
  }
  return map;
}

const VERIFY_RANK: Record<string, number> = { verified: 3, partial: 2, unverified: 1, regressed: 0 };

/**
 * 比较两份报告。
 *
 * `baseline` 与 `current` 的 schemaVersion 不同时直接抛错 —— 字段语义变了就没法逐项比，
 * 静默给一个"没有回归"的假安全感比报错更糟。
 */
export function diffReports(baseline: EvalReport, current: EvalReport, opts: DiffOptions = {}): DiffResult {
  const maxTokenIncreaseRatio = opts.maxTokenIncreaseRatio ?? 0.25;
  assertComparable(baseline, current);

  const base = worstByCase(baseline.cases);
  const now = worstByCase(current.cases);
  const regressions: RegressionFinding[] = [];
  const improvements: RegressionFinding[] = [];

  // 逐用例：整例退步 / 单项检查翻 / 验证等级变化（过程门槛单列一类）。
  for (const [id, b] of base) {
    const c = now.get(id);
    if (!c) {
      regressions.push({ kind: 'case_missing', caseId: id, detail: '基线里有这个用例，本次报告里没有' });
      continue;
    }
    const verdict = compareCase(b, c);
    regressions.push(...verdict.regressions);
    improvements.push(...verdict.improvements);
  }

  const counts = compareAggregates(baseline, current, base, now, maxTokenIncreaseRatio);
  regressions.push(...counts.regressions);
  improvements.push(...counts.improvements);

  const newCases = [...now.keys()].filter((id) => !base.has(id));
  // 默认**允许**新增（新增用例是好事）；`--no-new-cases` 时把它当回归，用于"用例集被冻结"的场景。
  if ((opts.allowNewCases ?? true) === false && newCases.length > 0) {
    for (const id of newCases) {
      regressions.push({ kind: 'case_missing', caseId: id, detail: '本次报告里有基线没有的用例' });
    }
  }

  return {
    regressions,
    improvements,
    newCases,
    tokensCompared: counts.tokensCompared,
    ...(counts.tokensSkippedReason ? { tokensSkippedReason: counts.tokensSkippedReason } : {}),
    // `tokensIn` 报**全量**和（人看的数字），判定用的是共同用例上的和（见 compareAggregates）。
    matches: {
      passed: current.cases.filter((c) => c.passed).length,
      total: current.cases.length,
      tokensIn: sumTokensIn(current),
      tokensInCommon: counts.cTokens,
    },
    baseline: {
      passed: baseline.cases.filter((c) => c.passed).length,
      total: baseline.cases.length,
      tokensIn: sumTokensIn(baseline),
      tokensInCommon: counts.bTokens,
    },
  };
}

/** 两份报告能不能比。跨版本/跨模式的比较只会产出垃圾，所以直接拒绝，不给"没有回归"的假安全感。 */
function assertComparable(baseline: EvalReport, current: EvalReport): void {
  if (baseline.meta?.schemaVersion !== current.meta?.schemaVersion) {
    throw new Error(
      `报告 schemaVersion 不一致（基线 ${baseline.meta?.schemaVersion} / 本次 ${current.meta?.schemaVersion}）：` +
        '先重跑基线再比较，不要跨版本对比。',
    );
  }
  // dry 报告里每个用例都是 passed=false（它只证明"数据集可加载 + grader 有判别力"），
  // 拿去和 live 基线比会得到 100% 的假回归。这不是"更严格"，这是垃圾进垃圾出。
  if (baseline.mode !== current.mode) {
    throw new Error(
      `报告模式不一致（基线 ${baseline.mode} / 本次 ${current.mode}）：` +
        'dry 报告不能与 live 基线比较 —— 请用 npm run eval:agent 跑一次真实评测。',
    );
  }
}

/** 单个用例的逐项对比。 */
function compareCase(
  b: EvalCaseRecord,
  c: EvalCaseRecord,
): { regressions: RegressionFinding[]; improvements: RegressionFinding[] } {
  const regressions: RegressionFinding[] = [];
  const improvements: RegressionFinding[] = [];
  const id = c.id;

  if (b.passed && !c.passed) {
    regressions.push({ kind: 'case_failed', caseId: id, detail: `原本通过，现在 ${c.score ?? 0} 分` });
  } else if (!b.passed && c.passed) {
    improvements.push({ kind: 'case_failed', caseId: id, detail: '原本没过，现在过了' });
  }

  // 逐项检查：过程门槛单列一类（门槛翻 = 行为变了，目标断言翻 = 结果变了，triage 时不是一回事）。
  const bChecks = checkMap(b);
  for (const [checkId, passed] of checkMap(c)) {
    if (bChecks.get(checkId) === undefined || bChecks.get(checkId) === passed) continue;
    const kind: RegressionKind = checkId.startsWith(PROCESS_CHECK_PREFIX) ? 'process_gate_flipped' : 'check_flipped';
    const verb = passed ? '从不过翻成通过' : '从通过翻成不通过';
    (passed ? improvements : regressions).push({ kind, caseId: id, detail: `检查 ${checkId} ${verb}` });
  }

  const bRank = VERIFY_RANK[b.verification?.status ?? 'unverified'] ?? 1;
  const cRank = VERIFY_RANK[c.verification?.status ?? 'unverified'] ?? 1;
  if (bRank !== cRank) {
    const detail = `${b.verification?.status} → ${c.verification?.status}`;
    (cRank < bRank ? regressions : improvements).push({ kind: 'verification_downgraded', caseId: id, detail });
  }
  return { regressions, improvements };
}

/** 报告级对比：通过数、共同用例上的 token 和。 */
function compareAggregates(
  baseline: EvalReport,
  current: EvalReport,
  base: Map<string, EvalCaseRecord>,
  now: Map<string, EvalCaseRecord>,
  maxTokenIncreaseRatio: number,
): {
  regressions: RegressionFinding[];
  improvements: RegressionFinding[];
  bTokens: number;
  cTokens: number;
  tokensCompared: boolean;
  tokensSkippedReason?: string;
} {
  const regressions: RegressionFinding[] = [];
  const improvements: RegressionFinding[] = [];

  const bPassed = baseline.cases.filter((c) => c.passed).length;
  const cPassed = current.cases.filter((c) => c.passed).length;
  if (bPassed !== cPassed) {
    const kind: RegressionKind = 'pass_count_dropped';
    const detail = `通过数 ${bPassed} → ${cPassed}`;
    (cPassed < bPassed ? regressions : improvements).push({ kind, caseId: '*', detail });
  }

  // token 只比**共同用例**上的和：新增用例会让总和自然上涨，那不是回归。
  // （跨不同数据集的报告本来就不该比 —— 那时交集为空，直接跳过。）
  const common = [...base.keys()].filter((id) => now.has(id));
  const bTokens = sumOver(baseline, common);
  const cTokens = sumOver(current, common);
  // 工具 schema 是缓存前缀的一部分：两边的指纹必须**记录过且一致**，token 才可比。
  // 否则比较的是"不同请求前缀下的输入量"，涨跌都没有意义 —— 宁可不报，也不给假信号。
  const bHash = baseline.meta?.toolSchemaHash;
  const cHash = current.meta?.toolSchemaHash;
  const tokensCompared = Boolean(bHash) && bHash === cHash;
  const tokensSkippedReason = tokensCompared
    ? undefined
    : !bHash
      ? '基线未记录工具 schema 指纹（下一次 live 运行请刷新基线）'
      : `工具 schema 已变（${bHash} → ${cHash}），token 不可比`;

  if (tokensCompared && bTokens > 0 && cTokens !== bTokens) {
    if (cTokens > bTokens * (1 + maxTokenIncreaseRatio)) {
      const pct = Math.round(maxTokenIncreaseRatio * 100);
      regressions.push({
        kind: 'tokens_increased',
        caseId: '*',
        detail: `输入 token ${bTokens} → ${cTokens}（超过 ${pct}% 阈值）`,
      });
    } else if (cTokens < bTokens) {
      improvements.push({ kind: 'tokens_increased', caseId: '*', detail: `输入 token ${bTokens} → ${cTokens}` });
    }
  }
  return {
    regressions,
    improvements,
    bTokens,
    cTokens,
    tokensCompared,
    ...(tokensSkippedReason ? { tokensSkippedReason } : {}),
  };
}

/**
 * 内置工具 schema 的指纹。
 *
 * 工具 schema 是**缓存前缀的一部分**（见 `context-manager.ts` 的硬约束），所以它一变，
 * 基线里的 token 数字就不再可比。指纹只取会进请求的三样：名字、描述、input_schema，
 * 且按给定顺序（顺序也进前缀）。
 */
export function toolSchemaHash(
  defs: readonly { name: string; description?: string; input_schema?: unknown }[],
): string {
  const canonical = defs.map((d) => JSON.stringify([d.name, d.description ?? '', d.input_schema ?? null])).join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
