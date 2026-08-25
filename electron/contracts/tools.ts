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
    properties: Record<string, any>;
    required: string[];
    additionalProperties?: boolean;
  };
}
