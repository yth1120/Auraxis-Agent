import { describe, it, expect } from 'vitest';
import { toToolStreamEvent } from '../event-bridge';
import type { EngineEvent } from '../engine-events';

const RID = 'req-1';

describe('event-bridge → ToolStreamEvent', () => {
  it('maps text/thinking chunks with requestId', () => {
    expect(toToolStreamEvent({ type: 'text_chunk', text: 'hi' }, RID)).toEqual({
      type: 'text_chunk',
      requestId: RID,
      text: 'hi',
    });
    expect(toToolStreamEvent({ type: 'thinking_chunk', chunk: 'think', isNewBlock: true }, RID)).toEqual({
      type: 'thinking_chunk',
      requestId: RID,
      chunk: 'think',
      isNewBlock: true,
    });
  });

  it('maps context_injected with source and producer', () => {
    expect(
      toToolStreamEvent(
        { type: 'context_injected', source: 'instructions', producer: 'AGENTS.md', detail: '项目指令已注入系统提示' },
        RID,
      ),
    ).toEqual({
      type: 'context_injected',
      requestId: RID,
      source: 'instructions',
      producer: 'AGENTS.md',
      detail: '项目指令已注入系统提示',
    });
  });

  it('maps tool lifecycle with injected timestamp', () => {
    const start = toToolStreamEvent(
      {
        type: 'tool_start',
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: { p: 1 },
        stepGroupId: 'g1',
      },
      RID,
    );
    expect(start).toMatchObject({
      type: 'tool_start',
      requestId: RID,
      toolCallId: 'tc-1',
      toolName: 'Read',
      input: { p: 1 },
      stepGroupId: 'g1',
    });
    expect(typeof (start as any).timestamp).toBe('number');

    const end = toToolStreamEvent(
      {
        type: 'tool_end',
        toolCallId: 'tc-1',
        toolName: 'Write',
        output: 'ok',
        durationMs: 12,
        stepGroupId: 'g1',
        input: { file_path: 'a.ts' },
      },
      RID,
    );
    expect(end).toMatchObject({
      type: 'tool_end',
      requestId: RID,
      toolCallId: 'tc-1',
      toolName: 'Write',
      output: 'ok',
      durationMs: 12,
      stepGroupId: 'g1',
      input: { file_path: 'a.ts' },
    });

    const err = toToolStreamEvent(
      {
        type: 'tool_error',
        toolCallId: 'tc-2',
        toolName: 'Bash',
        input: {},
        error: 'boom',
        stepGroupId: 'g1',
      },
      RID,
    );
    expect(err).toMatchObject({ type: 'tool_error', requestId: RID, error: 'boom' });

    const aborted = toToolStreamEvent(
      {
        type: 'tool_aborted',
        toolCallId: 'tc-3',
        toolName: 'Bash',
        input: {},
        error: 'denied',
        stepGroupId: 'g1',
      },
      RID,
    );
    expect(aborted).toMatchObject({ type: 'tool_aborted', requestId: RID, error: 'denied' });
  });

  it('maps iteration_start to the chat iteration counter', () => {
    expect(toToolStreamEvent({ type: 'iteration_start', iteration: 4, timestamp: 1 }, RID)).toEqual({
      type: 'iteration',
      requestId: RID,
      iteration: 4,
      maxIterations: 25,
    });
  });

  it('maps usage variants to usage_update', () => {
    expect(toToolStreamEvent({ type: 'usage', inputTokens: 1, outputTokens: 2 }, RID)).toEqual({
      type: 'usage_update',
      requestId: RID,
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(
      toToolStreamEvent(
        {
          type: 'usage',
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 3,
          cacheHitTokens: 4,
          cacheMissTokens: 5,
        },
        RID,
      ),
    ).toEqual({
      type: 'usage_update',
      requestId: RID,
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheHitTokens: 4,
      cacheMissTokens: 5,
    });
    expect(
      toToolStreamEvent({ type: 'usage_update', inputTokens: 1, outputTokens: 2, reasoningTokens: 3 }, RID),
    ).toEqual({
      type: 'usage_update',
      requestId: RID,
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
    });
  });

  it('maps plan lifecycle to plan_generated steps', () => {
    const out = toToolStreamEvent(
      {
        type: 'plan_created',
        plan: { tasks: [{ id: 't1', description: '重构', status: 'pending', dependencies: [] }], createdAt: 1234 },
      },
      RID,
    );
    expect(out).toMatchObject({
      type: 'plan_generated',
      requestId: RID,
      planId: 'plan-1234',
      steps: [{ id: 't1', description: '重构' }],
    });
  });

  it('maps warnings and system messages', () => {
    expect(toToolStreamEvent({ type: 'deviance_warning', message: '偏离计划' }, RID)).toEqual({
      type: 'system_message',
      requestId: RID,
      level: 'warning',
      content: '偏离计划',
    });
    expect(toToolStreamEvent({ type: 'system_message', level: 'info', content: 'note' }, RID)).toEqual({
      type: 'system_message',
      requestId: RID,
      level: 'info',
      content: 'note',
    });
  });

  it('maps done/error and context compression', () => {
    expect(toToolStreamEvent({ type: 'done' }, RID)).toEqual({ type: 'done', requestId: RID });
    expect(toToolStreamEvent({ type: 'error', error: 'oops' }, RID)).toEqual({
      type: 'error',
      requestId: RID,
      error: 'oops',
    });
    expect(
      toToolStreamEvent(
        { type: 'context_compressed', tokensBefore: 10, tokensAfter: 5, messagesRemoved: 2, tokensSaved: 5 },
        RID,
      ),
    ).toMatchObject({
      type: 'context_compressed',
      requestId: RID,
      tokensBefore: 10,
      tokensAfter: 5,
    });
  });

  it('drops engine-internal lifecycle events', () => {
    const internal: EngineEvent[] = [
      { type: 'turn_start', turnId: 't1', timestamp: 1 },
      { type: 'turn_end', turnId: 't1', reason: 'completed', timestamp: 2 },
      { type: 'step_start', iteration: 1, timestamp: 3 },
      { type: 'step_end', iteration: 1, timestamp: 4 },
      { type: 'request_start', model: 'deepseek-v4-pro', provider: 'deepseek', timestamp: 5 },
    ];
    for (const e of internal) {
      expect(toToolStreamEvent(e, RID)).toBeNull();
    }
  });
});
