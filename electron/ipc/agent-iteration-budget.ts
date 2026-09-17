/**
 * agent-iteration-budget.ts — 单个 Agent 任务的迭代预算解析。
 *
 * 解析顺序：请求显式值 → 设置里的 agentMaxIterations → 默认 200。
 * 收敛区间固定为 [1, BUSINESS_ITERATION_MAX]，与 agent-loop-driver 的
 * fail-safe 硬上限保持一致，避免"设置了 1000 却永远到不了 500"的误导。
 */

/** 未配置时的业务迭代上限。 */
export const BUSINESS_ITERATION_DEFAULT = 200;

/** 业务迭代上限的准许最大值（同时是循环的 fail-safe 硬上限）。 */
export const BUSINESS_ITERATION_MAX = 500;

function coerce(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
}

/** 把任意候选值收敛到业务允许区间；非法值返回 null。 */
export function boundIterationBudget(value: unknown): number | null {
  const n = coerce(value);
  if (n === null) return null;
  return Math.min(BUSINESS_ITERATION_MAX, Math.max(1, n));
}

/**
 * 解析本轮任务的迭代预算：请求 > 设置 > 默认。
 *
 * 渲染层不再自带默认值，避免它把设置面板里配置的预算覆盖掉。
 */
export function resolveIterationBudget(requested: unknown, settings?: Record<string, unknown> | null): number {
  return (
    boundIterationBudget(requested) ?? boundIterationBudget(settings?.agentMaxIterations) ?? BUSINESS_ITERATION_DEFAULT
  );
}

/**
 * 判断一条错误文本是否来自"业务迭代上限"的优雅收尾。
 *
 * 两条执行路径（agent-loop-driver / query-engine）都会带上"迭代上限"，
 * 渲染层据此把提示升级为可一键续跑的操作。
 */
export function isBusinessIterationLimitMessage(text: string | undefined | null): boolean {
  if (typeof text !== 'string' || !text) return false;
  return text.includes('迭代上限');
}
