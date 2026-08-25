import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { runCode } from '../../code-runtime';

const hasPython = (() => {
  try {
    return spawnSync('python3', ['-c', 'print(1)'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();

let UNSAFE_OLD: string | undefined;
beforeAll(() => {
  UNSAFE_OLD = process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  process.env.AURAXIS_ALLOW_UNSAFE_CODE = '1';
});
afterAll(() => {
  if (UNSAFE_OLD === undefined) delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  else process.env.AURAXIS_ALLOW_UNSAFE_CODE = UNSAFE_OLD;
});
describe('code-runtime', () => {
  it('runs JavaScript and captures stdout', async () => {
    const r = await runCode({ language: 'javascript', code: 'console.log(6 * 7)' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('42');
  });

  it('runs shell snippets', async () => {
    const r = await runCode({ language: 'shell', code: 'echo auraxis-code' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('auraxis-code');
  });

  it('kills runaway programs on timeout', async () => {
    const r = await runCode({ language: 'javascript', code: 'setTimeout(() => {}, 100000)', timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it('caps output size', async () => {
    const r = await runCode({
      language: 'javascript',
      code: 'for (let i = 0; i < 20000; i++) console.log("x".repeat(20));',
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(50_000);
  });

  it.skipIf(!hasPython)('runs Python when available', async () => {
    const r = await runCode({ language: 'python', code: 'print(1 + 2)' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('3');
  });
});
