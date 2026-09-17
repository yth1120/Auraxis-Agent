import { describe, expect, it } from 'vitest';
import {
  BUSINESS_ITERATION_DEFAULT,
  BUSINESS_ITERATION_MAX,
  boundIterationBudget,
  isBusinessIterationLimitMessage,
  resolveIterationBudget,
} from '../agent-iteration-budget';

describe('agent iteration budget', () => {
  it('falls back to the default when neither request nor settings specify a budget', () => {
    expect(resolveIterationBudget(undefined, null)).toBe(BUSINESS_ITERATION_DEFAULT);
    expect(resolveIterationBudget(undefined, {})).toBe(BUSINESS_ITERATION_DEFAULT);
  });

  it('honors the settings panel value when the request omits one', () => {
    // 这条就是"设置面板被渲染层 200 覆盖"的真 bug 回归位。
    expect(resolveIterationBudget(undefined, { agentMaxIterations: 50 })).toBe(50);
    expect(resolveIterationBudget(null, { agentMaxIterations: 320 })).toBe(320);
  });

  it('lets an explicit request value win over settings', () => {
    expect(resolveIterationBudget(7, { agentMaxIterations: 400 })).toBe(7);
  });

  it('clamps to the 1..500 business range and ignores invalid values', () => {
    expect(boundIterationBudget(0)).toBeNull();
    expect(boundIterationBudget(-5)).toBeNull();
    expect(boundIterationBudget(Number.NaN)).toBeNull();
    expect(boundIterationBudget('50')).toBeNull();
    expect(boundIterationBudget(12.9)).toBe(12);
    expect(boundIterationBudget(9_000)).toBe(BUSINESS_ITERATION_MAX);
    expect(resolveIterationBudget(undefined, { agentMaxIterations: 9_000 })).toBe(BUSINESS_ITERATION_MAX);
    expect(resolveIterationBudget(undefined, { agentMaxIterations: 0 })).toBe(BUSINESS_ITERATION_DEFAULT);
  });

  it('detects the graceful business-limit message from both execution paths', () => {
    expect(
      isBusinessIterationLimitMessage(
        '已达到业务迭代上限 (3)，任务暂停收尾。已完成 6 次工具调用，如需继续可发送跟进任务。',
      ),
    ).toBe(true);
    expect(isBusinessIterationLimitMessage('已达到业务迭代上限 50 次，任务暂停收尾。已完成 120 次工具调用。')).toBe(
      true,
    );
    expect(isBusinessIterationLimitMessage('达到安全硬上限 500 次迭代，强制终止。')).toBe(false);
    expect(isBusinessIterationLimitMessage(undefined)).toBe(false);
    expect(isBusinessIterationLimitMessage('')).toBe(false);
  });
});
