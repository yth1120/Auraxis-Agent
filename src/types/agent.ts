// Unified Agent type definitions — single source of truth
// Merges AgentInfo (System A) + AgentState (System B) into one schema

import type { ToolName } from './tools';
import type { PermissionRequest, ApprovalPolicy, DeepSeekToolChoice, WorkAutonomyTier, WorkDelivery } from './advanced';
import type { CompactionData, ContextDisclosure } from './chat';

// ─── Status ────────────────────────────────────────

export type AgentStatus = 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'stopped' | 'review';

// ─── Priority ──────────────────────────────────────

export type AgentPriority = 'high' | 'normal' | 'low';

// ─── Log ───────────────────────────────────────────

export interface AgentLogEntry {
  type:
    | 'text'
    | 'thinking'
    | 'user_message'
    | 'tool_start'
    | 'tool_end'
    | 'tool_error'
    | 'iteration_start'
    | 'iteration_end'
    | 'turn_start'
    | 'turn_end'
    | 'error'
    | 'plan'
    | 'progress'
    | 'warning'
    | 'context';
  timestamp: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  durationMs?: number;
  error?: string;
  iteration?: number;
  maxIterations?: number;
  /** Shared identifier for tool calls dispatched in the same parallel batch. */
  stepGroupId?: string;
  /** Structured tool output summary for card rendering */
  summary?: Record<string, unknown>;
  /** Live terminal/stdout payload accumulated while the tool is running. */
  streamOutput?: string;
  /** Per-tool timing */
  toolsThisIteration?: number;
  llmLatencyMs?: number;
  /** Time from step start to the first streamed token (ms). */
  firstTokenMs?: number;
  /** LLM output tokens attributed to this iteration. */
  outputTokens?: number;
  /** Turn-scoped lifecycle ids （每回合一个尾部操作行）. */
  turnId?: string;
  reason?: string;
  /** Context-compaction checkpoint (rendered as an inline foldable row). */
  compaction?: CompactionData;
  /** Injected-context disclosure （上下文注入披露). */
  disclosure?: ContextDisclosure;
  todos?: { content: string; status: string; activeForm?: string }[];
}

// ─── Plan ──────────────────────────────────────────

export interface AgentPlan {
  planId?: string;
  todos: { content: string; status: string; activeForm?: string }[];
}

// ─── Core Agent ────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  type: 'Explore' | 'Plan' | 'general-purpose';
  status: AgentStatus;
  priority: AgentPriority;

  startTime: number;
  endTime?: number;

  // Execution stats
  iteration: number;
  maxIterations: number;
  toolCallCount: number;
  messagesCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** 实测推理 tokens 与上下文缓存命中/未命中（API usage，累计）。 */
  totalReasoningTokens?: number;
  totalCacheHitTokens?: number;
  totalCacheMissTokens?: number;
  /** Project directory this task operates in (workspace linkage). */
  projectRoot?: string;
  /** Which UI surface this task belongs to ('work' / 'code' lists are separate). */
  surface?: 'chat' | 'work' | 'code';
  parentAgentId?: string;
  /** 通过 Report 工具发送的进度汇报。 */
  reports?: { id: string; text: string; ts: number }[];
  goal?: { text: string; maxRounds: number } | null;

  // Tool set override (empty = use type defaults)
  customTools?: ToolName[];

  // LLM config
  model?: string;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;

  // Workspace isolation
  workspaceId?: string;

  // Result
  result?: string;
  error?: string;

  /** Work 模式执行档位。 */
  workTier?: WorkAutonomyTier;
  /** Work 模式交付验收数据（任务完成后由后端结构化生成）。 */
  delivery?: WorkDelivery;

  // Plan (from scheduler path)
  plan?: AgentPlan | null;
  /** Markdown file this agent's plan was persisted to (`.auraxis/plans/`). */
  planFile?: string;

  // Live log (from IPC streaming path)
  log: AgentLogEntry[];
}

/** Durable same-session goal state (mirrors electron/goal-store). */
export interface AgentGoalState {
  id: string;
  sessionId: string;
  text: string;
  phase: 'active' | 'paused' | 'completed' | 'blocked' | 'cleared';
  reason?: string;
  revision: number;
  roundsStarted: number;
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
}

// ─── Create request ────────────────────────────────

export interface AgentCreateRequest {
  name: string;
  description: string;
  /** UI-facing description (user's literal words). `description` may carry an
   *  internal prompt wrapper (e.g. follow-up context) that must never render. */
  displayDescription?: string;
  type: 'Explore' | 'Plan' | 'general-purpose';
  model: string;
  temperature?: number;
  messages?: { role: string; content: string }[];
  projectRoot?: string;
  apiKey?: string;
  priority?: AgentPriority;
  maxIterations?: number;
  customTools?: ToolName[];
  autoApprove?: boolean;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  /** DeepSeek tool_choice：auto/none/required/强制指定工具。 */
  toolChoice?: DeepSeekToolChoice;
  /** 审批策略 for this task's tool calls (ask/plan/auto). */
  mode?: ApprovalPolicy;
  /** Work 模式执行自主度档位。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）；工具读写边界由它界定。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Per-task sandbox boundary; falls back to the global setting when absent. */
  sandboxMode?: 'read' | 'workspace-write' | 'full';
  /** Which UI surface created this task — 'chat' is rejected by the backend. */
  surface?: 'chat' | 'work' | 'code';
  /** Active goal carried into the agent run （目标状态）. */
  goal?: { text: string; maxRounds: number } | null;
}

// ─── IPC action envelope ───────────────────────────

export type AgentAction =
  | { type: 'start'; payload: AgentCreateRequest; projectPath: string }
  | { type: 'stop'; agentId: string }
  | { type: 'pause'; agentId: string }
  | { type: 'resume'; agentId: string }
  | { type: 'setPriority'; agentId: string; priority: AgentPriority }
  | { type: 'setMaxConcurrent'; count: number }
  | { type: 'getAll' }
  | { type: 'getState'; agentId: string }
  | { type: 'remove'; agentId: string }
  | { type: 'clear' };

// ─── Store shape ───────────────────────────────────

export interface AgentStore {
  agents: AgentInfo[];
  isLoading: boolean;
  maxConcurrent: number;
  /** The agent task currently focused in the Code-mode middle column. */
  currentAgentId: string | null;
  /** 各模式记住最近选中的任务：切走再切回时恢复，不再清空。 */
  lastAgentIdBySurface: { work?: string; code?: string };
  /** Pending permission prompts keyed by the agent task they belong to. */
  agentPermissions: Record<string, PermissionRequest[]>;

  // Local mutations
  setCurrentAgent: (id: string | null) => void;
  setPlanFile: (path: string | null, agentId?: string) => void;
  addAgent: (agent: AgentInfo) => void;
  updateAgent: (id: string, updates: Partial<AgentInfo>) => void;
  removeAgent: (id: string) => void;
  appendAgentLog: (id: string, entries: AgentLogEntry[]) => void;
  addAgentPermission: (agentId: string, req: PermissionRequest) => void;
  removeAgentPermission: (agentId: string, requestId: string) => void;

  // IPC-backed actions
  startAgent: (request: AgentCreateRequest, projectPath: string) => Promise<string | null>;
  stopAgent: (agentId: string) => Promise<void>;
  stopAllAgents: () => Promise<void>;
  pauseAgent: (agentId: string) => Promise<void>;
  resumeAgent: (agentId: string) => Promise<void>;
  /** Continue a settled task on the SAME agent (id/workspace/history). */
  continueAgent: (
    agentId: string,
    instruction: string,
    displayInstruction?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Work 交付验收通过：review → completed。 */
  approveDelivery: (agentId: string) => Promise<{ ok: boolean; error?: string }>;
  setAgentPriority: (agentId: string, priority: AgentPriority) => Promise<void>;
  setMaxConcurrent: (count: number) => Promise<void>;
  refreshStates: () => Promise<void>;
  clearAgents: () => Promise<void>;

  // Subscriptions
  subscribeToUpdates: () => () => void;
}
