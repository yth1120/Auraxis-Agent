import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runInlineWorkflow } from '../inline-workflow';

const BASE_CTX = { projectRoot: 'C:/proj', requestId: 'r1', log: () => {} };

let UNSAFE_OLD: string | undefined;
beforeAll(() => {
  UNSAFE_OLD = process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  process.env.AURAXIS_ALLOW_UNSAFE_CODE = '1';
});
afterAll(() => {
  if (UNSAFE_OLD === undefined) delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  else process.env.AURAXIS_ALLOW_UNSAFE_CODE = UNSAFE_OLD;
});
describe('inline-workflow', () => {
  it('runs an async script and returns its value', async () => {
    const logs: string[] = [];
    const r = await runInlineWorkflow('ctx.log("hi"); const x = 1 + 2; return { sum: x, root: ctx.projectRoot };', {
      ...BASE_CTX,
      log: (l) => logs.push(l),
    });
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ sum: 3, root: 'C:/proj' });
    expect(logs).toContain('hi');
  });

  it('supports top-level await via ctx.sleep', async () => {
    const r = await runInlineWorkflow('await ctx.sleep(5); return { done: true };', BASE_CTX);
    expect(r.ok).toBe(true);
    expect(r.output).toEqual({ done: true });
  });

  it('rejects empty scripts and syntax errors', async () => {
    const empty = await runInlineWorkflow('   ', BASE_CTX);
    expect(empty.ok).toBe(false);
    const bad = await runInlineWorkflow('return {', BASE_CTX);
    expect(bad.ok).toBe(false);
  });

  it('kills a runaway sync loop via the worker watchdog', async () => {
    const r = await runInlineWorkflow('while (true) {}', BASE_CTX, 300);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('aborts a long-running script when the signal fires', async () => {
    const ctrl = new AbortController();
    const promise = runInlineWorkflow(
      'await ctx.sleep(60000); return 1;',
      { ...BASE_CTX, abortSignal: ctrl.signal },
      5000,
    );
    setTimeout(() => ctrl.abort(), 50);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('取消');
  });
});
