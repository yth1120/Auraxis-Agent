/**
 * step-engine.ts — unified ReAct step driver (Phase 2).
 *
 * ONE step = one LLM request (with retry) + optional tool batch + history
 * append + stop-policy evaluation + context compaction. The caller owns turn
 * lifecycle and termination (safety cap / abort); runStep owns everything
 * that happens inside a single iteration, so query-engine and agent-loop no
 * longer re-implement the same body twice.
 */
import type { ApprovalPolicy } from '../types';
import type { WorkAutonomyTier } from '../types';
import type { ToolDef } from '../tool-defs';
import type { SandboxMode } from '../sandbox-policy';
import { writeSpill } from '../spill';
import type { AssistantMessage, ContextConfig, TaskPlan } from './agent-loop';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import {
  stopPolicyEvaluate,
  markInjected,
  deduplicateNudges,
  appendAssistantToHistory,
  readErrorBody,
} from './agent-loop';
import { invokeLlm, buildToolResultContent, buildToolResultText, isDeepSeekVisionModel } from './llm-adapter';
import { getShellExecutor } from './shell-executor';
import { runToolBatch, isDeniedError } from './tool-runner';
import type { RunnerToolCall, RunnerToolResult } from './tool-runner';
import { getAllTools } from '../tool-registry';
import { shouldCompactByTokens, compactHistory, estimateTokens } from './context-manager';
import type { EngineEvent } from './engine-events';
import type { StopDecision } from './agent-loop';

// ─── State ──────────────────────────────────────────────

/** Mutable per-run state threaded through every step. */
export interface StepState {
  messages: any[];
  iteration: number;
  toolCallCount: number;
  consecutiveTextOnly: number;
  emptyResponseCount: number;
  allText: string;
  /** Session start time — used for per-step time context. */
  startedAt: number;
}

export function createStepState(messages: any[]): StepState {
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

export function buildTimeContextMessage(startedAt: number, now: number): { role: 'system'; content: string } {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const elapsedText = h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
  return {
    role: 'system',
    content: `[时间上下文] 当前时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}；本轮会话已运行 ${elapsedText}。`,
  };
}

// ─── tmux context (tmux 上下文) ────────────

let cachedTmuxLocation: string | null | undefined;

/** Resolve the current tmux session:window.pane once per process. */
export async function resolveTmuxLocation(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  if (cachedTmuxLocation !== undefined) return cachedTmuxLocation;
  try {
    const result = await getShellExecutor().run({
      command: 'tmux',
      args: ['display-message', '-p', '#S:#W.#P'],
      shell: false,
      timeoutMs: 2000,
    });
    cachedTmuxLocation = (result.stdout || '').trim() || null;
  } catch {
    cachedTmuxLocation = null;
  }
  return cachedTmuxLocation;
}

/** Test seam — clears the memoized tmux location. */
export function resetTmuxLocationCache(): void {
  cachedTmuxLocation = undefined;
}

export function buildTmuxContextMessage(location: string, now = Date.now()): { role: 'system'; content: string } {
  return {
    role: 'system',
    content: `[tmux 上下文] 当前位于 tmux ${location}（${new Date(now).toLocaleString('zh-CN', { hour12: false })}）`,
  };
}

// ─── Config ─────────────────────────────────────────────

export interface StepEngineConfig {
  requestId: string;
  /** Stable agent/session identity for goal + report tools. Defaults to requestId. */
  sessionId?: string;
  model: string;
  apiKey: string;
  apiBase: string;
  systemPrompt: string;
  projectRoot: string;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  /** Work 模式执行自主度档位（透传到工具门禁）。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  signal?: AbortSignal;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  /** LLM adapter id — defaults to the built-in deepseek adapter. */
  adapter?: string;
  /** 主模型重试耗尽后的降级模型（如 deepseek-v4-flash）。 */
  fallbackModel?: string;
  /** Tool schemas injected into every request (defaults to all tools). */
  tools?: ToolDef[];
  /** External retry nudge (ai:retryTool IPC). */
  getPendingNudge?: () => string | null;
  /** Active plan — used by compaction's critical-result preservation. */
  plan?: TaskPlan | null;
  /** Model used for LLM summaries during compaction. */
  compactModel?: string;
  /** Token threshold that triggers compaction. */
  compactTokenThreshold?: number;
  /** 压缩策略：'snip'（默认原子组截断）或 'step'（AGORA 步骤级压缩）。 */
  compressMode?: 'snip' | 'step';
  /** step 策略下保留的最近步骤数。 */
  stepKeepRecent?: number;
  /** Retry base delay in ms (backoff = base * 2^attempt). */
  retryBaseDelayMs?: number;
  /** LLM temperature. */
  temperature?: number;
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  /** Sub-agent recursion depth for dispatched tools. */
  depth?: number;
  /** Agent 显示名（用于 MAP-Graph 角色自动绑定）。 */
  agentName?: string;
  /** Per-call sandbox mode; falls back to AURAXIS_SANDBOX_MODE env, then full. */
  sandboxMode?: SandboxMode;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: 'chat' | 'work' | 'code';
  /** Inject per-step current-time + elapsed context (Agent mode default on). */
  timeContext?: boolean;
  /** Inject the current tmux session:window.pane before each step (opt-in). */
  tmuxContext?: boolean;
  /** Override the toolCallId used for lifecycle events (defaults to a per-call generated id). */
  makeToolCallId?: (tc: RunnerToolCall) => string;
  /**
   * Synthetic tool seam — loop-owned tools such as Replan return a result
   * here instead of being dispatched to the tool handlers.
   */
  interceptTool?: (tc: RunnerToolCall, toolCallId: string) => Promise<{ output: unknown; error?: string } | null>;
  /** Called before each LLM request (driver hooks / deviance prep). May mutate messages. */
  onBeforeRequest?: (messages: any[]) => Promise<void> | void;
  /** Called after the assistant message is appended (plan conflict etc.). May mutate msg/messages. */
  onAssistantReady?: (msg: AssistantMessage) => void;
  /** Called after text-only counters are updated, right before stop-policy evaluation. */
  onBeforeStopEvaluation?: (counters: { consecutiveTextOnly: number; emptyResponseCount: number }) => void;
  /** Called after stop-policy evaluation (review-gate reminders etc.). */
  onStopEvaluated?: (decision: StopDecision, msg: AssistantMessage) => void;
  /** Called after a tool batch finishes (plan / review-gate bookkeeping). */
  onToolBatchEnd?: () => void;
  /** Build a structured summary attached to canonical `tool_end` events. */
  onToolSummary?: (r: RunnerToolResult, tc: RunnerToolCall) => Record<string, unknown> | undefined;
  /** Called after the engine emits `usage` (stats etc.). */
  onUsage?: (usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  }) => void;
  /** Pre-flight permission gate — denied calls are not executed. */
  preCheckPermission?: (toolName: string, input: Record<string, unknown>, toolCallId: string) => Promise<boolean>;
  /** MAP-Graph 记忆风险门控（M5，opt-in）。 */
  riskGate?: (toolName: string, input: Record<string, unknown>, toolCallId: string) => Promise<{ allowed: boolean; reason?: string }>;
  onBeforeToolDispatch?: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolStart?: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolProgress?: (tc: RunnerToolCall, toolCallId: string, chunk: string) => void;
  /** Per-result side effects (stats, sub-agent updates, deviance warnings). */
  onToolResult?: (result: RunnerToolResult, tc: RunnerToolCall, toolCallId: string) => void;
  /** Test seam — defaults to the real tool dispatcher. */
  executeTool?: typeof import('./tool-handlers').executeToolCall;
  emit: (event: EngineEvent) => void;
}

// ─── Outcome ────────────────────────────────────────────

export type StepOutcome =
  | { status: 'continue'; metrics?: StepMetrics }
  | { status: 'stop'; reason: string; isError: boolean; metrics?: StepMetrics }
  | { status: 'aborted'; metrics?: StepMetrics };

export interface StepMetrics {
  firstTokenMs?: number;
  outputTokens?: number;
}

// ─── Tool result append (preserves API protocol) ─────────

const SPILL_ABOVE_CHARS = 30_000;
const SPILL_PREVIEW_CHARS = 1_200;

async function appendToolResults(
  messages: any[],
  results: { toolUseId: string; toolName: string; input: Record<string, unknown>; output: unknown; error?: string }[],
  sessionId?: string,
  model = '',
): Promise<void> {
  const imageUserParts: Array<Record<string, unknown>> = [];
  for (const tr of results) {
    const raw = tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.output);
    let content = raw;
    if (!tr.error && !isImageResult(tr.output) && raw.length > SPILL_ABOVE_CHARS) {
      try {
        const ref = await writeSpill(raw, { sessionId, toolName: tr.toolName, toolCallId: tr.toolUseId });
        content = JSON.stringify({
          spill_path: ref.path,
          spill_bytes: ref.bytes,
          preview: raw.slice(0, SPILL_PREVIEW_CHARS),
          note: '输出过大已落盘，可用 ReadSpill 读取完整内容',
        });
      } catch {
        // Spill is best-effort — keep the raw output if the store fails.
      }
    }
    const imageResult = !tr.error && isImageResult(tr.output);
    const toolContent = imageResult ? buildToolResultText(tr.output) : content;
    messages.push({
      role: 'tool' as const,
      tool_call_id: tr.toolUseId,
      content: toolContent,
    });
    if (imageResult && isDeepSeekVisionModel(model)) {
      const imageParts = buildToolResultContent(tr.output);
      if (Array.isArray(imageParts)) imageUserParts.push(...imageParts);
    }
  }
  if (imageUserParts.length > 0) {
    messages.push({ role: 'user' as const, content: imageUserParts });
  }
}

function isImageResult(output: unknown): boolean {
  const obj = (output && typeof output === 'object' ? output : null) as Record<string, unknown> | null;
  return !!obj && typeof obj.image === 'string' && obj.image.startsWith('data:image/');
}

// ─── Step driver ────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_COMPACT_THRESHOLD = 100_000;
const DEFAULT_COMPACT_MODEL = 'deepseek-v4-flash';

/**
 * Run one full ReAct iteration. Mutates `state` (messages + counters) and
 * returns what the driver should do next.
 */
export async function runStep(
  cfg: StepEngineConfig,
  state: StepState,
  stepGroupId: string,
): Promise<StepOutcome> {
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
  let lastApiErr: any;
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
    } catch (apiErr: any) {
      // Pause/stop aborts the in-flight request — axios surfaces these as
      // CanceledError/ERR_CANCELED, NOT AbortError. They must never be
      // reported as "API 请求失败: canceled".
      if (
        apiErr?.name === 'AbortError'
        || apiErr?.name === 'CanceledError'
        || apiErr?.code === 'ERR_CANCELED'
        || signal?.aborted
      ) break;
      lastApiErr = apiErr;
      const isRetryable =
        apiErr.response?.status === 429 ||
        (apiErr.response?.status && apiErr.response.status >= 500) ||
        apiErr.code === 'ECONNRESET' || apiErr.code === 'ETIMEDOUT';
      if (isRetryable && attempt < maxRetries - 1) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 16000);
        emit({ type: 'system_message', level: 'info', content: `API 请求失败 (${apiErr.response?.status || apiErr.code})，${Math.round(delay / 1000)}s 后重试...` });
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
    // Pause/stop surfaces as CanceledError/ERR_CANCELED from axios even when
    // the AbortSignal flag hasn't flipped yet — never report that as an API
    // failure ("API 请求失败: canceled").
    if (
      lastApiErr.name === 'AbortError'
      || lastApiErr.name === 'CanceledError'
      || lastApiErr.code === 'ERR_CANCELED'
    ) {
      return { status: 'aborted' };
    }
    const errorBody = await readErrorBody(lastApiErr);
    let apiDetail = '';
    try { const p = JSON.parse(errorBody); apiDetail = p?.error?.message || p?.message || p?.error || ''; }
    catch { apiDetail = errorBody.slice(0, 200); }
    const errMsg = lastApiErr.response?.status
      ? `API 请求失败 (HTTP ${lastApiErr.response.status}): ${apiDetail || lastApiErr.response.statusText || lastApiErr.message}`
      : `API 请求失败: ${lastApiErr.message}`;
    console.error('[step-engine] API error:', { status: lastApiErr.response?.status, body: errorBody.slice(0, 500) });
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
  const sandboxMode: SandboxMode = cfg.sandboxMode
    ?? (process.env.AURAXIS_SANDBOX_MODE === 'read' || process.env.AURAXIS_SANDBOX_MODE === 'workspace-write'
      ? process.env.AURAXIS_SANDBOX_MODE
      : 'full');

  const collectedResults = await runToolBatch(assistantMsg.toolCalls, {
    projectRoot: cfg.projectRoot,
    requestId: cfg.requestId,
    // 权限路由 / 工作区会话 / 冲突检测都以稳定任务 ID 为 key；
    // requestId 是每次运行的随机 ID，不能当 agentId 用。
    agentId: cfg.sessionId ?? cfg.requestId,
    sessionId: cfg.sessionId ?? cfg.requestId,
    checkPermission: cfg.checkPermission,
    autoApprove: cfg.autoApprove,
    abortSignal: signal,
    mode: cfg.mode,
    approvedPlanSteps: cfg.approvedPlanSteps,
    workTier: cfg.workTier,
    workspaceRoots: cfg.workspaceRoots,
    writableRoots: cfg.writableRoots,
    depth: cfg.depth,
    sandboxMode,
    surface: cfg.surface,
    stepGroupId,
    executeTool: cfg.executeTool,
    interceptTool: cfg.interceptTool,
    riskGate: cfg.riskGate ?? (
      process.env.AURAXIS_MEMORY_RISK_GATE === '1'
        ? async (toolName: string) => {
            const { createMemoryRiskGate, recordRiskAudit, roleForAgent } = await import('./memory-graph');
            const role = roleForAgent(cfg.agentName || '');
            const verdict = createMemoryRiskGate(cfg.projectRoot, role)(toolName);
            if (!verdict.allowed) recordRiskAudit(cfg.projectRoot, toolName, verdict);
            return Promise.resolve({ allowed: verdict.allowed, reason: verdict.reason });
          }
        : undefined
    ),
  }, {
    makeToolCallId: cfg.makeToolCallId ?? ((tc) => `tc-${Date.now()}-${tc.name}`),
    preCheckPermission: cfg.preCheckPermission,
    onBeforeDispatch: cfg.onBeforeToolDispatch,
    onToolStart: (tc, toolCallId) => {
      state.toolCallCount++;
      // Canonical tool lifecycle events — emitted by the engine, not by callers.
      emit({ type: 'tool_start', toolCallId, toolName: tc.name, input: tc.input, stepGroupId: tc.stepGroupId ?? '' });
      cfg.onToolStart?.(tc, toolCallId);
    },
    onToolProgress: (tc, toolCallId, chunk) => {
      emit({ type: 'tool_progress', toolCallId, toolName: tc.name, input: tc.input, progress: chunk, stepGroupId: tc.stepGroupId ?? '' });
      cfg.onToolProgress?.(tc, toolCallId, chunk);
    },
    onToolResult: (r, tc, toolCallId) => {
      const isAbort = r.error === '用户手动中止' || isDeniedError(r.error);
      if (r.error) {
        emit({ type: isAbort ? 'tool_aborted' : 'tool_error',
          toolCallId, toolName: tc.name, input: tc.input, error: r.error, stepGroupId: tc.stepGroupId ?? '' });
      } else {
        emit({ type: 'tool_end',
          toolCallId, toolName: tc.name, input: tc.input, output: r.output, durationMs: r.durationMs, stepGroupId: tc.stepGroupId ?? '',
          summary: cfg.onToolSummary?.(r, tc) });
      }
      cfg.onToolResult?.(r, tc, toolCallId);
    },
  });

  await appendToolResults(messages, collectedResults.map((r) => ({
    toolUseId: r.toolUseId,
    toolName: r.toolName,
    input: r.input,
    output: r.output,
    error: r.error,
  })), cfg.requestId, cfg.model);

  cfg.onToolBatchEnd?.();

  // Context compaction after tool round
  await maybeCompact(cfg, state, stepGroupId);

  emit({ type: 'step_end', iteration, toolsThisIteration, llmLatencyMs: Date.now() - stepStartedAt, timestamp: Date.now(), ...stepMetrics() });
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
  emit({ type: 'context_compressed', tokensBefore, tokensAfter,
    messagesRemoved: result.messagesRemoved, tokensSaved: result.tokensSaved });
}
