/**
 * UndoManager — file-level undo for Write/Edit tool operations.
 * Uses async I/O (fs.promises) to avoid blocking the main process.
 */

import path from 'path';
import { promises as fs } from 'fs';
import { ipcMain } from 'electron';
import { secureHandle } from './trust';
import type { WorkspaceFileDiff } from '../types';

// ─── Types ─────────────────────────────────────────────

export interface UndoEntry {
  id: string;
  filePath: string;
  toolName: string;
  timestamp: number;
  sessionId: string;
  size: number;
  /** The file did not exist before the write — undo deletes it instead of restoring a backup. */
  created?: boolean;
  /** Coherence Collapse：被标记为"最佳已知补丁"的检查点。 */
  best?: boolean;
  bestLabel?: string;
}

// ─── Class ──────────────────────────────────────────────

class UndoManager {
  private history: UndoEntry[] = [];

  private getSnapshotDir(projectRoot: string): string {
    const dir = path.join(projectRoot, '.auraxis-snapshots');
    return dir;
  }

  private async ensureDir(dir: string) {
    try { await fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
  }

  /** Backup a file before modification. Returns backup ID. */
  async backupFile(
    filePath: string,
    projectRoot: string,
    toolName: string,
    sessionId: string,
  ): Promise<string | null> {
    const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const snapDir = this.getSnapshotDir(projectRoot);
    await this.ensureDir(snapDir);

    let created = false;
    try {
      await fs.access(filePath);
    } catch {
      // New file: no pre-write content exists. Record the fact so undo can
      // delete it and review can show an empty "before" side.
      created = true;
    }

    if (!created) {
      const backupPath = path.join(snapDir, id);
      try {
        await fs.copyFile(filePath, backupPath);
      } catch {
        return null;
      }
    }

    let size = 0;
    try { size = (await fs.stat(filePath)).size; } catch { /* created-but-removed race */ }
    const entry: UndoEntry = {
      id, filePath, toolName,
      timestamp: Date.now(), sessionId, size, created: created || undefined,
    };

    this.history.push(entry);
    if (this.history.length > 200) this.history = this.history.slice(-200);
    await this.saveHistory(snapDir);
    return id;
  }

  /** Restore a backup, overwriting the current file. */
  async undoFile(fileId: string, projectRoot: string): Promise<boolean> {
    const entry = this.history.find((e) => e.id === fileId);
    if (!entry) return false;

    if (entry.created) {
      try { await fs.rm(entry.filePath, { force: true }); } catch { /* already gone */ }
      this.history = this.history.filter((e) => e.id !== fileId);
      await this.saveHistory(this.getSnapshotDir(projectRoot));
      return true;
    }

    const snapDir = this.getSnapshotDir(projectRoot);
    const backupPath = path.join(snapDir, fileId);

    try {
      await fs.access(backupPath);
    } catch {
      return false;
    }

    try {
      await fs.copyFile(backupPath, entry.filePath);
    } catch {
      return false;
    }

    const idx = this.history.findIndex((e) => e.id === fileId);
    if (idx >= 0) {
      this.history = this.history.slice(0, idx);
      await this.saveHistory(snapDir);
    }

    try { await fs.unlink(backupPath); } catch { /* ignore */ }
    return true;
  }

  /** Restore one backup and drop only that history entry (no cascade truncation). */
  private async restoreEntry(fileId: string, projectRoot: string): Promise<boolean> {
    const entry = this.history.find((e) => e.id === fileId);
    if (!entry) return false;

    if (entry.created) {
      try { await fs.rm(entry.filePath, { force: true }); } catch { /* already gone */ }
      this.history = this.history.filter((e) => e.id !== fileId);
      await this.saveHistory(this.getSnapshotDir(projectRoot));
      return true;
    }

    const snapDir = this.getSnapshotDir(projectRoot);
    const backupPath = path.join(snapDir, fileId);
    try {
      await fs.access(backupPath);
    } catch {
      return false;
    }
    try {
      await fs.copyFile(backupPath, entry.filePath);
    } catch {
      return false;
    }

    this.history = this.history.filter((e) => e.id !== fileId);
    await this.saveHistory(snapDir);
    try { await fs.unlink(backupPath); } catch { /* ignore */ }
    return true;
  }

  /**
   * Coherence Collapse：把"该文件+会话 最近一次编辑前的备份"标记为最佳补丁。
   * 语义：agent 已跑到正确代码、即将做破坏性编辑前，把当前状态存为最优检查点。
   */
  async markBest(
    projectRoot: string,
    sessionId: string,
    filePath: string,
    label?: string,
  ): Promise<string | null> {
    const file = path.resolve(filePath);
    const matches = this.history.filter((e) => e.sessionId === sessionId && path.resolve(e.filePath) === file);
    if (matches.length === 0) return null;
    for (const e of matches) {
      e.best = false;
      delete e.bestLabel;
    }
    const entry = matches[matches.length - 1];
    entry.best = true;
    if (label) entry.bestLabel = label;
    await this.saveHistory(this.getSnapshotDir(projectRoot));
    return entry.id;
  }

  /** 恢复到标记的最佳补丁（只移除该条历史，不截断后续备份）。 */
  async restoreBest(
    projectRoot: string,
    sessionId: string,
    filePath: string,
  ): Promise<{ ok: boolean; restoredId?: string }> {
    const file = path.resolve(filePath);
    const entry = [...this.history].reverse().find(
      (e) => e.sessionId === sessionId && path.resolve(e.filePath) === file && e.best,
    );
    if (!entry) return { ok: false };
    const ok = await this.restoreEntry(entry.id, projectRoot);
    return ok ? { ok: true, restoredId: entry.id } : { ok: false };
  }

  listBest(projectRoot: string, sessionId?: string): UndoEntry[] {
    const root = path.resolve(projectRoot);
    return this.history
      .filter((e) => {
        if (!e.best) return false;
        if (sessionId && e.sessionId !== sessionId) return false;
        const p = path.resolve(e.filePath);
        return p === root || p.startsWith(root + path.sep);
      })
      .map((e) => ({ ...e, filePath: e.filePath.replace(/\\/g, '/') }));
  }

  /**
   * Revert every entry whose sessionId is in the wanted set — newest first.
   * Each chat turn / agent task has a stable sessionId (requestId / agentId),
   * so "回退到此" maps directly to a session set.
   */
  async revertSessions(sessionIds: string[], projectRoot: string): Promise<{ reverted: number }> {
    const wanted = new Set(sessionIds);
    let reverted = 0;
    const snapshot = [...this.history];
    for (let i = snapshot.length - 1; i >= 0; i--) {
      const entry = snapshot[i];
      if (wanted.has(entry.sessionId) && (await this.restoreEntry(entry.id, projectRoot))) {
        reverted++;
      }
    }
    return { reverted };
  }

  getUndoHistory(sessionId?: string): UndoEntry[] {
    return (sessionId ? this.history.filter((e) => e.sessionId === sessionId) : this.history)
      .map((e) => ({ ...e, filePath: e.filePath.replace(/\\/g, '/') }));
  }

  /** Original → current diff for every file a session touched (review surface). */
  async getSessionDiffs(sessionId: string, projectRoot: string): Promise<WorkspaceFileDiff[]> {
    const byFile = new Map<string, UndoEntry>();
    for (const entry of this.history) {
      if (entry.sessionId !== sessionId) continue;
      if (!byFile.has(entry.filePath)) byFile.set(entry.filePath, entry);
    }

    const MAX_DIFF_BYTES = 200 * 1024;
    const snapDir = this.getSnapshotDir(projectRoot);
    const diffs: WorkspaceFileDiff[] = [];
    for (const [filePath, entry] of byFile) {
      const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) continue;

      let oldContent = '';
      if (!entry.created) {
        const backupPath = path.join(snapDir, entry.id);
        try {
          const st = await fs.stat(backupPath);
          if (st.size > MAX_DIFF_BYTES) {
            diffs.push({ path: rel, skipped: 'too-large' });
            continue;
          }
          oldContent = await fs.readFile(backupPath, 'utf-8');
          if (oldContent.includes('\0')) {
            diffs.push({ path: rel, skipped: 'binary' });
            continue;
          }
        } catch {
          continue; // backup lost — nothing trustworthy to review
        }
      }

      let newContent = '';
      try {
        const st = await fs.stat(filePath);
        if (!st.isFile()) continue;
        if (st.size > MAX_DIFF_BYTES) {
          diffs.push({ path: rel, skipped: 'too-large' });
          continue;
        }
        newContent = await fs.readFile(filePath, 'utf-8');
        if (newContent.includes('\0')) {
          diffs.push({ path: rel, skipped: 'binary' });
          continue;
        }
      } catch {
        // Deleted since the session touched it — report the deletion.
      }

      if (oldContent === newContent) continue;
      diffs.push({ path: rel, oldContent, newContent });
    }
    return diffs;
  }

  /** Restore one session-touched file to its pre-task state and drop its backups. */
  async revertSessionFile(sessionId: string, relPath: string, projectRoot: string): Promise<{ reverted: number }> {
    const filePath = path.resolve(projectRoot, relPath);
    const normalized = path.resolve(filePath);
    const entries = this.history.filter((e) =>
      e.sessionId === sessionId && path.resolve(e.filePath) === normalized,
    );
    if (entries.length === 0) return { reverted: 0 };

    const earliest = entries[0];
    const snapDir = this.getSnapshotDir(projectRoot);
    if (earliest.created) {
      try { await fs.rm(earliest.filePath, { force: true }); } catch { /* already gone */ }
    } else {
      const backupPath = path.join(snapDir, earliest.id);
      try {
        await fs.access(backupPath);
        await fs.mkdir(path.dirname(earliest.filePath), { recursive: true });
        await fs.copyFile(backupPath, earliest.filePath);
      } catch {
        return { reverted: 0 };
      }
    }

    const ids = new Set(entries.map((e) => e.id));
    this.history = this.history.filter((e) => !ids.has(e.id));
    for (const entry of entries) {
      if (entry.created) continue;
      try { await fs.unlink(path.join(snapDir, entry.id)); } catch { /* ignore */ }
    }
    await this.saveHistory(snapDir);
    return { reverted: entries.length };
  }

  private async loadHistory(snapDir: string) {
    const metaPath = path.join(snapDir, '.undo-history.json');
    try {
      await fs.access(metaPath);
      const raw = await fs.readFile(metaPath, 'utf-8');
      this.history = JSON.parse(raw);
    } catch { /* fresh start */ }
  }

  private async saveHistory(snapDir: string) {
    const metaPath = path.join(snapDir, '.undo-history.json');
    try {
      await fs.writeFile(metaPath, JSON.stringify(this.history), 'utf-8');
    } catch { /* non-critical */ }
  }

  async init(projectRoot: string) {
    const snapDir = this.getSnapshotDir(projectRoot);
    await this.ensureDir(snapDir);
    await this.loadHistory(snapDir);
  }
}

// ─── Singleton ──────────────────────────────────────────

export const undoManager = new UndoManager();

// ─── IPC ─────────────────────────────────────────────────

export function registerUndoIpc() {
  secureHandle('undo:getHistory', async (_event, sessionId?: string) => {
    try {
      return { ok: true, data: undoManager.getUndoHistory(sessionId) };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:getList', async () => {
    try {
      return { ok: true, data: undoManager.getUndoHistory() };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:getSessionDiffs', async (_event, sessionId: string, projectRoot: string) => {
    try {
      const diffs = await undoManager.getSessionDiffs(sessionId, projectRoot);
      return { ok: true, data: diffs };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:revertSessionFile', async (_event, params: { sessionId: string; relPath: string; projectRoot: string }) => {
    try {
      const result = await undoManager.revertSessionFile(params.sessionId, params.relPath, params.projectRoot);
      return { ok: true, data: result };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:execute', async (_event, fileId: string, projectRoot: string) => {
    try {
      const ok = await undoManager.undoFile(fileId, projectRoot);
      if (!ok) return { ok: false, error: '备份不存在或恢复失败' };
      return { ok: true };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:revertLast', async (_event, projectRoot: string) => {
    try {
      const history = undoManager.getUndoHistory();
      if (history.length === 0) return { ok: false, error: '无撤销历史' };
      const last = history[history.length - 1];
      const ok = await undoManager.undoFile(last.id, projectRoot);
      return { ok };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:revertSessions', async (_event, params: { sessionIds: string[]; projectRoot: string }) => {
    try {
      const result = await undoManager.revertSessions(params.sessionIds, params.projectRoot);
      return { ok: true, data: result };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:revert', async (_event, fileId: string, projectRoot: string) => {
    try {
      const ok = await undoManager.undoFile(fileId, projectRoot);
      if (!ok) return { ok: false, error: '备份不存在或恢复失败' };
      return { ok: true };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:markBest', async (_event, params: {
    projectRoot: string; sessionId: string; filePath: string; label?: string;
  }) => {
    try {
      const id = await undoManager.markBest(
        params.projectRoot,
        params.sessionId,
        params.filePath,
        params.label,
      );
      if (!id) return { ok: false, error: '未找到该会话的文件备份' };
      return { ok: true, data: { id } };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:restoreBest', async (_event, params: {
    projectRoot: string; sessionId: string; filePath: string;
  }) => {
    try {
      const result = await undoManager.restoreBest(
        params.projectRoot,
        params.sessionId,
        params.filePath,
      );
      if (!result.ok) return { ok: false, error: '未找到最佳补丁检查点' };
      return { ok: true, data: result };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });

  secureHandle('undo:listBest', async (_event, params: { projectRoot: string; sessionId?: string }) => {
    try {
      return { ok: true, data: undoManager.listBest(params.projectRoot, params.sessionId) };
    } catch (error: any) { return { ok: false, error: error.message }; }
  });
}
