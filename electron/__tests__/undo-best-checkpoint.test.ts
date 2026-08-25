import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { undoManager } from '../ipc/undo-manager';

const testDir = path.join(os.tmpdir(), 'auraxis-best-checkpoint-' + Date.now());
const testFile = path.join(testDir, 'main.ts');

function setup() {
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, 'good implementation', 'utf-8');
}

function cleanup() {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}

describe('UndoManager 最佳补丁检查点（Coherence Collapse）', () => {
  beforeEach(() => {
    cleanup();
    setup();
  });
  afterEach(() => cleanup());

  it('markBest 标记最近一次编辑前的备份为最佳，restoreBest 可恢复', async () => {
    // 第一次编辑：good → broken（破坏性编辑）
    await undoManager.backupFile(testFile, testDir, 'Edit', 'session-x');
    fs.writeFileSync(testFile, 'broken implementation', 'utf-8');

    // 第二次编辑前：把当前 good 状态标为最佳（实际上第二次备份才是 good 状态的前置）
    await undoManager.backupFile(testFile, testDir, 'Edit', 'session-x');
    fs.writeFileSync(testFile, 'totally broken', 'utf-8');

    const id = await undoManager.markBest(testDir, 'session-x', testFile, '通过全部测试');
    expect(id).toBeTruthy();

    const best = undoManager.listBest(testDir, 'session-x');
    expect(best).toHaveLength(1);
    expect(best[0].bestLabel).toBe('通过全部测试');

    const restored = await undoManager.restoreBest(testDir, 'session-x', testFile);
    expect(restored.ok).toBe(true);
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('broken implementation');
  });

  it('没有备份或没有标记时 restoreBest 返回失败', async () => {
    const r = await undoManager.restoreBest(testDir, 'nope', testFile);
    expect(r.ok).toBe(false);
  });

  it('markBest 会清除同一文件+会话的旧标记', async () => {
    await undoManager.backupFile(testFile, testDir, 'Edit', 'session-x');
    fs.writeFileSync(testFile, 'v2', 'utf-8');
    await undoManager.markBest(testDir, 'session-x', testFile, 'first');
    await undoManager.backupFile(testFile, testDir, 'Edit', 'session-x');
    fs.writeFileSync(testFile, 'v3', 'utf-8');
    await undoManager.markBest(testDir, 'session-x', testFile, 'second');

    const best = undoManager.listBest(testDir, 'session-x');
    expect(best).toHaveLength(1);
    expect(best[0].bestLabel).toBe('second');
  });

  it('created 文件的最佳检查点恢复后删除文件', async () => {
    const created = path.join(testDir, 'new.ts');
    await undoManager.backupFile(created, testDir, 'Write', 'session-c');
    const id = await undoManager.markBest(testDir, 'session-c', created, '新文件版本');
    expect(id).toBeTruthy();
    fs.writeFileSync(created, 'should be removed', 'utf-8');
    const restored = await undoManager.restoreBest(testDir, 'session-c', created);
    expect(restored.ok).toBe(true);
    expect(fs.existsSync(created)).toBe(false);
  });

  it('listBest 按项目根过滤', async () => {
    const outside = path.join(os.tmpdir(), `auraxis-outside-${Date.now()}.ts`);
    fs.writeFileSync(outside, 'outside', 'utf-8');
    await undoManager.backupFile(outside, testDir, 'Write', 'session-outside');
    await undoManager.markBest(testDir, 'session-outside', outside, '外部');
    expect(undoManager.listBest(testDir, 'session-outside')).toHaveLength(0);
    fs.unlinkSync(outside);
  });

  it('无备份时 markBest 返回 null', async () => {
    expect(await undoManager.markBest(testDir, 'no-session', testFile, 'x')).toBeNull();
  });
});
