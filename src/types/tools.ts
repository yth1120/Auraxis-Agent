// Tool-related type definitions shared between renderer and main process.
// Tool identity + base ToolDef live in electron/contracts/tools.ts.
import type { ToolName } from '../../electron/contracts/tools';
export type { ToolName, BuiltInToolName, ToolDef, ToolStreamEvent } from '../../electron/contracts/tools';

type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ToolCall {
  id: string;
  requestId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  output?: unknown;
  summary?: Record<string, unknown>;
  status: ToolStatus;
  startTime: number;
  endTime?: number;
  error?: string;
  streamOutput?: string;
  /** Groups tool calls from the same LLM turn into a collapsible tree node. */
  stepGroupId?: string;
  /** Pre-modification file content (Write/Edit tools) — enables diff rendering. */
  oldContent?: string;
  /** Post-modification file content (Write/Edit tools). */
  newContent?: string;
}

/** Raw agent runtime event streamed over `agent:event:*` IPC. */
export interface AgentRuntimeEvent extends Record<string, unknown> {
  type: string;
  timestamp?: number;
  text?: string;
  chunk?: string;
  progress?: string;
  message?: string;
  content?: string;
  level?: 'warning' | 'info' | string;
  source?: 'instructions' | 'memory' | string;
  producer?: string;
  detail?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  summary?: Record<string, unknown>;
  durationMs?: number;
  stepGroupId?: string;
  streamOutput?: string;
  error?: string;
  iteration?: number;
  maxIterations?: number;
  toolsThisIteration?: number;
  llmLatencyMs?: number;
  firstTokenMs?: number;
  outputTokens?: number;
  turnId?: string;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  messagesRemoved?: number;
  tokensSaved?: number;
  inputTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  tasks?: Array<{ description?: string; status?: string }>;
  /** Raw plan payload: either frontend {todos} or backend TaskPlan {tasks}. */
  plan?: {
    todos?: Array<{ content: string; status: string; activeForm?: string }>;
    tasks?: Array<{ description?: string; status?: string }>;
  };
}
