import { describe, expect, it } from 'vitest';
import { runChecks, scoreOf, taskPassed, type EvalSnapshot } from '../agent-eval/graders';
import { projectAgentTrace } from '../agent-trace';
import type { AgentLogEntry } from '../contracts/advanced';

const baseline: Record<string, string> = {
  'src/config.ts': 'export const apiTimeoutMs = 30000;\n',
  'src/app.ts': 'export const app = true;\n',
};

function snapshot(files: Record<string, string>): EvalSnapshot {
  return { files, baseline };
}

describe('agent-eval graders — 判的是任务目标', () => {
  it('文件内容命中 + 只改允许文件 → 通过', () => {
    const results = runChecks(
      [
        { id: 'timeout', kind: 'file_contains', path: 'src/config.ts', needle: 'apiTimeoutMs = 60000' },
        { id: 'scope', kind: 'no_unexpected_changes', allow: ['src/config.ts'] },
      ],
      snapshot({ ...baseline, 'src/config.ts': 'export const apiTimeoutMs = 60000;\n' }),
    );
    expect(results.every((r) => r.passed)).toBe(true);
    expect(taskPassed(results)).toBe(true);
    expect(scoreOf(results)).toBe(1);
  });

  it('改错字段 / 改了无关文件 → 判失败并给出原因', () => {
    const results = runChecks(
      [
        { id: 'timeout', kind: 'file_contains', path: 'src/config.ts', needle: 'apiTimeoutMs = 60000' },
        { id: 'scope', kind: 'no_unexpected_changes', allow: ['src/config.ts'] },
      ],
      // 目标字段改对了，但顺手动了一个无关文件 → 只得一半分，且理由可读。
      snapshot({
        'src/config.ts': 'export const apiTimeoutMs = 60000;\n',
        'src/app.ts': 'export const app = false;\n',
      }),
    );
    expect(taskPassed(results)).toBe(false);
    expect(scoreOf(results)).toBe(0.5);
    expect(results[0].passed).toBe(true);
    expect(results[1].detail).toContain('src/app.ts');
  });

  it('file_unchanged / file_changed 都基于基线判定', () => {
    const results = runChecks(
      [
        { id: 'kept', kind: 'file_unchanged', path: 'src/app.ts' },
        { id: 'edited', kind: 'file_changed', path: 'src/config.ts' },
      ],
      snapshot({ ...baseline, 'src/config.ts': 'export const apiTimeoutMs = 60000;\n' }),
    );
    expect(taskPassed(results)).toBe(true);
  });
});

describe('agent-trace — 日志投影成结构化轨迹', () => {
  const log: AgentLogEntry[] = [
    { type: 'turn_start', timestamp: 100, turnId: 't1' },
    { type: 'tool_start', timestamp: 110, toolCallId: 'c1', toolName: 'Read', input: { file_path: 'src/config.ts' } },
    { type: 'tool_end', timestamp: 130, toolCallId: 'c1', output: 'ok' },
    { type: 'tool_start', timestamp: 140, toolCallId: 'c2', toolName: 'Edit', input: { file_path: 'src/config.ts' } },
    { type: 'tool_end', timestamp: 180, toolCallId: 'c2', output: 'ok' },
    { type: 'tool_start', timestamp: 190, toolCallId: 'c3', toolName: 'Bash' },
    { type: 'tool_error', timestamp: 220, toolCallId: 'c3', error: 'exit 1' },
    { type: 'turn_end', timestamp: 230, turnId: 't1' },
  ];

  it('统计回合 / 工具 / 失败 / 调用次数，并保留错误原因', () => {
    const trace = projectAgentTrace({ id: 'a1', status: 'completed', startTime: 90, log });
    expect(trace.stats).toMatchObject({ turns: 1, toolCalls: 3, failedToolCalls: 1, subAgents: 0 });
    expect(trace.turns[0].toolCallIds).toEqual(['c1', 'c2', 'c3']);
    const bash = trace.toolCalls.find((c) => c.name === 'Bash')!;
    expect(bash.status).toBe('error');
    expect(bash.error).toBe('exit 1');
    expect(bash.durationMs).toBe(30);
  });

  it('Agent 工具调用投影成子任务；状态由父任务状态归一化', () => {
    const trace = projectAgentTrace({
      id: 'a2',
      status: 'error',
      log: [
        { type: 'tool_start', timestamp: 10, toolCallId: 's1', toolName: 'Agent', input: { description: '扫描依赖' } },
        { type: 'tool_end', timestamp: 40, toolCallId: 's1' },
      ],
    });
    expect(trace.status).toBe('failed');
    expect(trace.subAgents).toEqual([{ id: 's1', name: '扫描依赖', status: 'done', at: 10 }]);
  });

  it('审批事件由宿主注入（日志里没有），并计入统计', () => {
    const trace = projectAgentTrace(
      { id: 'a3', status: 'running', log: [] },
      { approvals: [{ id: 'r1', toolName: 'Bash', at: 5, status: 'granted' }] },
    );
    expect(trace.approvals).toHaveLength(1);
    expect(trace.stats.approvals).toBe(1);
  });
});
