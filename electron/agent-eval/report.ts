/**
 * report.ts — 评测报告的结构（**单一来源**）。
 *
 * 这份结构原先只活在 `scripts/agent-eval.cjs` 的对象字面量里，"报告里有什么字段"
 * 只能靠读那个脚本。现在有两条独立的消费者：
 *   · `scripts/agent-eval.cjs` 写报告；
 *   · `scripts/eval-diff.cjs` + `regression.ts` 读报告做回归判定。
 * 两边各写一份类型必然会漂移，所以在这里定一次。
 *
 * 只放**结构**，不放判定逻辑（判定在 `regression.ts`，纯函数、可单测）。
 */
import type { EvalCheckResult } from './graders';
import type { ToolMetrics } from './tool-metrics';
import type { TaskVerification } from './verifier';
import type { AgentTraceRun } from '../contracts/agent-trace';

/** 报告格式版本：字段语义变了就 bump，diff 脚本据此拒绝跨版本的比较。 */
export const EVAL_REPORT_SCHEMA_VERSION = 1;

export interface EvalCaseRecord {
  id: string;
  category: string;
  task: string;
  passed: boolean;
  /** 通过率（0~1）；dry 模式没有判定，为 null。 */
  score: number | null;
  checks: EvalCheckResult[];
  checksSpec: unknown;
  processGates: unknown;
  tools: unknown;
  toolMetrics: ToolMetrics | null;
  verification: TaskVerification;
  changedFiles: string[];
  trace: AgentTraceRun | null;
  traceUnavailable: string | null;
  agentExitOk: boolean;
  routedModel: string | null;
  difficulty: string | null;
  routeReason: string | null;
  agentStderr: string;
  /** 臂名（baseline / fast / strong / …），A/B 对比靠它区分。 */
  arm: string;
  /** 第几次重复采样（`--repeat`）；单次运行为 1。 */
  rep?: number;
  tokensIn: number | null;
  tokensOut: number | null;
  /** 本次实际注入的工具数量与工具表指纹（无头 CLI 打印，见 `[工具集]`）。 */
  toolCount?: number | null;
  toolTableHash?: string | null;
}

export interface EvalReport {
  generatedAt: string;
  mode: 'dry' | 'live';
  cases: EvalCaseRecord[];
  meta: {
    schemaVersion: number;
    /** 本机内置工具 schema 的指纹；与基线不一致 ⇒ token 数字不可比（见 eval-diff --check-meta）。 */
    toolSchemaHash?: string;
    /** 数据集目录名（coding / memory / …）。 */
    dataset?: string;
    arm?: string;
  };
}

/** 通过数与总数（报告层面的唯一口径；对比只用这两个数 + sum(tokensIn)）。 */
export function passRate(report: Pick<EvalReport, 'cases'>): { passed: number; total: number } {
  return { passed: report.cases.filter((c) => c.passed).length, total: report.cases.length };
}

/** 输入 token 之和（跳过 null：dry 模式与轨迹缺失的用例不算 0）。 */
export function sumTokensIn(report: Pick<EvalReport, 'cases'>): number {
  return report.cases.reduce((n, c) => n + (typeof c.tokensIn === 'number' ? c.tokensIn : 0), 0);
}

/**
 * 基线里**不该**存的东西：轨迹、agent stderr、临时目录绝对路径。
 *
 * 理由不是"小一点"：基线要进版本控制、要在别人的机器与 CI 上被读。而报告里的
 * `trace` 与 `changedFiles` 带的是**本次运行的临时 fixture 路径**
 * （`…\Temp\auraxis-eval-coding-001-timeout-<随机>\src\config.ts`）—— 提交它等于把
 * 某台机器的目录结构写进仓库，且 CI 上生成的报告永远长得不一样。
 *
 * 门禁真正读的字段（passed / score / checks / verification / tokensIn）一个不少。
 */
export function projectForBaseline(report: EvalReport): EvalReport {
  return {
    ...report,
    cases: report.cases.map((c) => ({
      ...c,
      trace: null,
      traceUnavailable: c.traceUnavailable ? '（基线不保留轨迹）' : null,
      agentStderr: '',
      changedFiles: c.changedFiles.map((p) => relativizeEvalPath(p, c.id)),
    })),
  };
}

/**
 * 把临时 fixture 绝对路径折回**用例内相对路径**。
 *
 * 运行时每个用例被拷进 `auraxis-eval-<caseId>-<随机>/`，所以可辨认的那一段是
 * 用例目录之后的部分。认得出来就用它，认不出来就退回 basename（宁可少信息，
 * 也不把机器路径带进仓库）。
 */
export function relativizeEvalPath(p: string, caseId: string): string {
  const marker = `auraxis-eval-${caseId}-`;
  const at = p.indexOf(marker);
  if (at < 0) return p.split(/[/\\]/).pop() || p;
  const after = p.slice(at + marker.length);
  const slash = after.search(/[/\\]/);
  // 统一成 `/`：基线在 Windows 上冻结、在 Linux CI 上读，分隔符不该随之变化。
  return (slash < 0 ? after : after.slice(slash + 1)).replace(/\\/g, '/');
}
