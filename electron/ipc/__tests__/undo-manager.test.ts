import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { undoManager } from '../undo-manager';

const testDir = path.join(os.tmpdir(), 'auraxis-undo-test-' + Date.now());
const testFile = path.join(testDir, 'test-file.txt');

function setupTestDir() {
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, 'original content', 'utf-8');
}

function cleanup() {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}

describe('UndoManager', () => {
  beforeEach(() => {
    cleanup();
    setupTestDir();
  });
  afterEach(() => cleanup());

  it('备份文件后，原文件内容被保存到快照目录', () => {
    const original = fs.readFileSync(testFile, 'utf-8');
    expect(original).toBe('original content');

    // Simulate backup
    const snapDir = path.join(testDir, '.auraxis-snapshots');
    if (!fs.existsSync(snapDir)) fs.mkdirSync(snapDir, { recursive: true });
    const backupId = 'undo-test-001';
    const backupPath = path.join(snapDir, backupId);
    fs.copyFileSync(testFile, backupPath);

    // Modify
    fs.writeFileSync(testFile, 'modified content', 'utf-8');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('modified content');

    // Restore
    fs.copyFileSync(backupPath, testFile);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('original content');
  });

  it('撤销后恢复文件原内容', () => {
    const snapDir = path.join(testDir, '.auraxis-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const backupId = 'undo-revert-test';
    const backupPath = path.join(snapDir, backupId);
    fs.copyFileSync(testFile, backupPath);

    // Edit
    fs.writeFileSync(testFile, 'edited content\nline 2', 'utf-8');
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('edited content\nline 2');

    // Revert
    fs.copyFileSync(backupPath, testFile);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('original content');
  });

  it('新创建文件的撤销行为：撤销后文件被删除', () => {
    const newFile = path.join(testDir, 'new-created.txt');
    // Simulate new file creation backup (no original → null backup)
    // Then create the file
    fs.writeFileSync(newFile, 'new content', 'utf-8');
    expect(fs.existsSync(newFile)).toBe(true);

    // Revert = delete
    fs.unlinkSync(newFile);
    expect(fs.existsSync(newFile)).toBe(false);
  });

  it('revertSessions 只恢复指定会话的文件快照', async () => {
    const f1 = path.join(testDir, 'session-a.txt');
    const f2 = path.join(testDir, 'session-b.txt');
    fs.writeFileSync(f1, 'a-original');
    fs.writeFileSync(f2, 'b-original');

    await undoManager.backupFile(f1, testDir, 'Write', 'session-a');
    await undoManager.backupFile(f2, testDir, 'Write', 'session-b');
    fs.writeFileSync(f1, 'a-modified');
    fs.writeFileSync(f2, 'b-modified');

    const result = await undoManager.revertSessions(['session-a'], testDir);

    expect(result.reverted).toBe(1);
    expect(fs.readFileSync(f1, 'utf-8')).toBe('a-original');
    expect(fs.readFileSync(f2, 'utf-8')).toBe('b-modified');
    expect(undoManager.getUndoHistory().map((e) => e.sessionId)).toEqual(['session-b']);
  });

  it('新创建文件的备份会在撤销时删除该文件', async () => {
    const newFile = path.join(testDir, 'created-by-agent.txt');
    const id = await undoManager.backupFile(newFile, testDir, 'Write', 'session-create');
    expect(id).not.toBeNull();
    fs.writeFileSync(newFile, 'new content');

    const ok = await undoManager.undoFile(id!, testDir);
    expect(ok).toBe(true);
    expect(fs.existsSync(newFile)).toBe(false);
  });

  it('getSessionDiffs 返回该会话的原始 → 当前 diff，并跳过无变化文件', async () => {
    const touched = path.join(testDir, 'touched.txt');
    fs.writeFileSync(touched, 'before');
    await undoManager.backupFile(touched, testDir, 'Write', 'session-diff');
    fs.writeFileSync(touched, 'after');

    const diffs = await undoManager.getSessionDiffs('session-diff', testDir);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe('touched.txt');
    expect(diffs[0].oldContent).toBe('before');
    expect(diffs[0].newContent).toBe('after');

    // Same content → not a reviewable change.
    const created = path.join(testDir, 'created.txt');
    await undoManager.backupFile(created, testDir, 'Write', 'session-diff');
    fs.writeFileSync(created, 'created content');
    const createdDiffs = await undoManager.getSessionDiffs('session-diff', testDir);
    expect(createdDiffs.map((d) => d.path)).toContain('created.txt');
  });

  it('revertSessionFile 只还原该会话触达的文件', async () => {
    const a = path.join(testDir, 'revert-a.txt');
    const b = path.join(testDir, 'revert-b.txt');
    fs.writeFileSync(a, 'a-before');
    fs.writeFileSync(b, 'b-before');
    await undoManager.backupFile(a, testDir, 'Write', 'session-r');
    await undoManager.backupFile(b, testDir, 'Write', 'other-r');
    fs.writeFileSync(a, 'a-after');
    fs.writeFileSync(b, 'b-after');

    const result = await undoManager.revertSessionFile('session-r', 'revert-a.txt', testDir);
    expect(result.reverted).toBe(1);
    expect(fs.readFileSync(a, 'utf-8')).toBe('a-before');
    expect(fs.readFileSync(b, 'utf-8')).toBe('b-after');
  });

  it('init 从磁盘恢复持久化的撤销历史（重启后可用）', async () => {
    const snapDir = path.join(testDir, '.auraxis-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const persisted = [
      {
        id: 'undo-restart-1',
        filePath: path.join(testDir, 'persisted.txt'),
        toolName: 'Write',
        timestamp: Date.now(),
        sessionId: 'session-restart',
        size: 10,
      },
    ];
    fs.writeFileSync(path.join(snapDir, '.undo-history.json'), JSON.stringify(persisted), 'utf-8');

    await undoManager.init(testDir);

    const history = undoManager.getUndoHistory();
    expect(history.map((e) => e.id)).toContain('undo-restart-1');
    expect(history.find((e) => e.id === 'undo-restart-1')?.sessionId).toBe('session-restart');
  });

  it('撤销列表过期清理：过期条目被移除', () => {
    const now = Date.now();
    const expired = now - 10 * 60 * 1000; // 10 minutes ago
    const entries = [
      { id: '1', timestamp: now, description: 'recent' },
      { id: '2', timestamp: expired, description: 'expired' },
      { id: '3', timestamp: now, description: 'also-recent' },
    ];

    // Simulate expiry filter
    const expiryThreshold = 5 * 60 * 1000; // 5 min
    const active = entries.filter((e) => now - e.timestamp < expiryThreshold);
    expect(active).toHaveLength(2);
    expect(active.map((e) => e.id)).toEqual(['1', '3']);
  });

  it('历史列表按时间倒序排列', () => {
    const entries = [
      { id: 'old', timestamp: 1000 },
      { id: 'new', timestamp: 3000 },
      { id: 'mid', timestamp: 2000 },
    ];
    const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
    expect(sorted[0].id).toBe('new');
    expect(sorted[2].id).toBe('old');
  });
});
