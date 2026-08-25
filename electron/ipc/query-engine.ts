/**
 * query-engine.ts — Unified single-track agent engine.
 *
 * Principles:
 *   1. All registered tool schemas are injected on every API call (tool_choice: "auto").
 *      The LLM itself decides whether to use tools — no human toggle gating.
 *   2. Model selection ("deepseek-v4-flash" vs "deepseek-v4-pro") and the
 *      deep-thinking switch (reasoning_effort + thinking.type) are independent
 *      parameters, matching the DeepSeek API spec.
 *   3. A single while(true) ReAct loop with a three-tier PermissionInterceptor
 *      (Ask / Plan / Auto) that governs every tool execution.
 *   4. In deep-thinking mode, reasoning_content is preserved in assistant
 *      messages across tool-call rounds — losing it causes DeepSeek 400 errors.
 */

import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { normalizeApprovalPolicy } from '../contracts/core';
import type { ApprovalPolicy } from '../types';
import type { SandboxMode } from '../sandbox-policy';
import { errorRecord, errorText } from '../errors';
import { makeTurnId, type EngineEvent } from './engine-events';
import type { ContextConfig, LoopMessage } from './agent-loop';
import { isDeniedError } from './tool-runner';
import { runStep, createStepState } from './step-engine';
import type { StepEngineConfig } from './step-engine';
import { loadAgentInstructions } from '../agent-instructions';
import { appendWorkRules, type WorkSurface } from '../work-docs-policy';
import { trackTokens, trackToolCall, trackLinesGenerated, trackSession } from './stats-handlers';
import {
  STATIC_SYSTEM_PROMPT,
  WORK_GUIDE_MESSAGE,
  buildSessionPreamble,
  prepareCacheAlignedMessages,
} from './context-manager';
import { buildModeHint, loadLlmContext, saveLlmContext, tryReplayStoredContext } from './query-context';

// ─── Types ────────────────────────────────────────────────

interface QueryRequest {
  requestId: string;
  /** Durable chat session id — enables canonical context replay across turns. */
  sessionId?: string;
  /** Model ID — "deepseek-v4-flash" (fast) or "deepseek-v4-pro" (expert). */
  model: string;
  /** Chat messages — content may be string or multimodal content-block array. */
  messages: { role: string; content: LoopMessage['content'] }[];
  /** Freshly retrieved cross-session memory preamble — appended near the tail
   *  (cache-aligned) instead of being unshifted into the conversation head. */
  memoryContext?: string;
  /** Independent thinking toggle. When true, reasoning_effort + thinking.type are set. */
  isDeepThink: boolean;
  /** Reasoning effort level: 'high' (default) or 'max'. Mapped from frontend 'low'|'medium'|'high'. */
  reasoningEffort?: 'low' | 'high' | 'max';
  projectRoot: string;
  apiKey: string;
  apiBase: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  contextConfig?: ContextConfig;
  autoApprove?: boolean;
  mode: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  /** 业务迭代上限（默认 200，1–500 收敛）。 */
  maxIterations?: number;
  /** 主模型重试耗尽后的降级模型。 */
  fallbackModel?: string;
  approvedPlanSteps?: string[];
  getPendingNudge?: () => string | null;
  win?: BrowserWindow | null;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: WorkSurface;
  /** Work 模式开工前是否先澄清（默认 true）。 */
  clarifyBeforeWork?: boolean;
}

type EventCallback = (event: EngineEvent) => void;

// ─── Constants ─────────────────────────────────────────────

/** 安全硬上限（强制终止）。业务上限由请求配置，默认 200。 */
const SAFETY_MAX_ITERATIONS = 500;

// ─── Permission interceptor (three-tier guard) ─────────────

async function permissionInterceptor(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
  req: QueryRequest,
): Promise<boolean> {
  // Tier 1: Auto — execute everything, no questions asked
  if (req.mode === 'auto' || req.autoApprove) {
    return true;
  }

  // Tier 2: Plan — approved plan steps auto-pass; others blocked
  if (req.mode === 'plan') {
    // If the tool matches an approved plan step, allow
    if (req.approvedPlanSteps && req.approvedPlanSteps.length > 0) {
      // Plan steps are matched by caller — for query path without a plan,
      // fall through to the permission handler
    }
  }

  // Tier 3: Ask — IPC-based permission dialog
  if (req.checkPermission) {
    return req.checkPermission(toolName, input, toolCallId);
  }

  // Default: deny (shouldn't reach here in normal flow)
  return false;
}

// ─── Context-compression helpers ───────────────────────────

/** Snapshot head must match the CURRENT app version — system prompt, session
 *  preamble (platform/project/thinking) and work guide are all part of the
 *  cache prefix. After an app upgrade or project switch, replay would keep
 *  serving stale instructions, so it must fall back to fresh assembly. */
function storedHeadIsCurrent(stored: LoopMessage[], req: QueryRequest): boolean {
  if (!Array.isArray(stored) || stored.length < 3) return false;
  const expectedPreamble = buildSessionPreamble({
    platform: process.platform,
    projectRoot: req.projectRoot,
    isDeepThink: req.isDeepThink,
  });
  return (
    stored[0]?.role === 'system' &&
    stored[0]?.content === STATIC_SYSTEM_PROMPT &&
    stored[1]?.role === 'user' &&
    stored[1]?.content === expectedPreamble &&
    stored[2]?.role === 'user' &&
    stored[2]?.content === WORK_GUIDE_MESSAGE
  );
}

// ─── Main unified while(true) ReAct loop ──────────────────

async function runUnifiedLoop(req: QueryRequest, emit: EventCallback, signal: AbortSignal): Promise<void> {
  const instructions = await loadAgentInstructions(req.projectRoot);
  let modeHint = buildModeHint(req.mode);
  // Work 模式规则（docs-only + 开工前澄清）挂在 mode hint 上：同一会话内
  // 前缀稳定，且 replay 时也会被 tryReplayStoredContext 整体替换。
  modeHint = appendWorkRules(modeHint, req.surface, { clarify: req.clarifyBeforeWork });

  // Canonical replay: if the previous turn stored the exact messages that
  // were sent to the LLM, reuse them (including assistant tool_calls + tool
  // results) and append only the new memory preamble + user message at the
  // tail. This keeps the request prefix byte-stable for DeepSeek's cache and
  // restores tool history that the renderer's text-only payload drops.
  let messages: LoopMessage[] | null = null;
  if (req.sessionId) {
    let stored: LoopMessage[] | null = null;
    try {
      stored = await loadLlmContext(req.sessionId);
    } catch (error: unknown) {
      // Snapshot read failure must not break the turn — degrade to fresh.
      console.warn('[query-engine] loadLlmContext failed, falling back to fresh assembly:', errorText(error));
    }
    if (stored && stored.length > 0 && storedHeadIsCurrent(stored, req)) {
      const replay = tryReplayStoredContext(stored, req.messages, instructions, modeHint, req.memoryContext);
      if (replay.ok) messages = replay.messages;
    }
  }

  if (!messages) {
    messages = prepareCacheAlignedMessages({
      platform: process.platform,
      projectRoot: req.projectRoot,
      isDeepThink: req.isDeepThink,
      chatMessages: req.messages,
    });
    // Cache-Aware Prompt Compression: dynamic memory goes right before the
    // current user message (tail), never at the conversation head.
    if (req.memoryContext?.trim()) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      const memoryMsg = { role: 'user' as const, content: req.memoryContext.trim() };
      if (lastUserIdx >= 0) messages.splice(lastUserIdx, 0, memoryMsg);
      else messages.push(memoryMsg);
    }
    if (instructions.trim()) {
      messages.push({
        role: 'user' as const,
        content: `## 项目指令（AGENTS.md）\n${instructions.trim()}\n请严格遵循以上项目指令执行任务。`,
      });
      emit({
        type: 'context_injected',
        source: 'instructions',
        producer: 'AGENTS.md',
        detail: '项目指令已注入对话上下文',
      });
    }
    messages.push({ role: 'user' as const, content: modeHint });
  }

  // Shared StepEngine — runStep owns one full ReAct iteration (LLM + tools +
  // stop policy + compaction); this driver owns turn lifecycle + termination.
  const state = createStepState(messages);
  const businessMax = Math.min(SAFETY_MAX_ITERATIONS, Math.max(1, req.maxIterations ?? 200));
  const turnId = makeTurnId(req.requestId);
  emit({ type: 'turn_start', turnId, timestamp: Date.now() });

  const subAgentIds = new Map<number, string>();
  const engineConfig: StepEngineConfig = {
    requestId: req.requestId,
    model: req.model,
    apiKey: req.apiKey,
    apiBase: req.apiBase,
    systemPrompt: STATIC_SYSTEM_PROMPT,
    projectRoot: req.projectRoot,
    mode: req.mode,
    sandboxMode: req.sandboxMode,
    approvedPlanSteps: req.approvedPlanSteps,
    checkPermission: req.checkPermission,
    autoApprove: true,
    signal,
    isDeepThink: req.isDeepThink,
    reasoningEffort: req.reasoningEffort,
    surface: req.surface,
    getPendingNudge: req.getPendingNudge,
    fallbackModel: req.fallbackModel,
    emit,
    onUsage: (usage) => {
      trackTokens(usage.inputTokens, usage.outputTokens).catch(() => {});
    },
    preCheckPermission: (toolName, input, toolCallId) => permissionInterceptor(toolName, input, toolCallId, req),
    onBeforeToolDispatch: (tc) => {
      // ── Sub-agent spawn tracking (pre-flight for Agent tools) ──
      if (tc.name === 'Agent') {
        const subAgentId = `sub-agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        subAgentIds.set(tc.index, subAgentId);
        tc.input._agentId = subAgentId;
        if (req.win && !req.win.isDestroyed()) {
          req.win.webContents.send('agent:updated', {
            id: subAgentId,
            agentId: subAgentId,
            name: `${tc.input.subagent_type || 'general-purpose'}: ${tc.input.description || '子任务'}`,
            description: tc.input.prompt || tc.input.description || '',
            type: tc.input.subagent_type || 'general-purpose',
            status: 'running',
            priority: 'normal',
            startTime: Date.now(),
            iteration: 0,
            maxIterations: 25,
            toolCallCount: 0,
            messagesCount: 0,
            model: req.model,
            log: [],
          });
        }
      }
    },

    onToolResult: (r, tc, _toolCallId) => {
      const durationMs = r.durationMs;
      const isAbort = r.error === '用户手动中止' || isDeniedError(r.error);
      if (r.error) {
        if (!isAbort) trackToolCall(false, durationMs).catch(() => {});

        if (tc.name === 'Agent' && req.win && !req.win.isDestroyed()) {
          try {
            req.win.webContents.send('agent:updated', {
              id: subAgentIds.get(tc.index) || '',
              status: 'error',
              error: r.error,
              endTime: Date.now(),
            });
          } catch {
            /* best-effort */
          }
        }
      } else {
        // Stats tracking
        trackToolCall(true, durationMs).catch(() => {});
        if (tc.name === 'Write' || tc.name === 'Edit') {
          const content = (tc.input as Record<string, unknown>)?.content as string | undefined;
          const lines = content ? content.split('\n').length : 0;
          trackLinesGenerated(lines).catch(() => {});
        }

        if (tc.name === 'Agent' && req.win && !req.win.isDestroyed()) {
          try {
            req.win.webContents.send('agent:updated', {
              id: subAgentIds.get(tc.index) || '',
              status: 'completed',
              result: typeof r.output === 'string' ? r.output : JSON.stringify(r.output).slice(0, 500),
              toolCallCount:
                r.output && typeof r.output === 'object' && !Array.isArray(r.output)
                  ? Number((r.output as Record<string, unknown>).toolCallCount) || 0
                  : 0,
              iteration:
                r.output && typeof r.output === 'object' && !Array.isArray(r.output)
                  ? Number((r.output as Record<string, unknown>).iterations) || 0
                  : 0,
              endTime: Date.now(),
            });
          } catch {
            /* best-effort */
          }
        }
      }
    },
  };

  // ── Thin driver: termination checks + one step per iteration ──
  let completedNaturally = false;
  while (true) {
    if (signal.aborted) break;

    state.iteration++;
    if (state.iteration > businessMax) {
      emit({
        type: 'error',
        error: `已达到业务迭代上限 ${businessMax} 次，任务暂停收尾。已完成 ${state.toolCallCount} 次工具调用。`,
      });
      break;
    }
    if (state.iteration > SAFETY_MAX_ITERATIONS) {
      emit({ type: 'error', error: `达到安全上限 ${SAFETY_MAX_ITERATIONS} 次迭代，强制终止。` });
      break;
    }

    const outcome = await runStep(engineConfig, state, crypto.randomUUID());
    if (outcome.status === 'stop') {
      completedNaturally = true;
      break;
    }
    if (outcome.status === 'aborted') break;
  }

  if (completedNaturally && req.sessionId) {
    try {
      await saveLlmContext(req.sessionId, state.messages);
    } catch (error: unknown) {
      // Persistence is best-effort — the reply already streamed successfully.
      console.warn('[query-engine] saveLlmContext failed (cache alignment degraded):', errorText(error));
    }
  }

  emit({ type: 'turn_end', turnId, reason: signal.aborted ? 'aborted' : 'completed', timestamp: Date.now() });
}
// ─── Public entry point ───────────────────────────────────

export async function runQuery(req: QueryRequest, emit: EventCallback, signal: AbortSignal): Promise<void> {
  // Normalise approval policy — chat queries are always explicit-ask; plan
  // and auto flows go through per-task agent configs instead. Legacy 'afe'
  // spellings from old clients are folded into 'auto' here.
  req.mode = normalizeApprovalPolicy(req.mode);

  try {
    trackSession().catch(() => {});
    await runUnifiedLoop(req, emit, signal);

    if (!signal.aborted) {
      emit({ type: 'done' });
    }
  } catch (error: unknown) {
    const apiError = errorRecord(error);
    const status =
      typeof apiError.response === 'object' && apiError.response
        ? (apiError.response as { status?: number }).status
        : undefined;
    if (apiError.name === 'AbortError' || apiError.code === 'ERR_CANCELED') return;

    const message =
      status === 401
        ? 'API Key 无效或已过期'
        : status === 429
          ? '请求过于频繁，请稍后重试'
          : status === 402
            ? '账户余额不足，请前往 DeepSeek 平台充值后重试'
            : status === 503
              ? '服务繁忙，请稍后重试'
              : status === 500
                ? '服务器故障，请稍后重试'
                : status
                  ? `API 错误 (${status})`
                  : `请求失败: ${errorText(error)}`;

    emit({ type: 'error', error: message });
  }
}
