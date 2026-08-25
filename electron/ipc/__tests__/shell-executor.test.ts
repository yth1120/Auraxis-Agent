import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import { nodeShellExecutor, getShellExecutor, setShellExecutor, type ShellExecutor } from '../shell-executor';

afterEach(() => {
  setShellExecutor(nodeShellExecutor);
});

describe('shell-executor', () => {
  it('runs a command and captures stdout + exit code', async () => {
    const r = await nodeShellExecutor.run({
      command: process.execPath,
      args: ['-e', 'console.log("hello-exec")'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-exec');
    expect(r.stderr).toBe('');
  });

  it('captures stderr and non-zero exit codes', async () => {
    const r = await nodeShellExecutor.run({
      command: process.execPath,
      args: ['-e', 'console.error("boom"); process.exit(3)'],
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it('times out long-running commands', async () => {
    const r = await nodeShellExecutor.run({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 150,
    });
    expect(r.timedOut).toBe(true);
  });

  it('caps output per stream', async () => {
    const r = await nodeShellExecutor.run({
      command: process.execPath,
      args: ['-e', 'console.log("x".repeat(20000))'],
      outputCap: 100,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
  });

  it('supports shell mode', async () => {
    const r = await nodeShellExecutor.run({ command: 'echo shell-ok', shell: true, cwd: os.tmpdir() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('shell-ok');
  });

  it('exposes a swappable registry seam', async () => {
    const fake: ShellExecutor = {
      run: vi.fn(async () => ({ stdout: 'fake', stderr: '', exitCode: 0, timedOut: false, truncated: false })),
    };
    setShellExecutor(fake);
    expect(getShellExecutor()).toBe(fake);
    const r = await getShellExecutor().run({ command: 'anything', cwd: path.resolve('.') });
    expect(r.stdout).toBe('fake');
    expect(fake.run).toHaveBeenCalledTimes(1);
  });
});
