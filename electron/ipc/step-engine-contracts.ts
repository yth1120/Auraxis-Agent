/**
 * step-engine-contracts.ts — 步进引擎配置契约（叶子模块）。
 *
 * StepEngineConfig 原在 step-engine.ts；agent-loop / query-engine / 拦截器都用它，
 * 类型边因此把 step-engine 拉进类型环。契约下沉后使用方只依赖本模块。
 */
import type { ApprovalPolicy, WorkAutonomyTier } from '../types';
import type { ToolDef } from '../tool-defs';
import type { SandboxMode } from '../sandbox-policy';
import type { AssistantMessage, LoopMessage, TaskPlan, StopDecision } from './agent-loop';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import type { RunnerToolCall, RunnerToolResult } from './tool-runner';
import type { EngineEvent } from './engine-events';

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
  onBeforeRequest?: (messages: LoopMessage[]) => Promise<void> | void;
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
  riskGate?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  onBeforeToolDispatch?: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolStart?: (tc: RunnerToolCall, toolCallId: string) => void;
  onToolProgress?: (tc: RunnerToolCall, toolCallId: string, chunk: string) => void;
  /** Per-result side effects (stats, sub-agent updates, deviance warnings). */
  onToolResult?: (result: RunnerToolResult, tc: RunnerToolCall, toolCallId: string) => void;
  /** Test seam — defaults to the real tool dispatcher. */
  executeTool?: typeof import('./tool-handlers').executeToolCall;
  emit: (event: EngineEvent) => void;
}
