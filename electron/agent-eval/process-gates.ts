/**
 * process-gates.ts — 过程门槛：结果对不代表过程合格。
 *
 * 数据来自真实轨迹（agent-eval 的 trace）。没有任何门槛时返回空数组；
 * 声明了门槛但没有轨迹 → 直接判失败（不能用"看不见"冒充"通过了"）。
 */
import type { AgentTraceRun } from '../contracts/agent-trace';
import type { EvalCheckResult } from './graders';
import { computeToolMetrics } from './tool-metrics';

export interface ProcessGates {
  /** 允许的工具调用失败次数上限。 */
  maxFailedToolCalls?: number;
  /** 允许的迭代（回合）上限。 */
  maxIterations?: number;
  /** 要求「最后一次修改之后执行过成功的验证命令」。 */
  requireVerifiedAfterEdit?: boolean;
}

export function evaluateProcessGates(gates: ProcessGates, trace: AgentTraceRun | null): EvalCheckResult[] {
  const declared = Object.keys(gates).length > 0;
  if (!declared) return [];
  if (!trace) {
    return [
      {
        id: 'process:trace',
        passed: false,
        detail: '声明了过程门槛但缺少运行轨迹（--trace-out 未产出）',
      },
    ];
  }

  const results: EvalCheckResult[] = [];
  if (gates.maxFailedToolCalls !== undefined) {
    const failed = trace.stats.failedToolCalls;
    results.push({
      id: 'process:failed-tools',
      passed: failed <= gates.maxFailedToolCalls,
      detail: `工具失败 ${failed} 次（上限 ${gates.maxFailedToolCalls}）`,
    });
  }
  if (gates.maxIterations !== undefined) {
    const iterations = trace.stats.iterations;
    results.push({
      id: 'process:iterations',
      passed: iterations <= gates.maxIterations,
      detail: `迭代 ${iterations}（上限 ${gates.maxIterations}）`,
    });
  }
  if (gates.requireVerifiedAfterEdit) {
    const verified = computeToolMetrics(trace).verifiedAfterEdit;
    results.push({
      id: 'process:verified-after-edit',
      passed: verified,
      detail: verified ? 'ok' : '最后一次修改之后没有成功的验证命令',
    });
  }
  return results;
}
