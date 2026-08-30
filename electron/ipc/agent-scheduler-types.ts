/**
 * agent-scheduler-types.ts — scheduler contracts and pure plan mapping.
 *
 * Separating these interfaces from the scheduler implementation makes the
 * runtime class easier to audit and lets tests import the shapes without
 * loading the full scheduler.
 */
import type { AgentObserver, AgentStateSnapshot, LoopMessage, TaskPlan } from './agent-loop';
import type { DeepSeekToolChoice, WorkAutonomyTier, WorkDelivery } from '../contracts/advanced';
import type { ApprovalPolicy } from '../types';
import type { SandboxMode } from '../sandbox-policy';
import type { AgentLogEntry } from '../advanced-defs';

export interface FrontendTaskPlan {
  todos: { content: string; status: string; activeForm: string }[];
}

export interface SchedulerAgentState extends Omit<AgentStateSnapshot, 'plan'> {
  agentId: string;
  name: string;
  status: AgentInstance['status'];
  priority: 'high' | 'normal' | 'low';
  startTime?: number;
  endTime?: number;
  model?: string;
  maxIterations?: number;
  error?: string;
  result?: string;
  type?: string;
  description?: string;
  workTier?: WorkAutonomyTier;
  delivery?: WorkDelivery;
  plan: FrontendTaskPlan | null;
}

export interface SchedulerQueueItem {
  agentId: string;
  name: string;
  status: AgentInstance['status'];
  priority: 'high' | 'normal' | 'low';
  startTime?: number;
  queuePosition?: number;
}

export function taskPlanToFrontendPlan(plan: TaskPlan | null | undefined): FrontendTaskPlan | null {
  if (!plan) return null;
  return {
    todos: plan.tasks.map((t) => ({
      content: t.description,
      status: t.status,
      activeForm: `执行: ${t.description}`,
    })),
  };
}

export interface AgentConfig {
  name: string;
  description?: string;
  /** What the UI shows as the task description. `description` may carry an
   *  internal prompt wrapper (e.g. follow-up context) that must never render. */
  displayDescription?: string;
  /** Built-in agent role (Explore / Plan / general-purpose). Used to derive
   *  the system prompt when the caller doesn't supply one. */
  type?: string;
  model: string;
  /** Optional — built from the BUILTIN_AGENTS template (by `type`) when absent. */
  systemPrompt?: string;
  tools?: string[];
  temperature?: number;
  apiKey: string;
  priority?: 'high' | 'normal' | 'low';
  autoApprove?: boolean;
  mode?: ApprovalPolicy;
  /** Work 模式执行自主度档位（plan/smart/full）。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）；工具读写边界由它界定。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Per-task sandbox override — falls back to the global setting when absent. */
  sandboxMode?: SandboxMode;
  approvedPlanSteps?: string[];
  /** Business iteration limit. Default 200 in agentLoopRun. */
  maxIterations?: number;
  /** Enable deep thinking mode (DeepSeek V4 reasoning). */
  isDeepThink?: boolean;
  /** Reasoning effort level: low/medium/high/max. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  /** Which UI surface created this task — 'chat' is rejected (pure conversation). */
  surface?: 'chat' | 'work' | 'code';
  /** Active goal for this run （目标状态）. */
  goal?: { text: string; maxRounds: number } | null;
  /** Opaque caller metadata (e.g. cron job id) surfaced on terminal listeners. */
  metadata?: Record<string, unknown>;
}

export interface AgentInstance {
  agentId: string;
  config: AgentConfig;
  status: 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'queued' | 'paused' | 'review';
  priority: 'high' | 'normal' | 'low';
  queuePosition: number;
  startTime: number;
  endTime?: number;
  /** User-supplied project root. Captured at startAgent time so a queued agent
   *  dequeued later still knows which directory to operate in. */
  projectPath: string;
  /** Follow-up instruction queued by continueAgent, emitted when the run starts. */
  pendingInstruction?: string;
  abortController: AbortController;
  observer: AgentObserver;
  plan?: TaskPlan | null;
  result?: string;
  error?: string;
  /** Work 模式交付验收数据（结构化，非日志反推）。 */
  delivery?: WorkDelivery;
  toolCallCount: number;
  iterations: number;
  /** LLM message count snapshot — updated by observer.onStateChange. Distinct
   *  from log.length (which only counts text chunks). */
  messagesCount: number;
  maxIterations: number;
  checkPermission?: (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId?: string,
    agentId?: string,
  ) => Promise<boolean>;
  log: AgentLogEntry[];
  /** Unflushed engine events for the durable agent run log (session-log). */
  logBuffer: unknown[];
  /** Snapshot captured when the loop exits with status==='paused'.
   *  agentLoopRun reads this via config.resumeFrom on the next dequeueAndStart. */
  savedState?: {
    messages: LoopMessage[];
    plan: TaskPlan | null;
    iteration: number;
    toolCallCount: number;
    allText: string;
  };
  /** Final LLM transcript captured when the loop settles (completed/error/
   *  stopped). Continuation reuses it so a follow-up keeps the SAME task —
   *  same id, same workspace, same conversation history. */
  lastMessages?: LoopMessage[];
  /** Resolver for the in-flight pauseAgent call. Set when pauseAgent triggers
   *  abort; cleared and invoked when the loop's .then/.catch handler has
   *  captured savedState (or determined there is none). Callers awaiting
   *  pauseAgent's Promise are guaranteed savedState is settled when it resolves. */
  pauseResolve?: () => void;
  /** Same lifecycle as pauseResolve, but exposed as a Promise so resumeAgent
   *  (and any other operation that depends on savedState being captured) can
   *  await it without holding a reference to pauseAgent's returned Promise.
   *  Prevents the fire-and-forget race: caller does NOT await pauseAgent,
   *  immediately calls resumeAgent; without this, resume would read savedState
   *  before the loop's .then has written it. */
  pauseSettled?: Promise<void>;
}
