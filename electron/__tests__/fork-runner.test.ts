import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await vi.importActual<typeof import('events')>('events');
  return {
    spawn: vi.fn(() => {
      const child = new EE() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
        pid?: number;
      };
      child.stdout = new EE();
      child.stderr = new EE();
      child.stdin = new EE();
      child.kill = vi.fn(() => true);
      child.pid = 4242;
      return child;
    }),
  };
});

import { finalResultFromJsonl, runForkedSubagent } from '../fork-runner';
import { spawn } from 'child_process';

function lastChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  return vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof lastChild>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fork-runner — 结果解析', () => {
  it('从 NDJSON 事件流提取最终结果', () => {
    const stream = [
      JSON.stringify({ type: 'step', text: '中间过程' }),
      JSON.stringify({ type: 'result', result: '最终答案' }),
    ].join('\n');
    expect(finalResultFromJsonl(stream)).toBe('最终答案');
  });

  it('无 JSON 结果时回退到尾部文本', () => {
    const stream = 'line1\nline2\nplain final text';
    expect(finalResultFromJsonl(stream)).toBe('line1\nline2\nplain final text');
  });

  it('result 字段优先于 final_result 和 text 别名', () => {
    const stream = JSON.stringify({
      result: 'primary',
      final_result: 'fallback-1',
      text: 'fallback-2',
    });
    expect(finalResultFromJsonl(stream)).toBe('primary');
  });

  it('忽略非字符串结果并返回最近的自然文本', () => {
    const lines = [JSON.stringify({ result: 123 }), ...Array.from({ length: 25 }, (_, i) => `line-${i}`)];
    expect(finalResultFromJsonl(lines.join('\n'))).toBe(lines.slice(-20).join('\n'));
  });
});

describe('fork-runner — runForkedSubagent 生命周期', () => {
  it('child 正常退出时返回最终结果', async () => {
    const pending = runForkedSubagent({ prompt: 'p', projectRoot: 'C:/proj' });
    const child = lastChild();
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ result: 'done' })}\n`));
    child.emit('close', 0);
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(res.result).toBe('done');
  });

  it('child 非零退出时透传 stderr 细节', async () => {
    const pending = runForkedSubagent({ prompt: 'p', projectRoot: 'C:/proj' });
    const child = lastChild();
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 2);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
  });

  it('spawn 失败时标记 unavailable', async () => {
    const pending = runForkedSubagent({ prompt: 'p', projectRoot: 'C:/proj' });
    const child = lastChild();
    child.emit('error', new Error('spawn ENOENT'));
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe(true);
  });

  it('超时后 kill 并返回超时错误', async () => {
    vi.useFakeTimers();
    const pending = runForkedSubagent({ prompt: 'p', projectRoot: 'C:/proj', timeoutMs: 60_000 });
    const child = lastChild();
    await vi.advanceTimersByTimeAsync(61_000);
    const res = await pending;
    expect(child.kill).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('超时');
  });

  it('AbortSignal 触发后 kill 并返回中止错误', async () => {
    const controller = new AbortController();
    const pending = runForkedSubagent({
      prompt: 'p',
      projectRoot: 'C:/proj',
      signal: controller.signal,
    });
    const child = lastChild();
    controller.abort();
    const res = await pending;
    expect(child.kill).toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('中止');
  });
});
