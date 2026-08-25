/**
 * ConflictDetector — prevents multiple Agents from writing to the same
 * file simultaneously. Tracks file locks, operation history, and current
 * conflicts for display in the AgentDashboard.
 */

import { ipcMain } from 'electron';
import { secureHandle } from './trust';

// ─── Types ─────────────────────────────────────────────

export interface LockResult {
  success: boolean;
  lockedBy?: string[];
}

export interface Conflict {
  filePath: string;
  agentIds: string[];
  timestamp: number;
}

export interface FileOperation {
  agentId: string;
  timestamp: number;
  action: 'locked' | 'unlocked' | 'write' | 'edit';
}

// ─── Class ──────────────────────────────────────────────

class ConflictDetector {
  /** filePath → set of agentIds currently holding a lock */
  private locks = new Map<string, Set<string>>();

  /** filePath → lock timestamp (for timeout expiry) */
  private lockTimestamps = new Map<string, number>();

  /** Auto-release locks after this many milliseconds */
  private readonly LOCK_TIMEOUT = 300_000; // 5 minutes

  /** filePath → operation history */
  private history = new Map<string, FileOperation[]>();

  private addHistory(filePath: string, agentId: string, action: FileOperation['action']) {
    const ops = this.history.get(filePath) || [];
    ops.push({ agentId, timestamp: Date.now(), action });
    if (ops.length > 100) ops.splice(0, ops.length - 100);
    this.history.set(filePath, ops);
  }

  /** Attempt to lock a file for an agent. Returns success + who else holds it. */
  lockFile(filePath: string, agentId: string): LockResult {
    const normalized = filePath.replace(/\\/g, '/');
    let holders = this.locks.get(normalized);

    if (!holders) {
      holders = new Set();
      this.locks.set(normalized, holders);
    }

    // Already locked by this agent — re-entrant success
    if (holders.has(agentId)) {
      return { success: true };
    }

    // Check for stale locks
    const lockTime = this.lockTimestamps.get(normalized) || 0;
    if (Date.now() - lockTime > this.LOCK_TIMEOUT) {
      // Stale lock — clear and reacquire
      holders.clear();
      this.lockTimestamps.delete(normalized);
    }

    // Check if other agents hold this lock
    const others = [...holders].filter((id) => id !== agentId);
    if (others.length > 0) {
      return { success: false, lockedBy: others };
    }

    holders.add(agentId);
    this.lockTimestamps.set(normalized, Date.now());
    this.addHistory(normalized, agentId, 'locked');
    return { success: true };
  }

  /** Release a lock held by an agent. */
  unlockFile(filePath: string, agentId: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    const holders = this.locks.get(normalized);
    if (!holders) return;
    holders.delete(agentId);
    if (holders.size === 0) {
      this.locks.delete(normalized);
      this.lockTimestamps.delete(normalized);
    }
    this.addHistory(normalized, agentId, 'unlocked');
  }

  /** Return all current conflicts (files locked by > 1 agent). */
  getConflicts(): Conflict[] {
    const conflicts: Conflict[] = [];
    for (const [filePath, holders] of this.locks) {
      if (holders.size > 1) {
        conflicts.push({
          filePath,
          agentIds: [...holders],
          timestamp: Date.now(),
        });
      }
    }
    return conflicts;
  }

  /** Return operation history for a specific file. */
  getFileHistory(filePath: string): FileOperation[] {
    return this.history.get(filePath.replace(/\\/g, '/')) || [];
  }

  /** Release all locks held by an agent (e.g. on agent stop/error). */
  releaseAllForAgent(agentId: string): void {
    for (const [filePath, holders] of this.locks) {
      holders.delete(agentId);
      if (holders.size === 0) {
        this.locks.delete(filePath);
        this.lockTimestamps.delete(filePath);
      }
    }
  }
}

// ─── Singleton ──────────────────────────────────────────

export const conflictDetector = new ConflictDetector();

// ─── IPC ─────────────────────────────────────────────────

export function registerConflictIpc() {
  secureHandle('conflict:getConflicts', async () => {
    try {
      return { ok: true, data: conflictDetector.getConflicts() };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });

  secureHandle('conflict:getFileHistory', async (_event, filePath: string) => {
    try {
      return { ok: true, data: conflictDetector.getFileHistory(filePath) };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  });
}
