import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPluginTools,
  executeBatch,
  executeMcpTool,
  getAllTools,
  getMcpTools,
  getPluginTools,
  getToolCount,
  invalidateMcpToolCache,
  isMcpTool,
  isToolConcurrencySafe,
  registerPluginTools,
  removePluginTools,
  splitIntoConcurrencyBatches,
  stripMcpPrefix,
} from '../tool-registry';
import { getAllMcpTools, callMcpTool } from '../ipc/mcp-handlers';

vi.mock('../tool-defs', () => ({
  TOOL_DEFINITIONS: [
    { name: 'Read', description: 'read', isConcurrencySafe: true },
    { name: 'Write', description: 'write', isConcurrencySafe: false },
  ],
}));

vi.mock('../ipc/mcp-handlers', () => ({
  getAllMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

const getAllMcpToolsMock = vi.mocked(getAllMcpTools);
const callMcpToolMock = vi.mocked(callMcpTool);

const mcpTool = {
  name: 'search',
  serverId: 'server-a',
  serverName: 'Server A',
  description: 'search',
  inputSchema: { type: 'object' },
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMcpToolCache();
  registerPluginTools([]);
  getAllMcpToolsMock.mockReturnValue([mcpTool]);
  callMcpToolMock.mockResolvedValue({ results: [] });
});

describe('tool-registry — registry and batch branches', () => {
  it('covers plugin mounting, deduplication, removal and cache invalidation', () => {
    const plugin = (name: string, isConcurrencySafe: boolean) => ({
      name,
      description: name,
      isConcurrencySafe,
      input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
    });
    addPluginTools([plugin('P1', false)]);
    addPluginTools([plugin('P1', false)]);
    addPluginTools([plugin('P2', true)]);
    expect(getPluginTools()).toHaveLength(2);
    removePluginTools(['P1']);
    expect(getPluginTools().map((t) => t.name)).toEqual(['P2']);
    expect(getToolCount()).toMatchObject({ builtIn: 2, mcp: 1, plugins: 1 });
    expect(getMcpTools()).toHaveLength(1);
    invalidateMcpToolCache();
  });

  it('truncates the unified tool list when it exceeds the limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `plugin-${i}`,
      description: 'plugin',
      isConcurrencySafe: false,
      input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
    }));
    registerPluginTools(many);
    expect(getAllTools()).toHaveLength(96);
  });

  it('dispatches MCP tools by server and falls back to the qualified name', async () => {
    expect(await executeMcpTool('Read', {})).toMatchObject({ error: expect.stringContaining('非 MCP') });
    expect(await executeMcpTool('mcp__server-a__search', { q: 'x' })).toMatchObject({ output: { results: [] } });
    expect(callMcpToolMock).toHaveBeenCalledWith('server-a', 'search', { q: 'x' });

    getAllMcpToolsMock.mockReturnValue([{ ...mcpTool, name: 'search' }]);
    expect(await executeMcpTool('mcp__server-a__other', {})).toMatchObject({
      error: expect.stringContaining('未找到'),
    });

    getAllMcpToolsMock.mockReturnValue([mcpTool]);
    callMcpToolMock.mockRejectedValueOnce(new Error('rpc down'));
    expect(await executeMcpTool('mcp__server-a__search', {})).toMatchObject({
      error: expect.stringContaining('执行失败'),
    });
  });

  it('covers concurrency lookup, prefix helpers and batch splitting', () => {
    expect(isMcpTool('mcp__x')).toBe(true);
    expect(stripMcpPrefix('mcp__x')).toBe('x');
    expect(stripMcpPrefix('Read')).toBe('Read');
    expect(isToolConcurrencySafe('Read')).toBe(true);
    expect(isToolConcurrencySafe('Write')).toBe(false);
    expect(isToolConcurrencySafe('mcp__server-a__search')).toBe(false);
    expect(isToolConcurrencySafe('missing')).toBe(false);

    expect(
      splitIntoConcurrencyBatches([{ name: 'Read' }, { name: 'Read' }, { name: 'Read' }, { name: 'Write' }], 2),
    ).toEqual([[0, 1], [2], [3]]);
    expect(splitIntoConcurrencyBatches([{ name: 'Write' }, { name: 'Read' }, { name: 'Read' }], 2)).toEqual([
      [0],
      [1, 2],
    ]);
    expect(splitIntoConcurrencyBatches([], 2)).toEqual([]);
  });

  it('executes safe batches with allSettled and unsafe batches serially', async () => {
    const calls: string[] = [];
    const executor = vi.fn(async (tc: { id: string }) => {
      calls.push(tc.id);
      return {
        index: 0,
        toolUseId: tc.id,
        toolName: 'Read',
        input: {},
        output: tc.id,
        durationMs: 1,
      };
    });
    expect(await executeBatch([], [], executor)).toEqual([]);

    const safe = await executeBatch(
      [0, 1],
      [
        { index: 0, id: 'a', name: 'Read', input: {} },
        { index: 1, id: 'b', name: 'Read', input: {} },
      ],
      executor,
    );
    expect(safe).toHaveLength(2);

    const rejected = await executeBatch(
      [0],
      [{ index: 0, id: 'c', name: 'Read', input: {} }],
      vi.fn(async () => {
        throw new Error('crash');
      }),
    );
    expect(rejected[0].error).toContain('并发工具执行崩溃');

    const serial = await executeBatch(
      [0, 1],
      [
        { index: 0, id: 'd', name: 'Write', input: {} },
        { index: 1, id: 'e', name: 'Write', input: {} },
      ],
      executor,
      vi.fn(),
    );
    expect(serial).toHaveLength(2);
  });
});
