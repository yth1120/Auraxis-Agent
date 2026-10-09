/**
 * tool-provider.test.ts — ToolProvider 统一抽象与三来源注册的契约测试。
 *
 * 覆盖：注册顺序（= 工具清单拼接顺序）、owns 分派、execute 返回 undefined 时继续
 * 尝试下一个 provider、MAX_TOTAL_TOOLS 截断与告警，以及内置 / MCP / 插件在注册表
 * 里的归属（MCP 前缀工具必须由 mcp provider 认领并执行）。
 *
 * 注册表（tool-provider 的 providers 数组）是模块级状态，因此每个用例都经
 * vi.resetModules() + 动态 import 取一份全新实例，避免用例间互相污染。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDef } from '../tool-defs';
import type { ToolExecutionResult, ToolProvider } from '../tool-provider';

vi.mock('../tool-defs', () => ({
  TOOL_DEFINITIONS: [
    { name: 'Read', description: 'read', isConcurrencySafe: true },
    { name: 'Write', description: 'write', isConcurrencySafe: false },
  ],
}));

const mcpBridge = vi.hoisted(() => ({
  getAllMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

vi.mock('../ipc/mcp-handlers', () => mcpBridge);

const mcpTool = {
  name: 'search',
  serverId: 'server-a',
  serverName: 'Server A',
  description: 'search',
  inputSchema: { type: 'object' },
};

function tool(name: string): ToolDef {
  return {
    name,
    description: name,
    input_schema: { type: 'object', properties: {}, required: [] },
    isConcurrencySafe: false,
  };
}

/** 最小可用 provider：默认认领自己清单里的工具名，execute 由用例覆写。 */
function provider(id: string, tools: ToolDef[], overrides: Partial<ToolProvider> = {}): ToolProvider {
  return {
    id,
    listTools: () => tools,
    owns: (toolName) => tools.some((t) => t.name === toolName),
    // 夹具默认声明「语义已知」；要验证外部来源策略时由用例覆写。
    capabilities: () => ({ semanticsKnown: true }),
    execute: async () => undefined,
    ...overrides,
  };
}

type ProviderModule = typeof import('../tool-provider');
type RegistryModule = typeof import('../tool-registry');

/** 全新 provider 注册表（不注册任何内置来源）。 */
async function freshProviders(): Promise<ProviderModule> {
  vi.resetModules();
  return import('../tool-provider');
}

/** 全新注册表 + 已注册 builtin / mcp / plugin 三个来源的 tool-registry。 */
async function freshRegistry(): Promise<{ providers: ProviderModule; registry: RegistryModule }> {
  vi.resetModules();
  const providers = await import('../tool-provider');
  const registry = await import('../tool-registry');
  return { providers, registry };
}

beforeEach(() => {
  vi.clearAllMocks();
  mcpBridge.getAllMcpTools.mockReturnValue([mcpTool]);
  mcpBridge.callMcpTool.mockResolvedValue({ results: [] });
});

describe('tool-provider — 注册与分派', () => {
  it('按注册顺序拼接工具清单，listToolProviders 返回顺序快照', async () => {
    const { registerToolProvider, listToolProviders, listAllToolDefs } = await freshProviders();
    registerToolProvider(provider('first', [tool('A')]));
    registerToolProvider(provider('second', [tool('B')]));

    expect(listToolProviders().map((p) => p.id)).toEqual(['first', 'second']);
    expect(listAllToolDefs().map((t) => t.name)).toEqual(['A', 'B']);

    // 快照语义：改动返回数组不会污染注册表
    listToolProviders().pop();
    expect(listToolProviders()).toHaveLength(2);
  });

  it('owns 决定分派：不认领该工具名的 provider 不会被调用', async () => {
    const { registerToolProvider, resolveToolProvider, executeViaProviders } = await freshProviders();
    const execute = vi.fn(async (): Promise<ToolExecutionResult | undefined> => ({ output: 'never' }));
    registerToolProvider(provider('other', [tool('Other')], { execute }));

    expect(resolveToolProvider('Missing')).toBeUndefined();
    await expect(executeViaProviders('Missing', {})).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(resolveToolProvider('Other')?.id).toBe('other');
  });

  it('认领但 execute 返回 undefined 时继续尝试下一个 provider', async () => {
    const { registerToolProvider, resolveToolProvider, executeViaProviders } = await freshProviders();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => ({ output: 'second' }));
    registerToolProvider(provider('first', [tool('Shared')], { execute: first }));
    registerToolProvider(provider('second', [tool('Shared')], { execute: second }));

    expect(resolveToolProvider('Shared')?.id).toBe('first');
    await expect(executeViaProviders('Shared', { q: 1 })).resolves.toEqual({ output: 'second' });
    expect(first).toHaveBeenCalledWith('Shared', { q: 1 });
    expect(second).toHaveBeenCalledWith('Shared', { q: 1 });
  });

  it('所有认领者都返回 undefined 时整体返回 undefined', async () => {
    const { registerToolProvider, executeViaProviders } = await freshProviders();
    registerToolProvider(provider('only', [tool('Solo')]));

    await expect(executeViaProviders('Solo', {})).resolves.toBeUndefined();
  });
});

describe('tool-provider — MAX_TOTAL_TOOLS 截断', () => {
  it('超过上限时截断到 96 并保留原有告警文案', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { registerToolProvider, listAllToolDefs } = await freshProviders();
      const many = Array.from({ length: 100 }, (_, i) => tool(`t${i}`));
      registerToolProvider(provider('big', many));

      const defs = listAllToolDefs();
      expect(defs).toHaveLength(96);
      expect(defs.map((t) => t.name)).toEqual(many.slice(0, 96).map((t) => t.name));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '[ToolRegistry] Tool count 100 exceeds limit 96. Truncating to 96. Consider reducing MCP servers or disabling unused plugins.',
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('截断按注册顺序保留靠前的来源（内置 → MCP → 插件）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { registerToolProvider, listAllToolDefs } = await freshProviders();
      const builtIn = Array.from({ length: 90 }, (_, i) => tool(`b${i}`));
      const mcp = Array.from({ length: 10 }, (_, i) => tool(`m${i}`));
      registerToolProvider(provider('builtin', builtIn));
      registerToolProvider(provider('mcp', mcp));

      const names = listAllToolDefs().map((t) => t.name);
      expect(names).toHaveLength(96);
      expect(names.slice(0, 90)).toEqual(builtIn.map((t) => t.name));
      expect(names.slice(90)).toEqual(mcp.slice(0, 6).map((t) => t.name));
    } finally {
      warn.mockRestore();
    }
  });

  it('未超过上限时不截断也不告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { registerToolProvider, listAllToolDefs } = await freshProviders();
      registerToolProvider(provider('small', [tool('a'), tool('b')]));

      expect(listAllToolDefs().map((t) => t.name)).toEqual(['a', 'b']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('tool-registry — 三来源注册', () => {
  it('内置 / MCP / 插件按此顺序注册，拼接顺序与 getAllTools 一致', async () => {
    const { providers, registry } = await freshRegistry();
    expect(providers.listToolProviders().map((p) => p.id)).toEqual(['builtin', 'mcp', 'plugin']);

    registry.addPluginTools([tool('PluginA')]);

    const names = providers.listAllToolDefs().map((t) => t.name);
    expect(names).toEqual(['Read', 'Write', 'mcp__server-a__search', 'PluginA']);
    expect(registry.getAllTools().map((t) => t.name)).toEqual(names);
    expect(registry.getBuiltInTools().map((t) => t.name)).toEqual(['Read', 'Write']);
    expect(registry.getMcpTools().map((t) => t.name)).toEqual(['mcp__server-a__search']);
    expect(registry.getPluginTools().map((t) => t.name)).toEqual(['PluginA']);
    expect(registry.getToolCount()).toEqual({ builtIn: 2, mcp: 1, plugins: 1, total: 4 });
  });

  it('MCP 前缀工具由 mcp provider 认领并执行（兼容入口走同一实现）', async () => {
    const { providers, registry } = await freshRegistry();

    expect(providers.resolveToolProvider('mcp__server-a__search')?.id).toBe('mcp');
    expect(providers.resolveToolProvider('Read')?.id).toBe('builtin');
    expect(providers.resolveToolProvider('nope')).toBeUndefined();

    await expect(providers.executeViaProviders('mcp__server-a__search', { q: 'x' })).resolves.toEqual({
      output: { results: [] },
    });
    expect(mcpBridge.callMcpTool).toHaveBeenCalledWith('server-a', 'search', { q: 'x' }, undefined);

    await expect(registry.executeMcpTool('mcp__server-a__search', { q: 'x' })).resolves.toEqual({
      output: { results: [] },
    });

    // provider 契约：不认领的名字返回 undefined，交给下一个 provider
    const mcp = providers.listToolProviders().filter((p) => p.id === 'mcp');
    await expect(mcp[0].execute('Read', {})).resolves.toBeUndefined();
  });

  it('MCP 工具未找到时错误文本不变', async () => {
    const { providers } = await freshRegistry();
    mcpBridge.getAllMcpTools.mockReturnValue([{ ...mcpTool, name: 'search' }]);

    await expect(providers.executeViaProviders('mcp__server-a__other', {})).resolves.toMatchObject({
      error: expect.stringContaining('MCP 工具未找到'),
    });
  });

  it('插件与内置工具由各自 provider 认领，执行仍留在宿主管线', async () => {
    const { providers, registry } = await freshRegistry();

    registry.addPluginTools([tool('PluginA')]);
    expect(providers.resolveToolProvider('PluginA')?.id).toBe('plugin');
    const plugin = providers.listToolProviders().filter((p) => p.id === 'plugin');
    await expect(plugin[0].execute('PluginA', {})).resolves.toBeUndefined();

    registry.removePluginTools(['PluginA']);
    expect(providers.resolveToolProvider('PluginA')).toBeUndefined();

    const builtin = providers.listToolProviders().filter((p) => p.id === 'builtin');
    await expect(builtin[0].execute('Read', {})).resolves.toBeUndefined();
  });
});

describe('ToolProvider capabilities — 外部来源判定收敛到一处', () => {
  it('isExternalSourceTool：provider 声明优先，注册表为空时回退 mcp__ 前缀', async () => {
    const providers = await freshProviders();
    // 注册表为空：只有约定前缀被认作外部来源。
    expect(providers.isExternalSourceTool('mcp__any__tool')).toBe(true);
    expect(providers.isExternalSourceTool('Read')).toBe(false);

    // 注册一个显式声明「语义未知」的来源后，其无前缀工具同样算外部来源。
    providers.registerToolProvider(
      provider('third-party', [tool('ThirdPartyTool')], { capabilities: () => ({ semanticsKnown: false }) }),
    );
    expect(providers.isExternalSourceTool('ThirdPartyTool')).toBe(true);
  });

  it('三来源能力声明：内置语义已知，MCP 与插件语义未知', async () => {
    const { providers } = await freshRegistry();
    expect(providers.resolveToolProvider('Read')?.capabilities()).toEqual({ semanticsKnown: true });
    expect(providers.resolveToolProvider('mcp__server-a__search')?.capabilities()).toEqual({ semanticsKnown: false });
  });

  it('MCP 工具仍判为危险且不并发安全（前缀特判改为能力声明后行为不变）', async () => {
    const { registry } = await freshRegistry();
    const capability = await import('../tool-capability');
    expect(capability.isDangerousTool('mcp__server-a__search')).toBe(true);
    expect(registry.isToolConcurrencySafe('mcp__server-a__search')).toBe(false);
  });

  // 行为变化：插件工具此前沿用定义里的 isConcurrencySafe，现在作为外部来源一律串行，
  // 并进入危险工具与 Work 禁入集合 —— 与 AGENTS.md「Work 模式禁止动态插件」一致。
  it('插件工具作为外部来源：危险、不并发安全、Work 禁入', async () => {
    const { registry } = await freshRegistry();
    const capability = await import('../tool-capability');
    const workDocs = await import('../work-docs-policy');
    // 定义里明确声明并发安全，仍必须串行执行。
    registry.addPluginTools([{ ...tool('PluginSafe'), isConcurrencySafe: true }]);

    expect(registry.isToolConcurrencySafe('PluginSafe')).toBe(false);
    expect(capability.isDangerousTool('PluginSafe')).toBe(true);
    expect(workDocs.workDocsOnlyVerdict('work', 'PluginSafe', {})).toMatchObject({ allowed: false });
  });
});
