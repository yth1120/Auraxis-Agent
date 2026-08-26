import net from 'net';
import { describe, it, expect } from 'vitest';
import { handleSdkRequest, startSdkTcpServer, type SdkDeps } from '../../sdk-server';

const deps: SdkDeps = {
  runAgent: async ({ prompt }) => {
    if (prompt.includes('boom')) return { output: null, error: 'agent exploded' };
    return { output: { message: `done: ${prompt}` } };
  },
  searchSessions: async (query, limit = 8) =>
    [{ type: 'chat' as const, id: 's1', title: '旧会话', snippet: query, ts: 1, score: 2 }].slice(0, limit),
};

function sendLine(socket: net.Socket, payload: string | unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SDK TCP response timeout')), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      cleanup();
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.write(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
  });
}

async function withTcpServer(run: (socket: net.Socket, token: string) => Promise<void>): Promise<void> {
  const server = await startSdkTcpServer(deps, 0);
  const socket = net.createConnection({ host: '127.0.0.1', port: server.port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  try {
    await run(socket, server.token);
  } finally {
    socket.destroy();
    server.close();
  }
}

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

describe('sdk-server — JSON-RPC over TCP', () => {
  it('answers ping over the loopback transport', async () => {
    await withTcpServer(async (socket) => {
      const res = await sendLine(socket, { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(res.result).toMatchObject({ pong: true });
      expect(res.id).toBe(1);
    });
  });

  it('enforces token auth and accepts the matching token', async () => {
    await withTcpServer(async (socket, token) => {
      const denied = await sendLine(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'agent.run',
        params: { prompt: '测试' },
      });
      expect((denied.error as { code?: number }).code).toBe(-32603);

      const ok = await sendLine(socket, {
        jsonrpc: '2.0',
        id: 3,
        method: 'agent.run',
        params: { prompt: '测试', token },
      });
      expect((ok.result as { message?: string }).message).toContain('测试');
    });
  });

  it('rejects malformed JSON, oversized requests and missing params', async () => {
    await withTcpServer(async (socket, token) => {
      const parseError = await sendLine(socket, '{bad');
      expect((parseError.error as { code?: number }).code).toBe(-32700);

      const tooLarge = await sendLine(socket, 'x'.repeat(1024 * 1024 + 1));
      expect((tooLarge.error as { code?: number }).code).toBe(-32600);

      const missingPrompt = await sendLine(socket, {
        jsonrpc: '2.0',
        id: 4,
        method: 'agent.run',
        params: { token },
      });
      expect((missingPrompt.error as { code?: number }).code).toBe(-32602);
    });
  });
});
