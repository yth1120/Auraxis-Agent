import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

const spawnOverride = vi.hoisted(() => ({ impl: null as null | ((...args: unknown[]) => unknown) }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      spawnOverride.impl
        ? spawnOverride.impl(...args)
        : (actual.spawn as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

vi.mock('../project-access', () => ({
  resolveTrustedProjectRoot: vi.fn(async (root?: string) => root ?? '/trusted-root'),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { buildLintArgs, lintCommand, runLintFix, registerLintHandlers } from '../lint-handlers';
import { resolveTrustedProjectRoot } from '../project-access';
import { ipcMain } from 'electron';

let testDir: string;
let fixture: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-lint-test-'));
  fixture = path.join(testDir, 'fake-lint.cjs');
  fs.writeFileSync(
    fixture,
    "process.stdout.write('fixed 2 files\\n'); process.exit(Number(process.env.FAKE_LINT_EXIT || 0));",
    'utf-8',
  );
});

afterEach(async () => {
  delete process.env.FAKE_LINT_EXIT;
  delete process.env.AURAXIS_LINT_CMD;
  spawnOverride.impl = null;
  vi.mocked(resolveTrustedProjectRoot).mockImplementation(async (root?: string) => root ?? '/trusted-root');
  // 超时测试刚 kill 的子进程在 Windows 上可能仍短暂占用目录，重试清理。
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('lint-handlers', () => {
  it('builds eslint --fix args without installing packages', () => {
    expect(buildLintArgs()).toEqual(['--no-install', 'eslint', '--fix', '.']);
    expect(buildLintArgs(['src/a.ts', 'src/b.ts'])).toEqual([
      '--no-install',
      'eslint',
      '--fix',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('runs the fixer and captures stdout', async () => {
    const result = await runLintFix(testDir, undefined, {
      command: process.execPath,
      args: [fixture],
    });
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('fixed 2 files');
  });

  it('reports a non-zero exit when lint still has problems', async () => {
    const result = await runLintFix(testDir, undefined, {
      command: process.execPath,
      args: [fixture],
      env: { FAKE_LINT_EXIT: '1' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('surfaces a clear error when the linter binary is missing', async () => {
    const result = await runLintFix(testDir, undefined, {
      command: 'auraxis-definitely-missing-linter-xyz',
      args: ['--fix'],
    });
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/npx|eslint|ENOENT|spawn/i);
  });

  it('kills and reports a hanging fixer on timeout', async () => {
    fs.writeFileSync(fixture, 'setInterval(() => {}, 1000);', 'utf8');
    const result = await runLintFix(testDir, undefined, {
      command: process.execPath,
      args: [fixture],
      timeoutMs: 150,
    });
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe('lint 执行超时');
  });

  it('registerLintHandlers rejects missing project roots', async () => {
    registerLintHandlers();
    const map = new Map(vi.mocked(ipcMain.handle).mock.calls as unknown as [string, Function][]);
    const handler = map.get('lint:fix')!;
    await expect(handler({}, {})).resolves.toEqual({ ok: false, error: '缺少项目目录' });
    await expect(handler({}, { projectRoot: '' })).resolves.toEqual({ ok: false, error: '缺少项目目录' });
  });

  it('lintCommand 支持环境变量覆盖，未覆盖时按平台选择 npx', () => {
    process.env.AURAXIS_LINT_CMD = 'custom-linter';
    expect(lintCommand()).toBe('custom-linter');
    delete process.env.AURAXIS_LINT_CMD;
    expect(lintCommand()).toMatch(/npx/);
    expect(lintCommand().endsWith('.cmd')).toBe(process.platform === 'win32');
  });

  it('spawn 同步抛错时返回可读错误', async () => {
    spawnOverride.impl = () => {
      throw new Error('spawn boom');
    };
    const result = await runLintFix(testDir, ['a.ts'], { command: 'x', args: [] });
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe('spawn boom');
  });

  it('子进程没有 stdout/stderr 时仍返回退出码', async () => {
    spawnOverride.impl = () => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const result = await runLintFix(testDir, undefined, { command: 'x', args: [] });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('');
  });

  it('超时且 kill 失败时仍按超时返回', async () => {
    spawnOverride.impl = () => ({
      kill() {
        throw new Error('already gone');
      },
      on() {
        /* 永不 settle，交给超时兜底 */
      },
    });
    const result = await runLintFix(testDir, undefined, { command: 'x', args: [], timeoutMs: 40 });
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe('lint 执行超时');
  });

  it('lint:fix 走通受信任目录并透传结果', async () => {
    registerLintHandlers();
    const map = new Map(vi.mocked(ipcMain.handle).mock.calls as unknown as [string, Function][]);
    const handler = map.get('lint:fix')!;
    process.env.AURAXIS_LINT_CMD = process.execPath;
    await expect(handler({}, { projectRoot: testDir, files: ['a.ts'] })).resolves.toMatchObject({
      ok: true,
      data: { exitCode: expect.any(Number) },
    });
  });

  it('lint:fix 在 lint 二进制缺失时返回错误', async () => {
    registerLintHandlers();
    const map = new Map(vi.mocked(ipcMain.handle).mock.calls as unknown as [string, Function][]);
    const handler = map.get('lint:fix')!;
    process.env.AURAXIS_LINT_CMD = 'auraxis-definitely-missing-linter-xyz';
    const result = await handler({}, { projectRoot: testDir });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/npx|eslint|ENOENT|spawn/i);
  });

  it('lint:fix 捕获受信任目录解析失败', async () => {
    registerLintHandlers();
    const map = new Map(vi.mocked(ipcMain.handle).mock.calls as unknown as [string, Function][]);
    const handler = map.get('lint:fix')!;
    vi.mocked(resolveTrustedProjectRoot).mockRejectedValueOnce(new Error('项目目录未被授权'));
    await expect(handler({}, { projectRoot: '/not-allowed' })).resolves.toEqual({
      ok: false,
      error: '项目目录未被授权',
    });
  });
});
