import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

// executeToolCall 前置门全部放行，聚焦会话检索族本身
vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));
vi.mock('../dynamic-plugin', () => ({
  mountDynamicPlugin: vi.fn(() => ({ ok: true })),
  unmountDynamicPlugin: vi.fn(() => true),
  getDynamicTool: vi.fn(() => undefined),
  executeDynamicTool: vi.fn(async () => ({ output: null })),
}));
vi.mock('../../tool-registry', () => ({
  executeMcpTool: vi.fn(async () => ({ output: 'mcp-result' })),
  addPluginTools: vi.fn(),
}));

// 会话检索依赖
vi.mock('../../fts', () => ({
  sessionQuerySearch: vi.fn(async () => []),
}));
vi.mock('../../spill', () => ({
  readSpill: vi.fn(async () => ({ content: 'spilled', bytes: 7 })),
}));
vi.mock('../../session-log', () => ({
  readAgentLog: vi.fn(async () => []),
  listAgentLogs: vi.fn(async () => []),
  appendAgentLog: vi.fn(async () => {}),
}));
vi.mock('../../chat-log', () => ({
  readChatLog: vi.fn(async () => []),
  listChatSessions: vi.fn(async () => []),
}));

import { executeToolCall } from '../tool-handlers';
import { sessionQuerySearch } from '../../fts';
import { readSpill } from '../../spill';
import { readAgentLog, listAgentLogs } from '../../session-log';
import { readChatLog, listChatSessions } from '../../chat-log';
import { executeMcpTool } from '../../tool-registry';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: os.tmpdir(),
    requestId: 'sess-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

function ev(seq: number, type: string, data: Record<string, unknown> = {}): any {
  return { seq, type, ts: Date.now(), data };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sessionQuerySearch).mockResolvedValue([]);
  vi.mocked(readSpill).mockResolvedValue({ content: 'spilled', bytes: 7 });
  vi.mocked(readAgentLog).mockResolvedValue([]);
  vi.mocked(listAgentLogs).mockResolvedValue([]);
  vi.mocked(readChatLog).mockResolvedValue([]);
  vi.mocked(listChatSessions).mockResolvedValue([]);
});

describe('SessionQuery — 历史会话召回', () => {
  it('空查询拒绝', async () => {
    const r = await executeToolCall('SessionQuery', { query: '  ' }, ctx());
    expect(r.error).toBe('query 不能为空');
  });

  it('映射命中字段并在无结果时带提示', async () => {
    vi.mocked(sessionQuerySearch).mockResolvedValue([
      { type: 'agent', id: 'a1', title: '标题', snippet: '片段', ts: 1, score: 0.9 },
    ]);
    const r = await executeToolCall('SessionQuery', { query: 'foo', limit: 3 }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual({
      query: 'foo',
      count: 1,
      results: [{ type: 'agent', id: 'a1', title: '标题', snippet: '片段', ts: 1, score: 0.9 }],
      note: undefined,
    });
    expect(sessionQuerySearch).toHaveBeenCalledWith('foo', 3);

    vi.mocked(sessionQuerySearch).mockResolvedValue([]);
    const empty = await executeToolCall('SessionQuery', { query: 'bar' }, ctx());
    expect((empty.output as any).note).toBe('没有找到相关历史会话');
  });
});

describe('ReadSpill — 溢写产物读取', () => {
  it('空路径拒绝', async () => {
    expect((await executeToolCall('ReadSpill', {}, ctx())).error).toBe('path 不能为空');
  });

  it('读取成功返回内容与字节数', async () => {
    const r = await executeToolCall('ReadSpill', { path: 'spill/1.json' }, ctx());
    expect(r.output).toEqual({ spill_path: 'spill/1.json', bytes: 7, content: 'spilled' });
  });

  it('读取失败包装错误', async () => {
    vi.mocked(readSpill).mockRejectedValueOnce(new Error('ENOENT'));
    const r = await executeToolCall('ReadSpill', { path: 'x' }, ctx());
    expect(r.error).toContain('读取 spill 失败');
  });
});

describe('SessionEventSearch / Read / Trace', () => {
  it('Search 支持指定会话与全量扫描并限流', async () => {
    vi.mocked(readAgentLog).mockImplementation(async (id: string) =>
      id === 'agent-1'
        ? [ev(1, 'user', { text: 'hello world' }), ev(2, 'tool', { toolName: 'Bash', input: { command: 'ls' } })]
        : [],
    );
    vi.mocked(listAgentLogs).mockResolvedValue([{ id: 'agent-1', title: 'T1' } as any]);

    const r = await executeToolCall('SessionEventSearch', { sessionId: 'agent-1', query: 'ls', limit: 1 }, ctx());
    expect(r.error).toBeUndefined();
    const out = r.output as any;
    expect(out.count).toBe(1);
    expect(out.hits[0]).toMatchObject({ sessionId: 'agent-1', seq: 2, type: 'tool', toolName: 'Bash' });
    expect(out.hits[0].snippet).toContain('Bash');
    expect(readAgentLog).toHaveBeenCalledWith('agent-1');
  });

  it('Search 无 sessionId 时合并 agent/chat 列表', async () => {
    vi.mocked(listAgentLogs).mockResolvedValue([{ id: 'a1', title: 'A' } as any]);
    vi.mocked(listChatSessions).mockResolvedValue([{ id: 'c1', title: 'C' } as any]);
    vi.mocked(readChatLog).mockImplementation(async (id: string) =>
      id === 'c1' ? [ev(1, 'assistant_chunk', { chunk: '匹配词' })] : [],
    );

    const r = await executeToolCall('SessionEventSearch', { query: '匹配' }, ctx());
    expect((r.output as any).hits[0].sessionId).toBe('c1');
    expect(readChatLog).toHaveBeenCalledWith('c1');
  });

  it('Search 空查询拒绝', async () => {
    expect((await executeToolCall('SessionEventSearch', {}, ctx())).error).toBe('query 不能为空');
  });

  it('Read 缺参拒绝与未找到事件', async () => {
    expect((await executeToolCall('SessionEventRead', {}, ctx())).error).toBe('sessionId 和 seq 不能为空');
    const missing = await executeToolCall('SessionEventRead', { sessionId: 's', seq: 99 }, ctx());
    expect(missing.error).toContain('未找到 seq=99');
  });

  it('Read 返回目标事件与前后文窗口', async () => {
    vi.mocked(readAgentLog).mockResolvedValue([
      ev(1, 'user', { text: 'a' }),
      ev(2, 'tool', { toolName: 'Read' }),
      ev(3, 'assistant_chunk', { chunk: 'b' }),
      ev(4, 'system', {}),
    ]);
    const r = await executeToolCall('SessionEventRead', { sessionId: 's', seq: 2, before: 1, after: 1 }, ctx());
    expect(r.error).toBeUndefined();
    expect((r.output as any).event.seq).toBe(2);
    expect((r.output as any).before.map((e: any) => e.seq)).toEqual([1]);
    expect((r.output as any).after.map((e: any) => e.seq)).toEqual([3]);
  });

  it('Read 在 agent 日志为空时回退 chat 日志', async () => {
    vi.mocked(readAgentLog).mockResolvedValue([]);
    vi.mocked(readChatLog).mockResolvedValue([ev(1, 'user', { text: 'x' })]);
    const r = await executeToolCall('SessionEventRead', { sessionId: 'c', seq: 1 }, ctx());
    expect(r.error).toBeUndefined();
    expect(readChatLog).toHaveBeenCalledWith('c');
  });

  it('Trace 空会话报错，完整会话返回 title/父子/谱系', async () => {
    expect((await executeToolCall('SessionTrace', {}, ctx())).error).toBe('sessionId 不能为空');
    expect((await executeToolCall('SessionTrace', { sessionId: 'nope' }, ctx())).error).toContain('不存在或为空');

    vi.mocked(readAgentLog).mockResolvedValue([
      ev(1, 'user', { text: '任务' }),
      ev(2, 'tool', { toolCallId: 'tc1', toolName: 'Bash' }),
      ev(3, 'tool', { toolCallId: 'tc1', toolName: 'Bash' }),
      ev(4, 'assistant_chunk', { chunk: 'done' }),
    ]);
    vi.mocked(listAgentLogs).mockResolvedValue([
      { id: 'parent', title: 'P', kind: 'agent', messageCount: 3, branchedFrom: undefined } as any,
      { id: 'main', title: 'M', kind: 'agent', messageCount: 4, branchedFrom: { sessionId: 'parent' } } as any,
      { id: 'child', title: 'C', kind: 'agent', messageCount: 1, branchedFrom: { sessionId: 'main' } } as any,
    ]);
    vi.mocked(listChatSessions).mockResolvedValue([]);

    const r = await executeToolCall('SessionTrace', { sessionId: 'main' }, ctx());
    expect(r.error).toBeUndefined();
    const out = r.output as any;
    expect(out.title).toBe('M');
    expect(out.parent).toEqual({ sessionId: 'parent', title: 'P' });
    expect(out.children).toEqual([{ sessionId: 'child', title: 'C' }]);
    expect(out.lineage.turns).toHaveLength(1);
    expect(out.lineage.toolFamilies).toEqual([{ toolCallId: 'tc1', toolName: 'Bash', events: [2, 3] }]);
    expect(out.events[0].summary).toContain('任务');
  });
});

describe('executeToolCall 路由兜底', () => {
  it('mcp__ 前缀路由到 MCP 桥', async () => {
    const r = await executeToolCall('mcp__echo', { x: 1 }, ctx());
    expect(executeMcpTool).toHaveBeenCalledWith('mcp__echo', { x: 1 }, undefined);
    expect(r.output).toBe('mcp-result');
  });

  // 取消传播回归：MCP 分支的 executor 曾经只声明一个形参，把调用点传入的 ctx
  // 整个丢掉，中止信号因此到不了 client.callTool —— 长跑 MCP 工具只能干等 30s
  // 请求超时，SDK 也无法上发 notifications/cancelled。
  it('把 ctx.abortSignal 透传给 MCP 桥', async () => {
    const ac = new AbortController();
    await executeToolCall('mcp__echo', { x: 1 }, ctx({ abortSignal: ac.signal }));
    expect(executeMcpTool).toHaveBeenCalledWith('mcp__echo', { x: 1 }, ac.signal);
  });

  it('未知工具返回错误', async () => {
    const r = await executeToolCall('NoSuchTool', {}, ctx());
    expect(r.error).toBe('未知工具: NoSuchTool');
  });
});
