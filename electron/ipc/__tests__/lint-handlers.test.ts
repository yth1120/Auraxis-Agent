import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}));

import { buildLintArgs, runLintFix } from '../lint-handlers';

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
});
