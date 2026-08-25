import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
}));

import { undoManager, registerUndoIpc } from '../undo-manager';

const root = mkdtempSync(path.join(os.tmpdir(), 'auraxis-undo-'));
let proj = '';

beforeEach(async () => {
  h.handlers.clear();
  registerUndoIpc();
  proj = mkdtempSync(path.join(root, 'proj-'));
  await undoManager.init(proj);
});

function file(name: string, content: string): string {
  const p = path.join(proj, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('undoManager — 备份与撤销', () => {
  it('revertLast 空历史返回错误', async () => {
    const handler = h.handlers.get('undo:revertLast')! as any;
    expect(await handler({}, proj)).toEqual({ ok: false, error: '无撤销历史' });
  });

  it('backupFile 为既有文件建备份并登记', async () => {
    const p = file('a.txt', 'OLD');
    const id = await undoManager.backupFile(p, proj, 'Write', 's1');
    expect(id).toBeTruthy();
    expect(existsSync(path.join(proj, '.auraxis-snapshots', id!))).toBe(true);
    expect(undoManager.getUndoHistory('s1')).toHaveLength(1);
    expect(undoManager.getUndoHistory('nope')).toHaveLength(0);
  });

  it('backupFile 新文件标记 created', async () => {
    const p = path.join(proj, 'new.txt');
    const id = await undoManager.backupFile(p, proj, 'Write', 's2');
    expect(undoManager.getUndoHistory('s2')[0].created).toBe(true);

    writeFileSync(p, 'CONTENT', 'utf-8');
    expect(await undoManager.undoFile(id!, proj)).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it('undoFile 恢复旧内容、截断历史并删除备份', async () => {
    const p = file('b.txt', 'OLD');
    const id = await undoManager.backupFile(p, proj, 'Edit', 's3');
    writeFileSync(p, 'NEW', 'utf-8');

    expect(await undoManager.undoFile(id!, proj)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe('OLD');
    expect(undoManager.getUndoHistory('s3')).toHaveLength(0);
    expect(existsSync(path.join(proj, '.auraxis-snapshots', id!))).toBe(false);

    expect(await undoManager.undoFile(id!, proj)).toBe(false);
  });

  it('revertSessions 按 session 集合回退并计数', async () => {
    const p1 = file('c1.txt', 'OLD1');
    const p2 = file('c2.txt', 'OLD2');
    const id1 = await undoManager.backupFile(p1, proj, 'Write', 'sess-a');
    const id2 = await undoManager.backupFile(p2, proj, 'Write', 'sess-b');
    writeFileSync(p1, 'NEW1', 'utf-8');
    writeFileSync(p2, 'NEW2', 'utf-8');

    const r = await undoManager.revertSessions(['sess-a', 'sess-b'], proj);
    expect(r).toEqual({ reverted: 2 });
    expect(readFileSync(p1, 'utf-8')).toBe('OLD1');
    expect(readFileSync(p2, 'utf-8')).toBe('OLD2');
    expect(undoManager.getUndoHistory()).not.toContainEqual(expect.objectContaining({ id: id1 }));
    expect(undoManager.getUndoHistory()).not.toContainEqual(expect.objectContaining({ id: id2 }));
  });
});

describe('undoManager — 会话 diff 与文件级回退', () => {
  it('getSessionDiffs 输出内容 diff 与删除态', async () => {
    const p = file('d.ts', 'OLD');
    const id = await undoManager.backupFile(p, proj, 'Write', 'sess-d');
    writeFileSync(p, 'NEW', 'utf-8');

    const diffs = await undoManager.getSessionDiffs('sess-d', proj);
    expect(diffs).toEqual([{ path: 'd.ts', oldContent: 'OLD', newContent: 'NEW' }]);

    // 文件被删除后只保留 oldContent
    const { rmSync } = await import('fs');
    rmSync(p, { force: true });
    const after = await undoManager.getSessionDiffs('sess-d', proj);
    expect(after[0].newContent).toBe('');

    // 备份丢失时跳过
    const snapPath = path.join(proj, '.auraxis-snapshots', id!);
    const { rmSync: rm2 } = await import('fs');
    rm2(snapPath, { force: true });
    const lost = await undoManager.getSessionDiffs('sess-d', proj);
    expect(lost).toEqual([]);
  });

  it('getSessionDiffs 跳过超大/二进制/目录外文件', async () => {
    const big = file('big.txt', 'x'.repeat(300 * 1024));
    await undoManager.backupFile(big, proj, 'Write', 'sess-big');
    writeFileSync(big, 'small', 'utf-8');

    const bin = file('bin.dat', 'ab\0cd');
    await undoManager.backupFile(bin, proj, 'Write', 'sess-bin');

    const outside = path.join(root, 'outside.txt');
    writeFileSync(outside, 'x', 'utf-8');
    await undoManager.backupFile(outside, proj, 'Write', 'sess-out');

    const diffs = await undoManager.getSessionDiffs('sess-big', proj);
    expect(diffs[0]).toEqual({ path: 'big.txt', skipped: 'too-large' });
    const binDiffs = await undoManager.getSessionDiffs('sess-bin', proj);
    expect(binDiffs[0]).toEqual({ path: 'bin.dat', skipped: 'binary' });
    expect(await undoManager.getSessionDiffs('sess-out', proj)).toEqual([]);
  });

  it('revertSessionFile 恢复最早备份并清理全部条目', async () => {
    const p = file('e.txt', 'V0');
    const id1 = await undoManager.backupFile(p, proj, 'Write', 'sess-e');
    writeFileSync(p, 'V1', 'utf-8');
    const id2 = await undoManager.backupFile(p, proj, 'Write', 'sess-e');
    writeFileSync(p, 'V2', 'utf-8');

    const r = await undoManager.revertSessionFile('sess-e', 'e.txt', proj);
    expect(r).toEqual({ reverted: 2 });
    expect(readFileSync(p, 'utf-8')).toBe('V0');
    expect(undoManager.getUndoHistory('sess-e')).toHaveLength(0);
    expect(existsSync(path.join(proj, '.auraxis-snapshots', id1!))).toBe(false);
    expect(existsSync(path.join(proj, '.auraxis-snapshots', id2!))).toBe(false);

    expect(await undoManager.revertSessionFile('sess-e', 'nope.txt', proj)).toEqual({ reverted: 0 });
  });
});

describe('undo IPC 通道', () => {
  it('getHistory / getList / execute / revert 包裹结果', async () => {
    const p = file('f.txt', 'OLD');
    const id = await undoManager.backupFile(p, proj, 'Write', 'sess-ipc');
    writeFileSync(p, 'NEW', 'utf-8');

    const getHistory = h.handlers.get('undo:getHistory')! as any;
    const getList = h.handlers.get('undo:getList')! as any;
    const execute = h.handlers.get('undo:execute')! as any;
    const revert = h.handlers.get('undo:revert')! as any;
    const revertLast = h.handlers.get('undo:revertLast')! as any;

    expect((await getHistory({}, 'sess-ipc')).data).toHaveLength(1);
    expect((await getList()).data.length).toBeGreaterThanOrEqual(1);
    expect(await execute({}, id, proj)).toEqual({ ok: true });
    expect(readFileSync(p, 'utf-8')).toBe('OLD');
    expect(await execute({}, id, proj)).toEqual({ ok: false, error: '备份不存在或恢复失败' });

    const p2 = file('g.txt', 'OLD');
    await undoManager.backupFile(p2, proj, 'Write', 'sess-ipc2');
    writeFileSync(p2, 'NEW', 'utf-8');
    expect((await revertLast({}, proj)).ok).toBe(true);
    expect(readFileSync(p2, 'utf-8')).toBe('OLD');

    const p3 = file('h.txt', 'OLD');
    await undoManager.backupFile(p3, proj, 'Write', 'sess-ipc3');
    writeFileSync(p3, 'NEW', 'utf-8');
    expect((await revert({}, (await getHistory({}, 'sess-ipc3')).data[0].id, proj)).ok).toBe(true);
  });

  it('getSessionDiffs / revertSessionFile / revertSessions 通道', async () => {
    const p = file('i.txt', 'OLD');
    await undoManager.backupFile(p, proj, 'Write', 'sess-ipc4');
    writeFileSync(p, 'NEW', 'utf-8');

    const diffs = h.handlers.get('undo:getSessionDiffs')! as any;
    const revertFile = h.handlers.get('undo:revertSessionFile')! as any;
    const revertSessions = h.handlers.get('undo:revertSessions')! as any;

    expect((await diffs({}, 'sess-ipc4', proj)).data).toHaveLength(1);
    expect(await revertFile({}, { sessionId: 'sess-ipc4', relPath: 'i.txt', projectRoot: proj })).toEqual({
      ok: true,
      data: { reverted: 1 },
    });

    const p2 = file('j.txt', 'OLD');
    await undoManager.backupFile(p2, proj, 'Write', 'sess-ipc5');
    writeFileSync(p2, 'NEW', 'utf-8');
    expect(await revertSessions({}, { sessionIds: ['sess-ipc5'], projectRoot: proj })).toEqual({
      ok: true,
      data: { reverted: 1 },
    });
  });
});
