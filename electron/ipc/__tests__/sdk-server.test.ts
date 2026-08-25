import { describe, it, expect } from 'vitest';
import { handleSdkRequest, type SdkDeps } from '../../sdk-server';

const deps: SdkDeps = {
  runAgent: async ({ prompt }) => {
    if (prompt.includes('boom')) return { output: null, error: 'agent exploded' };
    return { output: { message: `done: ${prompt}` } };
  },
  searchSessions: async (query, limit = 8) =>
    [{ type: 'chat' as const, id: 's1', title: '旧会话', snippet: query, ts: 1, score: 2 }].slice(0, limit),
};

describe('sdk-server — JSON-RPC over stdio', () => {
  it('answers ping', async () => {
    const res = await handleSdkRequest(deps, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.result).toMatchObject({ pong: true });
    expect(res.id).toBe(1);
  });

  it('runs an agent and returns its output', async () => {
    const res = await handleSdkRequest(deps, {
      jsonrpc: '2.0',
      id: 2,
      method: 'agent.run',
      params: { prompt: '写一个测试' },
    });
    expect(res.result).toEqual({ message: 'done: 写一个测试' });
  });

  it('maps agent errors to code 1', async () => {
    const res = await handleSdkRequest(deps, {
      jsonrpc: '2.0',
      id: 3,
      method: 'agent.run',
      params: { prompt: 'boom' },
    });
    expect(res.error?.code).toBe(1);
    expect(res.error?.message).toContain('agent exploded');
  });

  it('searches sessions', async () => {
    const res = await handleSdkRequest(deps, {
      jsonrpc: '2.0',
      id: 4,
      method: 'session.search',
      params: { query: '登录', limit: 3 },
    });
    expect((res.result as any).count).toBe(1);
    expect((res.result as any).results[0].title).toBe('旧会话');
  });

  it('rejects unknown methods and malformed requests', async () => {
    const unknown = await handleSdkRequest(deps, { jsonrpc: '2.0', id: 5, method: 'nope' });
    expect(unknown.error?.code).toBe(-32601);
    const invalid = await handleSdkRequest(deps, { method: 'ping' });
    expect(invalid.error?.code).toBe(-32600);
  });

  it('requires a matching token when AURAXIS_SDK_TOKEN is set', async () => {
    const prev = process.env.AURAXIS_SDK_TOKEN;
    process.env.AURAXIS_SDK_TOKEN = 'sdk-secret';
    try {
      const denied = await handleSdkRequest(deps, {
        jsonrpc: '2.0',
        id: 6,
        method: 'agent.run',
        params: { prompt: '写一个测试' },
      });
      expect(denied.error?.code).toBe(-32603);

      const ok = await handleSdkRequest(deps, {
        jsonrpc: '2.0',
        id: 7,
        method: 'agent.run',
        params: { prompt: '写一个测试', token: 'sdk-secret' },
      });
      expect(ok.error).toBeUndefined();
      expect((ok.result as any).message).toContain('写一个测试');
    } finally {
      if (prev === undefined) delete process.env.AURAXIS_SDK_TOKEN;
      else process.env.AURAXIS_SDK_TOKEN = prev;
    }
  });
});
