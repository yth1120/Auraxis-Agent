import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: class {},
  safeStorage: {
    encryptString: vi.fn((s: string) => s),
    decryptString: vi.fn((s: string) => s),
    isEncryptionAvailable: () => true,
  },
}));

const mcpBridge = vi.hoisted(() => ({
  getAllMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

vi.mock('../../ipc/mcp-handlers', () => mcpBridge);

import {
  addPluginTools,
  removePluginTools,
  getPluginTools,
  getAllTools,
  getMcpTools,
  invalidateMcpToolCache,
  executeMcpTool,
  registerPluginTools,
} from '../../tool-registry';

beforeEach(() => {
  mcpBridge.getAllMcpTools.mockReturnValue([]);
  mcpBridge.callMcpTool.mockResolvedValue({ ok: true });
});

const TOOL_A = {
  name: 'PluginA',
  description: 'test plugin tool A',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  isConcurrencySafe: false,
};

const TOOL_B = {
  name: 'PluginB',
  description: 'test plugin tool B',
  input_schema: { type: 'object' as const, properties: {}, required: [] },
  isConcurrencySafe: true,
};

describe('electron tool-registry — dynamic plugin tools', () => {
  afterEach(() => {
    registerPluginTools([]);
  });

  it('addPluginTools appends without replacing existing plugin tools', () => {
    addPluginTools([TOOL_A]);
    addPluginTools([TOOL_B]);
    const names = getPluginTools().map((t) => t.name);
    expect(names).toEqual(['PluginA', 'PluginB']);
  });

  it('addPluginTools ignores duplicate names', () => {
    addPluginTools([TOOL_A]);
    addPluginTools([TOOL_A]);
    expect(getPluginTools()).toHaveLength(1);
  });

  it('removePluginTools drops only the named tools', () => {
    addPluginTools([TOOL_A, TOOL_B]);
    removePluginTools(['PluginA']);
    expect(getPluginTools().map((t) => t.name)).toEqual(['PluginB']);
  });

  it('mounted tools are visible in getAllTools', () => {
    addPluginTools([TOOL_A]);
    expect(getAllTools().some((t) => t.name === 'PluginA')).toBe(true);
  });
});

describe('electron tool-registry — MCP routing', () => {
  afterEach(() => {
    mcpBridge.getAllMcpTools.mockReset();
    mcpBridge.callMcpTool.mockReset();
    invalidateMcpToolCache();
  });

  it('qualifies MCP tool names by server id and routes calls by id', async () => {
    mcpBridge.getAllMcpTools.mockReturnValue([
      {
        name: 'ping',
        description: 'pong',
        inputSchema: { type: 'object' },
        serverName: 'server one',
        serverId: 'srv1',
      },
      {
        name: 'ping',
        description: 'pong two',
        inputSchema: { type: 'object' },
        serverName: 'server two',
        serverId: 'srv2',
      },
    ]);
    mcpBridge.callMcpTool.mockResolvedValue({ ok: true });

    invalidateMcpToolCache();
    expect(getMcpTools().map((t) => t.name)).toEqual(['mcp__srv1__ping', 'mcp__srv2__ping']);
    await expect(executeMcpTool('mcp__srv2__ping', { x: 1 })).resolves.toEqual({
      output: { ok: true },
    });
    expect(mcpBridge.callMcpTool).toHaveBeenCalledWith('srv2', 'ping', { x: 1 });
  });

  it('keeps legacy unqualified MCP names working', async () => {
    mcpBridge.getAllMcpTools.mockReturnValue([
      {
        name: 'ping',
        description: 'pong',
        inputSchema: { type: 'object' },
        serverName: 'server one',
        serverId: 'srv1',
      },
    ]);
    mcpBridge.callMcpTool.mockResolvedValue({ ok: true });

    await expect(executeMcpTool('mcp__ping', {})).resolves.toEqual({ output: { ok: true } });
    expect(mcpBridge.callMcpTool).toHaveBeenCalledWith('srv1', 'ping', {});
  });
});
