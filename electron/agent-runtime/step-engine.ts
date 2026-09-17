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
import type { EngineEvent } from './engine-events';
import type { ToolDef } from '../tool-defs';

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

import { runtimePorts } from './ports';
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
const DEFAULT_COMPACT_MODEL = 'deepseek-flash';

interface StepTracker {
  startedAt: number;
  firstTokenAt: number | null;
  outputTokens: number;
}

function metricsOf(tracker: StepTracker): StepMetrics {
  return {
    firstTokenMs: tracker.firstTokenAt !== null ? tracker.firstTokenAt - tracker.startedAt : undefined,
    outputTokens: tracker.outputTokens,
  };
}

/** Pause/stop aborts surface as CanceledError/ERR_CANCELED from axios, not AbortError. */
function isAbortError(apiError: ReturnType<typeof errorRecord>, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return apiError.name === 'AbortError' || apiError.name === 'CanceledError' || apiError.code === 'ERR_CANCELED';
}

function parseApiDetail(errorBody: string): string {
  try {
    const p = JSON.parse(errorBody) as { message?: string; error?: string | { message?: string } };
    if (typeof p?.error === 'string') return p.error;
    if (typeof p?.error === 'object') return p?.error?.message ?? '';
    return p?.message ?? '';
  } catch {
    return errorBody.slice(0, 200);
  }
}

/** 最终 API 失败：给出可读原因并抛出原始错误（调用方负责收尾）。 */
async function raiseApiFailure(lastApiErr: unknown, emit: (event: EngineEvent) => void): Promise<never> {
  const savedApiError = errorRecord(lastApiErr);
  const errorBody = await readErrorBody(lastApiErr);
  const apiDetail = parseApiDetail(errorBody);
  const response =
    typeof savedApiError.response === 'object' && savedApiError.response
      ? (savedApiError.response as { status?: number; statusText?: string })
      : undefined;
  const errMsg = response?.status
    ? `API 请求失败 (HTTP ${response.status}): ${apiDetail || response.statusText || errorText(lastApiErr)}`
    : `API 请求失败: ${errorText(lastApiErr)}`;
  console.error('[step-engine] API error:', { status: response?.status, body: errorBody.slice(0, 500) });
  emit({ type: 'error', error: errMsg });
  throw lastApiErr;
}

/** 步前把队列里的 nudge 注入为 user 消息（去重后）。 */
function injectPendingNudge(cfg: StepEngineConfig, state: StepState): void {
  deduplicateNudges(state.messages);
  const nudge = cfg.getPendingNudge?.();
  if (!nudge) return;
  const m = { role: 'user' as const, content: nudge };
  markInjected(m);
  state.messages.push(m);
}

/** 时间/tmux 上下文注入 + 请求前钩子（必须发生在 request_start 之后、调用之前）。 */
async function injectStepContext(cfg: StepEngineConfig, state: StepState): Promise<void> {
  if (cfg.timeContext) {
    const tc = buildTimeContextMessage(state.startedAt, Date.now());
    markInjected(tc);
    state.messages.push(tc);
  }
  if (cfg.tmuxContext) {
    const location = await resolveTmuxLocation();
    if (location) {
      const tc = buildTmuxContextMessage(location);
      markInjected(tc);
      state.messages.push(tc);
    }
  }
  await cfg.onBeforeRequest?.(state.messages);
}

interface LlmAttempt {
  assistantMsg: AssistantMessage | null;
  lastApiErr: unknown;
  aborted: boolean;
}

/** 调用 LLM；429/5xx/网络错误按指数退避重试，必要时降级到 fallback 模型。 */
async function invokeLlmWithRetry(
  cfg: StepEngineConfig,
  state: StepState,
  messages: LoopMessage[],
  tools: ToolDef[],
  tracker: StepTracker,
  emit: (event: EngineEvent) => void,
): Promise<LlmAttempt> {
  const { signal } = cfg;
  const maxRetries = DEFAULT_MAX_RETRIES;
  const baseDelay = cfg.retryBaseDelayMs ?? 2000;
  const fallback = cfg.fallbackModel && cfg.fallbackModel !== cfg.model ? cfg.fallbackModel : undefined;
  const totalAttempts = maxRetries + (fallback ? 1 : 0);
  let usedFallback = false;
  let lastApiErr: unknown;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (signal?.aborted) break;
    try {
      const assistantMsg = await invokeLlm({
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
          if (tracker.firstTokenAt === null) tracker.firstTokenAt = Date.now();
          state.allText += text;
          emit({ type: 'text_chunk', text });
        },
        onThinkingChunk: (chunk, isNewBlock) => {
          if (tracker.firstTokenAt === null) tracker.firstTokenAt = Date.now();
          emit({ type: 'thinking_chunk', chunk, isNewBlock });
        },
        onUsage: (usage) => {
          const { inputTokens, outputTokens, reasoningTokens, cacheHitTokens, cacheMissTokens } = usage;
          tracker.outputTokens += outputTokens;
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
      return { assistantMsg, lastApiErr: undefined, aborted: false };
    } catch (apiErr: unknown) {
      const apiError = errorRecord(apiErr);
      const status =
        typeof apiError.response === 'object' && apiError.response
          ? (apiError.response as { status?: number }).status
          : undefined;
      if (isAbortError(apiError, signal)) return { assistantMsg: null, lastApiErr: apiErr, aborted: true };
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
        if (signal?.aborted) return { assistantMsg: null, lastApiErr: apiErr, aborted: true };
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
  return { assistantMsg: null, lastApiErr, aborted: false };
}

/** max_tokens 截断守卫：把截断的最终回答改回非最终态并请求续写。 */
function applyTruncationGuard(
  assistantMsg: AssistantMessage,
  state: StepState,
  messages: LoopMessage[],
  emit: (event: EngineEvent) => void,
): void {
  if (!assistantMsg.isFinal || assistantMsg.completionStopReason !== 'max_tokens') return;
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

/** 无 tool_calls：空响应补救 → 停止策略 → 上下文压缩。 */
async function finishWithoutTools(
  cfg: StepEngineConfig,
  state: StepState,
  messages: LoopMessage[],
  assistantMsg: AssistantMessage,
  iteration: number,
  stepGroupId: string,
  tracker: StepTracker,
  emit: (event: EngineEvent) => void,
): Promise<StepOutcome> {
  const hasText = assistantMsg.contentTimeline.some((b) => b.type === 'text');
  if (!hasText) {
    state.emptyResponseCount++;
    if (state.emptyResponseCount === 1) {
      const m = {
        role: 'user' as const,
        content: '上一轮 API 返回了空响应。请重新回答，或继续执行必要的工具调用。',
      };
      markInjected(m);
      messages.push(m);
      emit({ type: 'step_end', iteration, timestamp: Date.now(), ...metricsOf(tracker) });
      return { status: 'continue', metrics: metricsOf(tracker) };
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
    signalAborted: cfg.signal?.aborted || false,
    plan: cfg.plan ?? null,
  });

  cfg.onStopEvaluated?.(stopDecision, assistantMsg);

  if (stopDecision.shouldStop) {
    emit({ type: 'step_end', iteration, timestamp: Date.now(), ...metricsOf(tracker) });
    return { status: 'stop', reason: stopDecision.reason, isError: stopDecision.isError, metrics: metricsOf(tracker) };
  }

  // Context compaction — Snip-Compact + Auto-Summary
  await maybeCompact(cfg, state, stepGroupId);
  emit({ type: 'step_end', iteration, timestamp: Date.now(), ...metricsOf(tracker) });
  return { status: 'continue', metrics: metricsOf(tracker) };
}

/** 有 tool_calls：走共享工具批次 seam，结果回填历史后压缩上下文。 */
async function finishWithTools(
  cfg: StepEngineConfig,
  state: StepState,
  messages: LoopMessage[],
  assistantMsg: AssistantMessage,
  iteration: number,
  stepGroupId: string,
  tracker: StepTracker,
  emit: (event: EngineEvent) => void,
): Promise<StepOutcome> {
  state.consecutiveTextOnly = 0;
  state.emptyResponseCount = 0;
  const toolsThisIteration = assistantMsg.toolCalls.length;
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
    llmLatencyMs: Date.now() - tracker.startedAt,
    timestamp: Date.now(),
    ...metricsOf(tracker),
  });
  return { status: 'continue', metrics: metricsOf(tracker) };
}

/**
 * Run one full ReAct iteration. Mutates `state` (messages + counters) and
 * returns what the driver should do next.
 */
export async function runStep(cfg: StepEngineConfig, state: StepState, stepGroupId: string): Promise<StepOutcome> {
  const { emit, signal } = cfg;
  const messages = state.messages;
  const iteration = state.iteration;

  injectPendingNudge(cfg, state);
  emit({ type: 'iteration_start', iteration, timestamp: Date.now() });
  emit({ type: 'step_start', iteration, timestamp: Date.now() });
  const tracker: StepTracker = { startedAt: Date.now(), firstTokenAt: null, outputTokens: 0 };

  await injectStepContext(cfg, state);
  emit({ type: 'request_start', model: cfg.model, provider: cfg.adapter ?? 'deepseek', timestamp: Date.now() });
  const tools = cfg.tools ?? runtimePorts().listTools();

  const attempt = await invokeLlmWithRetry(cfg, state, messages, tools, tracker, emit);
  if (attempt.aborted || signal?.aborted) return { status: 'aborted' };
  if (!attempt.assistantMsg) {
    if (attempt.lastApiErr) await raiseApiFailure(attempt.lastApiErr, emit);
    return { status: 'aborted' };
  }

  const assistantMsg = attempt.assistantMsg;
  applyTruncationGuard(assistantMsg, state, messages, emit);
  const hasText = assistantMsg.contentTimeline.some((b) => b.type === 'text');
  const hasTools = assistantMsg.toolCalls.length > 0;

  if (hasText || hasTools) appendAssistantToHistory(messages, assistantMsg);
  cfg.onAssistantReady?.(assistantMsg);

  return hasTools
    ? finishWithTools(cfg, state, messages, assistantMsg, iteration, stepGroupId, tracker, emit)
    : finishWithoutTools(cfg, state, messages, assistantMsg, iteration, stepGroupId, tracker, emit);
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
