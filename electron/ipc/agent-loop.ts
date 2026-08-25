import { errorText } from '../errors';
import crypto from 'crypto';
import path from 'path';
import { readdir } from 'fs/promises';
import { executeToolCall } from './tool-handlers';
import { runHooksFor } from '../hooks';
import { loadAgentInstructions } from '../agent-instructions';
import { appendWorkRules } from '../work-docs-policy';
import type { ToolDef } from '../tool-defs';
import type { BatchToolResult } from '../tool-registry';
import { estimateTokensForMessages } from '../utils/token-counter';
import { compressHistorySteps } from '../step-compressor';
import { workspaceDrift, driftSummary } from '../workspace-drift';
import { devLog } from './shared';
import { invokeLlm, llmClientInvoke } from './llm-adapter';
import { runStep, createStepState } from './step-engine';
import type { StepEngineConfig } from './step-engine';
import { makeTurnId } from './engine-events';
import type { DeepSeekToolChoice } from '../contracts/advanced';

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v).slice(0, 500);
  }
}

/** Read error response body when axios responseType='stream' — the body is a Readable, not parsed JSON. */
export async function readErrorBody(err: any): Promise<string> {
  try {
    const data = err?.response?.data;
    if (!data) return '';
    if (typeof data.on === 'function') {
      return await new Promise<string>((resolve) => {
        let body = '';
        const t = setTimeout(() => resolve(body), 2000);
        data.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 2000) {
            clearTimeout(t);
            data.destroy();
            resolve(body);
          }
        });
        data.on('end', () => {
          clearTimeout(t);
          resolve(body);
        });
        data.on('error', () => {
          clearTimeout(t);
          resolve(body);
        });
      });
    }
    return safeStringify(data);
  } catch {
    return '';
  }
}
import type { AgentLogEntry } from '../advanced-defs';
import type { ApprovalPolicy } from '../types';
import type { WorkAutonomyTier } from '../types';
import type { SandboxMode } from '../sandbox-policy';

// ─── Shared types ──────────────────────────────────────

export interface ContentBlock {
  type: 'text';
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  error?: string;
  durationMs: number;
}

export interface AssistantMessage {
  /** Chronological content blocks (text ↔ tool_use interleaved in order) */
  contentTimeline: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  toolCalls: ToolCall[];
  rawText: string;
  /** Accumulated thinking/reasoning content — must be passed back to DeepSeek V4 thinking mode */
  thinkingText?: string;
  /** LLM explicitly signaled completion via <FINAL_ANSWER> — only valid when toolCalls is empty */
  isFinal: boolean;
  /** API-level stop reason: 'end_turn' | 'stop_sequence' | 'max_tokens' | 'tool_use' | null */
  completionStopReason: string | null;
}

export interface ToolResults {
  results: ToolResult[];
  hasErrors: boolean;
}

export interface AgentState {
  iteration: number;
  toolCallCount: number;
  consecutiveTextOnly: number;
  emptyResponseCount: number;
}

export interface StopDecision {
  shouldStop: boolean;
  reason: string;
  isError: boolean;
}

export interface ContextConfig {
  /** Maximum assistant+tool rounds before compression triggers */
  maxRounds: number;
  /** Fraction of oldest rounds to compress (0-1). Default 0.5 */
  compressRatio: number;
  /**
   * 'round' = 传统轮次压缩（LLM/规则摘要）；'step' = AGORA 步骤级压缩
   * （动作语法完整保留，免推理）。默认 'round'；agent 循环默认 'step'。
   */
  compressMode?: 'round' | 'step';
  /** step 模式下始终保留的最近步骤数（AGORA always-keep floor）。默认 6。 */
  stepKeepRecent?: number;
  /** Use LLM to generate summaries (default true). Falls back to rule-based on failure. */
  useLLMSummary?: boolean;
  /**
   * Token-based threshold. When set, compression triggers when estimated tokens
   * exceed this value, and the boundary is found via token accumulation rather
   * than round counting. Takes precedence over maxRounds for the trigger check.
   */
  maxTokensBeforeCompress?: number;
}

/** LLM config needed for summary generation */
export interface LLMSummaryConfig {
  model: string;
  apiKey: string;
  apiBase: string;
  signal?: AbortSignal;
}

export interface AgentObserver {
  /** Emit a discrete event (text_chunk, tool_start, tool_end, error, done, etc.) */
  emit(event: AgentLoopEvent): void;
  /** Push a state snapshot for synchronized progress tracking */
  onStateChange(snapshot: AgentStateSnapshot): void;
}

export interface AgentStateSnapshot {
  iteration: number;
  toolCallCount: number;
  messagesCount: number;
  plan: TaskPlan | null;
  /** Which UI surface created this task (used to separate work / code lists). */
  surface?: 'chat' | 'work' | 'code';
}

export interface AgentLoopConfig {
  model: string;
  apiKey: string;
  apiBase: string;
  systemPrompt: string;
  projectRoot: string;
  /** Stable agent/session identity for goal + report tools. Defaults to the
   *  per-run session id, which changes on pause/resume. */
  sessionId?: string;
  /** External follow-up messages to inject at the next turn boundary（消息投递）。
   *  Returned messages are drained (removed) by the loop. */
  messageQueue?: () => string[];
  tools: ToolDef[];
  signal?: AbortSignal;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  /** Work 模式执行自主度档位（透传到工具门禁）。 */
  workTier?: WorkAutonomyTier;
  /** Which UI surface created this run — 'work' enforces docs-only writes. */
  surface?: 'chat' | 'work' | 'code';
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Called after a plan is generated in 'plan' mode. Await to pause the loop
   *  until the user approves. Returns approved step IDs, or null on timeout/reject. */
  onPlanGenerated?: (plan: TaskPlan) => Promise<string[] | null>;
  observer: AgentObserver;
  /** Sub-agent recursion depth for this run. Threaded into tool ctx so the
   *  Agent tool can enforce the max-depth limit. Top-level run = 0. */
  depth?: number;
  /** Agent 显示名（MAP-Graph 角色自动绑定；默认按名称推导）。 */
  agentName?: string;
  temperature?: number;
  contextConfig?: ContextConfig;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  /** Business iteration cap — agent exits gracefully with result when hit. Default 25. */
  maxIterations?: number;
  /** Per-call sandbox mode for tool execution (falls back to env, then full). */
  sandboxMode?: SandboxMode;
  /** Inject current time + session elapsed before each step (Agent mode default on). */
  timeContext?: boolean;
  /** Inject the current tmux session:window.pane before each step (opt-in). */
  tmuxContext?: boolean;
  /** Model used for the planning phase; defaults to the execution model. */
  planModel?: string;
  /** LLM adapter id — defaults to the built-in deepseek adapter. */
  adapter?: string;
  /** 主模型重试耗尽后的降级模型。 */
  fallbackModel?: string;
  /** Test seam — overrides the real tool dispatcher. */
  executeTool?: typeof executeToolCall;
  /** Active goal for this run （目标状态）: injected into the prompt and
   *  bounded by maxRounds of execution. */
  goal?: { text: string; maxRounds: number } | null;
  /** Force the planning phase even outside plan mode (tests / explicit opt-in).
   *  规划为可选; ordinary runs start executing directly. */
  forcePlanning?: boolean;
  /** Resume from a previously-paused agent loop. When set, the planning phase
   *  and initial message setup are skipped, and the loop continues from the
   *  saved state. The caller (typically scheduler) is responsible for capturing
   *  this state when status transitions to 'paused'. */
  resumeFrom?: {
    messages: any[];
    plan: TaskPlan | null;
    iteration: number;
    toolCallCount: number;
    allText: string;
  };
}

export type AgentLoopEvent =
  | { type: 'text_chunk'; text: string }
  | { type: 'thinking_chunk'; chunk: string; isNewBlock: boolean }
  | { type: 'tool_start'; toolCallId: string; toolName: string; input: Record<string, unknown>; stepGroupId: string }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      output: unknown;
      durationMs: number;
      stepGroupId: string;
      input?: Record<string, unknown>;
      summary?: Record<string, unknown>;
    }
  | {
      type: 'tool_error';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      error: string;
      stepGroupId: string;
    }
  | {
      type: 'tool_progress';
      toolCallId: string;
      toolName: string;
      progress: string;
      stepGroupId: string;
      input?: Record<string, unknown>;
    }
  | { type: 'iteration_start'; iteration: number; timestamp?: number }
  | {
      type: 'iteration_end';
      iteration: number;
      toolsThisIteration?: number;
      llmLatencyMs?: number;
      firstTokenMs?: number;
      outputTokens?: number;
    }
  | { type: 'plan_created'; plan: TaskPlan }
  | { type: 'plan_updated'; plan: TaskPlan }
  | { type: 'deviance_warning'; message: string }
  | { type: 'context_injected'; source: 'instructions' | 'memory' | 'workspace'; producer: string; detail?: string }
  | {
      type: 'context_compressed';
      tokensBefore: number;
      tokensAfter: number;
      messagesRemoved?: number;
      tokensSaved?: number;
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    }
  | { type: 'done' }
  | { type: 'error'; error: string }
  // ── Unified engine lifecycle (engine-events contract) ──
  | {
      type: 'tool_aborted';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      error: string;
      stepGroupId: string;
    }
  | { type: 'system_message'; level: 'warning' | 'info'; content: string }
  | {
      type: 'usage_update';
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    }
  | { type: 'turn_start'; turnId: string; timestamp: number }
  | { type: 'turn_end'; turnId: string; reason: string; timestamp: number }
  | { type: 'step_start'; iteration: number; timestamp: number }
  | { type: 'step_end'; iteration: number; toolsThisIteration?: number; llmLatencyMs?: number; timestamp: number }
  | { type: 'request_start'; model: string; provider?: string; timestamp: number };

export interface AgentLoopResult {
  allText: string;
  toolCallCount: number;
  iterations: number;
  log: AgentLogEntry[];
  plan: TaskPlan | null;
  /** Internal LLM message history at loop exit. Captured by the scheduler on
   *  pause so resumeFrom can replay the conversation without re-planning. */
  messages: any[];
}

// ─── Planner ──────────────────────────────────────────────
// Structured task planning: creates plans from LLM output, tracks progress,
// auto-matches tool calls to tasks, detects deviation from plan.

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PlanTask {
  id: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  /** Keywords/phrases extracted from description for fuzzy-matching tool calls */
  toolMatches?: string[];
}

export interface TaskPlan {
  tasks: PlanTask[];
  createdAt: number;
  /** Step IDs approved by the user in 'plan' permission mode. */
  approvedSteps?: string[];
}

/** Honor partial plan approval: keep only the user-approved steps so the
 *  injected prompt, progress tracking, and the final-answer gate all operate
 *  on the same executable subset. */
export function restrictPlanToApproved(plan: TaskPlan, approvedStepIds: string[]): TaskPlan {
  return {
    ...plan,
    approvedSteps: approvedStepIds,
    tasks: plan.tasks.filter((t) => approvedStepIds.includes(t.id)),
  };
}

export function parsePlanFromLLMText(text: string): TaskPlan | null {
  // Try to extract JSON from markdown code blocks or raw text
  let jsonStr = text;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Try to find raw JSON object in text
    const jsonMatch = text.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.tasks || !Array.isArray(parsed.tasks)) return null;
    const tasks: PlanTask[] = parsed.tasks.map((t: any, i: number) => ({
      id: t.id || String(i + 1),
      description: t.description || '',
      status: 'pending' as TaskStatus,
      dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
      toolMatches: extractKeywords(t.description || ''),
    }));
    return { tasks, createdAt: Date.now() };
  } catch {
    return null;
  }
}

/** Extract meaningful keywords from a task description for fuzzy matching */
function extractKeywords(description: string): string[] {
  const keywords: string[] = [];
  // File path patterns
  const pathMatches = description.match(/[\w.\/-]+\.(ts|tsx|js|jsx|json|css|yml|yaml|md|py|go|rs|java)/gi);
  if (pathMatches) keywords.push(...pathMatches);
  // Action words → tool mappings
  const actionMap: Record<string, string> = {
    'read|阅读|查看|读取|检查|查看|查阅': 'Read',
    'write|创建|新建|写入|生成|构建': 'Write',
    'edit|修改|编辑|更改|更新|重构|修复': 'Edit',
    'search|搜索|查找|grep|检索': 'Grep',
    'find|glob|文件|目录|列表|查看项目|查找文件': 'Glob',
    'run|执行|运行|测试|安装|编译|构建|启动|bash|命令|npm': 'Bash',
    'fetch|获取|请求|接口': 'WebFetch',
  };
  for (const [pattern, tool] of Object.entries(actionMap)) {
    if (new RegExp(pattern, 'i').test(description)) {
      keywords.push(tool);
    }
  }
  return keywords;
}

/** Score how well a tool call matches a plan task (0-1) */
function matchScore(toolName: string, toolInput: Record<string, unknown>, task: PlanTask): number {
  let score = 0;
  const searchText = JSON.stringify(toolInput).toLowerCase() + ' ' + toolName.toLowerCase();

  for (const kw of task.toolMatches || []) {
    if (searchText.includes(kw.toLowerCase())) {
      score += 0.4;
    }
  }

  // Bonus for description substring match
  const descWords = task.description.toLowerCase().split(/\s+/);
  const matchedWords = descWords.filter((w) => w.length > 3 && searchText.includes(w));
  score += (matchedWords.length / Math.max(descWords.length, 1)) * 0.3;

  // Penalty for mismatched tool type vs expected action
  const expectedAction = (task.toolMatches || []).some((k) =>
    ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebFetch'].includes(k),
  );
  if (expectedAction && !(task.toolMatches || []).includes(toolName)) {
    score -= 0.2;
  }

  return Math.max(0, Math.min(1, score));
}

export const Planner = {
  /** Try to auto-match a completed tool call to a plan task and mark it done */
  markCompleted(
    plan: TaskPlan,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolSuccess: boolean,
  ): { updated: boolean; taskId?: string } {
    if (!plan) return { updated: false };

    const pendingTasks = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    if (pendingTasks.length === 0) return { updated: false };

    // Score all pending tasks against this tool call
    let bestTask: PlanTask | null = null;
    let bestScore = 0.25; // minimum threshold

    for (const task of pendingTasks) {
      // Check dependencies are completed
      const depsDone = task.dependencies.every((depId) => {
        const dep = plan.tasks.find((t) => t.id === depId);
        return dep && dep.status === 'completed';
      });
      if (!depsDone && task.dependencies.length > 0) continue;

      const score = matchScore(toolName, toolInput, task);
      if (score > bestScore) {
        bestScore = score;
        bestTask = task;
      }
    }

    if (bestTask && toolSuccess) {
      bestTask.status = 'completed';
      return { updated: true, taskId: bestTask.id };
    }
    return { updated: false };
  },

  /** Mark a specific task with given status */
  markTask(plan: TaskPlan, taskId: string, status: TaskStatus): boolean {
    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    task.status = status;
    return true;
  },

  /** Mark first pending task as in_progress */
  startNextTask(plan: TaskPlan): PlanTask | null {
    const next = plan.tasks.find((t) => t.status === 'pending');
    if (next) {
      next.status = 'in_progress';
      return next;
    }
    return null;
  },

  /** Check if all tasks are in terminal state */
  isAllDone(plan: TaskPlan): boolean {
    return plan.tasks.every((t) => t.status === 'completed' || t.status === 'blocked');
  },

  /** Get pending tasks */
  getPending(plan: TaskPlan): PlanTask[] {
    return plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
  },

  /** Human-readable summary of plan state */
  getSummary(plan: TaskPlan): string {
    const total = plan.tasks.length;
    const completed = plan.tasks.filter((t) => t.status === 'completed').length;
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').length;
    const pending = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    const pendingList = pending.map((t) => `  [${t.id}] ${t.description} (${t.status})`).join('\n');
    return `计划进度: ${completed}/${total} 已完成${blocked > 0 ? `, ${blocked} 已阻塞` : ''}\n待完成:\n${pendingList || '  无'}`;
  },

  /** Merge a new plan (from Replan) into the existing plan.
   *  Preserves completed/blocked tasks, appends new tasks with fresh IDs. */
  mergePlan(existingPlan: TaskPlan, newTasks: { description: string; dependencies: string[] }[]): TaskPlan {
    // Generate new IDs that don't collide with existing ones
    const existingIds = new Set(existingPlan.tasks.map((t) => t.id));
    let nextId = existingPlan.tasks.length + 1;
    const generateId = (): string => {
      while (existingIds.has(String(nextId))) nextId++;
      const id = String(nextId);
      existingIds.add(id);
      nextId++;
      return id;
    };

    // Map old dependency references (may reference pre-merge task IDs)
    const newPlannedTasks: PlanTask[] = newTasks.map((t) => ({
      id: generateId(),
      description: t.description,
      status: 'pending' as TaskStatus,
      dependencies: t.dependencies || [],
      toolMatches: extractKeywords(t.description),
    }));

    // Append new tasks to existing plan
    return {
      tasks: [...existingPlan.tasks, ...newPlannedTasks],
      createdAt: existingPlan.createdAt,
    };
  },
};

// ─── DevianceDetector ──────────────────────────────────────
// Monitors plan execution for deviation: tasks not progressing, repeated failures,
// model stopping prematurely while tasks remain. Warnings are UI transparency
// only — they are never injected back into the model context.

export interface DevianceResult {
  shouldWarn: boolean;
  message: string;
  blockedTaskId?: string;
}

interface FailureRecord {
  count: number;
  lastError: string;
  taskDescription: string;
}

/** Factory: create a fresh DevianceDetector instance per agent to avoid shared mutable state. */
export function createDevianceDetector() {
  const failureTracker = new Map<string, FailureRecord>();

  return {
    failureTracker,

    checkFailures(plan: TaskPlan, toolName: string, toolInput: Record<string, unknown>, error: string): DevianceResult {
      let bestTask: PlanTask | null = null;
      let bestScore = 0.2;
      for (const task of plan.tasks.filter((t) => t.status !== 'completed')) {
        const score = matchScore(toolName, toolInput, task);
        if (score > bestScore) {
          bestScore = score;
          bestTask = task;
        }
      }

      if (bestTask) {
        const key = `${bestTask.id}`;
        const prev = this.failureTracker.get(key);
        const count = (prev?.count || 0) + 1;
        this.failureTracker.set(key, { count, lastError: error.slice(0, 120), taskDescription: bestTask.description });

        if (count >= 2) {
          bestTask.status = 'blocked';
          return {
            shouldWarn: true,
            message: `任务 [${bestTask.id}] "${bestTask.description}" 已连续失败 ${count} 次，已自动标记为 blocked。请更换策略或跳过此任务，继续执行其他任务。`,
            blockedTaskId: bestTask.id,
          };
        }
        return {
          shouldWarn: true,
          message: `工具 ${toolName} 执行失败（第 ${count} 次）。请分析错误原因并重试: ${error.slice(0, 200)}`,
        };
      }

      return { shouldWarn: false, message: '' };
    },

    reset() {
      failureTracker.clear();
    },

    /** Remove failure records for a specific task (called when task is unblocked via replan) */
    clearFailureRecord(taskId: string) {
      failureTracker.delete(taskId);
    },
  };
}

/**
 * @deprecated Test-only singleton. Production code MUST create per-call
 * instances via `createDevianceDetector()` to avoid cross-query state leaks.
 * Both `agentLoopRun` and the query-engine already follow this rule.
 * Kept as a named export only so existing unit tests can reset and inspect
 * a stable instance.
 */
export const DevianceDetector = createDevianceDetector();

// ─── Message Deduplication ────────────────────────────────
// Merges consecutive system-injected user messages at the tail of the
// messages array to prevent nudge/deviance stacking before LLM calls.

const INJECTED_MARKER = '_ddInjected';

export function markInjected(msg: any): void {
  msg[INJECTED_MARKER] = true;
}

export function isInjected(msg: any): boolean {
  return msg[INJECTED_MARKER] === true;
}

/**
 * Merge consecutive injected user messages at the end of the messages array.
 * Returns the messages array (mutated in place) for chaining.
 */
export function deduplicateNudges(messages: any[]): void {
  if (messages.length < 2) return;

  // Collect consecutive injected user messages from the tail
  const tail: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && isInjected(messages[i])) {
      tail.unshift(i);
    } else {
      break;
    }
  }

  if (tail.length <= 1) return;

  // Merge them into a single message
  const merged = tail.map((i) => messages[i].content as string).join('\n\n');
  // Keep the first message position, remove the rest
  messages[tail[0]].content = merged;
  for (let i = tail.length - 1; i > 0; i--) {
    messages.splice(tail[i], 1);
  }
}

// ─── LLMClient ──────────────────────────────────────────
// Pure API call + SSE parsing. No tool execution, no UI events (except text_chunk via callback).

// ─── LLM client (extracted to llm-adapter.ts; re-exported for compatibility) ──
export { llmClientInvoke };
export {
  invokeLlm,
  registerLlmAdapter,
  getLlmAdapter,
  sanitizeToolCallPairing,
  isAnthropicFormatEndpoint,
  buildOpenAIFormatTools,
  buildAnthropicFormatTools,
} from './llm-adapter';
// ─── ToolExecutor ───────────────────────────────────────
// Pure function: takes tool calls + context, returns results. No UI, no events, no side effects.

export async function toolExecutorExecute(params: {
  toolCalls: ToolCall[];
  projectRoot: string;
  requestId: string;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  abortSignal?: AbortSignal;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  workTier?: WorkAutonomyTier;
  workspaceRoots?: string[];
  writableRoots?: string[];
}): Promise<ToolResults> {
  const {
    toolCalls,
    projectRoot,
    requestId,
    checkPermission,
    autoApprove,
    abortSignal,
    mode,
    approvedPlanSteps,
    workTier,
    workspaceRoots,
    writableRoots,
  } = params;
  const results: ToolResult[] = [];
  let hasErrors = false;

  for (const tc of toolCalls) {
    const start = Date.now();
    let output: unknown = null;
    let error: string | undefined;

    try {
      const result = await executeToolCall(tc.name, tc.input, {
        projectRoot,
        requestId,
        checkPermission,
        autoApprove,
        abortSignal,
        toolCallId: tc.id,
        mode,
        approvedPlanSteps,
        workTier,
        workspaceRoots,
        writableRoots,
      });
      output = result.output;
      error = result.error;
    } catch (execErr: unknown) {
      error = `工具执行异常: ${errorText(execErr)}`;
    }

    if (error) hasErrors = true;

    results.push({
      toolUseId: tc.id,
      toolName: tc.name,
      input: tc.input,
      output,
      error,
      durationMs: Date.now() - start,
    });
  }

  return { results, hasErrors };
}

// ─── ContextManager ──────────────────────────────────────
// Sliding window + summary compression. When the conversation exceeds the
// round budget, the oldest messages are compressed into a structured summary.
// Critical information (Read results for pending tasks) is preserved.

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxRounds: 20,
  compressRatio: 0.5,
};

/** Count assistant messages (rounds) in the messages array */
function countRounds(messages: any[]): number {
  let rounds = 0;
  for (const m of messages) {
    if (m.role === 'assistant') rounds++;
  }
  return rounds;
}

/** Lightweight token estimator — delegates to the shared token-counter utility. */
const estimateTokens = estimateTokensForMessages;
export { estimateTokens };

/** Determine if a tool_result is critical (must not be compressed away) */
export function isCriticalResult(toolResultMsg: any, plan: TaskPlan | null): boolean {
  if (!plan) return false;

  const content = toolResultMsg.content;
  if (!content) return false;

  // Try parsing string content as JSON first (OpenAI-format: role: 'tool' + JSON string)
  if (typeof content === 'string') {
    let parsed: any = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      return false;
    }
    if (!parsed) return false;
    if (parsed.file_path && parsed.content && parsed.total_lines && parsed.total_lines > 10) {
      return matchesPlanTask(parsed.file_path, plan);
    }
    // Also check Grep result (has pattern + results array)
    if (parsed.pattern && Array.isArray(parsed.results)) {
      for (const r of parsed.results) {
        if (r.file && matchesPlanTask(r.file, plan)) return true;
      }
    }
    return false;
  }

  // For Anthropic format: content is [{type: 'tool_result', tool_use_id, content}]
  const resultBlocks = Array.isArray(content) ? content : [content];
  for (const block of resultBlocks) {
    const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    let parsed: any = null;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      continue;
    }
    if (!parsed) continue;

    if (parsed.file_path && parsed.content && parsed.total_lines && parsed.total_lines > 10) {
      return matchesPlanTask(parsed.file_path, plan);
    }
  }
  return false;
}

/** Check if a file path matches any pending plan task */
export function matchesPlanTask(filePath: string, plan: TaskPlan): boolean {
  const fileName = filePath.toLowerCase();
  for (const task of plan.tasks) {
    if (task.status === 'completed') continue;
    const taskDesc = task.description.toLowerCase();
    const fileParts = fileName.split(/[\/\\]/);
    for (const part of fileParts) {
      if (part.length > 3 && taskDesc.includes(part)) return true;
    }
    if ((task.toolMatches || []).some((kw) => fileName.includes(kw.toLowerCase()))) return true;
  }
  return false;
}

const LLM_SUMMARY_MARKER = 'LLM_SUMMARY';

/** Call LLM to generate a concise summary of compressed history */
async function llmSummarize(
  messagesToCompress: any[],
  plan: TaskPlan | null,
  llm: LLMSummaryConfig,
): Promise<string | null> {
  // Build context text from compress zone
  const contextParts: string[] = [];
  for (const msg of messagesToCompress) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) contextParts.push(`[助手]: ${block.text.slice(0, 500)}`);
          if (block.type === 'tool_use')
            contextParts.push(`[工具调用]: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      } else if (typeof content === 'string') {
        contextParts.push(`[助手]: ${content.slice(0, 500)}`);
      }
    } else if (msg.role === 'user') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const rc =
              typeof block.content === 'string'
                ? block.content.slice(0, 300)
                : JSON.stringify(block.content).slice(0, 300);
            contextParts.push(`[工具结果]: ${rc}`);
          }
        }
      } else if (typeof content === 'string' && !content.startsWith('[历史上下文摘要]')) {
        contextParts.push(`[用户]: ${content.slice(0, 300)}`);
      }
    }
  }

  const planInfo = plan ? `\n当前计划状态: ${Planner.getSummary(plan)}` : '';
  const prompt = `请用一段话总结以下历史交互，保留文件修改、命令执行结果、关键发现和当前计划状态。不要遗漏任何与未完成任务相关的信息。${planInfo}\n\n历史交互:\n${contextParts.join('\n')}`;

  try {
    const result = await invokeLlm({
      model: llm.model,
      apiKey: llm.apiKey,
      apiBase: llm.apiBase,
      systemPrompt:
        'You are a concise summarizer. Output a single paragraph in the same language as the input, covering all key actions, findings, file changes, command results, and remaining tasks. Keep it under 300 tokens.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: llm.signal || new AbortController().signal,
    });
    if (result?.rawText && result.rawText.trim().length > 20) {
      return `[历史上下文摘要] ${result.rawText.trim()}\n\n（以上为 LLM 生成的上下文摘要。当前计划状态: ${plan ? Planner.getSummary(plan) : '无计划'}）`;
    }
  } catch {
    /* fall through to rule-based */
  }
  return null;
}

/** Build a compressed summary from old messages (rule-based fallback) */
function buildSummary(messagesToCompress: any[], plan: TaskPlan | null): string {
  const parts: string[] = [];
  const filesRead: Set<string> = new Set();
  const filesEdited: Set<string> = new Set();
  const filesWritten: Set<string> = new Set();
  const commandsRun: string[] = [];
  const findings: string[] = [];

  for (const msg of messagesToCompress) {
    if (msg.role === 'assistant') {
      // Extract text content from assistant message
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            // Collect significant findings (text 100+ chars likely has substance)
            const text = block.text.trim();
            if (text.length > 100) {
              findings.push(text.slice(0, 300));
            }
          }
          if (block.type === 'tool_use') {
            const tc = block;
            if (tc.name === 'Read' && tc.input?.file_path) filesRead.add(tc.input.file_path as string);
            if (tc.name === 'Edit' && tc.input?.file_path) filesEdited.add(tc.input.file_path as string);
            if (tc.name === 'Write' && tc.input?.file_path) filesWritten.add(tc.input.file_path as string);
            if (tc.name === 'Bash' && tc.input?.command) commandsRun.push(tc.input.command as string);
          }
        }
      } else if (typeof content === 'string' && content.length > 100) {
        findings.push(content.slice(0, 300));
      }
      // Check OpenAI tool_calls format
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || tc;
          if (fn.name === 'Read' && fn.arguments) {
            try {
              const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
              if (args.file_path) filesRead.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Edit' && fn.arguments) {
            try {
              const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
              if (args.file_path) filesEdited.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Write' && fn.arguments) {
            try {
              const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
              if (args.file_path) filesWritten.add(args.file_path);
            } catch {}
          }
          if (fn.name === 'Bash' && fn.arguments) {
            try {
              const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
              if (args.command) commandsRun.push(args.command);
            } catch {}
          }
        }
      }
    }
  }

  if (filesRead.size > 0) parts.push(`阅读了文件: ${[...filesRead].join(', ')}`);
  if (filesEdited.size > 0) parts.push(`编辑了文件: ${[...filesEdited].join(', ')}`);
  if (filesWritten.size > 0) parts.push(`创建了文件: ${[...filesWritten].join(', ')}`);
  if (commandsRun.length > 0) {
    const uniqueCmds = [...new Set(commandsRun)].slice(0, 5);
    parts.push(`执行了命令: ${uniqueCmds.join('; ')}`);
  }

  // Plan task status
  if (plan) {
    const completed = plan.tasks.filter((t) => t.status === 'completed').map((t) => t.description);
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').map((t) => t.description);
    const pending = plan.tasks
      .filter((t) => t.status === 'pending' || t.status === 'in_progress')
      .map((t) => t.description);
    if (completed.length > 0) parts.push(`已完成任务: ${completed.join('; ')}`);
    if (blocked.length > 0) parts.push(`已阻塞任务: ${blocked.join('; ')}`);
    if (pending.length > 0) parts.push(`待完成任务: ${pending.join('; ')}`);
  }

  // Key findings (up to 2, truncated)
  if (findings.length > 0) {
    const key = findings.slice(0, 2).map((f) => f.slice(0, 200));
    parts.push(`关键发现: ${key.join(' | ')}`);
  }

  return `[历史上下文摘要] 在之前的交互中，${parts.join('。')}。以下是最近的对话继续。`;
}

export const ContextManager = {
  /** Check if compression is needed — supports both round-based and token-based thresholds */
  shouldCompress(messages: any[], config: ContextConfig = DEFAULT_CONTEXT_CONFIG): boolean {
    if (config.maxTokensBeforeCompress && estimateTokens(messages) > config.maxTokensBeforeCompress) {
      return true;
    }
    return countRounds(messages) > config.maxRounds;
  },

  /** Token-based compression check. Convenience wrapper for query paths. */
  shouldCompressByTokens(messages: any[], maxTokens: number): boolean {
    return estimateTokens(messages) > maxTokens;
  },

  /**
   * Compress oldest 50% of conversation history into a summary.
   * Uses LLM for summary generation when configured; falls back to rule-based.
   * Preserves system messages and critical tool results.
   * Returns a new messages array (does not mutate input).
   */
  async compressHistory(
    messages: any[],
    plan: TaskPlan | null,
    config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
    llmConfig?: LLMSummaryConfig,
  ): Promise<any[]> {
    const useTokenBased = config.maxTokensBeforeCompress != null;

    // Early return: check both token and round thresholds
    if (!useTokenBased && countRounds(messages) <= config.maxRounds) return messages;
    if (useTokenBased && estimateTokens(messages) <= config.maxTokensBeforeCompress!) return messages;

    // AGORA 步骤级压缩：整步保留/整步丢弃，永不拆分工具调用与结果。
    if ((config.compressMode ?? 'round') === 'step') {
      return compressHistorySteps(messages, {
        keepRecentSteps: config.stepKeepRecent ?? 6,
        plan,
      });
    }

    // Identify system messages (always at very beginning)
    const systemMsgs: any[] = [];
    let idx = 0;
    while (idx < messages.length && messages[idx].role === 'system') {
      systemMsgs.push(messages[idx]);
      idx++;
    }

    // Injected system-style user messages (plan info, deviance warnings, nudges)
    const preambleMsgs: any[] = [];
    while (idx < messages.length && typeof messages[idx].content === 'string') {
      const c = messages[idx].content as string;
      if (c.includes('你的任务计划') || c.includes('请根据 system prompt')) {
        preambleMsgs.push(messages[idx]);
        idx++;
        continue;
      }
      break;
    }

    // Find boundary: token-based accumulation or round-based counting
    const compressZone: any[] = [];
    const criticalPool: any[] = [];
    let boundaryIdx = idx;

    if (useTokenBased) {
      const remainingMsgs = messages.slice(idx);
      const totalTokens = estimateTokens(remainingMsgs);
      const compressTokenBudget = Math.floor(totalTokens * config.compressRatio);
      let cumulativeTokens = 0;
      let found = false;

      for (let i = idx; i < messages.length; i++) {
        const msg = messages[i];
        const msgTokens = estimateTokens([msg]);
        cumulativeTokens += msgTokens;

        if (!found && cumulativeTokens > compressTokenBudget) {
          boundaryIdx = i;
          found = true;
        }

        if (!found) {
          if ((msg.role === 'user' || msg.role === 'tool') && isCriticalResult(msg, plan)) {
            criticalPool.push(msg);
            for (let j = i - 1; j >= idx; j--) {
              if (messages[j].role === 'assistant' && !criticalPool.includes(messages[j])) {
                criticalPool.push(messages[j]);
                // Rescue ALL tool results belonging to this assistant
                for (let k = j + 1; k <= i; k++) {
                  if (messages[k].role === 'tool' && !criticalPool.includes(messages[k])) {
                    criticalPool.push(messages[k]);
                  }
                }
                break;
              }
            }
          } else {
            compressZone.push(msg);
          }
        }
      }

      // Align token-based boundary to nearest previous assistant so that
      // no assistant/tool_result pairing is broken by the split point.
      if (found && boundaryIdx > idx && messages[boundaryIdx]?.role !== 'assistant') {
        let aligned = boundaryIdx;
        for (let j = boundaryIdx - 1; j >= idx; j--) {
          if (messages[j].role === 'assistant') {
            aligned = j;
            break;
          }
        }
        if (aligned !== boundaryIdx) {
          const displaced = new Set(messages.slice(aligned, boundaryIdx));
          for (let k = compressZone.length - 1; k >= 0; k--) {
            if (displaced.has(compressZone[k])) compressZone.splice(k, 1);
          }
          for (let k = criticalPool.length - 1; k >= 0; k--) {
            if (displaced.has(criticalPool[k])) criticalPool.splice(k, 1);
          }
          boundaryIdx = aligned;
        }
      }
    } else {
      // Round-based boundary finding
      const totalAssistantRounds = countRounds(messages.slice(idx));
      const compressCount = Math.floor(totalAssistantRounds * config.compressRatio);
      let seenAssistants = 0;
      let inCompressZone = true;

      for (let i = idx; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'assistant') {
          seenAssistants++;
          if (seenAssistants > compressCount) {
            inCompressZone = false;
            boundaryIdx = i;
          }
        }

        if (inCompressZone) {
          if ((msg.role === 'user' || msg.role === 'tool') && isCriticalResult(msg, plan)) {
            criticalPool.push(msg);
            for (let j = i - 1; j >= idx; j--) {
              if (messages[j].role === 'assistant' && !criticalPool.includes(messages[j])) {
                criticalPool.push(messages[j]);
                // Rescue ALL tool results belonging to this assistant
                for (let k = j + 1; k <= i; k++) {
                  if (messages[k].role === 'tool' && !criticalPool.includes(messages[k])) {
                    criticalPool.push(messages[k]);
                  }
                }
                break;
              }
            }
          } else {
            compressZone.push(msg);
          }
        }
      }
    }

    // Build the compressed messages array
    const result: any[] = [...systemMsgs, ...preambleMsgs];

    // Add summary of compressed zone (LLM-driven with rule-based fallback)
    if (compressZone.length > 0) {
      let summary: string | null = null;
      let isLLMGenerated = false;
      if (config.useLLMSummary !== false && llmConfig) {
        summary = await llmSummarize(compressZone, plan, llmConfig);
        if (summary) isLLMGenerated = true;
      }
      if (!summary) {
        summary = buildSummary(compressZone, plan);
      }
      const summaryMsg: any = { role: 'user', content: summary };
      if (isLLMGenerated) summaryMsg[LLM_SUMMARY_MARKER] = true;
      result.push(summaryMsg);
    }

    // Add critical items rescued from compress zone
    for (const item of criticalPool.reverse()) {
      if (!result.includes(item)) {
        result.push(item);
      }
    }

    // Add everything after the compress zone (recent rounds)
    for (let i = boundaryIdx; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  },
};

// ─── StopPolicy ─────────────────────────────────────────
// Pure function. 无工具调用的纯文本回复即视为
// answer — the turn ends on the model's own end_turn, not on a required
// <FINAL_ANSWER> marker. The marker remains an accepted signal, and the
// max_tokens truncation guard keeps a cut-off reply from ending early.
// All hardcoded iteration limits removed. Loop runs until natural termination.

export function stopPolicyEvaluate(state: {
  iteration: number;
  consecutiveTextOnly: number;
  emptyResponseCount: number;
  hasText: boolean;
  hasTools: boolean;
  isFinal: boolean;
  completionStopReason: string | null;
  signalAborted: boolean;
  plan: TaskPlan | null;
}): StopDecision {
  if (state.signalAborted) {
    return { shouldStop: true, reason: '用户手动停止', isError: false };
  }

  // Empty response guard
  if (!state.hasText && !state.hasTools) {
    if (state.emptyResponseCount >= 2) {
      return {
        shouldStop: true,
        reason: '连续收到空 API 响应，可能原因：API 限流、模型不支持工具调用、或请求格式异常',
        isError: true,
      };
    }
    return { shouldStop: false, reason: '', isError: false };
  }

  // ── PRIMARY: text-only reply ends the turn （回合结束信号） ──
  // A completed response that called no tools is the model's final answer.
  // The only exception is a max_tokens truncation — the loop must continue
  // so the model can finish the cut-off reply instead of repeating it.
  if (state.hasText && !state.hasTools && state.completionStopReason !== 'max_tokens') {
    const confirmInfo = state.completionStopReason ? `（API stop_reason: ${state.completionStopReason}）` : '';
    return { shouldStop: true, reason: `模型已完成回答，未调用工具${confirmInfo}`, isError: false };
  }

  // ── LLM explicit stop signal with dual confirmation ──
  if (state.isFinal) {
    // Dual confirmation: check API-level stop_reason
    if (state.completionStopReason === 'max_tokens') {
      // LLM was truncated — <FINAL_ANSWER> may be hallucinated
      return { shouldStop: false, reason: '', isError: false };
    }

    // 以模型的完成信号为准. Plan
    // tracking is display-only — we never hold the model hostage to a
    // pending checklist or lecture it about unfinished steps.
    const confirmInfo = state.completionStopReason ? `（API stop_reason: ${state.completionStopReason}）` : '';
    return { shouldStop: true, reason: `LLM 发送了 <FINAL_ANSWER> 信号${confirmInfo}`, isError: false };
  }

  // Stuck detection: no tools for too long (plan-independent safety net).
  // Only reachable for text-only replies that were truncated by max_tokens
  // and kept looping without completing.
  if (state.hasText && !state.hasTools && state.consecutiveTextOnly >= 5) {
    const planInfo =
      state.plan && !Planner.isAllDone(state.plan)
        ? `（计划仍有 ${Planner.getPending(state.plan).length} 个任务未完成）`
        : '';
    return {
      shouldStop: true,
      reason: `Agent 连续 ${state.consecutiveTextOnly} 轮未调用工具且回复被截断，强制中止${planInfo}`,
      isError: true,
    };
  }

  // Has tool calls → continue
  return { shouldStop: false, reason: '', isError: false };
}

// ─── AgentLoop ──────────────────────────────────────────
// Orchestrator: runs Planning Phase first, then the execution loop.
// Delegates to LLMClient / ToolExecutor / StopPolicy / Planner / DevianceDetector.
// Emits events at the right moments for UI consumption.

// EN (original):
// `You are a task planner. Your ONLY job is to analyze the user's request and produce a structured JSON execution plan.
// Output ONLY a valid JSON object in this exact format (no markdown, no extra text):
// ...
// Rules: Each task must be specific and actionable... 3-8 tasks is ideal. Do NOT include any text outside the JSON object.`

const PLANNING_SYSTEM_PROMPT = `你是任务规划器。你唯一的工作是分析用户的需求，生成结构化的 JSON 执行计划。

仅输出以下格式的有效 JSON 对象（不要 markdown，不要额外文字）：

{
  "tasks": [
    { "id": "1", "description": "读取配置文件了解当前设置", "dependencies": [] },
    { "id": "2", "description": "修改 config.ts 中的端口号", "dependencies": ["1"] },
    { "id": "3", "description": "重新读取文件验证修改结果", "dependencies": ["2"] }
  ]
}

规则：
- 每个任务必须具体、可执行（是 Read/Write/Edit/Bash/Grep/Glob 能完成的操作）
- 依赖必须引用列表中已出现的有效任务 ID
- 3-8 个任务最理想，不要对简单请求过度规划
- JSON 之外不要输出任何文字`;

// ─── AgentLoop Helpers ──────────────────────────────────

async function runPlanningPhase(params: {
  model: string;
  apiKey: string;
  apiBase: string;
  adapter?: string;
  systemPrompt: string;
  signal?: AbortSignal;
  observer: AgentObserver;
}): Promise<TaskPlan | null> {
  const { model, apiKey, apiBase, adapter, systemPrompt, signal, observer } = params;
  const planningUserMsg = systemPrompt.includes('Your Task') ? systemPrompt : `Task: ${systemPrompt}`;
  // Planning LLM output is raw JSON for parsePlanFromLLMText — never stream it
  // to the UI as text. Surface a single quiet progress line instead.
  observer.emit({
    type: 'tool_progress',
    toolCallId: 'planning',
    toolName: 'Planning',
    progress: '正在分析需求并生成执行计划…',
    stepGroupId: 'planning',
  });
  const planningStartedAt = Date.now();
  const planningTimer = setInterval(() => {
    const waited = Math.floor((Date.now() - planningStartedAt) / 1000);
    observer.emit({
      type: 'tool_progress',
      toolCallId: 'planning',
      toolName: 'Planning',
      progress: waited >= 6 ? `正在生成执行计划…（已等待 ${waited}s）` : '正在分析任务与项目上下文…',
      stepGroupId: 'planning',
    });
  }, 3000);
  try {
    const planAssistant = await invokeLlm({
      model,
      apiKey,
      apiBase,
      adapter,
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: planningUserMsg }],
      tools: [],
      // 官方 JSON Output：保证计划输出是合法 JSON，避免 markdown 包裹导致的解析失败。
      responseFormat: 'json_object',
      signal: signal || new AbortController().signal,
    });
    if (planAssistant?.rawText) {
      const parsed = parsePlanFromLLMText(planAssistant.rawText);
      if (parsed && parsed.tasks.length > 0) {
        observer.emit({
          type: 'tool_progress',
          toolCallId: 'planning',
          toolName: 'Planning',
          progress: `计划已生成，共 ${parsed.tasks.length} 个任务`,
          stepGroupId: 'planning',
        });
        observer.emit({ type: 'plan_created', plan: parsed });
        return parsed;
      }
    }
  } catch {
    /* fall through */
  } finally {
    clearInterval(planningTimer);
  }
  return null;
}

function setupInitialMessages(systemPrompt: string, activePlan: TaskPlan | null, mode: ApprovalPolicy = 'ask'): any[] {
  const msgs: any[] = [];
  const workGuide =
    '请根据 system prompt 中的任务描述开始工作。\n' +
    '节奏由你自主决定：可以直接执行，也可以先探索理解再动手；多步骤任务如需跟踪进度可以使用 TodoWrite。\n' +
    (mode === 'plan'
      ? '当前为计划模式：先制定执行计划并等待用户批准，批准后再开始执行；未批准前不要调用修改类工具。'
      : mode === 'auto'
        ? '当前为全自动模式：可自主决定并执行所有工具，无需向用户请求确认。'
        : '当前为交互模式：写文件、执行命令等风险操作需要先向用户确认。');
  msgs.push({ role: 'system', content: systemPrompt });
  msgs.push({ role: 'user', content: workGuide });
  if (activePlan) {
    msgs.push({
      role: 'user',
      content: `你的任务计划:\n${Planner.getSummary(activePlan)}\n\n请按批准的计划逐项推进；完成一项后继续下一项。`,
    });
  }
  return msgs;
}

export function appendAssistantToHistory(messages: any[], msg: AssistantMessage): void {
  const m: any = {
    role: 'assistant',
    content: msg.rawText || null,
    tool_calls:
      msg.toolCalls.length > 0
        ? msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        : undefined,
  };
  // DeepSeek V4 thinking mode: must pass reasoning_content back to the API
  if (msg.thinkingText) {
    m.reasoning_content = msg.thinkingText;
  }
  messages.push(m);
}

// ─── Debug logger ────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);

// Tool batching (concurrency, abort, zero-orphan results) is owned by
// step-engine via tool-runner; Replan is intercepted through the step-engine
// `interceptTool` seam (see agentLoopRun) instead of a bespoke loop branch.

/** Plan/deviance side effects for a completed tool result.
 *  Canonical tool_start/tool_end/tool_error events are emitted by step-engine;
 *  this function only updates the plan, emits deviance warnings and surfaces
 *  Replan plan updates. */
/** Build structured summary from tool output for frontend rendering */
function buildToolSummary(
  toolName: string,
  output: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    switch (toolName) {
      case 'Read': {
        const text = typeof output === 'string' ? output : '';
        return { filePath: input.file_path, lines: text.split('\n').length, size: text.length };
      }
      case 'Write':
        return {
          filePath: input.file_path,
          bytesWritten: typeof input.content === 'string' ? input.content.length : 0,
        };
      case 'Edit':
        return { filePath: input.file_path, replaced: true };
      case 'Grep': {
        const lines = typeof output === 'string' ? output.split('\n').filter(Boolean) : [];
        return { matchCount: lines.length, filesSearched: 'current' };
      }
      case 'Glob':
        return { matchCount: Array.isArray(output) ? output.length : 0 };
      case 'Bash': {
        const o = output as any;
        return { exitCode: o?.exitCode, stdoutLen: o?.stdout?.length || 0, stderrLen: o?.stderr?.length || 0 };
      }
      case 'ReviewArtifact':
        return {
          checkType: input.check_type,
          passed: true,
          output: typeof output === 'string' ? output.slice(0, 300) : '',
        };
      case 'Delete':
        return { filePath: input.file_path, deleted: true };
      case 'GitCommit':
        return { message: input.message, hash: (output as any)?.hash || '' };
      case 'Replan':
        return { replanned: true, message: (output as any)?.message };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function emitToolObserverForResult(
  r: BatchToolResult,
  observer: AgentObserver,
  activePlan: TaskPlan | null,
  // dd is REQUIRED — callers must pass a per-loop DevianceDetector instance so
  // failure tracking is isolated to a single query/agent run.
  dd: ReturnType<typeof createDevianceDetector>,
  toolName?: string,
): void {
  if (r.error) {
    console.error(
      `[AURAXIS] [${ts()}] [TOOL:FAIL] tool=${r.toolName} toolCallId=${r.toolUseId} error=${r.error.slice(0, 200)} duration=${r.durationMs}ms`,
    );
    if (activePlan && toolName !== 'Replan') {
      const dv = dd.checkFailures(activePlan, r.toolName, r.input, r.error);
      if (dv.shouldWarn) {
        // UI transparency only — 模型从工具结果中看到错误
        // its result and decides how to react; we do not lecture it.
        observer.emit({ type: 'deviance_warning', message: dv.message });
        if (dv.blockedTaskId) observer.emit({ type: 'plan_updated', plan: activePlan });
      }
    }
  } else {
    devLog(`[AURAXIS] [${ts()}] [TOOL:OK] tool=${r.toolName} toolCallId=${r.toolUseId} duration=${r.durationMs}ms`);
    if (toolName === 'Replan' && activePlan) {
      // The interceptor already merged the new plan — surface it to the UI.
      observer.emit({ type: 'plan_updated', plan: activePlan });
      return;
    }
    if (activePlan) {
      const match = Planner.markCompleted(activePlan, r.toolName, r.input, true);
      if (match.updated) observer.emit({ type: 'plan_updated', plan: activePlan });
    }
  }
}

// ─── AgentLoop ──────────────────────────────────────────

export async function agentLoopRun(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const {
    model,
    apiKey,
    apiBase,
    systemPrompt,
    projectRoot,
    tools,
    checkPermission,
    autoApprove,
    signal,
    observer,
    onPlanGenerated,
  } = config;
  let { mode, approvedPlanSteps } = config;
  let effectiveSystemPrompt = systemPrompt;
  if (!config.resumeFrom) {
    const instructions = await loadAgentInstructions(projectRoot);
    if (instructions.trim()) {
      effectiveSystemPrompt += `\n\n## 项目指令（AGENTS.md）\n${instructions.trim()}`;
      observer.emit({
        type: 'context_injected',
        source: 'instructions',
        producer: 'AGENTS.md',
        detail: '项目指令已注入系统提示',
      });
    }
  }
  if (config.goal) {
    effectiveSystemPrompt += `\n\n## 当前目标\n${config.goal.text}\n（最多执行 ${config.goal.maxRounds} 轮；达到轮次上限时总结当前进展并结束）`;
  }
  if (config.surface === 'work') {
    try {
      const { readSettings } = await import('./settings-store');
      const settings = await readSettings();
      const before = effectiveSystemPrompt;
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, {
        clarify: settings.clarifyBeforeWork !== false,
      });
      if (effectiveSystemPrompt !== before) {
        observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'Work 规则',
          detail: '已注入 Work 边界与澄清规则',
        });
      }
    } catch {
      // Settings unavailable — still keep docs-only rule from the caller.
      effectiveSystemPrompt = appendWorkRules(effectiveSystemPrompt, config.surface, { clarify: true });
    }
  }
  void runHooksFor('SessionStart', { projectRoot, model }, projectRoot).catch(() => {});
  const baseContextConfig =
    config.contextConfig ||
    (model.startsWith('deepseek-v4')
      ? { maxRounds: 20, compressRatio: 0.5, maxTokensBeforeCompress: 900_000 }
      : DEFAULT_CONTEXT_CONFIG);
  // AGORA 步骤级压缩作为 agent 循环默认策略；显式指定 compressMode 时尊重调用方。
  const contextConfig: ContextConfig = {
    ...baseContextConfig,
    compressMode: baseContextConfig.compressMode ?? 'step',
  };
  const dd = createDevianceDetector();
  dd.reset();

  // Stable session ID — spans the entire agent lifecycle.
  // Used as the worktree session key so EnterWorktree and all subsequent tool
  // calls share the same lookup key (fixes Critical 2: worktree redirect mismatch).
  const agentSessionId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const stableSessionId = config.sessionId || agentSessionId;

  // ── [NODE 1] Agent received input ─────────────────────
  const isResume = !!config.resumeFrom;
  devLog(
    `[AURAXIS] [${ts()}] [AGENT:${isResume ? 'RESUME' : 'START'}] model=${model} project=${projectRoot} mode=${mode} tools=${tools.length}`,
  );

  // Phase 0: Planning + setup — SKIPPED when resuming from a paused state.
  // The saved messages array already contains the system prompt, plan info,
  // and the prior conversation; re-planning would corrupt the history.
  let activePlan: TaskPlan | null = null;
  let messages: any[];
  let startIter = 1;
  let toolCallCount = 0;
  let allText = '';

  if (config.resumeFrom) {
    activePlan = config.resumeFrom.plan;
    messages = [...config.resumeFrom.messages];
    startIter = (config.resumeFrom.iteration || 0) + 1;
    toolCallCount = config.resumeFrom.toolCallCount || 0;
    allText = config.resumeFrom.allText || '';
    // Re-emit current plan so a freshly-attached UI can render it on resume.
    if (activePlan) observer.emit({ type: 'plan_updated', plan: activePlan });
  } else {
    // ── New project detection ─────────────────────────────
    // If the project directory has no package.json, inject guidance so the
    // agent knows to initialize the project first before writing code.
    let projectInitHint: string | undefined;
    if (projectRoot) {
      const { existsSync } = await import('fs');
      const pkgPath = path.join(projectRoot, 'package.json');
      if (!existsSync(pkgPath)) {
        const dirContents = await readdir(projectRoot).catch(() => [] as string[]);
        const isEmpty = dirContents.filter((n) => !n.startsWith('.')).length === 0;
        if (isEmpty || !dirContents.some((n) => n.endsWith('.json') || n.endsWith('.ts') || n.endsWith('.js'))) {
          projectInitHint =
            '该项目目录尚未初始化（没有 package.json）。请根据实际需要决定是否先初始化项目（如 npm init -y）或安装依赖，再开始工作。';
        }
      }
    }

    // 规划阶段为可选 (plan mode or explicit
    // forcePlanning). Ordinary ask/auto runs start executing directly — the
    // first thing the user sees is the model's own reasoning/tool choice.
    const shouldPlan = mode === 'plan' || config.forcePlanning === true;
    if (shouldPlan) {
      activePlan = await runPlanningPhase({
        model: config.planModel || model,
        apiKey,
        apiBase,
        adapter: config.adapter,
        systemPrompt: effectiveSystemPrompt,
        signal,
        observer,
      });
    }

    // Plan mode with a failed/unparseable plan must not stall: there is no
    // approval UI to wait on, and the prompt would tell the model to hold
    // until approval that never comes. Fall back to interactive (ask) mode.
    if (mode === 'plan' && !activePlan) {
      mode = 'ask';
    }

    // ── Plan mode: wait for user approval ─────────────────
    if (activePlan && mode === 'plan' && onPlanGenerated) {
      const approvedStepIds = await onPlanGenerated(activePlan);
      if (approvedStepIds && approvedStepIds.length > 0) {
        activePlan = restrictPlanToApproved(activePlan, approvedStepIds);
        observer.emit({ type: 'plan_updated', plan: activePlan });
      } else {
        // Timeout or user rejected — fall back to Ask mode
        mode = 'ask';
      }
    }
    // ───────────────────────────────────────────────────────

    messages = setupInitialMessages(effectiveSystemPrompt, activePlan, mode);
    // Inject new-project guidance if detected
    if (projectInitHint) {
      messages.push({ role: 'user', content: projectInitHint });
    }
  }

  // ── [NODE 2] Final prompt constructed ──────────────────
  devLog(
    `[AURAXIS] [${ts()}] [PROMPT:BUILT] messages=${messages.length} planTasks=${activePlan?.tasks.length ?? 0} systemPromptLen=${systemPrompt.length} startIter=${startIter}`,
  );
  // ══ Unified loop ══
  // step-engine owns ONE ReAct iteration (LLM + retry + tool batch + stop
  // policy + compaction); this driver owns planning/resume, termination caps,
  // plan/deviance/review-gate strategy hooks, and the turn event envelope.
  const state = createStepState(messages);
  state.iteration = startIter - 1;
  state.toolCallCount = toolCallCount;
  state.allText = allText;
  /** Auto tier: a failed ReviewArtifact pauses the loop for a human check. */
  interface ReviewGate {
    toolCallId: string;
    checkType: string;
    summary: string;
  }
  let reviewGate: ReviewGate | null = null;
  // Read through a function so TS does not narrow the closure-assigned
  // variable to `null` at the consumption site below.
  const pendingReviewGate = (): ReviewGate | null => reviewGate;
  const resolvedApprovedSteps = activePlan?.approvedSteps ?? approvedPlanSteps;

  const engineConfig: StepEngineConfig = {
    requestId: agentSessionId,
    sessionId: stableSessionId,
    model,
    apiKey,
    apiBase,
    systemPrompt: effectiveSystemPrompt,
    projectRoot,
    tools,
    mode,
    approvedPlanSteps: resolvedApprovedSteps,
    workTier: config.workTier,
    surface: config.surface,
    workspaceRoots: config.workspaceRoots,
    writableRoots: config.writableRoots,
    checkPermission,
    autoApprove,
    signal,
    isDeepThink: config.isDeepThink,
    reasoningEffort: config.reasoningEffort,
    toolChoice: config.toolChoice,
    temperature: config.temperature,
    depth: config.depth,
    agentName: config.agentName,
    sandboxMode: config.sandboxMode,
    timeContext: config.timeContext ?? true,
    tmuxContext: config.tmuxContext ?? process.env.AURAXIS_TMUX_CONTEXT === '1',
    plan: activePlan,
    compactTokenThreshold: contextConfig.maxTokensBeforeCompress || 900_000,
    // ContextConfig 的 'round' 对应 step-engine/context-manager 的 'snip' 策略。
    compressMode: contextConfig.compressMode === 'round' ? 'snip' : (contextConfig.compressMode ?? 'step'),
    stepKeepRecent: contextConfig.stepKeepRecent,
    compactModel: model,
    retryBaseDelayMs: 1000,
    adapter: config.adapter,
    fallbackModel: config.fallbackModel,
    executeTool: config.executeTool,
    makeToolCallId: (tc) => tc.id,
    onToolSummary: (r, tc) => buildToolSummary(tc.name, r.output, r.input),
    emit: (event) => observer.emit(event),
    onUsage: (usage) => observer.emit({ type: 'usage', ...usage }),
    onBeforeRequest: async (msgs) => {
      // UserPromptSubmit 生命周期钩子。
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (lastUser) {
        const hook = await runHooksFor(
          'UserPromptSubmit',
          { prompt: typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content) },
          projectRoot,
        ).catch(() => null);
        if (hook) {
          for (const out of hook.outputs) {
            if (!out.trim()) continue;
            const m = { role: 'user' as const, content: `[Hook 补充]\n${out}` };
            markInjected(m);
            msgs.push(m);
          }
        }
      }
    },
    onAssistantReady: () => undefined,
    interceptTool: async (tc) => {
      // 规划是模型可自主选择的工具.
      // EnterPlanMode generates a plan, waits for approval, and binds the
      // approved plan into the loop — permissions, the review gate and
      // TodoWrite tracking all switch to plan mode. ExitPlanMode acknowledges.
      if (tc.name === 'EnterPlanMode') {
        if (activePlan && mode === 'plan') {
          return { output: { entered: true, alreadyActive: true, plan: Planner.getSummary(activePlan) } };
        }
        const generated = await runPlanningPhase({
          model: config.planModel || model,
          apiKey,
          apiBase,
          adapter: config.adapter,
          systemPrompt: effectiveSystemPrompt,
          signal,
          observer,
        });
        if (!generated || generated.tasks.length === 0) {
          return { output: null, error: '规划失败：未能生成有效计划。请直接说明方案后继续执行。' };
        }
        const applyApproval = async (plan: TaskPlan): Promise<boolean> => {
          if (onPlanGenerated) {
            const approvedStepIds = await onPlanGenerated(plan);
            if (!approvedStepIds || approvedStepIds.length === 0) return false;
            activePlan = restrictPlanToApproved(plan, approvedStepIds);
          } else {
            // No approval UI (tests/headless) — auto-approve every step.
            activePlan = plan;
            activePlan.approvedSteps = plan.tasks.map((t) => t.id);
          }
          mode = 'plan';
          engineConfig.mode = 'plan';
          engineConfig.approvedPlanSteps = activePlan.approvedSteps;
          engineConfig.plan = activePlan;
          observer.emit({ type: 'plan_updated', plan: activePlan });
          return true;
        };
        if (await applyApproval(generated)) {
          const planMsg = {
            role: 'user' as const,
            content: `你的任务计划已获批准：\n${Planner.getSummary(activePlan!)}\n\n请按批准后的计划逐项执行，不要执行未包含在计划中的步骤。`,
          };
          markInjected(planMsg);
          messages.push(planMsg);
          return {
            output: {
              entered: true,
              approved: true,
              tasks: activePlan!.tasks.map((t) => ({ id: t.id, description: t.description })),
            },
          };
        }
        const deniedMsg = {
          role: 'user' as const,
          content: '用户未批准该计划。请继续以交互方式执行任务；修改类工具需要用户逐次确认。',
        };
        markInjected(deniedMsg);
        messages.push(deniedMsg);
        return { output: { entered: false, approved: false, message: '计划未获批准，继续交互执行。' } };
      }
      if (tc.name === 'ExitPlanMode') {
        if (!activePlan || mode !== 'plan') {
          return { output: null, error: '当前不在计划模式，无需退出' };
        }
        return { output: { exited: true, message: '已退出规划模式，继续实施。' } };
      }
      if (tc.name !== 'Replan') return null;
      if (!activePlan) return { output: null, error: '没有活动计划可重规划' };
      const replanPrompt = `以下是任务执行中途的状态。部分任务已完成，部分受阻。请基于当前情况生成一个新的子计划，仅包含剩余待完成的任务。\n\n当前计划状态: ${(tc.input as any).currentPlanStatus || '未知'}\n受阻任务: ${JSON.stringify((tc.input as any).blockedTasks || [])}\n重新规划原因: ${(tc.input as any).reason || '原始计划无法继续'}\n\n请输出 JSON 格式的新计划（仅包含还需要执行的任务）:\n{"tasks": [{"id": "1", "description": "...", "dependencies": []}]}`;
      try {
        const replanResult = await invokeLlm({
          model,
          apiKey,
          apiBase,
          adapter: config.adapter,
          systemPrompt: PLANNING_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: replanPrompt }],
          tools: [],
          responseFormat: 'json_object',
          signal: signal || new AbortController().signal,
        });
        if (!replanResult?.rawText) return { output: null, error: '重规划失败：LLM 返回空响应。' };
        const parsed = parsePlanFromLLMText(replanResult.rawText);
        if (!parsed || parsed.tasks.length === 0)
          return { output: null, error: '重规划失败：LLM 未返回有效的 JSON 计划。' };
        const merged = Planner.mergePlan(
          activePlan,
          parsed.tasks.map((t) => ({ description: t.description, dependencies: t.dependencies || [] })),
        );
        activePlan.tasks.length = 0;
        activePlan.tasks.push(...merged.tasks);
        return {
          output: {
            message: `重规划完成。新增 ${parsed.tasks.length} 个任务。当前共 ${activePlan.tasks.length} 个任务。`,
            newTasks: parsed.tasks.map((t) => ({ id: t.id, description: t.description })),
            planSummary: Planner.getSummary(activePlan),
          },
        };
      } catch (replanErr: unknown) {
        return { output: null, error: `重规划异常: ${errorText(replanErr)}` };
      }
    },
    onToolResult: (r, tc, toolCallId) => {
      emitToolObserverForResult(r, observer, activePlan, dd, tc.name);
      // Auto tier only: full access intentionally skips the gate, ask/plan
      // already involve the user. ReviewArtifact reports `passed:false`
      // inside its output (not as a tool error), so detect it here.
      if (tc.name === 'ReviewArtifact' && config.mode === 'auto' && !config.autoApprove && !r.error) {
        const out = (r.output ?? null) as Record<string, unknown> | null;
        if (out && out.passed === false) {
          reviewGate = {
            toolCallId,
            checkType: String(out.check_type ?? 'check'),
            summary: String(out.summary ?? ''),
          };
        }
      }
    },
  };

  // ── Phase 1-N: execution loop (thin driver) ───────────
  // Layer 1 (business): config.maxIterations (default 200) — graceful exit.
  // Layer 2 (fail-safe): SAFETY_MAX_ITERATIONS (500) — prevents runaway loops.
  const BUSINESS_MAX_ITERATIONS = config.maxIterations ?? 200;
  const SAFETY_MAX_ITERATIONS = 500;
  const turnId = makeTurnId(agentSessionId);
  observer.emit({ type: 'turn_start', turnId, timestamp: Date.now() });
  let lastIteration = startIter - 1;

  for (let iter = startIter; ; iter++) {
    if (signal?.aborted) break;

    if (iter > BUSINESS_MAX_ITERATIONS && iter <= SAFETY_MAX_ITERATIONS) {
      const errMsg = `已达到业务迭代上限 (${BUSINESS_MAX_ITERATIONS})，任务暂停收尾。已完成 ${state.toolCallCount} 次工具调用，如需继续可发送跟进任务。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }
    if (config.goal && iter > config.goal.maxRounds) {
      const errMsg = `已达到目标轮次上限（${config.goal.maxRounds} 轮），暂停执行。请总结当前进展。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }
    if (iter > SAFETY_MAX_ITERATIONS) {
      const errMsg = `达到安全硬上限 ${SAFETY_MAX_ITERATIONS} 次迭代，强制终止。已完成 ${state.toolCallCount} 次工具调用。`;
      observer.emit({ type: 'error', error: errMsg });
      state.allText += `\n\n⚠️ ${errMsg}`;
      break;
    }

    lastIteration = iter;
    state.iteration = iter;
    const iterStartTime = Date.now();
    const toolsBeforeIter = state.toolCallCount;
    const stepGroupId = crypto.randomUUID();
    // External follow-up messages (SendMessage / UI steer) are injected into
    // the conversation at the turn boundary — the LLM sees them as new user
    // instructions for the next step.
    if (config.messageQueue) {
      for (const text of config.messageQueue()) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) continue;
        const m = { role: 'user' as const, content: `[外部指令]\n${trimmed}` };
        markInjected(m);
        messages.push(m);
        observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'external',
          detail: trimmed,
        });
        observer.emit({ type: 'system_message', level: 'info', content: `收到外部指令：${trimmed.slice(0, 120)}` });
      }
    }
    // SWE-Touch：检测用户/其它进程在任务执行期间对工作区的外部修改。
    if (projectRoot) {
      try {
        const drifted = await workspaceDrift.takeDrift(projectRoot);
        if (drifted.length > 0) {
          const driftMsg = { role: 'user' as const, content: driftSummary(drifted) };
          markInjected(driftMsg);
          messages.push(driftMsg);
          observer.emit({
            type: 'context_injected',
            source: 'workspace',
            producer: 'drift-detector',
            detail: `检测到 ${drifted.length} 个文件被外部修改：${drifted.map((d) => d.filePath).join('、')}`,
          });
        }
      } catch {
        /* 漂移检测不允许影响主循环 */
      }
    }
    observer.emit({ type: 'iteration_start', iteration: iter });
    observer.onStateChange({
      iteration: iter,
      toolCallCount: state.toolCallCount,
      messagesCount: messages.length,
      plan: activePlan,
    });

    const outcome = await runStep(engineConfig, state, stepGroupId);

    observer.emit({
      type: 'iteration_end',
      iteration: iter,
      toolsThisIteration: state.toolCallCount - toolsBeforeIter,
      llmLatencyMs: Date.now() - iterStartTime,
      firstTokenMs: outcome.metrics?.firstTokenMs,
      outputTokens: outcome.metrics?.outputTokens,
    });

    // ── Auto-review gate (auto tier) ─────────────────────
    // A failed ReviewArtifact pauses after the iteration completes so the
    // user can decide: approve → the loop continues with an explicit
    // instruction; deny → the task stops for manual handling.
    const gate = pendingReviewGate();
    if (gate) {
      reviewGate = null;
      observer.emit({
        type: 'system_message',
        level: 'warning',
        content: `质量门未通过（${gate.checkType}），正在等待你确认是否继续修复。`,
      });
      const allowed = config.checkPermission
        ? await config.checkPermission(
            'ReviewArtifact',
            {
              action: 'continue_after_failed_review',
              check_type: gate.checkType,
              summary: gate.summary.slice(0, 300),
            },
            gate.toolCallId,
          )
        : true;
      if (allowed) {
        const m = {
          role: 'user' as const,
          content:
            '[用户] 已确认继续修复质量门失败项。请根据 ReviewArtifact 的失败输出修复，完成后再次调用 ReviewArtifact 验证通过。',
        };
        markInjected(m);
        messages.push(m);
        observer.emit({
          type: 'context_injected',
          source: 'instructions',
          producer: 'review-gate',
          detail: `用户确认继续修复质量门失败项（${gate.checkType}）`,
        });
      } else {
        const errMsg = `质量门未通过（${gate.checkType}），已暂停。请人工处理后继续。`;
        observer.emit({ type: 'error', error: errMsg });
        state.allText += `\n\n⚠️ ${errMsg}`;
        break;
      }
      // The user may have paused/stopped while the gate was waiting — honor
      // the abort immediately instead of running another iteration.
      if (signal?.aborted) break;
    }

    if (outcome.status === 'stop' || outcome.status === 'aborted') break;
  }

  observer.emit({ type: 'turn_end', turnId, reason: signal?.aborted ? 'aborted' : 'completed', timestamp: Date.now() });
  observer.emit({ type: 'done' });
  void runHooksFor('Stop', { iterations: lastIteration, toolCallCount: state.toolCallCount }, projectRoot).catch(
    () => {},
  );
  return {
    allText: state.allText,
    toolCallCount: state.toolCallCount,
    iterations: lastIteration,
    log: [],
    plan: activePlan,
    messages,
  };
}
