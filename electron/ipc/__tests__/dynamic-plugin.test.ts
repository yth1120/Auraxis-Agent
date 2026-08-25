import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
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
