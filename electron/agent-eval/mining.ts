/**
 * mining.ts — 失败挖掘：把一次真实失败运行固化成可回归的 Eval Case。
 *
 * 只处理「真的没通过」的运行：把失败检查 + 本次实际改动的文件固化成新用例。
 * 通过的运行不产出候选（避免把噪声写进数据集）。
 */
import type { AgentTraceRun } from '../contracts/agent-trace';
import type { EvalCheck, EvalCheckResult } from './graders';

export interface MinedCandidate {
  id: string;
  category: string;
  task: string;
  fixture?: string;
  checks: EvalCheck[];
  source: {
    sessionId: string;
    failedChecks: string[];
    toolCalls: number;
    failedToolCalls: number;
    minedAt: string;
  };
}

export function mineCandidate(input: {
  id: string;
  task: string;
  category?: string;
  fixture?: string;
  checks: EvalCheck[];
  results: EvalCheckResult[];
  changedFiles: string[];
  trace: AgentTraceRun | null;
}): MinedCandidate | null {
  const failed = input.results.filter((r) => !r.passed);
  if (failed.length === 0) return null;

  const allowed = new Set(
    input.checks.flatMap((c) => {
      if (c.kind === 'file_contains' || c.kind === 'file_equals' || c.kind === 'file_changed') return [c.path];
      if (c.kind === 'file_unchanged') return [c.path];
      return c.kind === 'no_unexpected_changes' ? c.allow : [];
    }),
  );
  const extraChecks: EvalCheck[] = failed.some((f) => f.id.includes('scope') || f.id.includes('unexpected'))
    ? []
    : [
        {
          id: 'mined-scope',
          kind: 'no_unexpected_changes',
          allow: [...allowed, ...input.changedFiles.filter((p) => allowed.has(p))],
        },
      ];

  return {
    id: input.id,
    category: input.category ?? 'coding',
    task: input.task,
    fixture: input.fixture,
    checks: [...input.checks, ...extraChecks],
    source: {
      sessionId: input.trace?.sessionId ?? 'unknown',
      failedChecks: failed.map((f) => f.id),
      toolCalls: input.trace?.stats.toolCalls ?? 0,
      failedToolCalls: input.trace?.stats.failedToolCalls ?? 0,
      minedAt: new Date().toISOString(),
    },
  };
}
