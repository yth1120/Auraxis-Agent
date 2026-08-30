import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatLogBuffer, createUsageAccumulator } from '../chatRuntime';

afterEach(() => {
  vi.useRealTimers();
});

describe('createUsageAccumulator', () => {
  it('accumulates deltas and flushes only non-empty snapshots', () => {
    const apply = vi.fn();
    const acc = createUsageAccumulator(apply);

    acc.add({ input: 10, output: 2, reasoning: 1, cacheHit: 7, cacheMiss: 3 });
    acc.flush();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ input: 10, output: 2, reasoning: 1, cacheHit: 7, cacheMiss: 3 });

    acc.flush();
    expect(apply).toHaveBeenCalledTimes(1);

    acc.add({ input: 1 });
    acc.reset();
    acc.flush();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('createChatLogBuffer', () => {
  it('groups events by session and writes after the debounce window', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const buffer = createChatLogBuffer({
      write,
      getProjectPath: () => 'C:/project',
    });

    buffer.queue('s1', 'user', { text: 'a' });
    buffer.queue('s1', 'assistant_chunk', { text: 'b' });
    buffer.queue('s2', 'tool', { kind: 'x' });

    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(
      's1',
      [
        expect.objectContaining({ type: 'user', data: { text: 'a' } }),
        expect.objectContaining({ type: 'assistant_chunk', data: { text: 'b' } }),
      ],
      'C:/project',
    );
    expect(write).toHaveBeenCalledWith('s2', [expect.objectContaining({ type: 'tool' })], 'C:/project');
  });

  it('requeues failed writes and retries with the longer backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const write = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk busy');
    });
    const buffer = createChatLogBuffer({ write, getProjectPath: () => undefined });

    buffer.queue('s1', 'user', { text: 'a' });
    buffer.flushNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ignores empty session ids without scheduling a write', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const buffer = createChatLogBuffer({ write, getProjectPath: () => undefined });

    buffer.queue(null, 'user', { text: 'a' });
    buffer.queue('', 'tool', { kind: 'x' });
    buffer.flushNow();

    expect(write).not.toHaveBeenCalled();
  });
});
