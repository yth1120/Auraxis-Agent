/**
 * event-bridge.ts — centralized engine → renderer event mapping.
 *
 * The engine emits `EngineEvent` (turn/step/tool lifecycle). Query/chat
 * surfaces consume `ToolStreamEvent`; this bridge is the ONLY place that
 * conversion happens, so both loops share one mapping instead of each
 * hand-rolling renderer payloads.
 */
import type { ToolStreamEvent } from '../tool-defs';
import type { EngineEvent } from '../agent-runtime/engine-events';

/**
 * `usage` 与 `usage_update` 是引擎的同一个事实（前者给统计、后者给界面），
 * 映射到渲染层是同一件事 —— 抽出来，别让两份条件展开各占一半圈复杂度。
 */
function usageUpdate(
  event: Extract<EngineEvent, { type: 'usage' | 'usage_update' }>,
  requestId: string,
): ToolStreamEvent {
  return {
    type: 'usage_update',
    requestId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
    ...(event.cacheHitTokens !== undefined ? { cacheHitTokens: event.cacheHitTokens } : {}),
    ...(event.cacheMissTokens !== undefined ? { cacheMissTokens: event.cacheMissTokens } : {}),
  };
}

/**
 * Convert an engine event into the renderer chat-stream shape.
 * Returns null for engine-internal events (turn/step/request envelopes) that
 * the chat UI does not render yet — they remain available to the agent
 * pipeline and to future diagnostics.
 */
export function toToolStreamEvent(
  event: EngineEvent,
  requestId: string,
  maxIterations?: number,
): ToolStreamEvent | null {
  switch (event.type) {
    case 'text_chunk':
      return { type: 'text_chunk', requestId, text: event.text };
    case 'thinking_chunk':
      return { type: 'thinking_chunk', requestId, chunk: event.chunk, isNewBlock: event.isNewBlock };
    case 'tool_start':
      return {
        type: 'tool_start',
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input ?? {},
        timestamp: Date.now(),
        stepGroupId: event.stepGroupId,
      };
    case 'tool_progress':
      return {
        type: 'tool_progress',
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input ?? {},
        timestamp: Date.now(),
        progress: event.progress,
        stepGroupId: event.stepGroupId,
      };
    case 'tool_end':
      return {
        type: 'tool_end',
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
        durationMs: event.durationMs,
        timestamp: Date.now(),
        stepGroupId: event.stepGroupId,
        input: event.input ?? {},
        // 引擎已经算好的摘要事实（行数 / 字节数 / 退出码 / 命中数）。此前这里把它丢掉，
        // 于是聊天区永远拿不到摘要，只能各自从入参重推一个更弱的版本 —— 见
        // agent-runtime/agent-loop-utils.ts 的 buildToolSummary。
        ...(event.summary ? { summary: event.summary } : {}),
      };
    case 'tool_error':
      return {
        type: 'tool_error',
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        error: event.error,
        timestamp: Date.now(),
        stepGroupId: event.stepGroupId,
      };
    case 'tool_aborted':
      return {
        type: 'tool_aborted',
        requestId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
        error: event.error,
        timestamp: Date.now(),
        stepGroupId: event.stepGroupId,
      };
    case 'iteration_start':
      // Chat surface shows a single "iteration" counter. 上限用调用方解析出的真实预算。
      return {
        type: 'iteration',
        requestId,
        iteration: event.iteration,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      };
    case 'context_compressed':
      return {
        type: 'context_compressed',
        requestId,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        messagesRemoved: event.messagesRemoved,
        tokensSaved: event.tokensSaved,
      };
    case 'usage':
    case 'usage_update':
      return usageUpdate(event, requestId);
    case 'plan_created':
    case 'plan_updated':
      return {
        type: 'plan_generated',
        requestId,
        planId: `plan-${event.plan.createdAt || Date.now()}`,
        steps: event.plan.tasks.map((t) => ({
          id: t.id,
          toolName: '',
          description: t.description,
          parameters: { dependencies: t.dependencies },
        })),
      };
    case 'deviance_warning':
      return { type: 'system_message', requestId, level: 'warning', content: event.message };
    case 'context_injected':
      return {
        type: 'context_injected',
        requestId,
        source: event.source,
        producer: event.producer,
        detail: event.detail,
      };
    case 'system_message':
      return { type: 'system_message', requestId, level: event.level, content: event.content };
    case 'done':
      return { type: 'done', requestId };
    case 'error':
      return { type: 'error', requestId, error: event.error };
    default:
      // turn_start / turn_end / step_start / step_end / request_start —
      // engine-internal lifecycle, not rendered by the chat stream.
      return null;
  }
}
