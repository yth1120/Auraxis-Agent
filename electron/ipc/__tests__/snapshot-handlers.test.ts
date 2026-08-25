import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { undoManager } from '../undo-manager';
import {
  createNamedSnapshot,
  listNamedSnapshots,
  restoreNamedSnapshot,
  deleteNamedSnapshot,
} from '../snapshot-handlers';

let testDir: string;

function setupTestDir() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-snap-test-'));
}

function cleanup() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

/** Seed one touched file: backup current content, then overwrite with new content. */
async function seedTouchedFile(relPath: string, content: string): Promise<string> {
  const abs = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'baseline', 'utf-8');
  const backupId = await undoManager.backupFile(abs, testDir, 'Write', 'session-a');
  expect(backupId).toBeTruthy();
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('named snapshots', () => {
  beforeEach(() => {
    cleanup();
    setupTestDir();
  });
  afterEach(() => cleanup());

  it('创建快照记录已改动文件的当前内容', async () => {
    const f1 = await seedTouchedFile('src/a.ts', 'current-a');
    await seedTouchedFile('src/b.ts', 'current-b');

    const snap = await createNamedSnapshot(testDir, '方案 B 完成');

    expect(snap.name).toBe('方案 B 完成');
    expect(snap.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const list = await listNamedSnapshots(testDir);
    expect(list).toHaveLength(1);
    expect(list[0].files).toHaveLength(2);

    // Snapshot files hold the CURRENT content, not the pre-write baseline.
    const snapFile = path.join(testDir, '.auraxis-snapshots', 'named', snap.id, 'f0');
    const content = fs.readFileSync(snapFile, 'utf-8');
    expect(['current-a', 'current-b']).toContain(content);
    expect(f1).toBeTruthy();
  });

  it('恢复快照覆盖当前文件内容', async () => {
    const f1 = await seedTouchedFile('src/a.ts', 'v1-content');
    const snap = await createNamedSnapshot(testDir, 'v1');

    fs.writeFileSync(f1, 'v2-content', 'utf-8');
    const result = await restoreNamedSnapshot(snap.id, testDir);

    expect(result).toEqual({ restored: 1, skipped: 0 });
    expect(fs.readFileSync(f1, 'utf-8')).toBe('v1-content');
  });

  it('无已改动文件时创建快照报错', async () => {
    await expect(createNamedSnapshot(testDir, '空快照')).rejects.toThrow('暂无可记录');
  });

  it('删除快照后列表为空', async () => {
    await seedTouchedFile('src/a.ts', 'x');
    const snap = await createNamedSnapshot(testDir, '临时');
    await deleteNamedSnapshot(snap.id, testDir);
    expect(await listNamedSnapshots(testDir)).toHaveLength(0);
  });

  it('被篡改的清单无法逃逸项目根目录', async () => {
    await seedTouchedFile('src/a.ts', 'safe-content');
    const snap = await createNamedSnapshot(testDir, 'guard');

    const outside = path.join(os.tmpdir(), `auraxis-snap-escape-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'do-not-touch', 'utf-8');
    try {
      const manifestPath = path.join(testDir, '.auraxis-snapshots', 'named', snap.id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.files.push({ path: `../${path.basename(outside)}`, bytes: 8 });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
      fs.writeFileSync(path.join(testDir, '.auraxis-snapshots', 'named', snap.id, 'f1'), 'escaped!', 'utf-8');

      const result = await restoreNamedSnapshot(snap.id, testDir);
      expect(result.restored).toBe(1);
      expect(result.skipped).toBe(1);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('do-not-touch');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
