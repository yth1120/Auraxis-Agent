/**
 * tool-handlers.ts — built-in tool facade.
 *
 * Executors live in electron/ipc/tool-handlers/*; the safety pipeline lives
 * in pipeline.ts. This file keeps historical import paths working and wires
 * the abort registry into the task monitor.
 */
import { abortTool } from './tool-handlers/abort-registry';
import { setTaskStopper } from './task-monitor';

export { cacheTaskResult } from './tool-handlers/task-cache';
export { abortTool } from './tool-handlers/abort-registry';
export { executeToolCall } from './tool-handlers/pipeline';
export { runLSPTool } from './tool-handlers/lsp';
export { runReviewArtifact } from './tool-handlers/review';
export {
  clearWorktreeSession,
  getActiveWorktree,
  isValidWorktreeTaskId,
  restoreWorktreeSession,
  runEnterWorktree,
} from './tool-handlers/worktree';
export type { ToolExecutor } from './tool-handlers/execution';
export type { ToolContext, ToolResult } from './tool-handlers/path-utils';

setTaskStopper((toolCallId) => abortTool(toolCallId));
