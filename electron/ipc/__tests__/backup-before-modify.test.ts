import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { backupBeforeModify } from '../tool-handlers/backup';
import { undoManager } from '../undo-manager';

/**
 * 回归守卫：backupBeforeModify 曾经用 `require('./undo-manager')` 指向了不存在的
 * 模块，异常被空 catch 吞掉，于是工具管线里的“修改前备份”静默失效（覆盖率仍是
 * 100%，因为 try/catch 都执行了）。这里断言备份真的落进 undo 历史。
 */
const dir = path.join(os.tmpdir(), `auraxis-backup-${Date.now()}`);
const file = path.join(dir, 'main.ts');

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: dir,
    requestId: 'req-backup',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

describe('backupBeforeModify — 修改前备份', () => {
  beforeEach(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'export const a = 1;\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Edit 调用后会在 undo 历史里留下备份', async () => {
    await backupBeforeModify(file, 'Edit', ctx({ sessionId: 'session-backup' }));
    const history = undoManager.getUndoHistory('session-backup');
    expect(history.length).toBeGreaterThan(0);
    expect(history.at(-1)?.filePath).toContain('main.ts');
    expect(history.at(-1)?.toolName).toBe('Edit');
  });

  it('Delete 同样触发备份', async () => {
    await backupBeforeModify(file, 'Delete', ctx({ sessionId: 'session-delete' }));
    expect(undoManager.getUndoHistory('session-delete').length).toBeGreaterThan(0);
  });

  it('只读工具与空路径不产生备份', async () => {
    await backupBeforeModify(file, 'Read', ctx({ sessionId: 'session-read' }));
    await backupBeforeModify('', 'Edit', ctx({ sessionId: 'session-empty' }));
    expect(undoManager.getUndoHistory('session-read')).toHaveLength(0);
    expect(undoManager.getUndoHistory('session-empty')).toHaveLength(0);
  });
});
