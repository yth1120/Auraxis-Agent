/**
 * tools.ts — single source of truth for tool identity + the shared ToolDef
 * shape. electron/tool-defs.ts extends ToolDef with main-process-only fields
 * (isConcurrencySafe); the renderer uses this base shape for plugin tools.
 */

/** Built-in tool names. The union is kept for type-narrowing in tool handlers. */
export type BuiltInToolName =
  | 'Bash'
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Grep'
  | 'Glob'
  | 'WebFetch'
  | 'WebSearch'
  | 'TodoWrite'
  | 'Agent'
  | 'Replan'
  | 'CronCreate'
  | 'CronDelete'
  | 'CronList'
  | 'TaskOutput'
  | 'TaskStop'
  | 'EnterPlanMode'
  | 'ExitPlanMode'
  | 'NotebookEdit'
  | 'EnterWorktree'
  | 'LSP'
  | 'ReviewArtifact'
  | 'ListSkills'
  | 'ReadSkill'
  | 'SessionQuery'
  | 'ReadSpill'
  | 'RunWorkflow'
  | 'RunCode'
  | 'AskUser'
  | 'Pty'
  | 'ReadDocument'
  | 'WriteDocument'
  | 'SlackListChannels'
  | 'SlackPostMessage'
  | 'DriveList'
  | 'DriveRead'
  | 'NotionSearch'
  | 'NotionCreatePage'
  | 'InspectRuntime'
  | 'WriteSkill'
  | 'ListAgents'
  | 'SendMessage'
  | 'InterruptAgent'
  | 'Report'
  | 'GetGoal'
  | 'CreateGoal'
  | 'UpdateGoal'
  | 'MountPlugin'
  | 'UnmountPlugin'
  | 'Ralph'
  | 'Pwsh'
  | 'SessionEventSearch'
  | 'SessionEventRead'
  | 'SessionTrace'
  | 'TaskList';

/** Any tool name — built-in, MCP (mcp__ prefix), or plugin-provided. */
export type ToolName = BuiltInToolName | (string & {});

/** Minimal tool definition shared by both processes. */
export interface ToolDef {
  name: ToolName;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
}

/** Shared IPC event payload for chat/query streaming. */
export type ToolStreamEvent =
  | { type: 'text_chunk'; requestId: string; text: string }
  | {
      type: 'tool_start' | 'tool_progress' | 'tool_end' | 'tool_error' | 'tool_aborted';
      requestId: string;
      toolCallId: string;
      toolName: ToolName;
      input: Record<string, unknown>;
      timestamp: number;
      stepGroupId: string;
      progress?: string;
      output?: unknown;
      durationMs?: number;
      error?: string;
    }
  | { type: 'iteration'; requestId: string; iteration: number; maxIterations: number }
  | {
      type: 'context_compressed';
      requestId: string;
      tokensBefore: number;
      tokensAfter: number;
      messagesRemoved?: number;
      tokensSaved?: number;
    }
  | { type: 'system_message'; requestId: string; level: 'warning' | 'info'; content: string }
  | {
      type: 'context_injected';
      requestId: string;
      source: 'instructions' | 'memory' | 'workspace';
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
      steps: Array<{
        id: string;
        toolName: string;
        description: string;
        parameters: Record<string, unknown>;
      }>;
      filePath?: string;
      agentId?: string;
    }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; error: string };
