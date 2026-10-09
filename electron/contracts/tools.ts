/**
 * tools.ts — single source of truth for tool identity + the shared ToolDef
 * shape. electron/tool-defs.ts extends ToolDef with main-process-only fields
 * (isConcurrencySafe); the renderer uses this base shape for plugin tools.
 */

/** Built-in tool names. The union is kept for type-narrowing in tool handlers. */
/**
 * 内置工具名。
 *
 * ⚠️ 这张清单是**工具身份的唯一事实源**，必须与 `electron/tool-defs/` +
 * `ipc/tool-handlers/registry.ts` 保持一致。它曾经漏掉 17 个真实存在的工具
 * （Delete / ReadImage / GitCommit / Terminal* / Schedule* / Job* …），后果不是编译失败，
 * 而是 UI 侧按 `Record<BuiltInToolName, X>` 建的映射表**静默漏掉它们**，
 * 这些步骤在界面上退化成兜底分类。新增工具时**必须**同时加在这里。
 */
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
  | 'TaskList'
  | 'ReadImage'
  | 'StrReplaceEditor'
  | 'Delete'
  | 'IngestDocument'
  | 'GitCommit'
  | 'TerminalOpen'
  | 'TerminalList'
  | 'TerminalRead'
  | 'TerminalSend'
  | 'TerminalSignal'
  | 'TerminalClose'
  | 'ScheduleCreate'
  | 'ScheduleDelete'
  | 'ScheduleList'
  | 'JobList'
  | 'JobOutput'
  | 'JobKill'
  | 'BrowserOpen'
  | 'BrowserRead'
  | 'BrowserScreenshot';

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
      /**
       * 引擎算好的结构化摘要事实（`buildToolSummary`：行数 / 字节数 / 退出码 / 命中数）。
       * 语言无关，由渲染层翻成一行字 —— 不要在引擎里拼展示文案。
       */
      summary?: Record<string, unknown>;
    }
  /**
   * 迭代进度。`maxIterations` 来自本次请求真实解析出的预算（见 resolveIterationBudget）；
   * 拿不到时**省略而不是编一个数** —— 从前这里硬编码 25，界面上会把真实预算显示错。
   */
  | { type: 'iteration'; requestId: string; iteration: number; maxIterations?: number }
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
