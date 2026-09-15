import type { ToolContext } from './path-utils';
import { undoManager } from '../undo-manager';

export const FILE_MODIFY_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Delete']);

export async function backupBeforeModify(filePath: string, toolName: string, ctx: ToolContext): Promise<void> {
  if (!FILE_MODIFY_TOOLS.has(toolName) || !filePath) return;
  try {
    await undoManager.backupFile(filePath, ctx.projectRoot, toolName, ctx.sessionId || ctx.requestId);
  } catch {
    /* undo is best-effort */
  }
}
