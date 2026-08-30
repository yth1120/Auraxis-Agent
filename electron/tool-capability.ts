/**
 * tool-capability.ts — single source of truth for tool side effects.
 *
 * Previously the same sets were duplicated in tool-handlers, work-docs-policy,
 * sandbox-policy and permission-profile. Keeping one matrix makes it much
 * harder to add a tool with inconsistent Work/Profile/Sandbox treatment.
 */

/** Pure read tools that never mutate files or external state. */
export const FILE_READ_TOOLS = new Set([
  'Read',
  'ReadImage',
  'Grep',
  'Glob',
  'ReadDocument',
  'LSP',
  'SessionQuery',
  'SessionEventSearch',
  'SessionEventRead',
  'SessionTrace',
]);

/** Tools whose primary effect is a project/user file write. */
export const FILE_WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'Delete',
  'NotebookEdit',
  'StrReplaceEditor',
  'WriteDocument',
  'GitCommit',
]);

/** File mutations that need an old/new diff before approval. */
export const FILE_DIFF_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Read-only integration lookups (no external mutation). */
export const INTEGRATION_READ_TOOLS = new Set(['SlackListChannels', 'DriveList', 'DriveRead', 'NotionSearch']);

/** All network-facing tools, including external mutation integrations. */
export const NETWORK_TOOLS = new Set([
  'WebFetch',
  'WebSearch',
  ...INTEGRATION_READ_TOOLS,
  'SlackPostMessage',
  'NotionCreatePage',
]);

/** Tools that can be auto-approved in interactive mode without a diff. */
export const SAFE_READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ReadDocument', ...INTEGRATION_READ_TOOLS]);

/** Local shells. Bash is handled separately after a command-policy check. */
export const SHELL_TOOLS = new Set(['Bash', 'Pwsh']);

/** Persistent PTY / terminal surfaces. */
export const TERMINAL_TOOLS = new Set([
  'Pty',
  'TerminalOpen',
  'TerminalList',
  'TerminalRead',
  'TerminalSend',
  'TerminalSignal',
  'TerminalClose',
]);

/** Model/runtime written code and dynamic runtime extension. */
export const CODE_EXECUTION_TOOLS = new Set(['RunCode', 'RunWorkflow', 'MountPlugin', 'UnmountPlugin']);

/** External cloud/side-effect mutation tools. */
export const EXTERNAL_MUTATION_TOOLS = new Set(['SlackPostMessage', 'NotionCreatePage']);

/** Runtime/schedule/agent-control mutations. */
export const RUNTIME_MUTATION_TOOLS = new Set([
  'CronCreate',
  'CronDelete',
  'ScheduleCreate',
  'ScheduleDelete',
  'TaskStop',
  'JobKill',
  'EnterWorktree',
  'WriteSkill',
  'SendMessage',
  'InterruptAgent',
]);

/** Tools that should be surfaced for approval even in full-auto workflows. */
export const DANGEROUS_TOOLS = new Set([
  ...SHELL_TOOLS,
  ...TERMINAL_TOOLS,
  ...CODE_EXECUTION_TOOLS,
  ...RUNTIME_MUTATION_TOOLS,
  'Agent',
  'Ralph',
  'Write',
  'Edit',
  'StrReplaceEditor',
  'NotebookEdit',
  'Delete',
  'WriteDocument',
  'WebFetch',
  'WebSearch',
  'ReviewArtifact',
  'GitCommit',
  'SlackPostMessage',
  'NotionCreatePage',
  'CreateGoal',
  'UpdateGoal',
]);

/** Work 模式必须整体拒绝的执行/扩展入口。 */
export const WORK_FORBIDDEN_TOOLS = new Set([
  ...SHELL_TOOLS,
  ...TERMINAL_TOOLS,
  ...CODE_EXECUTION_TOOLS,
  ...RUNTIME_MUTATION_TOOLS,
  'Agent',
  'Ralph',
]);

/** Tools with side effects that a permission profile must consider. */
export const PROFILE_MUTATION_TOOLS = new Set([
  ...SHELL_TOOLS,
  ...TERMINAL_TOOLS,
  ...CODE_EXECUTION_TOOLS,
  ...RUNTIME_MUTATION_TOOLS,
  ...FILE_WRITE_TOOLS,
  ...EXTERNAL_MUTATION_TOOLS,
  'Agent',
  'Ralph',
]);

/** Confined sandbox modes cannot wrap these surfaces; fail closed. */
export const UNSUPPORTED_CONFINED_TOOLS = new Set([...TERMINAL_TOOLS, ...CODE_EXECUTION_TOOLS]);

export interface ToolCapability {
  readsFiles: boolean;
  writesFiles: boolean;
  shell: boolean;
  terminal: boolean;
  codeExecution: boolean;
  externalMutation: boolean;
  runtimeMutation: boolean;
}

export function toolCapability(toolName: string): ToolCapability {
  return {
    readsFiles: FILE_READ_TOOLS.has(toolName),
    writesFiles: FILE_WRITE_TOOLS.has(toolName),
    shell: SHELL_TOOLS.has(toolName),
    terminal: TERMINAL_TOOLS.has(toolName),
    codeExecution: CODE_EXECUTION_TOOLS.has(toolName),
    externalMutation: EXTERNAL_MUTATION_TOOLS.has(toolName),
    runtimeMutation: RUNTIME_MUTATION_TOOLS.has(toolName),
  };
}

export function isDangerousTool(toolName: string): boolean {
  return DANGEROUS_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

export function isWorkForbiddenTool(toolName: string): boolean {
  return WORK_FORBIDDEN_TOOLS.has(toolName);
}

export function isProfileMutationTool(toolName: string): boolean {
  return PROFILE_MUTATION_TOOLS.has(toolName);
}

export function isUnsupportedConfinementTool(toolName: string): boolean {
  return UNSUPPORTED_CONFINED_TOOLS.has(toolName);
}
