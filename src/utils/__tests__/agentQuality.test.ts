import { describe, it, expect } from 'vitest';
import { collectQualityRuns, findLatestFailure, deriveNextSteps } from '../agentQuality';
import type { AgentLogEntry } from '@/types/agent';

function reviewEnd(timestamp: number, passed: boolean, checkType = 'build', error?: string): AgentLogEntry {
  return {
    type: 'tool_end',
    timestamp,
    toolName: 'ReviewArtifact',
    input: { check_type: checkType },
    output: {
      passed,
      check_type: checkType,
      command: `npm run ${checkType}`,
      error,
      output: error ? `stderr: ${error}` : 'ok',
      exitCode: passed ? 0 : 1,
    },
    durationMs: 1200,
  };
}

function toolError(timestamp: number, toolName: string, error: string): AgentLogEntry {
  return { type: 'tool_error', timestamp, toolName, error };
}

describe('collectQualityRuns — 质量门结果收集', () => {
  it('collects ReviewArtifact runs newest first with pass/fail', () => {
    const runs = collectQualityRuns([
      reviewEnd(1, false, 'build', 'TS error'),
      reviewEnd(2, true, 'lint'),
      reviewEnd(3, false, 'test', '1 failed'),
    ]);
    expect(runs.map((r) => r.checkType)).toEqual(['test', 'lint', 'build']);
    expect(runs[0].passed).toBe(false);
    expect(runs[0].error).toBe('1 failed');
    expect(runs[1].passed).toBe(true);
    expect(runs[2].command).toBe('npm run build');
  });

  it('includes tool_error runs and caps at the limit', () => {
    const entries: AgentLogEntry[] = [];
    for (let i = 0; i < 8; i += 1) entries.push(reviewEnd(i + 1, true, `lint${i}`));
    entries.push({ type: 'tool_error', timestamp: 99, toolName: 'ReviewArtifact', error: 'spawn failed' });
    const runs = collectQualityRuns(entries, 4);
    expect(runs).toHaveLength(4);
    expect(runs[0].passed).toBe(false);
    expect(runs[0].checkType).toBe('review');
    expect(runs[0].error).toBe('spawn failed');
  });
});

describe('findLatestFailure — 最新可修复问题', () => {
  it('returns the latest failed gate even after earlier passes', () => {
    const f = findLatestFailure([reviewEnd(1, true, 'build'), reviewEnd(2, false, 'test', '2 failed')]);
    expect(f?.title).toBe('test 审查未通过');
    expect(f?.detail).toContain('2 failed');
  });

  it('returns null when the latest gate passed', () => {
    const f = findLatestFailure([reviewEnd(1, false, 'build', 'old error'), reviewEnd(2, true, 'build')]);
    expect(f).toBeNull();
  });

  it('prefers a tool error after the last review result', () => {
    const f = findLatestFailure([reviewEnd(1, true, 'build'), toolError(2, 'Bash', 'exit code 1')]);
    expect(f?.title).toBe('Bash 执行失败');
    expect(f?.detail).toBe('exit code 1');
  });

  it('falls back to the agent error when the log has no failures', () => {
    const f = findLatestFailure([{ type: 'text', timestamp: 1, text: 'hello' }], '任务超时');
    expect(f?.title).toBe('任务失败');
    expect(f?.detail).toBe('任务超时');
  });
});

describe('deriveNextSteps — 规则式下一步建议', () => {
  it('suggests continuing remaining plan steps when clean', () => {
    const steps = deriveNextSteps({ latestFailure: null, pendingTodos: 3, diffCount: 0, hasQualityRuns: true });
    expect(steps.map((s) => s.kind)).toEqual(['composer']);
    expect(steps[0].label).toContain('3 个计划步骤');
  });

  it('suggests reviewing diffs when changes are unmerged', () => {
    const steps = deriveNextSteps({ latestFailure: null, pendingTodos: 0, diffCount: 5, hasQualityRuns: true });
    expect(steps).toEqual([{ kind: 'view', label: '审查变更（5 个文件）', view: 'diff' }]);
  });

  it('omits the failed-review fix (quality card owns it) and still flags diffs', () => {
    const failure = { title: 'build 审查未通过', detail: 'TS error', timestamp: 1 };
    const steps = deriveNextSteps({ latestFailure: failure, pendingTodos: 2, diffCount: 4, hasQualityRuns: true });
    expect(steps.some((s) => s.prompt?.includes('修复'))).toBe(false);
    expect(steps.some((s) => s.kind === 'view')).toBe(true);
  });

  it('suggests a full verification run when nothing else is actionable', () => {
    const steps = deriveNextSteps({ latestFailure: null, pendingTodos: 0, diffCount: 0, hasQualityRuns: false });
    expect(steps[0].label).toBe('运行完整验证');
    expect(steps).toHaveLength(1);
  });
});
