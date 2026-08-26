import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  mountDynamicPlugin,
  unmountDynamicPlugin,
  executeDynamicTool,
  getDynamicTool,
  getDynamicPluginCatalog,
} from '../dynamic-plugin';

let UNSAFE_OLD: string | undefined;
beforeAll(() => {
  UNSAFE_OLD = process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  process.env.AURAXIS_ALLOW_UNSAFE_CODE = '1';
});
afterAll(() => {
  if (UNSAFE_OLD === undefined) delete process.env.AURAXIS_ALLOW_UNSAFE_CODE;
  else process.env.AURAXIS_ALLOW_UNSAFE_CODE = UNSAFE_OLD;
});
describe('dynamic-plugin', () => {
  afterEach(() => {
    for (const p of getDynamicPluginCatalog()) unmountDynamicPlugin(p.id);
  });

  it('mounts tools and executes handlers with input + ctx', async () => {
    const r = mountDynamicPlugin({
      id: 'test-echo',
      name: 'Echo',
      tools: [
        {
          name: 'EchoTool',
          description: 'echo input back',
          handler: '(input, ctx) => ({ echo: input.value, root: ctx.projectRoot })',
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.toolNames).toEqual(['EchoTool']);
    expect(getDynamicTool('EchoTool')).toBeTruthy();

    const res = await executeDynamicTool('EchoTool', { value: 42 }, { projectRoot: 'C:/x', requestId: 'r1' });
    expect(res?.output).toEqual({ echo: 42, root: 'C:/x' });
  });

  it('supports async handlers', async () => {
    mountDynamicPlugin({
      id: 'test-async',
      name: 'Async',
      tools: [
        {
          name: 'AsyncTool',
          description: 'async handler',
          handler: 'async (input) => { await new Promise(r => setTimeout(r, 2)); return { doubled: input.n * 2 }; }',
        },
      ],
    });
    const res = await executeDynamicTool('AsyncTool', { n: 21 }, { projectRoot: 'C:/x', requestId: 'r1' });
    expect(res?.output).toEqual({ doubled: 42 });
  });

  it('terminates a blocking handler under the vm watchdog', async () => {
    mountDynamicPlugin({
      id: 'test-spin',
      name: 'Spin',
      tools: [{ name: 'SpinTool', description: 'blocks forever', handler: '() => { while (true) {} }' }],
    });
    const started = Date.now();
    const res = await executeDynamicTool('SpinTool', {}, { projectRoot: 'C:/x', requestId: 'r1' }, 100);
    expect(res?.output).toBeNull();
    expect(res?.error).toContain('执行失败');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('bounds a never-resolving async handler', async () => {
    vi.useFakeTimers();
    try {
      mountDynamicPlugin({
        id: 'test-hang',
        name: 'Hang',
        tools: [{ name: 'HangTool', description: 'hangs', handler: 'async () => new Promise(() => {})' }],
      });
      const pending = executeDynamicTool('HangTool', {}, { projectRoot: 'C:/x', requestId: 'r1' }, 500);
      await vi.advanceTimersByTimeAsync(600);
      const res = await pending;
      expect(res?.error).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects duplicate tool names and invalid ids', async () => {
    mountDynamicPlugin({
      id: 'test-dup',
      name: 'Dup',
      tools: [{ name: 'DupTool', description: 'd', handler: '() => ({})' }],
    });
    const dup = mountDynamicPlugin({
      id: 'test-dup-2',
      name: 'Dup2',
      tools: [{ name: 'DupTool', description: 'd', handler: '() => ({})' }],
    });
    expect(dup.ok).toBe(false);
    const badId = mountDynamicPlugin({
      id: 'bad id!',
      name: 'Bad',
      tools: [{ name: 'BadTool', description: 'd', handler: '() => ({})' }],
    });
    expect(badId.ok).toBe(false);
  });

  it('unmount removes the plugin and its tools', async () => {
    mountDynamicPlugin({
      id: 'test-remove',
      name: 'Remove',
      tools: [{ name: 'RemoveTool', description: 'd', handler: '() => ({ ok: true })' }],
    });
    expect(getDynamicTool('RemoveTool')).toBeTruthy();
    const r = unmountDynamicPlugin('test-remove');
    expect(r.ok).toBe(true);
    expect(getDynamicTool('RemoveTool')).toBeUndefined();
    expect(getDynamicPluginCatalog()).toHaveLength(0);
  });
});
