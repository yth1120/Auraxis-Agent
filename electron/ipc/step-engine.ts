import type { StepEngineConfig, StepState } from './step-engine-contracts';
export type { StepEngineConfig, StepState };

/**
 * step-engine.ts — unified ReAct step driver (Phase 2).
 *
 * ONE step = one LLM request (with retry) + optional tool batch + history
 * append + stop-policy evaluation + context compaction. The caller owns turn
 * lifecycle and termination (safety cap / abort); runStep owns everything
 * that happens inside a single iteration, so query-engine and agent-loop no
 * longer re-implement the same body twice.
 */

import type { AssistantMessage, LoopMessage } from './agent-loop-types';

import { errorRecord, errorText } from '../errors';
import {
  stopPolicyEvaluate,
  markInjected,
  deduplicateNudges,
  appendAssistantToHistory,
  readErrorBody,
} from './agent-loop';
import { invokeLlm } from './llm-adapter';
import { runToolBatch } from './tool-runner';

import { getAllTools } from '../tool-registry';
import { shouldCompactByTokens, compactHistory, estimateTokens } from './context-manager';

import { buildTimeContextMessage, buildTmuxContextMessage, resolveTmuxLocation } from './step-engine-context';
import { appendToolResults } from './step-engine-tool-results';
import { buildStepToolBatch } from './step-engine-tools';
export {
  buildTimeContextMessage,
  buildTmuxContextMessage,
  resetTmuxLocationCache,
  resolveTmuxLocation,
} from './step-engine-context';

// ─── State ──────────────────────────────────────────────

export function createStepState(messages: LoopMessage[]): StepState {
  return {
    messages,
    iteration: 0,
    toolCallCount: 0,
    consecutiveTextOnly: 0,
    emptyResponseCount: 0,
    allText: '',
    startedAt: Date.now(),
  };
}

// ─── Config ─────────────────────────────────────────────

// ─── Outcome ────────────────────────────────────────────

export type StepOutcome =
  | { status: 'continue'; metrics?: StepMetrics }
  | { status: 'stop'; reason: string; isError: boolean; metrics?: StepMetrics }
  | { status: 'aborted'; metrics?: StepMetrics };

export interface StepMetrics {
  firstTokenMs?: number;
  outputTokens?: number;
}

// ─── Step driver ────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_COMPACT_THRESHOLD = 100_000;
const DEFAULT_COMPACT_MODEL = 'deepseek-v4-flash';

/**
 * Run one full ReAct iteration. Mutates `state` (messages + counters) and
 * returns what the driver should do next.
 */
export async function runStep(cfg: StepEngineConfig, state: StepState, stepGroupId: string): Promise<StepOutcome> {
  const { emit, signal } = cfg;
  const messages = state.messages;
  const iteration = state.iteration;

  // ── Pre-step: nudge prep ──
  deduplicateNudges(messages);
  if (cfg.getPendingNudge) {
    const nudge = cfg.getPendingNudge();
    if (nudge) {
      const m = { role: 'user' as const, content: nudge };
      markInjected(m);
      messages.push(m);
    }
  }

  emit({ type: 'iteration_start', iteration, timestamp: Date.now() });
  emit({ type: 'step_start', iteration, timestamp: Date.now() });
  const stepStartedAt = Date.now();
  let toolsThisIteration = 0;
  let firstTokenAt: number | null = null;
  let stepOutputTokens = 0;
  const stepMetrics = () => ({
    firstTokenMs: firstTokenAt !== null ? firstTokenAt - stepStartedAt : undefined,
    outputTokens: stepOutputTokens,
  });

  // ══ Step A: LLM invoke with retry ══
  emit({ type: 'request_start', model: cfg.model, provider: cfg.adapter ?? 'deepseek', timestamp: Date.now() });
  let assistantMsg: AssistantMessage | null = null;
  let lastApiErr: unknown;
  const maxRetries = DEFAULT_MAX_RETRIES;
  const baseDelay = cfg.retryBaseDelayMs ?? 2000;
  const tools = cfg.tools ?? getAllTools();
  const fallback = cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? cfg.fallbackModel : undefined;
  const totalAttempts = maxRetries + (fallback ? 1 : 0);
  let usedFallback = false;

  if (cfg.timeContext) {
    const tc = buildTimeContextMessage(state.startedAt, Date.now());
    markInjected(tc);
    messages.push(tc);
  }
  if (cfg.tmuxContext) {
    const location = await resolveTmuxLocation();
    if (location) {
      const tc = buildTmuxContextMessage(location);
      markInjected(tc);
      messages.push(tc);
    }
  }

  await cfg.onBeforeRequest?.(messages);

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (signal?.aborted) break;
    try {
      assistantMsg = await invokeLlm({
        model: usedFallback ? fallback! : cfg.model,
        apiKey: cfg.apiKey,
        apiBase: cfg.apiBase,
        systemPrompt: cfg.systemPrompt,
        messages,
        tools,
        isDeepThink: cfg.isDeepThink,
        reasoningEffort: cfg.reasoningEffort,
        temperature: cfg.temperature,
        toolChoice: cfg.toolChoice,
        adapter: cfg.adapter,
        signal: signal || new AbortController().signal,
        onTextChunk: (text) => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          state.allText += text;
          emit({ type: 'text_chunk', text });
        },
        onThinkingChunk: (chunk, isNewBlock) => {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          emit({ type: 'thinking_chunk', chunk, isNewBlock });
        },
        onUsage: (usage) => {
          const { inputTokens, outputTokens, reasoningTokens, cacheHitTokens, cacheMissTokens } = usage;
          stepOutputTokens += outputTokens;
          emit({
            type: 'usage',
            inputTokens,
            outputTokens,
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
            ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
            ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
          });
          cfg.onUsage?.(usage);
        },
      });
      break;
    } catch (apiErr: unknown) {
      const apiError = errorRecord(apiErr);
      const status =
        typeof apiError.response === 'object' && apiError.response
          ? (apiError.response as { status?: number }).status
          : undefined;
      // Pause/stop aborts the in-flight request — axios surfaces these as
      // CanceledError/ERR_CANCELED, NOT AbortError. They must never be
      // reported as "API 请求失败: canceled".
      if (
        apiError.name === 'AbortError' ||
        apiError.name === 'CanceledError' ||
        apiError.code === 'ERR_CANCELED' ||
        signal?.aborted
      )
        break;
      lastApiErr = apiErr;
      const isRetryable =
        status === 429 || (status && status >= 500) || apiError.code === 'ECONNRESET' || apiError.code === 'ETIMEDOUT';
      if (isRetryable && attempt < maxRetries - 1) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 16000);
        emit({
          type: 'system_message',
          level: 'info',
          content: `API 请求失败 (${status || apiError.code})，${Math.round(delay / 1000)}s 后重试...`,
        });
        await new Promise((r) => setTimeout(r, delay));
        if (signal?.aborted) break;
        continue;
      }
      if (!usedFallback && fallback) {
        usedFallback = true;
        emit({ type: 'system_message', level: 'info', content: `主模型多次失败，切换到降级模型 ${fallback}` });
        continue;
      }
      break;
    }
  }

  if (signal?.aborted) return { status: 'aborted' };
  if (!assistantMsg && lastApiErr) {
    const savedApiError = errorRecord(lastApiErr);
    // Pause/stop surfaces as CanceledError/ERR_CANCELED from axios even when
    // the AbortSignal flag hasn't flipped yet — never report that as an API
    // failure ("API 请求失败: canceled").
    if (
      savedApiError.name === 'AbortError' ||
      savedApiError.name === 'CanceledError' ||
      savedApiError.code === 'ERR_CANCELED'
    ) {
      return { status: 'aborted' };
    }
    const errorBody = await readErrorBody(lastApiErr);
    let apiDetail = '';
    try {
      const p = JSON.parse(errorBody);
      apiDetail = p?.error?.message || p?.message || p?.error || '';
    } catch {
      apiDetail = errorBody.slice(0, 200);
    }
    const savedStatus =
      typeof savedApiError.response === 'object' && savedApiError.response
        ? (savedApiError.response as { status?: number; statusText?: string }).status
        : undefined;
    const savedStatusText =
      typeof savedApiError.response === 'object' && savedApiError.response
        ? (savedApiError.response as { statusText?: string }).statusText
        : undefined;
    const errMsg = savedStatus
      ? `API 请求失败 (HTTP ${savedStatus}): ${apiDetail || savedStatusText || errorText(lastApiErr)}`
      : `API 请求失败: ${errorText(lastApiErr)}`;
    console.error('[step-engine] API error:', { status: savedStatus, body: errorBody.slice(0, 500) });
    emit({ type: 'error', error: errMsg });
    throw lastApiErr;
  }
  if (!assistantMsg) return { status: 'aborted' };

  // ══ Step B: max_tokens truncation guard ══
  if (assistantMsg.isFinal && assistantMsg.completionStopReason === 'max_tokens') {
    const m = {
      role: 'user' as const,
      content: '上一条回复可能因 token 限制被截断（API 返回 stop_reason: max_tokens）。请从断点继续，完成剩余内容。',
    };
    markInjected(m);
    messages.push(m);
    assistantMsg.isFinal = false;
    state.allText += '\n\n⚠️ 上一条回复因 token 限制被截断，已请求模型继续生成';
    // 截断上限以回合行呈现.
    emit({ type: 'system_message', level: 'info', content: '输出达到 token 上限，正在请求模型继续生成…' });
  }

  const hasText = assistantMsg.contentTimeline.some((b) => b.type === 'text');
  const hasTools = assistantMsg.toolCalls.length > 0;

  // ══ Step C: append assistant to history (preserves reasoning_content) ══
  if (hasText || hasTools) {
    appendAssistantToHistory(messages, assistantMsg);
  }
  cfg.onAssistantReady?.(assistantMsg);

  // ══ Step D: no tool_calls → stop policy + nudges ══
  if (!hasTools) {
    if (!hasText) {
      state.emptyResponseCount++;
      if (state.emptyResponseCount === 1) {
        const m = {
          role: 'user' as const,
          content: '上一轮 API 返回了空响应。请重新回答，或继续执行必要的工具调用。',
        };
        markInjected(m);
        messages.push(m);
        emit({ type: 'step_end', iteration, timestamp: Date.now(), ...stepMetrics() });
        return { status: 'continue', metrics: stepMetrics() };
      }
    } else {
      state.emptyResponseCount = 0;
    }

    if (hasText) state.consecutiveTextOnly++;
    else state.consecutiveTextOnly = 0;

    cfg.onBeforeStopEvaluation?.({
      consecutiveTextOnly: state.consecutiveTextOnly,
      emptyResponseCount: state.emptyResponseCount,
    });

    const stopDecision = stopPolicyEvaluate({
      iteration,
      consecutiveTextOnly: state.consecutiveTextOnly,
      emptyResponseCount: state.emptyResponseCount,
      hasText,
      hasTools: false,
      isFinal: assistantMsg.isFinal,
      completionStopReason: assistantMsg.completionStopReason,
      signalAborted: signal?.aborted || false,
      plan: cfg.plan ?? null,
    });

    cfg.onStopEvaluated?.(stopDecision, assistantMsg);

    if (stopDecision.shouldStop) {
      emit({ type: 'step_end', iteration, timestamp: Date.now(), ...stepMetrics() });
      return { status: 'stop', reason: stopDecision.reason, isError: stopDecision.isError, metrics: stepMetrics() };
    }

    // Context compaction — Snip-Compact + Auto-Summary
    await maybeCompact(cfg, state, stepGroupId);

    emit({ type: 'step_end', iteration, timestamp: Date.now(), ...stepMetrics() });
    return { status: 'continue', metrics: stepMetrics() };
  }

  // ══ Step E: tool_calls → shared tool batch seam ══
  state.consecutiveTextOnly = 0;
  state.emptyResponseCount = 0;
  toolsThisIteration = assistantMsg.toolCalls.length;
  const toolBatch = buildStepToolBatch(cfg, state, stepGroupId, emit);
  const collectedResults = await runToolBatch(assistantMsg.toolCalls, toolBatch.context, toolBatch.callbacks);

  await appendToolResults(
    messages,
    collectedResults.map((r) => ({
      toolUseId: r.toolUseId,
      toolName: r.toolName,
      input: r.input,
      output: r.output,
      error: r.error,
    })),
    cfg.requestId,
    cfg.model,
  );

  cfg.onToolBatchEnd?.();

  // Context compaction after tool round
  await maybeCompact(cfg, state, stepGroupId);

  emit({
    type: 'step_end',
    iteration,
    toolsThisIteration,
    llmLatencyMs: Date.now() - stepStartedAt,
    timestamp: Date.now(),
    ...stepMetrics(),
  });
  return { status: 'continue', metrics: stepMetrics() };
}

async function maybeCompact(cfg: StepEngineConfig, state: StepState, _stepGroupId: string): Promise<void> {
  const threshold = cfg.compactTokenThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  if (!shouldCompactByTokens(state.messages, threshold)) return;
  const { emit } = cfg;
  const tokensBefore = estimateTokens(state.messages);
  const result = await compactHistory({
    messages: state.messages,
    plan: cfg.plan ?? null,
    llmConfig: { model: cfg.compactModel ?? DEFAULT_COMPACT_MODEL, apiKey: cfg.apiKey, apiBase: cfg.apiBase },
    compressMode: cfg.compressMode ?? 'snip',
    stepKeepRecent: cfg.stepKeepRecent,
  });
  state.messages.length = 0;
  state.messages.push(...result.messages);
  const tokensAfter = estimateTokens(state.messages);
  emit({
    type: 'context_compressed',
    tokensBefore,
    tokensAfter,
    messagesRemoved: result.messagesRemoved,
    tokensSaved: result.tokensSaved,
  });
}
