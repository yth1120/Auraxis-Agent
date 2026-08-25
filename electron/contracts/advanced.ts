/**
 * advanced.ts — single source of truth for MCP / permission / agent types.
 *
 * electron/advanced-defs.ts and src/types/advanced.ts both re-export from
 * here; fields that only one side needed (maxIterations, parentAgentId, goal)
 * are merged so neither side loses information.
 */
import type { ApprovalPolicy } from './core';

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
  enabled: boolean;
}

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
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

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'review';

export interface AgentLogEntry {
  type:
    | 'text'
    | 'tool_start'
    | 'tool_end'
    | 'tool_error'
    | 'iteration_start'
    | 'iteration_end'
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
  /** Shared identifier for tool calls dispatched in the same parallel batch. */
  stepGroupId?: string;
  toolsThisIteration?: number;
  llmLatencyMs?: number;
  firstTokenMs?: number;
  outputTokens?: number;
  disclosure?: { source: string; producer: string; detail?: string };
  todos?: { content: string; status: string; activeForm: string }[];
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  projectRoot?: string;
  /** Built-in agent role (Explore / Plan / general-purpose). */
  type?: string;
  status: AgentStatus;
  priority?: 'high' | 'normal' | 'low';
  startTime: number;
  endTime?: number;
  result?: string;
  error?: string;
  toolCallCount: number;
  iterations: number;
  /** LLM message count snapshot used by scheduler UI. */
  messagesCount?: number;
  model?: string;
  maxIterations?: number;
  parentAgentId?: string;
  goal?: { text: string; maxRounds: number } | null;
  /** 该 Agent 通过 Report 工具发送的进度汇报。 */
  reports?: { id: string; text: string; ts: number }[];
  log: AgentLogEntry[];
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
  model: string;
  messages: { role: string; content: string }[];
  projectRoot: string;
  apiKey: string;
  autoApprove?: boolean;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 项目工作区根目录（含主根）。 */
  workspaceRoots?: string[];
  /** 项目可写根目录（roots 的子集）。 */
  writableRoots?: string[];
}
