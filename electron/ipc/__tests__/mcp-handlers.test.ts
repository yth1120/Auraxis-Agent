import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  spawn: vi.fn(),
  resolveCredential: vi.fn(),
  readSettings: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\probe',
  },
}));
vi.mock('child_process', () => ({
  spawn: h.spawn,
}));
vi.mock('cross-spawn', () => ({
  default: h.spawn,
}));
vi.mock('../../credentials', () => ({
  resolveCredential: h.resolveCredential,
}));
vi.mock('../settings-store', () => ({
  readSettings: h.readSettings,
}));
vi.mock('../../tool-registry', () => ({
  invalidateMcpToolCache: vi.fn(),
}));

import { registerMcpHandlers, getAllMcpTools } from '../mcp-handlers';
import { invalidateMcpToolCache } from '../../tool-registry';

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdin = { write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.removeAllListeners = vi.fn((...args: any[]) =>
    (EventEmitter.prototype as any).removeAllListeners.apply(child, args),
  ) as any;
  return child;
}

function respond(child: any, line: unknown) {
  // setTimeout(0)：先让 sendJsonRpc 的 pending 注册完成，再投递响应
  setTimeout(() => child.stdout.emit('data', Buffer.from(JSON.stringify(line) + '\n')), 0);
}

const cfg = (overrides: Record<string, unknown> = {}) => ({
  id: 'srv1',
  name: '测试服务器',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server'],
  env: { FOO: 'bar' },
  ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.spawn.mockReset();
  h.resolveCredential.mockReset();
  h.resolveCredential.mockResolvedValue(undefined);
  h.readSettings.mockReset();
  h.readSettings.mockResolvedValue({});
  registerMcpHandlers();
  // 清空模块级 connections，避免用例间串扰
  await h.handlers.get('mcp:setServers')!({}, []);
});

describe('mcp — setServers / connect / disconnect', () => {
  it('setServers 增删服务器并返回配置', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const get = h.handlers.get('mcp:getServers')! as any;
    const statuses = h.handlers.get('mcp:getStatuses')! as any;

    await set({}, [cfg(), cfg({ id: 'srv2', name: 'B' })]);
    expect((await get()).data).toHaveLength(2);
    expect((await statuses()).data.every((s: any) => s.connected === false)).toBe(true);

    await set({}, [cfg()]);
    expect((await get()).data.map((c: any) => c.id)).toEqual(['srv1']);
  });

  it('connect 完成初始化握手与工具发现', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    await set({}, [cfg()]);

    respond(child, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
    respond(child, {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'ping', description: 'd', inputSchema: { type: 'object' } }] },
    });
    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ serverId: 'srv1', connected: true, toolCount: 1 });
    expect(invalidateMcpToolCache).toHaveBeenCalled();
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('initialize'));
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('notifications/initialized'));
    expect(h.spawn).toHaveBeenCalledWith('npx', expect.any(Array), expect.objectContaining({ shell: false }));

    const list = h.handlers.get('mcp:listTools')! as any;
    expect((await list({}, 'srv1')).data[0]).toMatchObject({
      name: 'ping',
      serverName: '测试服务器',
      serverId: 'srv1',
    });
    expect(getAllMcpTools()).toHaveLength(1);

    // 已连接重复 connect 直接返回
    expect((await connect({}, 'srv1')).data.toolCount).toBe(1);
  });

  it('初始化失败返回错误并保持断开', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    await set({}, [cfg()]);

    respond(child, { jsonrpc: '2.0', id: 1, error: { message: 'bad handshake' } });
    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad handshake');
  });

  it('配置校验：空命令/路径/未授权命令/非法 args/env', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: '' }, 'MCP 命令不能为空'],
      [{ command: 'C:/tools/npx' }, '不能包含路径'],
      [{ command: 'curl' }, '不支持的 MCP 命令'],
      [{ command: 'npx', args: 'bad' }, 'args 必须是字符串数组'],
      [{ command: 'npx', env: 'bad' }, 'env 必须是键值对对象'],
    ];
    for (const [over, msg] of cases) {
      const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await set({}, [cfg({ id, command: over.command ?? 'npx', ...over })]);
      const r = await connect({}, id);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(msg);
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('DeepSeek Harness 预设会注入 Auraxis 已保存的 Key', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    h.resolveCredential.mockResolvedValue({ value: 'sk-auraxis-test' });
    await set({}, [cfg({ useAuraxisDeepSeekKey: true })]);

    respond(child, { jsonrpc: '2.0', id: 1, result: {} });
    respond(child, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await connect({}, 'srv1');

    expect(h.spawn).toHaveBeenCalledWith(
      'npx',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ DEEPSEEK_API_KEY: 'sk-auraxis-test' }),
      }),
    );
  });

  it('飞书/Lark MCP 预设会注入加密设置中的 App 凭据', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    h.readSettings.mockResolvedValue({
      larkAppId: 'cli-test',
      larkAppSecret: 'secret-test',
      larkDomain: 'https://open.larksuite.com',
      larkTools: 'preset.im.default',
    });
    await set({}, [cfg({ useAuraxisLarkCredentials: true })]);

    respond(child, { jsonrpc: '2.0', id: 1, result: {} });
    respond(child, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await connect({}, 'srv1');

    expect(h.spawn).toHaveBeenCalledWith(
      'npx',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          APP_ID: 'cli-test',
          APP_SECRET: 'secret-test',
          LARK_DOMAIN: 'https://open.larksuite.com',
          LARK_TOOLS: 'preset.im.default',
          LARK_TOKEN_MODE: 'tenant_access_token',
        }),
      }),
    );
  });

  it('飞书/Lark 凭据缺失时直接返回可读错误而不是启动进程', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    h.readSettings.mockResolvedValue({});
    await set({}, [cfg({ useAuraxisLarkCredentials: true })]);

    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('飞书/Lark 未配置');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('disconnect 清理监听、kill 进程并拒绝 pending', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const disconnect = h.handlers.get('mcp:disconnect')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    await set({}, [cfg()]);
    respond(child, { jsonrpc: '2.0', id: 1, result: {} });
    respond(child, { jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await connect({}, 'srv1');

    const r = await disconnect({}, 'srv1');
    expect(r).toEqual({ ok: true, data: { serverId: 'srv1', connected: false, toolCount: 0 } });
    expect(child.kill).toHaveBeenCalled();
    expect(child.removeAllListeners).toHaveBeenCalled();
  });
});

describe('mcp — callTool / IPC 校验', () => {
  it('callTool 命中工具并透传结果，未命中抛错', async () => {
    const set = h.handlers.get('mcp:setServers')! as any;
    const connect = h.handlers.get('mcp:connect')! as any;
    const call = h.handlers.get('mcp:callTool')! as any;
    const child = fakeChild();
    h.spawn.mockReturnValue(child);
    await set({}, [cfg()]);
    respond(child, { jsonrpc: '2.0', id: 1, result: {} });
    respond(child, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'ping', description: '', inputSchema: {} }] } });
    await connect({}, 'srv1');

    respond(child, { jsonrpc: '2.0', id: 3, result: { ok: true } });
    expect(await call({}, 'srv1', 'ping', { x: 1 })).toEqual({ ok: true, data: { ok: true } });

    const miss = await call({}, 'srv1', 'nope', {});
    expect(miss).toEqual({ ok: false, error: 'MCP 工具未找到: nope' });
  });

  it('callTool 参数断言', async () => {
    const call = h.handlers.get('mcp:callTool')! as any;
    expect(await call({}, 123, 't', {})).toEqual({ ok: false, error: expect.stringContaining('serverId') });
    expect(await call({}, 's', 456, {})).toEqual({ ok: false, error: expect.stringContaining('toolName') });
  });

  it('listTools 服务器不存在', async () => {
    const list = h.handlers.get('mcp:listTools')! as any;
    expect(await list({}, 'missing')).toEqual({ ok: false, error: '服务器未找到' });
  });

  it('connect 服务器不存在', async () => {
    const connect = h.handlers.get('mcp:connect')! as any;
    expect((await connect({}, 'missing')).ok).toBe(false);
  });
});
