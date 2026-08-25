import type { AgentLogEntry } from '@/types/agent';

export interface QualityRun {
  checkType: string;
  passed: boolean;
  command?: string;
  durationMs?: number;
  error?: string;
  output?: string;
  exitCode?: number;
  timestamp: number;
}

export interface TaskFailure {
  title: string;
  detail: string;
  timestamp: number;
}

export interface NextStep {
  kind: 'composer' | 'view';
  label: string;
  prompt?: string;
  view?: 'diff';
}

/**
 * Rule-based next actions for a settled agent. The failed-review fix is
 * intentionally omitted here — the 质量门 card already carries that button —
 * so the suggestions cover what's not already visible one click away.
 */
export function deriveNextSteps(opts: {
  latestFailure: TaskFailure | null;
  pendingTodos: number;
  diffCount: number;
  hasQualityRuns: boolean;
}): NextStep[] {
  const steps: NextStep[] = [];
  if (opts.pendingTodos > 0) {
    steps.push({
      kind: 'composer',
      label: `继续完成剩余 ${opts.pendingTodos} 个计划步骤`,
      prompt:
        '请继续完成计划中尚未完成（in_progress / pending）的步骤，每完成一步更新计划状态，全部完成后运行 ReviewArtifact 验证。',
    });
  }
  if (opts.diffCount > 0) {
    steps.push({ kind: 'view', label: `审查变更（${opts.diffCount} 个文件）`, view: 'diff' });
  }
  if (!opts.latestFailure && opts.pendingTodos === 0 && opts.diffCount === 0 && !opts.hasQualityRuns) {
    steps.push({
      kind: 'composer',
      label: '运行完整验证',
      prompt: '请对当前项目运行 build / test / lint 全量验证，确保没有回归；发现问题请直接修复。',
    });
  }
  return steps;
}

function reviewInput(e: AgentLogEntry): Record<string, unknown> {
  return (e.input ?? {}) as Record<string, unknown>;
}

function reviewOutput(e: AgentLogEntry): Record<string, unknown> {
  return (e.output ?? {}) as Record<string, unknown>;
}

/** Collect ReviewArtifact results from the agent log (newest first, capped). */
export function collectQualityRuns(log: AgentLogEntry[], limit = 4): QualityRun[] {
  const runs: QualityRun[] = [];
  for (const e of log) {
    if (e.type === 'tool_error' && e.toolName === 'ReviewArtifact') {
      runs.push({
        checkType: String(reviewInput(e).check_type ?? 'review'),
        passed: false,
        error: e.error || '审查执行失败',
        timestamp: e.timestamp,
      });
    } else if (e.type === 'tool_end' && e.toolName === 'ReviewArtifact') {
      const out = reviewOutput(e);
      runs.push({
        checkType: String(out.check_type ?? reviewInput(e).check_type ?? 'review'),
        passed: out.passed === true,
        command: typeof out.command === 'string' ? out.command : undefined,
        durationMs: e.durationMs,
        error: typeof out.error === 'string' ? out.error : undefined,
        output: typeof out.output === 'string' ? out.output : undefined,
        exitCode: typeof out.exitCode === 'number' ? out.exitCode : undefined,
        timestamp: e.timestamp,
      });
    }
  }
  return runs.slice(-limit).reverse();
}

/**
 * Latest actionable failure, scanning from the end of the log:
 * ReviewArtifact gate failure > tool error > engine error > agent.error.
 * A passed gate after an earlier failure means the issue was resolved.
 */
export function findLatestFailure(log: AgentLogEntry[], agentError?: string | null): TaskFailure | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i];
    if (e.type === 'tool_end' && e.toolName === 'ReviewArtifact') {
      const out = reviewOutput(e);
      if (out.passed === true) return null;
      const checkType = String(out.check_type ?? reviewInput(e).check_type ?? 'review');
      const err =
        typeof out.error === 'string' && out.error.trim() ? out.error : String(out.output ?? '').slice(0, 600);
      return {
        title: `${checkType} 审查未通过`,
        detail: err || '审查未通过（无详细输出）',
        timestamp: e.timestamp,
      };
    }
    if (e.type === 'tool_error') {
      return {
        title: `${e.toolName || '工具'} 执行失败`,
        detail: e.error || '工具执行失败',
        timestamp: e.timestamp,
      };
    }
    if (e.type === 'error') {
      return {
        title: '任务出错',
        detail: e.error || e.text || '未知错误',
        timestamp: e.timestamp,
      };
    }
  }
  if (agentError) {
    return { title: '任务失败', detail: agentError, timestamp: Date.now() };
  }
  return null;
}
