import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'auraxis-wt-'));

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));

import {
  executeToolCall,
  getActiveWorktree,
  restoreWorktreeSession,
  clearWorktreeSession,
  isValidWorktreeTaskId,
} from '../tool-handlers';

let repo = '';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: repo,
    requestId: 'wt-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

function initRepo(): string {
  const r = mkdtempSync(path.join(tmpRoot, 'repo-'));
  spawnSync('git', ['init', '-q'], { cwd: r });
  writeFileSync(path.join(r, 'f.txt'), 'x', 'utf-8');
  spawnSync('git', ['add', '-A'], { cwd: r });
  spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.c', 'commit', '-q', '-m', 'init'], { cwd: r });
  return r;
}

beforeEach(() => {
  repo = initRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('工作树会话工具', () => {
  it('isValidWorktreeTaskId 只接受安全字符集', () => {
    expect(isValidWorktreeTaskId('abc_123-')).toBe(true);
    expect(isValidWorktreeTaskId('a b')).toBe(false);
    expect(isValidWorktreeTaskId('a;rm -rf')).toBe(false);
    expect(isValidWorktreeTaskId('../x')).toBe(false);
    expect(isValidWorktreeTaskId('x'.repeat(65))).toBe(false);
    expect(isValidWorktreeTaskId(42)).toBe(false);
  });

  it('非法 task_id 与非 Git 目录被拒绝', async () => {
    const bad = await executeToolCall('EnterWorktree', { task_id: 'bad;id', projectRoot: repo }, ctx());
    expect(bad.error).toContain('task_id 非法');

    const notGit = path.join(tmpRoot, 'not-a-repo');
    if (!existsSync(notGit)) mkdirSync(notGit, { recursive: true });
    const r = await executeToolCall('EnterWorktree', { task_id: 't1', projectRoot: notGit }, ctx());
    expect(r.error).toContain('不是一个 Git 仓库');
  });

  it('创建新分支工作树并激活会话重定向', async () => {
    const r = await executeToolCall('EnterWorktree', { task_id: 't1', projectRoot: repo }, ctx());
    expect(r.error).toBeUndefined();
    const out = r.output as any;
    expect(out.branch).toBe('auraxis-task-t1');
    expect(out.sandbox_path).toContain('task-t1');
    expect(existsSync(out.sandbox_path)).toBe(true);
    expect(getActiveWorktree('wt-1')).toBe(out.sandbox_path);

    // 后续文件工具重定向到沙箱
    writeFileSync(path.join(out.sandbox_path, 'sandbox-only.txt'), 'sandbox', 'utf-8');
    const read = await executeToolCall('Read', { file_path: 'sandbox-only.txt' }, ctx());
    expect(read.error).toBeUndefined();
    expect((read.output as any).content).toBe('sandbox');
  }, 30_000);

  it('同名任务再次进入时复用已有分支', async () => {
    const first = await executeToolCall('EnterWorktree', { task_id: 't2', projectRoot: repo }, ctx());
    expect(first.error).toBeUndefined();
    const second = await executeToolCall('EnterWorktree', { task_id: 't2', projectRoot: repo }, ctx());
    expect(second.error).toBeUndefined();
    expect((second.output as any).branch).toBe('auraxis-task-t2');
    expect((second.output as any).sandbox_path).toBe((first.output as any).sandbox_path);
  }, 30_000);

  it('restore / clear 会话映射', async () => {
    restoreWorktreeSession('key-1', 'C:/sandbox/task-x');
    expect(getActiveWorktree('key-1')).toBe('C:/sandbox/task-x');
    clearWorktreeSession('key-1');
    expect(getActiveWorktree('key-1')).toBeUndefined();
  });
});
