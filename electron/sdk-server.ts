/**
 * sdk-server.ts — out-of-process JSON-RPC server for driving Auraxis
 * headlessly （SDK 服务端）. Newline-delimited JSON-RPC 2.0 over a
 * loopback TCP socket; launch the app with --sdk or AURAXIS_SDK=1 and read
 * the advertised port from stdout (`AURAXIS_SDK_PORT=<port>`).
 *
 * TCP is used instead of stdio because Electron's main process does not
 * receive piped stdin on Windows, which makes a stdio transport unreliable
 * across platforms.
 */
import { createInterface } from 'readline';
import net from 'net';
import crypto from 'crypto';
import type { FtsHit } from './fts';
import { errorRecord, errorText } from './errors';

export interface SdkDeps {
  runAgent: (params: {
    prompt: string;
    description?: string;
    subagentType?: string;
    projectRoot?: string;
  }) => Promise<{ output: unknown; error?: string }>;
  searchSessions: (query: string, limit?: number) => Promise<FtsHit[]>;
}

export interface SdkRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export interface SdkResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

class SdkError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleSdkRequest(
  deps: SdkDeps,
  raw: unknown,
  opts: { token?: string } = {},
): Promise<SdkResponse> {
  const req = raw as SdkRequest;
  if (!req || req.jsonrpc !== '2.0' || req.id === undefined) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  // TCP 服务默认生成随机 token 并强制鉴权；stdio 模式仍可由父进程管控。
  const expectedToken = opts.token ?? process.env.AURAXIS_SDK_TOKEN;
  const authorize = (params: any): boolean => {
    if (!expectedToken) return true;
    const got = typeof params?.token === 'string' ? params.token : '';
    const a = Buffer.from(got);
    const b = Buffer.from(expectedToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  try {
    switch (req.method) {
      case 'ping':
        return { jsonrpc: '2.0', id: req.id, result: { pong: true, time: Date.now() } };

      case 'agent.run': {
        const p = req.params ?? {};
        if (!authorize(p)) throw new SdkError(-32603, '未授权：缺少或错误的 SDK token');
        if (typeof p.prompt !== 'string' || !p.prompt.trim()) {
          throw new SdkError(-32602, 'prompt 必填');
        }
        const res = await deps.runAgent({
          prompt: p.prompt,
          description: typeof p.description === 'string' ? p.description : undefined,
          subagentType: typeof p.subagentType === 'string' ? p.subagentType : undefined,
          projectRoot: typeof p.projectRoot === 'string' ? p.projectRoot : undefined,
        });
        if (res.error) throw new SdkError(1, res.error);
        return { jsonrpc: '2.0', id: req.id, result: res.output };
      }

      case 'session.search': {
        const p = req.params ?? {};
        if (!authorize(p)) throw new SdkError(-32603, '未授权：缺少或错误的 SDK token');
        if (typeof p.query !== 'string' || !p.query.trim()) {
          throw new SdkError(-32602, 'query 必填');
        }
        const hits = await deps.searchSessions(p.query, typeof p.limit === 'number' ? p.limit : 8);
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: { query: p.query, count: hits.length, results: hits },
        };
      }

      default:
        throw new SdkError(-32601, `未知方法: ${req.method}`);
    }
  } catch (e: unknown) {
    const apiError = errorRecord(e);
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: { code: typeof apiError.code === 'number' ? apiError.code : -32603, message: errorText(e) },
    };
  }
}

export function startSdkServer(deps: SdkDeps): () => void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (res: SdkResponse) => {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void handleSdkRequest(deps, req).then(write);
  });
  return () => rl.close();
}

/** Start the JSON-RPC server on a loopback TCP port (0 = auto-assign). */
export function startSdkTcpServer(
  deps: SdkDeps,
  port = 0,
): Promise<{ port: number; token: string; close: () => void }> {
  const MAX_LINE_BYTES = 1024 * 1024;
  // 未显式配置 AURAXIS_SDK_TOKEN 时生成一次性随机 token，并要求客户端携带。
  const token = process.env.AURAXIS_SDK_TOKEN || crypto.randomBytes(24).toString('hex');
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_LINE_BYTES) {
          socket.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求过大（超过 1MB）' } })}\n`,
          );
          continue;
        }
        let req: unknown;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
          );
          continue;
        }
        void handleSdkRequest(deps, req, { token }).then((res) => socket.write(`${JSON.stringify(res)}\n`));
      }
      if (buffer.length > MAX_LINE_BYTES) buffer = '';
    });
    socket.on('error', () => {
      /* client disconnected */
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        token,
        close: () => server.close(),
      });
    });
  });
}
