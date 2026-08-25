// Tool-related type definitions shared between renderer and main process.
// Tool identity + base ToolDef live in electron/contracts/tools.ts.
import type { ToolName } from '../../electron/contracts/tools';
export type { ToolName, BuiltInToolName, ToolDef } from '../../electron/contracts/tools';

type ToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface ToolCall {
  id: string;
  requestId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  output?: unknown;
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

// IPC event types
interface ToolEventBase {
  requestId: string;
  toolCallId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
  timestamp: number;
  /** Groups tool calls from the same LLM turn into a collapsible tree node. */
  stepGroupId: string;
}

interface ToolStartEvent extends ToolEventBase {
  type: 'tool_start';
}

interface ToolProgressEvent extends ToolEventBase {
  type: 'tool_progress';
  progress: string;
}

interface ToolEndEvent extends ToolEventBase {
  type: 'tool_end';
  output: unknown;
  durationMs: number;
}

interface ToolErrorEvent extends ToolEventBase {
  type: 'tool_error';
  error: string;
}

export type ToolStreamEvent =
  | { type: 'text_chunk'; requestId: string; text: string }
  | ToolStartEvent
  | ToolProgressEvent
  | ToolEndEvent
  | ToolErrorEvent
  | { type: 'iteration'; requestId: string; iteration: number; maxIterations: number }
  | {
      type: 'context_compressed';
      requestId: string;
      tokensBefore: number;
      tokensAfter: number;
      messagesRemoved?: number;
      tokensSaved?: number;
    }
  | {
      type: 'tool_aborted';
      requestId: string;
      toolCallId: string;
      toolName: ToolName;
      input: Record<string, unknown>;
      timestamp: number;
      error: string;
      stepGroupId: string;
    }
  | { type: 'system_message'; requestId: string; level: 'warning' | 'info'; content: string }
  | {
      type: 'context_injected';
      requestId: string;
      source: 'instructions' | 'memory';
      producer: string;
      detail?: string;
    }
  | { type: 'thinking_chunk'; requestId: string; chunk: string; isNewBlock: boolean }
  | {
      type: 'usage_update';
      requestId: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    }
  | {
      type: 'plan_generated';
      requestId: string;
      planId: string;
      steps: import('./chat').PlanStep[];
      filePath?: string;
      agentId?: string;
    }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; error: string };
