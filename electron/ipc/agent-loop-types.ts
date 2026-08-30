/** agent-loop-types.ts — pure loop contracts shared by the loop implementation. */
import type { ToolDef } from '../tool-defs';
import type { DeepSeekToolChoice } from '../contracts/advanced';
import type { AgentLogEntry } from '../advanced-defs';
import type { ApprovalPolicy, WorkAutonomyTier } from '../types';
import type { SandboxMode } from '../sandbox-policy';
import type { executeToolCall as ExecuteToolCall } from './tool-handlers';

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

export type LoopMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LoopMessage {
  role: string;
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface AssistantMessage {
  contentTimeline: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  toolCalls: ToolCall[];
  rawText: string;
  thinkingText?: string;
  isFinal: boolean;
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
  maxRounds: number;
  compressRatio: number;
  compressMode?: 'round' | 'step';
  stepKeepRecent?: number;
  useLLMSummary?: boolean;
  maxTokensBeforeCompress?: number;
}

export interface LLMSummaryConfig {
  model: string;
  apiKey: string;
  apiBase: string;
  signal?: AbortSignal;
}

export interface AgentObserver {
  emit(event: AgentLoopEvent): void;
  onStateChange(snapshot: AgentStateSnapshot): void;
}

export interface AgentStateSnapshot {
  iteration: number;
  toolCallCount: number;
  messagesCount: number;
  plan: TaskPlan | null;
  surface?: 'chat' | 'work' | 'code';
}

export interface AgentLoopConfig {
  model: string;
  apiKey: string;
  apiBase: string;
  systemPrompt: string;
  projectRoot: string;
  sessionId?: string;
  messageQueue?: () => string[];
  tools: ToolDef[];
  signal?: AbortSignal;
  checkPermission?: (toolName: string, input: Record<string, unknown>, toolCallId?: string) => Promise<boolean>;
  autoApprove?: boolean;
  mode: ApprovalPolicy;
  approvedPlanSteps?: string[];
  workTier?: WorkAutonomyTier;
  surface?: 'chat' | 'work' | 'code';
  workspaceRoots?: string[];
  writableRoots?: string[];
  onPlanGenerated?: (plan: TaskPlan) => Promise<string[] | null>;
  observer: AgentObserver;
  depth?: number;
  agentName?: string;
  temperature?: number;
  contextConfig?: ContextConfig;
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  toolChoice?: DeepSeekToolChoice;
  maxIterations?: number;
  sandboxMode?: SandboxMode;
  timeContext?: boolean;
  tmuxContext?: boolean;
  planModel?: string;
  adapter?: string;
  fallbackModel?: string;
  executeTool?: typeof ExecuteToolCall;
  goal?: { text: string; maxRounds: number } | null;
  forcePlanning?: boolean;
  resumeFrom?: {
    messages: LoopMessage[];
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
  messages: LoopMessage[];
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PlanTask {
  id: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  toolMatches?: string[];
}

export interface TaskPlan {
  tasks: PlanTask[];
  createdAt: number;
  approvedSteps?: string[];
}
