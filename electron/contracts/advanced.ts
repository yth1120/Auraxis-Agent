/**
 * advanced.ts — single source of truth for MCP / permission / agent types.
 *
 * electron/advanced-defs.ts and src/types/advanced.ts both re-export from
 * here; fields that only one side needed (maxIterations, parentAgentId, goal)
 * are merged so neither side loses information.
 */
import type { ApprovalPolicy } from './core';
import type { ToolName } from './tools';

export type { ApprovalPolicy };
export { normalizeApprovalPolicy } from './core';
export * from './permission';

/** DeepSeek tool_choice：auto / none / required / 强制指定某个工具。 */
export type DeepSeekToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/** Work 模式执行自主度（档位）。
 *  · plan  — 计划确认：先规划并审批，审批后计划内动作自动执行。
 *  · smart — 智能放行：低风险自动，中/高风险逐项询问。
 *  · full  — 全自动：低/中风险自动，高危操作仍询问（除非 autoApprove）。
 */
export type WorkAutonomyTier = 'plan' | 'smart' | 'full';

export const WORK_AUTONOMY_TIERS: readonly WorkAutonomyTier[] = ['plan', 'smart', 'full'];

export function normalizeWorkAutonomyTier(value: unknown): WorkAutonomyTier {
  if (value === 'plan' || value === 'smart' || value === 'full') return value;
  return 'smart';
}

/** 交付验收数据：任务完成后呈现给用户的结构化交付物清单。 */
export interface WorkDelivery {
  files: string[];
  result: string;
  summary?: string;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** 仅为 DeepSeek Harness 预设启用：把 Auraxis 中已保存的 DeepSeek Key
   *  注入该 MCP 子进程，避免把密钥复制到 localStorage。 */
  useAuraxisDeepSeekKey?: boolean;
  /** 仅为飞书/Lark MCP 预设启用：从加密设置中注入 App ID / App Secret。 */
  useAuraxisLarkCredentials?: boolean;
  enabled: boolean;
}

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  serverId: string;
}

export interface MCPStatus {
  serverId: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface PermissionRule {
  id: string;
  toolName: string;
  action: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always';
  createdAt: number;
  matchPattern?: string;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  message: string;
  timestamp: number;
  mode: ApprovalPolicy;
  oldContent?: string;
  /** Set when the request originates from a background (Code-mode) agent task. */
  agentId?: string;
}

export type AgentPriority = 'high' | 'normal' | 'low';

export type AgentStatus = 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'stopped' | 'review';

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
    | 'progress'
    | 'warning'
    | 'error'
    | 'plan'
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
  turnId?: string;
  reason?: string;
  streamOutput?: string;
  summary?: Record<string, unknown>;
  compaction?: {
    tokensBefore: number;
    tokensAfter: number;
    messagesRemoved?: number;
    tokensSaved?: number;
  };
  /** Shared identifier for tool calls dispatched in the same parallel batch. */
  stepGroupId?: string;
  toolsThisIteration?: number;
  llmLatencyMs?: number;
  firstTokenMs?: number;
  outputTokens?: number;
  disclosure?: { source: 'instructions' | 'memory' | 'workspace'; producer: string; detail?: string; content?: string };
  todos?: { content: string; status: string; activeForm?: string }[];
}

export interface AgentPlan {
  planId?: string;
  todos: { content: string; status: string; activeForm?: string }[];
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  projectRoot?: string;
  /** Built-in agent role (Explore / Plan / general-purpose). */
  type?: 'Explore' | 'Plan' | 'general-purpose' | string;
  status: AgentStatus;
  priority?: AgentPriority;
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  toolCallCount: number;
  iterations?: number;
  /** Renderer-facing singular iteration alias. */
  iteration?: number;
  /** LLM message count snapshot used by scheduler UI. */
  messagesCount?: number;
  model?: string;
  maxIterations?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalReasoningTokens?: number;
  totalCacheHitTokens?: number;
  totalCacheMissTokens?: number;
  parentAgentId?: string;
  goal?: { text: string; maxRounds: number } | null;
  /** 该 Agent 通过 Report 工具发送的进度汇报。 */
  reports?: { id: string; text: string; ts: number }[];
  log: AgentLogEntry[];
  /** Which UI surface this task belongs to ('work' / 'code' lists are separate). */
  surface?: 'chat' | 'work' | 'code';
  customTools?: ToolName[];
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  toolChoice?: DeepSeekToolChoice;
  workspaceId?: string;
  plan?: AgentPlan | null;
  planFile?: string;
  /** Work 模式执行档位（透传到前端展示/恢复）。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
  /** Work 模式交付验收数据。 */
  delivery?: WorkDelivery;
}

export interface AgentCreateRequest {
  name: string;
  description: string;
  /** UI-facing description (user's literal words). `description` may carry an
   *  internal prompt wrapper (e.g. follow-up context) that must never render. */
  displayDescription?: string;
  type?: 'Explore' | 'Plan' | 'general-purpose';
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
  toolChoice?: DeepSeekToolChoice;
  /** 审批策略 for this task's tool calls (ask/plan/auto). */
  mode?: ApprovalPolicy;
  /** Work 模式执行自主度档位。 */
  workTier?: WorkAutonomyTier;
  /** 项目工作区根目录（含主根）。 */
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
