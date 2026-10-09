/**
 * tool-metrics.ts — 工具使用质量指标（选择正确性 / 参数完整度 / 无用调用 / 是否验证）。
 * 数据全部来自真实轨迹；没有期望值时不瞎打分。
 */
import type { AgentTraceRun } from '../contracts/agent-trace';

export interface ToolExpectation {
  /** 期望用到的工具（缺失即扣分）。 */
  expect?: string[];
  /** 不该出现的工具（出现即判失败）。 */
  forbid?: string[];
  /** 指定工具必须具备的参数键（参数准确率）。 */
  requireArgs?: Record<string, string[]>;
}

export interface ToolMetrics {
  /** 期望工具命中率 0~1；无期望时为 null。 */
  selection: number | null;
  /** 参数完整率 0~1；无要求时为 null。 */
  argumentAccuracy: number | null;
  /** 期望之外的工具调用次数（无期望时为 null）。 */
  unnecessaryCalls: number | null;
  /** 是否在最后一次修改之后执行过验证命令。 */
  verifiedAfterEdit: boolean;
  failedToolCalls: number;
  repeatedToolRuns: number;
}

const MUTATING = new Set(['Write', 'Edit', 'NotebookEdit', 'StrReplaceEditor', 'Delete']);
const VERIFYING = new Set(['Bash', 'Pwsh', 'ReviewArtifact']);

export function computeToolMetrics(trace: AgentTraceRun, expectation: ToolExpectation = {}): ToolMetrics {
  const used = trace.toolCalls.map((c) => c.name);
  const usedSet = new Set(used);
  const forbidden = (expectation.forbid ?? []).filter((n) => usedSet.has(n));

  let selection: number | null = null;
  if (expectation.expect?.length) {
    const hit = expectation.expect.filter((n) => usedSet.has(n)).length;
    selection = forbidden.length > 0 ? 0 : hit / expectation.expect.length;
  }

  let argumentAccuracy: number | null = null;
  const requireArgs = Object.entries(expectation.requireArgs ?? {});
  if (requireArgs.length > 0) {
    const checked = requireArgs.flatMap(([tool, keys]) =>
      trace.toolCalls.filter((c) => c.name === tool).map((c) => keys.every((k) => c.input?.[k] !== undefined)),
    );
    argumentAccuracy = checked.length === 0 ? 0 : checked.filter(Boolean).length / checked.length;
  }

  const unnecessaryCalls = expectation.expect
    ? used.filter((n) => !expectation.expect!.includes(n) && !VERIFYING.has(n)).length
    : null;

  // 按调用顺序判定：轨迹里多个事件常常落在同一毫秒，比时间戳会误判。
  const lastEditIndex = trace.toolCalls.reduce(
    (acc, call, i) => (MUTATING.has(call.name) && call.status === 'done' ? i : acc),
    -1,
  );
  const verifiedAfterEdit =
    lastEditIndex >= 0 &&
    trace.toolCalls.some((c, i) => i > lastEditIndex && VERIFYING.has(c.name) && c.status === 'done');

  return {
    selection,
    argumentAccuracy,
    unnecessaryCalls,
    verifiedAfterEdit,
    failedToolCalls: trace.stats.failedToolCalls,
    repeatedToolRuns: trace.stats.repeatedToolRuns,
  };
}
