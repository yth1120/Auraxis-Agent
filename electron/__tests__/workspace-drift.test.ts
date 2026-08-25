import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { workspaceDrift, driftSummary, type DriftedFile } from '../workspace-drift';

const testDir = path.join(os.tmpdir(), 'auraxis-drift-test-' + Date.now());
const fileA = path.join(testDir, 'a.ts');
const fileB = path.join(testDir, 'b.ts');

function setup() {
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(fileA, 'const a = 1;', 'utf-8');
  fs.writeFileSync(fileB, 'const b = 2;', 'utf-8');
}

function cleanup() {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}

describe('WorkspaceDriftTracker', () => {
  beforeEach(() => {
    cleanup();
    setup();
    workspaceDrift.clear();
  });
  afterEach(() => cleanup());

  it('登记基线后检测到内容变化', async () => {
    await workspaceDrift.observe('proj', fileA);
    expect(workspaceDrift.count('proj')).toBe(1);
    expect(await workspaceDrift.detectDrift('proj')).toHaveLength(0);

    fs.writeFileSync(fileA, 'const b = 1;', 'utf-8'); // 同长度内容变化 → content 漂移
    const drifted = await workspaceDrift.detectDrift('proj');
    expect(drifted).toHaveLength(1);
    expect(drifted[0].filePath).toBe(path.resolve(fileA));
    expect(drifted[0].reason).toBe('content');
  });

  it('takeDrift 确认后同一次修改不会重复报告', async () => {
    await workspaceDrift.observe('proj', fileA);
    fs.writeFileSync(fileA, 'changed', 'utf-8');

    const first = await workspaceDrift.takeDrift('proj');
    expect(first).toHaveLength(1);
    const second = await workspaceDrift.takeDrift('proj');
    expect(second).toHaveLength(0);
  });

  it('删除文件视为漂移', async () => {
    await workspaceDrift.observe('proj', fileB);
    fs.unlinkSync(fileB);
    const drifted = await workspaceDrift.detectDrift('proj');
    expect(drifted.some((d) => d.filePath === path.resolve(fileB))).toBe(true);
  });

  it('漂移摘要包含文件与重检指令', async () => {
    const fake: DriftedFile[] = [
      {
        filePath: path.resolve(fileA),
        reason: 'content',
        observedAt: 1,
        detectedAt: 2,
      },
    ];
    const summary = driftSummary(fake);
    expect(summary).toContain('工作区变更');
    expect(summary).toContain('定向测试');
  });

  it('内容未变时仅 mtime 变化不算漂移', async () => {
    await workspaceDrift.observe('proj', fileA);
    const now = new Date();
    const later = new Date(now.getTime() + 5000);
    fs.utimesSync(fileA, later, later);
    expect(await workspaceDrift.detectDrift('proj')).toHaveLength(0);
  });

  it('先观测不存在的文件，创建后视为漂移', async () => {
    const missing = path.join(testDir, 'missing.ts');
    await workspaceDrift.observe('proj', missing);
    fs.writeFileSync(missing, 'created later', 'utf-8');
    const drifted = await workspaceDrift.detectDrift('proj');
    expect(drifted.some((d) => d.filePath === path.resolve(missing))).toBe(true);
    fs.unlinkSync(missing);
  });

  it('clear 清空指定 scope，不同 scope 互不串扰', async () => {
    await workspaceDrift.observe('p1', fileA);
    fs.writeFileSync(fileA, 'changed content for scope test', 'utf-8');
    // p2 在修改之后才登记基线 → 不应报告漂移。
    await workspaceDrift.observe('p2', fileA);
    expect(await workspaceDrift.detectDrift('p1')).toHaveLength(1);
    expect(await workspaceDrift.detectDrift('p2')).toHaveLength(0);
    workspaceDrift.clear('p1');
    expect(workspaceDrift.count('p1')).toBe(0);
    expect(workspaceDrift.count('p2')).toBe(1);
  });
});
