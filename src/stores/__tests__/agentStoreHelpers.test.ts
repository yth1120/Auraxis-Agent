import { describe, expect, it } from 'vitest';
import { isRecord, logEntryFromEvent, normalizeTodos, toBackendPatch } from '../agentStoreHelpers';

describe('agentStoreHelpers — pure mapping branches', () => {
  it('isRecord and normalizeTodos cover invalid/empty inputs', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(normalizeTodos(undefined)).toBeUndefined();
    expect(
      normalizeTodos([
        { content: 'a', status: 'pending' },
        { content: 1, status: 'x' },
      ]),
    ).toEqual([{ content: 'a', status: 'pending' }]);
    expect(normalizeTodos([{ content: 'a', status: 'pending', activeForm: 'A' }])).toEqual([
      { content: 'a', status: 'pending', activeForm: 'A' },
    ]);
    expect(normalizeTodos([])).toBeUndefined();
  });

  it('toBackendPatch maps status/type/priority/iteration/plan/delivery/project', () => {
    const patch = toBackendPatch({
      id: 'a1',
      agentId: 'a1',
      name: 'T',
      description: 'd',
      type: 'Explore',
      status: 'running',
      priority: 'high',
      startTime: 1,
      endTime: 2,
      iteration: 3,
      maxIterations: 10,
      toolCallCount: 2,
      messagesCount: 5,
      surface: 'work',
      plan: {
        todos: [{ content: 'todo', status: 'pending', activeForm: 'T' }],
        tasks: [{ description: 'task', status: 'pending' }],
      },
      error: 'e',
      result: 'r',
      model: 'm',
      workTier: 'full',
      delivery: { files: ['a.md', 2], result: 'ok', summary: 's' },
      projectPath: 'C:/p',
    });
    expect(patch).toMatchObject({
      type: 'Explore',
      status: 'running',
      priority: 'high',
      iteration: 3,
      surface: 'work',
      workTier: 'full',
      projectRoot: 'C:/p',
    });
    expect(patch.plan).toMatchObject({ todos: [{ content: 'task' }] });
    expect(patch.delivery).toEqual({ files: ['a.md'], result: 'ok', summary: 's' });

    const invalid = toBackendPatch({
      type: 'bogus',
      status: 'bogus',
      priority: 'bogus',
      surface: 'bogus',
      iteration: 'x' as never,
      workTier: 'bogus',
      plan: { bogus: true },
      delivery: { files: 'bad', result: 1 },
    });
    expect(invalid.type).toBeUndefined();
    expect(invalid.plan).toBeNull();
    expect(invalid.delivery).toBeUndefined();
  });

  it('logEntryFromEvent covers every mapped event type', () => {
    expect(logEntryFromEvent({ type: 'text_chunk', text: 'x' } as any)).toBeNull();
    expect(logEntryFromEvent({ type: 'tool_start', toolName: 'Read', toolCallId: 'c1' } as any)).toMatchObject({
      type: 'tool_start',
    });
    expect(
      logEntryFromEvent({
        type: 'tool_end',
        toolName: 'TodoWrite',
        output: { todos: [{ content: 'a', status: 'pending' }] },
      } as any),
    ).toMatchObject({ type: 'tool_end', todos: [{ content: 'a' }] });
    expect(logEntryFromEvent({ type: 'tool_aborted', toolName: 'Read', toolCallId: 'c' } as any)).toMatchObject({
      type: 'tool_error',
      error: '工具已中止',
    });
    expect(
      logEntryFromEvent({ type: 'tool_error', toolName: 'Read', toolCallId: 'c', error: 'x' } as any),
    ).toMatchObject({
      type: 'tool_error',
    });
    expect(logEntryFromEvent({ type: 'iteration_start', iteration: 1 } as any)).toMatchObject({
      type: 'iteration_start',
    });
    expect(logEntryFromEvent({ type: 'iteration_end', iteration: 1 } as any)).toMatchObject({ type: 'iteration_end' });
    expect(logEntryFromEvent({ type: 'turn_start', turnId: 't' } as any)).toMatchObject({ type: 'turn_start' });
    expect(logEntryFromEvent({ type: 'turn_end', turnId: 't', reason: 'done' } as any)).toMatchObject({
      type: 'turn_end',
    });
    expect(logEntryFromEvent({ type: 'tool_progress', progress: 'p' } as any)).toMatchObject({ type: 'progress' });
    expect(logEntryFromEvent({ type: 'tool_progress', progress: '' } as any)).toBeNull();
    expect(logEntryFromEvent({ type: 'deviance_warning', message: 'w' } as any)).toMatchObject({ type: 'warning' });
    expect(logEntryFromEvent({ type: 'deviance_warning', message: '' } as any)).toBeNull();
    expect(logEntryFromEvent({ type: 'system_message', level: 'warning', content: 'x' } as any)).toMatchObject({
      type: 'warning',
    });
    expect(logEntryFromEvent({ type: 'system_message', level: 'info', content: 'x' } as any)).toBeNull();
    expect(logEntryFromEvent({ type: 'context_compressed', tokensBefore: 1, tokensAfter: 2 } as any)).toMatchObject({
      type: 'progress',
    });
    expect(
      logEntryFromEvent({ type: 'context_injected', source: 'instructions', producer: 'AGENTS.md' } as any),
    ).toMatchObject({ type: 'context' });
    expect(
      logEntryFromEvent({ type: 'context_injected', source: 'external', producer: 'external', detail: 'd' } as any),
    ).toMatchObject({ type: 'user_message', text: 'd' });
    expect(logEntryFromEvent({ type: 'user_message', text: 'u' } as any)).toMatchObject({ type: 'user_message' });
    expect(logEntryFromEvent({ type: 'error', error: 'e' } as any)).toMatchObject({ type: 'error' });
    expect(logEntryFromEvent({ type: 'plan', todos: [{ content: 'x', status: 'pending' }] } as any)).toMatchObject({
      type: 'plan',
    });
    expect(logEntryFromEvent({ type: 'plan' } as any)).toBeNull();
    expect(logEntryFromEvent({ type: 'unknown' } as any)).toBeNull();
  });
});
