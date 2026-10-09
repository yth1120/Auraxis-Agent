/**
 * mcp-handlers.test.ts — MCP 客户端策略层测试。
 *
 * 协议实现已交给 `@modelcontextprotocol/sdk`，因此这里在 **SDK 边界**上断言：
 * transport 的创建参数（命令/参数/环境/stderr）、工具发现与映射、连接生命周期，
 * 以及 Auraxis 自己的策略层（命令白名单、凭据注入、Windows preload、IPC 形状）。
 *
 * 协议本身（握手、能力协商、版本、超时）由官方 SDK 单测保证，这里不再手写
 * JSON-RPC 帧来验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  transports: [] as Array<Record<string, unknown>>,
  httpTransports: [] as Array<Record<string, unknown>>,
  clients: [] as Array<Record<string, unknown>>,
  /** 下一次 tools/list 返回的工具（Client 在 connect 内部创建，无法提前打桩）。 */
  nextTools: [] as unknown[],
  /** 非空时握手抛错，用于验证初始化失败路径。 */
  connectError: null as Error | null,
  resolveCredential: vi.fn(),
  readSettings: vi.fn(),
  /** 最近一次注册的 tools/list_changed 处理器（供用例手动触发）。 */
  listChangedHandler: null as (() => Promise<void>) | null,
  /** 注册该处理器时传入的 schema，用于确认订阅的是正确的通知。 */
  listChangedSchema: null as { shape?: Record<string, { value?: unknown }> } | null,
  /** 握手上报的服务端能力与实现信息。 */
  serverCapabilities: undefined as Record<string, unknown> | undefined,
  serverVersion: undefined as Record<string, unknown> | undefined,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  shell: { openExternal: vi.fn(async () => {}) },
  app: {
    isPackaged: false,
    getAppPath: () => 'C:\\probe',
    getVersion: () => '3.4.0',
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    params: Record<string, unknown>;
    stderr: EventEmitter;
    close = vi.fn(async () => {});
    constructor(params: Record<string, unknown>) {
      this.params = params;
      this.stderr = new EventEmitter();
      h.transports.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    url: URL;
    opts: Record<string, unknown>;
    close = vi.fn(async () => {});
    finishAuth = vi.fn(async () => {});
    constructor(url: URL, opts?: Record<string, unknown>) {
      this.url = url;
      this.opts = opts ?? {};
      h.httpTransports.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {
    constructor(message = 'unauthorized') {
      super(message);
      this.name = 'UnauthorizedError';
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    info: Record<string, unknown>;
    options: Record<string, unknown>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    connect = vi.fn(async () => {
      // 只抛一次：OAuth 流程在拿到授权码后会重试握手。
      if (h.connectError) {
        const error = h.connectError;
        h.connectError = null;
        throw error;
      }
    });
    listTools = vi.fn(async () => ({ tools: h.nextTools }));
    callTool = vi.fn(async () => ({ ok: true }));
    close = vi.fn(async () => {});
    setNotificationHandler = vi.fn((schema: unknown, handler: () => Promise<void>) => {
      h.listChangedSchema = schema as typeof h.listChangedSchema;
      h.listChangedHandler = handler;
    });
    getServerCapabilities = vi.fn(() => h.serverCapabilities);
    getServerVersion = vi.fn(() => h.serverVersion);
    constructor(info: Record<string, unknown>, options: Record<string, unknown>) {
      this.info = info;
      this.options = options;
      h.clients.push(this as unknown as Record<string, unknown>);
    }
  },
}));

vi.mock('../../credentials', () => ({ resolveCredential: h.resolveCredential }));
vi.mock('../settings-store', () => ({ readSettings: h.readSettings }));
vi.mock('../mcp-tool-cache', () => ({ invalidateMcpToolCache: vi.fn() }));

import {
  registerMcpHandlers,
  getAllMcpTools,
  resolveMcpTransport,
  hostMatchesAllowlist,
  callMcpTool,
} from '../mcp-handlers';
import { invalidateMcpToolCache } from '../mcp-tool-cache';

const lastTransport = () =>
  h.transports.at(-1)! as { params: Record<string, unknown>; close: ReturnType<typeof vi.fn> };
const lastHttpTransport = () =>
  h.httpTransports.at(-1)! as {
    url: URL;
    opts: Record<string, unknown>;
    close: ReturnType<typeof vi.fn>;
    finishAuth: ReturnType<typeof vi.fn>;
  };
const lastClient = () =>
  h.clients.at(-1)! as unknown as {
    connect: ReturnType<typeof vi.fn>;
    listTools: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    info: Record<string, unknown>;
    options: Record<string, unknown>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
  };

const handler = (channel: string) => h.handlers.get(channel)! as any;

const cfg = (overrides: Record<string, unknown> = {}) => ({
  id: 'srv1',
  name: '测试服务器',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server'],
  env: { FOO: 'bar' },
  ...overrides,
});

/** 指定下一次 tools/list 的返回内容（在 connect 之前调用）。 */
function stubTools(tools: unknown[]) {
  h.nextTools = tools;
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.transports.length = 0;
  h.httpTransports.length = 0;
  h.clients.length = 0;
  h.nextTools = [];
  h.connectError = null;
  h.listChangedHandler = null;
  h.listChangedSchema = null;
  h.serverCapabilities = undefined;
  h.serverVersion = undefined;
  h.resolveCredential.mockReset();
  h.resolveCredential.mockResolvedValue(undefined);
  h.readSettings.mockReset();
  h.readSettings.mockResolvedValue({});
  registerMcpHandlers();
  // 清空模块级 connections，避免用例间串扰
  await handler('mcp:setServers')({}, []);
});

describe('mcp — setServers / connect / disconnect', () => {
  it('setServers 增删服务器并返回配置', async () => {
    const set = handler('mcp:setServers');
    const get = handler('mcp:getServers');
    const statuses = handler('mcp:getStatuses');

    await set({}, [cfg(), cfg({ id: 'srv2', name: 'B' })]);
    expect((await get()).data).toHaveLength(2);
    expect((await statuses()).data.every((s: any) => s.connected === false)).toBe(true);

    await set({}, [cfg()]);
    expect((await get()).data.map((c: any) => c.id)).toEqual(['srv1']);
  });

  it('connect 通过官方 SDK 客户端完成握手与工具发现', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [cfg()]);
    stubTools([{ name: 'ping', description: 'd', inputSchema: { type: 'object' } }]);

    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ serverId: 'srv1', connected: true, toolCount: 1 });
    expect(invalidateMcpToolCache).toHaveBeenCalled();
    const client = lastClient();

    // transport 按配置创建：命令/参数/环境/stderr 管道
    expect(lastTransport().params).toMatchObject({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server'],
      stderr: 'pipe',
      env: expect.objectContaining({ FOO: 'bar' }),
    });
    // 客户端标识与能力声明
    expect(client.info).toMatchObject({ name: 'Auraxis' });
    expect(client.options).toMatchObject({ capabilities: {} });
    // 首次握手使用放宽后的超时
    expect(client.connect).toHaveBeenCalledWith(expect.anything(), { timeout: 180_000 });

    const list = handler('mcp:listTools');
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
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [cfg()]);
    h.connectError = new Error('bad handshake');

    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad handshake');
    expect((await handler('mcp:getStatuses')({})).data[0].connected).toBe(false);
  });

  it('配置校验：空命令/路径/未授权命令/非法 args/env', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ command: '' }, 'MCP 命令不能为空'],
      [{ command: 'C:/tools/npx' }, '不能包含路径'],
      [{ command: 'curl' }, '不支持的 MCP 命令'],
      [{ command: 'npx', args: 'bad' }, 'args 必须是字符串数组'],
      [{ command: 'npx', env: 'bad' }, 'env 必须是键值对对象'],
      [{ command: 'node', args: ['--eval', '1'] }, '代码执行/交互参数'],
      [{ command: 'python', args: ['-c', '1'] }, '代码执行/交互参数'],
      [{ name: 'Generic MCP', useAuraxisDeepSeekKey: true }, '仅 DeepSeek Harness'],
    ];
    for (const [over, msg] of cases) {
      const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await set({}, [cfg({ id, command: over.command ?? 'npx', ...over })]);
      const r = await connect({}, id);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(msg);
    }
    expect(h.transports).toHaveLength(0);
  });

  it('DeepSeek Harness 预设会注入 Auraxis 已保存的 Key', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    h.resolveCredential.mockResolvedValue({ value: 'sk-auraxis-test' });
    await set({}, [
      cfg({ name: 'DeepSeek Harness MCP', args: ['-y', 'deepseek-harness-mcp'], useAuraxisDeepSeekKey: true }),
    ]);
    stubTools([]);

    await connect({}, 'srv1');
    expect(lastTransport().params.env).toMatchObject({ DEEPSEEK_API_KEY: 'sk-auraxis-test' });
  });

  it('飞书/Lark MCP 预设会注入加密设置中的 App 凭据', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    h.readSettings.mockResolvedValue({
      larkAppId: 'cli-test',
      larkAppSecret: 'secret-test',
      larkDomain: 'https://open.larksuite.com',
      larkTools: 'preset.im.default',
    });
    await set({}, [cfg({ useAuraxisLarkCredentials: true })]);
    stubTools([]);

    await connect({}, 'srv1');
    expect(lastTransport().params.env).toMatchObject({
      APP_ID: 'cli-test',
      APP_SECRET: 'secret-test',
      LARK_DOMAIN: 'https://open.larksuite.com',
      LARK_TOOLS: 'preset.im.default',
      LARK_TOKEN_MODE: 'tenant_access_token',
    });
  });

  it('飞书/Lark 凭据缺失时直接返回可读错误而不是启动进程', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    h.readSettings.mockResolvedValue({});
    await set({}, [cfg({ useAuraxisLarkCredentials: true })]);

    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('飞书/Lark 未配置');
    expect(h.transports).toHaveLength(0);
  });

  it('Windows 下 DeepSeek Harness 会注入 npx.cmd 兼容 preload', async () => {
    if (process.platform !== 'win32') return;
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [cfg({ name: 'DeepSeek Harness MCP', args: ['-y', 'deepseek-harness-mcp'] })]);
    stubTools([]);

    await connect({}, 'srv1');
    expect(String((lastTransport().params.env as Record<string, string>).NODE_OPTIONS)).toContain(
      'auraxis-mcp-preload.cjs',
    );
  });

  it('disconnect 关闭 SDK 客户端并清空工具', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const disconnect = handler('mcp:disconnect');
    await set({}, [cfg()]);
    stubTools([{ name: 'ping', description: '', inputSchema: {} }]);
    await connect({}, 'srv1');
    const client = lastClient();
    expect(getAllMcpTools()).toHaveLength(1);

    const r = await disconnect({}, 'srv1');
    expect(r).toEqual({ ok: true, data: { serverId: 'srv1', connected: false, toolCount: 0 } });
    expect(client.close).toHaveBeenCalled();
    expect(getAllMcpTools()).toHaveLength(0);
  });

  it('子进程退出（client.onclose）后工具来源立即失效', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [cfg()]);
    stubTools([{ name: 'ping', description: '', inputSchema: {} }]);
    await connect({}, 'srv1');
    const client = lastClient();
    expect(getAllMcpTools()).toHaveLength(1);

    client.onclose?.();
    expect(getAllMcpTools()).toHaveLength(0);
    expect((await handler('mcp:getStatuses')({})).data[0]).toMatchObject({ connected: false, toolCount: 0 });
  });
});

describe('mcp — callTool / IPC 校验', () => {
  it('callTool 命中工具并透传结果，未命中抛错', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const call = handler('mcp:callTool');
    await set({}, [cfg()]);
    stubTools([{ name: 'ping', description: '', inputSchema: {} }]);
    await connect({}, 'srv1');
    const client = lastClient();
    client.callTool.mockResolvedValue({ ok: true });

    expect(await call({}, 'srv1', 'ping', { x: 1 })).toEqual({ ok: true, data: { ok: true } });
    expect(client.callTool).toHaveBeenCalledWith({ name: 'ping', arguments: { x: 1 } }, undefined, {
      timeout: 30_000,
    });

    const miss = await call({}, 'srv1', 'nope', {});
    expect(miss).toEqual({ ok: false, error: 'MCP 工具未找到: nope' });
  });

  // 取消传播回归：宿主（agent 工具管线）传下来的 abortSignal 必须进入 SDK 的
  // 请求选项 —— 只有 SDK 拿到它，用户点停止时才会立刻拒绝在途请求并上发
  // notifications/cancelled，否则长跑 MCP 工具只能干等 30s 超时。
  it('callMcpTool 把 abortSignal 透传进 SDK 请求选项', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [cfg()]);
    stubTools([{ name: 'ping', description: '', inputSchema: {} }]);
    await connect({}, 'srv1');
    const client = lastClient();
    client.callTool.mockResolvedValue({ ok: true });

    const ac = new AbortController();
    await callMcpTool('srv1', 'ping', { x: 1 }, ac.signal);
    expect(client.callTool).toHaveBeenCalledWith({ name: 'ping', arguments: { x: 1 } }, undefined, {
      timeout: 30_000,
      signal: ac.signal,
    });

    // 无信号时不得凭空多造一个 signal 键（renderer 一次性 IPC 路径保持原状）。
    client.callTool.mockClear();
    await callMcpTool('srv1', 'ping', { x: 1 });
    expect(client.callTool).toHaveBeenCalledWith({ name: 'ping', arguments: { x: 1 } }, undefined, {
      timeout: 30_000,
    });
  });

  it('callTool 参数断言', async () => {
    const call = handler('mcp:callTool');
    expect(await call({}, 123, 't', {})).toEqual({ ok: false, error: expect.stringContaining('serverId') });
    expect(await call({}, 's', 456, {})).toEqual({ ok: false, error: expect.stringContaining('toolName') });
  });

  it('listTools 服务器不存在', async () => {
    expect(await handler('mcp:listTools')({}, 'missing')).toEqual({ ok: false, error: '服务器未找到' });
  });

  it('connect 服务器不存在', async () => {
    expect((await handler('mcp:connect')({}, 'missing')).ok).toBe(false);
  });
});

describe('mcp — 服务端能力协商与消费', () => {
  it('连接后记录服务端实现与能力，并在 getStatuses 中暴露', async () => {
    h.serverVersion = { name: 'test-server', version: '1.2.3' };
    h.serverCapabilities = { tools: { listChanged: true }, extensions: { 'io.example/foo': {} } };
    await handler('mcp:setServers')({}, [cfg()]);
    stubTools([{ name: 'ping', description: '', inputSchema: {} }]);
    await handler('mcp:connect')({}, 'srv1');

    const statuses = (await handler('mcp:getStatuses')({})).data as Array<Record<string, unknown>>;
    expect(statuses[0]).toMatchObject({
      serverId: 'srv1',
      connected: true,
      toolCount: 1,
      serverName: 'test-server',
      serverVersion: '1.2.3',
      supportsTools: true,
      toolListChanged: true,
      // 扩展只如实透出协商结果，仓库不实现任何扩展。
      extensions: ['io.example/foo'],
    });
  });

  it('服务端未声明 tools 能力时不谎报 supportsTools', async () => {
    h.serverCapabilities = {};
    await handler('mcp:setServers')({}, [cfg()]);
    stubTools([]);
    await handler('mcp:connect')({}, 'srv1');

    const statuses = (await handler('mcp:getStatuses')({})).data as Array<Record<string, unknown>>;
    expect(statuses[0].supportsTools).toBe(false);
    expect(statuses[0].toolListChanged).toBeUndefined();
    expect(statuses[0].extensions).toBeUndefined();
  });

  it('订阅的是 tools/list_changed 通知', async () => {
    await handler('mcp:setServers')({}, [cfg()]);
    stubTools([]);
    await handler('mcp:connect')({}, 'srv1');

    expect(h.listChangedSchema?.shape?.method?.value).toBe('notifications/tools/list_changed');
    expect(h.listChangedHandler).toBeTypeOf('function');
  });

  it('收到 list_changed 后刷新工具列表并失效注册表缓存', async () => {
    await handler('mcp:setServers')({}, [cfg()]);
    stubTools([{ name: 'a', description: '', inputSchema: {} }]);
    await handler('mcp:connect')({}, 'srv1');
    expect(getAllMcpTools().map((t) => t.name)).toEqual(['a']);

    vi.mocked(invalidateMcpToolCache).mockClear();
    stubTools([
      { name: 'a', description: '', inputSchema: {} },
      { name: 'b', description: '', inputSchema: {} },
    ]);
    await h.listChangedHandler!();

    expect(getAllMcpTools().map((t) => t.name)).toEqual(['a', 'b']);
    expect(invalidateMcpToolCache).toHaveBeenCalled();
  });

  it('断开后清空能力信息，且迟到的 list_changed 不再把工具加回来', async () => {
    h.serverCapabilities = { tools: { listChanged: true } };
    h.serverVersion = { name: 's', version: '1' };
    await handler('mcp:setServers')({}, [cfg()]);
    stubTools([{ name: 'a', description: '', inputSchema: {} }]);
    await handler('mcp:connect')({}, 'srv1');

    await handler('mcp:disconnect')({}, 'srv1');
    const statuses = (await handler('mcp:getStatuses')({})).data as Array<Record<string, unknown>>;
    expect(statuses[0].serverName).toBeUndefined();
    expect(statuses[0].supportsTools).toBeUndefined();

    stubTools([{ name: 'zombie', description: '', inputSchema: {} }]);
    await h.listChangedHandler!();
    expect(getAllMcpTools()).toHaveLength(0);
  });
});

describe('mcp — Streamable HTTP 传输', () => {
  const httpCfg = (overrides: Record<string, unknown> = {}) =>
    cfg({ command: '', args: [], url: 'https://mcp.example.com/mcp', ...overrides });

  it('transport 推断：有 url 走 http，显式声明最优先', () => {
    expect(resolveMcpTransport(httpCfg() as never)).toBe('http');
    expect(resolveMcpTransport(cfg() as never)).toBe('stdio');
    expect(resolveMcpTransport(httpCfg({ transport: 'stdio' }) as never)).toBe('stdio');
    expect(resolveMcpTransport(cfg({ transport: 'http' }) as never)).toBe('http');
  });

  it('url 配置走官方 HTTP 传输并透传请求头（不起子进程）', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [httpCfg({ headers: { Authorization: 'Bearer t' } })]);
    stubTools([{ name: 'ping', description: 'd', inputSchema: { type: 'object' } }]);

    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ serverId: 'srv1', connected: true, toolCount: 1 });
    expect(h.transports).toHaveLength(0);
    const transport = lastHttpTransport();
    expect(String(transport.url)).toBe('https://mcp.example.com/mcp');
    expect(transport.opts.requestInit).toEqual({ headers: { Authorization: 'Bearer t' } });
  });

  it('默认只允许 https，本机回环地址例外', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const cases: Array<[string, boolean]> = [
      ['https://mcp.example.com/mcp', true],
      ['http://localhost:3000/mcp', true],
      ['http://127.0.0.1:3000/mcp', true],
      ['http://mcp.example.com/mcp', false],
      ['ftp://mcp.example.com/mcp', false],
      ['not-a-url', false],
      ['', false],
    ];
    for (const [url, ok] of cases) {
      const id = `h-${Math.random().toString(36).slice(2, 8)}`;
      await set({}, [httpCfg({ id, url })]);
      const r = await connect({}, id);
      expect(r.ok, `url=${url}`).toBe(ok);
      if (!ok) expect(r.error, `url=${url}`).toBeTruthy();
    }
  });

  it('禁止在端点 URL 中内嵌凭据', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [httpCfg({ url: 'https://user:pass@mcp.example.com/mcp' })]);
    const r = await connect({}, 'srv1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能内嵌凭据');
    expect(h.httpTransports).toHaveLength(0);
  });

  it('云元数据与链路本地地址一律拒绝（SSRF 防护）', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const urls = [
      'https://169.254.169.254/latest/meta-data',
      'http://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/mcp',
      'https://[fe80::1]/mcp',
    ];
    for (const url of urls) {
      const id = `m-${Math.random().toString(36).slice(2, 8)}`;
      await set({}, [httpCfg({ id, url })]);
      const r = await connect({}, id);
      expect(r.ok, `url=${url}`).toBe(false);
    }
    expect(h.httpTransports).toHaveLength(0);
  });

  it('私网地址默认拒绝，显式放行后才可连接', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [httpCfg({ id: 'lan', url: 'https://192.168.1.10:8443/mcp' })]);

    const denied = await connect({}, 'lan');
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('内网地址');

    process.env.AURAXIS_MCP_ALLOW_PRIVATE_HOSTS = '1';
    try {
      stubTools([]);
      expect((await connect({}, 'lan')).ok).toBe(true);
    } finally {
      delete process.env.AURAXIS_MCP_ALLOW_PRIVATE_HOSTS;
    }
  });

  it('访问令牌来自加密凭据库并注入 Authorization', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    h.resolveCredential.mockResolvedValue({ value: 'tok-123' });
    await set({}, [httpCfg({ id: 'srv1' })]);
    stubTools([]);

    await connect({}, 'srv1');
    expect(h.resolveCredential).toHaveBeenCalledWith('MCP_TOKEN_SRV1');
    const requestInit = lastHttpTransport().opts.requestInit as { headers: Record<string, string> };
    expect(requestInit.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
  });

  it('显式 Authorization 头优先于存储的令牌', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    h.resolveCredential.mockResolvedValue({ value: 'tok-123' });
    await set({}, [httpCfg({ id: 'srv2', headers: { Authorization: 'Custom x' } })]);
    stubTools([]);

    await connect({}, 'srv2');
    const requestInit = lastHttpTransport().opts.requestInit as { headers: Record<string, string> };
    expect(requestInit.headers.Authorization).toBe('Custom x');
  });

  it('出口 allowlist：未列入的主机被拒绝，命中规则后放行', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    const cfgOauth = httpCfg({ id: 'allow', url: 'https://mcp.example.com/mcp' });
    await set({}, [cfgOauth]);

    process.env.AURAXIS_MCP_ALLOWED_HOSTS = 'other.example.org';
    try {
      const denied = await connect({}, 'allow');
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain('AURAXIS_MCP_ALLOWED_HOSTS');
    } finally {
      delete process.env.AURAXIS_MCP_ALLOWED_HOSTS;
    }

    // 后缀规则 .example.com 命中后放行
    process.env.AURAXIS_MCP_ALLOWED_HOSTS = ' .example.com , other.org ';
    try {
      stubTools([]);
      expect((await connect({}, 'allow')).ok).toBe(true);
    } finally {
      delete process.env.AURAXIS_MCP_ALLOWED_HOSTS;
    }
  });

  it('hostMatchesAllowlist 支持精确 / 自身+子域 / 仅子域三种规则', () => {
    expect(hostMatchesAllowlist('mcp.example.com', ['example.com'])).toBe(true);
    expect(hostMatchesAllowlist('example.com', ['example.com'])).toBe(true);
    expect(hostMatchesAllowlist('example.com', ['.example.com'])).toBe(false);
    expect(hostMatchesAllowlist('a.example.com', ['.example.com'])).toBe(true);
    expect(hostMatchesAllowlist('10.0.0.5', ['10.0.0.5'])).toBe(true);
    expect(hostMatchesAllowlist('evil-example.com', ['example.com'])).toBe(false);
    expect(hostMatchesAllowlist('mcp.example.com', ['other.org'])).toBe(false);
  });

  it('OAuth：401 后等回环回调，拿到授权码完成 finishAuth 并重连', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [httpCfg({ id: 'oauth-srv', oauth: true })]);
    stubTools([{ name: 'ping', description: 'd', inputSchema: { type: 'object' } }]);

    h.connectError = Object.assign(new Error('auth required'), { name: 'UnauthorizedError' });

    const pending = connect({}, 'oauth-srv');
    // 等回环服务器建好（transport 创建即代表回调地址已就绪）
    await vi.waitFor(() => expect(h.httpTransports.length).toBe(1));
    const transport = lastHttpTransport();
    const authProvider = transport.opts.authProvider as { redirectUrl: string; clientMetadata: unknown };
    expect(authProvider.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // 模拟浏览器带着授权码跳回回环地址
    await fetch(`${authProvider.redirectUrl}?code=code-42`);

    const r = await pending;
    expect(r.ok).toBe(true);
    expect(transport.finishAuth).toHaveBeenCalledWith('code-42');
  });

  it('OAuth：未启用时不会挂 authProvider', async () => {
    const set = handler('mcp:setServers');
    const connect = handler('mcp:connect');
    await set({}, [httpCfg({ id: 'plain-srv' })]);
    stubTools([]);
    await connect({}, 'plain-srv');
    expect(lastHttpTransport().opts.authProvider).toBeUndefined();
  });
});
