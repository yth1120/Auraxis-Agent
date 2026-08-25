import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCodeProgram } from '../code-mode';

const baseHost = {
  projectRoot: process.cwd(),
  requestId: 'code-mode-test',
  mode: 'ask' as const,
};

let UNSAFE_OLD: string | undefined;
beforeAll(() => {
  UNSAFE_OLD = process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  process.env.AURAXIS_ALLOW_UNSAFE_CODE = '1';
});
afterAll(() => {
  if (UNSAFE_OLD === undefined) delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  else process.env.AURAXIS_ALLOW_UNSAFE_CODE = UNSAFE_OLD;
});
describe('runCodeProgram — TypeScript 工具编排程序', () => {
  it('顺序调用工具并返回程序 return 值', async () => {
    const calls: string[] = [];
    const r = await runCodeProgram(
      `const a = await tools.Echo({ text: 'a' });\nconst b = await tools.Echo({ text: 'b' });\nreturn a.text + b.text;`,
      baseHost,
      {
        executeTool: async (name, input) => {
          calls.push(name);
          return { output: { text: String(input.text) } };
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('ab');
    expect(r.subCalls.map((s) => s.name)).toEqual(['Echo', 'Echo']);
    expect(calls).toEqual(['Echo', 'Echo']);
  });

  it('Promise.all 并发调用确实重叠执行', async () => {
    const r = await runCodeProgram(
      `const [a, b, c] = await Promise.all([tools.Read({ n: 1 }), tools.Read({ n: 2 }), tools.Read({ n: 3 })]);\nreturn a.n + b.n + c.n;`,
      baseHost,
      {
        executeTool: async (_name, input) => {
          await new Promise((res) => setTimeout(res, 80));
          return { output: { n: Number(input.n) } };
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('6');
    expect(r.subCalls).toHaveLength(3);
    const elapsed =
      Math.max(...r.subCalls.map((s) => s.finishedAt ?? 0)) - Math.min(...r.subCalls.map((s) => s.startedAt));
    // 3×80ms serial would be ≥240ms; overlapped must be well below that.
    expect(elapsed).toBeLessThan(240);
  });

  it('程序抛错时返回结构化 stderr', async () => {
    const r = await runCodeProgram(`throw new Error('boom');`, baseHost, {
      executeTool: async () => ({ output: null }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('boom');
  });

  it('子调用错误成为 Promise rejection 并传播给程序', async () => {
    const r = await runCodeProgram(
      `try { await tools.Fail({}); } catch (e) { return 'caught:' + e.message; }`,
      baseHost,
      {
        executeTool: async () => ({ output: null, error: 'permission denied' }),
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('caught:permission denied');
  });

  it('非法 TypeScript 语法在运行前被拒绝', async () => {
    await expect(
      runCodeProgram(`const x: = 1;`, baseHost, {
        executeTool: async () => ({ output: null }),
      }),
    ).rejects.toThrow(/语法错误/);
  });
});
