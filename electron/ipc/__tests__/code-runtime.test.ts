import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { runCode } from '../../code-runtime';
import { getShellExecutor, setShellExecutor } from '../shell-executor';

const hasPython = (() => {
  const bin = process.env.AURAXIS_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  try {
    return spawnSync(bin, ['-c', 'print(1)'], { timeout: 5000 }).status === 0;
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

  it('选择平台正确的 Python 解释器并支持环境变量覆盖', async () => {
    const previous = getShellExecutor();
    const captured: Array<{ command: string }> = [];
    setShellExecutor({
      run: async (req) => {
        captured.push({ command: req.command });
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false };
      },
    });
    const oldBin = process.env.AURAXIS_PYTHON_BIN;
    try {
      await runCode({ language: 'python', code: 'print(1)' });
      expect(captured.at(-1)?.command).toBe(process.platform === 'win32' ? 'python' : 'python3');

      process.env.AURAXIS_PYTHON_BIN = 'C:/Python310/python.exe';
      await runCode({ language: 'python', code: 'print(1)' });
      expect(captured.at(-1)?.command).toBe('C:/Python310/python.exe');
    } finally {
      setShellExecutor(previous);
      if (oldBin === undefined) delete process.env.AURAXIS_PYTHON_BIN;
      else process.env.AURAXIS_PYTHON_BIN = oldBin;
    }
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
