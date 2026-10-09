import { describe, expect, it } from 'vitest';
import { verifyTask } from '../agent-eval/verifier';
import { computeToolMetrics } from '../agent-eval/tool-metrics';
import { mineCandidate } from '../agent-eval/mining';
import { evaluateProcessGates } from '../agent-eval/process-gates';
import { projectAgentTraceFromSessionEvents } from '../agent-trace';
import type { SessionEvent } from '../contracts/session-types';
import type { EvalCheckResult } from '../agent-eval/graders';

const events: SessionEvent[] = [
  { seq: 1, type: 'agent_status', ts: 10, data: { turnId: 't1', status: 'running' } },
  {
    seq: 2,
    type: 'tool',
    ts: 20,
    data: { action: 'start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' } },
  },
  { seq: 3, type: 'tool', ts: 30, data: { action: 'end', toolName: 'Read', toolCallId: 'c1' } },
  {
    seq: 4,
    type: 'tool',
    ts: 40,
    data: { action: 'start', toolName: 'Edit', toolCallId: 'c2', input: { file_path: 'a.ts' } },
  },
  { seq: 5, type: 'tool', ts: 60, data: { action: 'end', toolName: 'Edit', toolCallId: 'c2' } },
  {
    seq: 6,
    type: 'tool',
    ts: 70,
    data: { action: 'start', toolName: 'Bash', toolCallId: 'c3', input: { command: 'npm test' } },
  },
  { seq: 7, type: 'tool', ts: 90, data: { action: 'end', toolName: 'Bash', toolCallId: 'c3', output: 'ok' } },
];

const passed: EvalCheckResult[] = [{ id: 'target', passed: true, detail: 'ok' }];
const scopeFailed: EvalCheckResult[] = [
  { id: 'target', passed: true, detail: 'ok' },
  { id: 'mined-scope', passed: false, detail: '无关文件被改动：b.ts' },
];

describe('trace ← session events 投影', () => {
  it('从持久化事件流还原工具调用与验证命令', () => {
    const trace = projectAgentTraceFromSessionEvents(events, { sessionId: 's1', status: 'completed' });
    expect(trace.toolCalls.map((c) => c.name)).toEqual(['Read', 'Edit', 'Bash']);
    expect(trace.toolCalls[2].durationMs).toBe(20);
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0].toolCallIds).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('Task Verifier — 结论与证据', () => {
  const trace = projectAgentTraceFromSessionEvents(events, { sessionId: 's1', status: 'completed' });

  it('目标全过 + 修改后有验证命令 → verified，置信度高', () => {
    const r = verifyTask(passed, trace);
    expect(r.status).toBe('verified');
    expect(r.confidence).toBeGreaterThanOrEqual(1);
    expect(r.evidence.some((e) => e.kind === 'verification_command')).toBe(true);
  });

  it('目标达成但范围越界 → regressed，并给出失败证据', () => {
    const r = verifyTask(scopeFailed, trace);
    expect(r.status).toBe('regressed');
    expect(r.evidence.some((e) => e.detail.includes('b.ts'))).toBe(true);
  });

  it('没有验证命令 / 有工具失败时，置信度下调', () => {
    const noVerify = projectAgentTraceFromSessionEvents(events.slice(0, 5), { sessionId: 's2', status: 'completed' });
    const r = verifyTask(passed, noVerify);
    expect(r.status).toBe('verified');
    expect(r.confidence).toBeLessThan(1);
  });

  it('完全没有轨迹时不给满分置信度（判分通过与过程可信是两件事）', () => {
    const r = verifyTask(passed, null);
    expect(r.status).toBe('verified');
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.evidence.some((e) => e.detail.includes('缺少运行轨迹'))).toBe(true);
  });
});

describe('工具质量指标', () => {
  const trace = projectAgentTraceFromSessionEvents(events, { sessionId: 's1', status: 'completed' });

  it('命中期望工具、参数完整、且修改后验证 → 指标全绿', () => {
    const m = computeToolMetrics(trace, {
      expect: ['Read', 'Edit'],
      requireArgs: { Read: ['file_path'], Edit: ['file_path'] },
    });
    expect(m.selection).toBe(1);
    expect(m.argumentAccuracy).toBe(1);
    expect(m.verifiedAfterEdit).toBe(true);
    expect(m.unnecessaryCalls).toBe(0);
  });

  it('用了禁用的工具 → selection 直接判 0', () => {
    const m = computeToolMetrics(trace, { expect: ['Read'], forbid: ['Bash'] });
    expect(m.selection).toBe(0);
  });
});

describe('失败挖掘', () => {
  const trace = projectAgentTraceFromSessionEvents(events, { sessionId: 's1', status: 'completed' });

  it('通过的运行不产出候选；失败的运行固化成新用例', () => {
    const base = {
      id: 'coding-999',
      task: '改 a.ts',
      checks: [{ id: 'target', kind: 'file_contains' as const, path: 'a.ts', needle: 'x' }],
      changedFiles: ['a.ts', 'b.ts'],
      trace,
    };
    expect(mineCandidate({ ...base, results: passed })).toBeNull();
    const mined = mineCandidate({ ...base, results: scopeFailed });
    expect(mined?.source.sessionId).toBe('s1');
    expect(mined?.source.failedChecks).toEqual(['mined-scope']);
    expect(mined?.checks.some((c) => c.kind === 'no_unexpected_changes')).toBe(false); // 已有 scope 检查，不重复加
  });
});

describe('过程门槛 — 结果对但过程不能离谱', () => {
  const clean = projectAgentTraceFromSessionEvents(events, { sessionId: 's-clean', status: 'completed' });

  it('没有门槛就不产出判定', () => {
    expect(evaluateProcessGates({}, clean)).toEqual([]);
  });

  it('声明门槛但缺少轨迹 → 直接判失败（不冒充通过）', () => {
    const results = evaluateProcessGates({ maxIterations: 5 }, null);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain('缺少运行轨迹');
  });

  it('失败次数 / 迭代 / 改后验证三条门槛逐条判定', () => {
    const ok = evaluateProcessGates(
      { maxFailedToolCalls: 0, maxIterations: 10, requireVerifiedAfterEdit: true },
      clean,
    );
    expect(ok.every((r) => r.passed)).toBe(true);

    const tooTight = evaluateProcessGates({ maxIterations: 0, requireVerifiedAfterEdit: false }, clean);
    expect(tooTight[0].passed).toBe(false);
    expect(tooTight[0].detail).toContain('上限 0');
  });
});
