import { describe, it, expect } from 'vitest';
import { workTurns } from '../workUtils';
import type { AgentInfo, AgentLogEntry } from '../../../types/agent';

function agent(log: AgentLogEntry[]): AgentInfo {
  return {
    id: 'a1',
    name: '工作项',
    description: '',
    status: 'running',
    startTime: 0,
    toolCallCount: 0,
    iterations: 0,
    log,
  } as unknown as AgentInfo;
}

describe('workTurns — Work 执行流程分组', () => {
  it('按迭代分轮，合并 tool_start/tool_end 为一行', () => {
    const turns = workTurns(
      agent([
        { type: 'turn_start', timestamp: 900 },
        { type: 'iteration_start', iteration: 0, timestamp: 1000 },
        { type: 'tool_start', toolCallId: 't1', toolName: 'Bash', input: { command: 'ls' }, timestamp: 1100 },
        { type: 'tool_end', toolCallId: 't1', toolName: 'Bash', output: 'a.ts', durationMs: 120, timestamp: 1220 },
        { type: 'iteration_end', iteration: 0, timestamp: 1300 },
        { type: 'turn_end', timestamp: 1400 },
      ]),
    );

    expect(turns).toHaveLength(1);
    expect(turns[0].iteration).toBe(0);
    expect(turns[0].toolCount).toBe(1);
    const tool = turns[0].items[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.row.running).toBe(false);
      expect(tool.row.durationMs).toBe(120);
      expect(tool.row.output).toBe('a.ts');
    }
  });

  it('tool_error 标记失败并累计 errorCount', () => {
    const turns = workTurns(
      agent([
        { type: 'iteration_start', iteration: 0, timestamp: 1000 },
        { type: 'tool_start', toolCallId: 't1', toolName: 'Bash', input: { command: 'npm test' }, timestamp: 1100 },
        { type: 'tool_error', toolCallId: 't1', toolName: 'Bash', error: 'exit 1', timestamp: 1200 },
        { type: 'iteration_end', iteration: 0, timestamp: 1300 },
      ]),
    );

    expect(turns[0].errorCount).toBe(1);
    const tool = turns[0].items[0];
    if (tool.kind === 'tool') {
      expect(tool.row.running).toBe(false);
      expect(tool.row.error).toBe('exit 1');
    }
  });

  it('连续 text 合并为一条笔记，thinking 单独成段', () => {
    const turns = workTurns(
      agent([
        { type: 'iteration_start', iteration: 0, timestamp: 1000 },
        { type: 'text', text: '先看', timestamp: 1100 },
        { type: 'text', text: '目录', timestamp: 1110 },
        { type: 'thinking', text: '想一下', timestamp: 1200 },
        { type: 'iteration_end', iteration: 0, timestamp: 1300 },
      ]),
    );

    const notes = turns[0].items.filter((i) => i.kind === 'note');
    expect(notes).toHaveLength(2);
    if (notes[0].kind === 'note') expect(notes[0].text).toBe('先看目录');
    if (notes[1].kind === 'note') {
      expect(notes[1].text).toBe('想一下');
      expect(notes[1].thinking).toBe(true);
    }
  });

  it('progress 追加到对应工具行', () => {
    const turns = workTurns(
      agent([
        { type: 'iteration_start', iteration: 0, timestamp: 1000 },
        {
          type: 'tool_start',
          toolCallId: 't1',
          toolName: 'Bash',
          input: { command: 'npm run build' },
          timestamp: 1100,
        },
        { type: 'progress', toolCallId: 't1', text: '50%', timestamp: 1200 },
        { type: 'tool_end', toolCallId: 't1', toolName: 'Bash', output: 'ok', timestamp: 1300 },
      ]),
    );

    const tool = turns[0].items[0];
    if (tool.kind === 'tool') {
      expect(tool.row.progress).toBe('50%');
    }
  });

  it('空日志返回空数组', () => {
    expect(workTurns(agent([]))).toEqual([]);
  });
});
