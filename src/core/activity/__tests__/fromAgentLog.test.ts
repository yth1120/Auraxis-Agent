/**
 * fromAgentLog.test.ts — 子代理日志 → 嵌套 Activity。
 *
 * 关键行为：同一 toolCallId 的 start/end 在日志里是**两条独立条目**，
 * 必须合并成一条 Activity（否则子代理里每个工具都会显示两行）。
 */
import { describe, it, expect } from 'vitest';
import { agentLogToActivities } from '../fromAgentLog';
import { formatBytes, formatDuration } from '../format';
import type { AgentLogEntry } from '../../../types/agent';

function entry(over: Partial<AgentLogEntry> & { type: AgentLogEntry['type'] }): AgentLogEntry {
  return { timestamp: 1000, ...over } as AgentLogEntry;
}

describe('agentLogToActivities', () => {
  it('start 与 end 合并成一条（按 toolCallId 原地替换）', () => {
    const items = agentLogToActivities(
      [
        entry({
          type: 'tool_start',
          toolCallId: 'c1',
          toolName: 'Read',
          input: { file_path: 'a.ts' },
          timestamp: 1000,
        }),
        entry({ type: 'tool_end', toolCallId: 'c1', toolName: 'Read', output: 'x', durationMs: 12, timestamp: 1012 }),
      ],
      'run-1',
      'parent-1',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'parent-1:c1',
      parentId: 'parent-1',
      runId: 'run-1',
      status: 'completed',
      type: 'read_file',
      durationMs: 12,
      // 起始时间取自 start，而不是被 end 的时间覆盖。
      startedAt: 1000,
    });
  });

  it('没有 toolCallId 的条目各自成项（不去猜它们是同一次调用）', () => {
    const items = agentLogToActivities(
      [
        entry({ type: 'tool_start', toolName: 'Bash', timestamp: 1 }),
        entry({ type: 'tool_end', toolName: 'Bash', timestamp: 2 }),
      ],
      'r',
      'p',
    );
    expect(items).toHaveLength(2);
  });

  it('错误落成 failed，并带上错误文本', () => {
    const items = agentLogToActivities(
      [
        entry({ type: 'tool_start', toolCallId: 'c1', toolName: 'Bash', input: { command: 'npm test' } }),
        entry({ type: 'tool_error', toolCallId: 'c1', toolName: 'Bash', error: 'exit 1' }),
      ],
      'r',
      'p',
    );
    expect(items[0]).toMatchObject({ status: 'failed', error: 'exit 1', type: 'test' });
  });

  it('文本 / 思考 / 迭代标记不进嵌套列表（子代理的最终文本由父项承担）', () => {
    const items = agentLogToActivities(
      [
        entry({ type: 'text', text: '我在读文件' }),
        entry({ type: 'thinking', text: '思考' }),
        entry({ type: 'iteration_start', iteration: 1 }),
        entry({ type: 'plan' }),
      ],
      'r',
      'p',
    );
    expect(items).toEqual([]);
  });

  it('空日志 → 空列表（调用方据此显示"尚无步骤"）', () => {
    expect(agentLogToActivities(undefined, 'r', 'p')).toEqual([]);
    expect(agentLogToActivities([], 'r', 'p')).toEqual([]);
  });
});

describe('格式化', () => {
  it('时长分档合理（不把 0.4s 显示成 0s）', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(65_000)).toBe('1m5s');
    expect(formatDuration(-1)).toBe('');
  });

  it('字节只保留一位小数（不出现 1.9999MB 这类噪声）', () => {
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5MB');
  });
});
