/**
 * @auraxis/sdk — TypeScript client for driving an Auraxis runtime over
 * newline-delimited JSON-RPC 2.0 （SDK 客户端）.
 *
 * The runtime is the Electron main process launched with `--sdk` (headless,
 * no window). Because Electron's main process cannot read piped stdin on
 * Windows, the runtime advertises a loopback TCP port on stdout
 * (`AURAXIS_SDK_PORT=<port>`) and the client connects over TCP.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import crypto from 'crypto';
import { createInterface } from 'readline';
import net from 'net';
import path from 'path';

export interface AuraxisRuntimeOptions {
  /** Electron executable. Defaults to the repo's node_modules/electron. */
  electronPath?: string;
  /** Path to the compiled Electron main script. Defaults to repo dist-electron/main.js. */
  mainJs?: string;
  /** Extra env vars for the runtime process. */
  env?: NodeJS.ProcessEnv;
  /** Optional SDK auth token. Defaults to AURAXIS_SDK_TOKEN or a random one. */
  token?: string;
  /** How long to wait for the runtime to advertise its port. */
  spawnTimeoutMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Receive runtime stderr lines (useful for startup diagnostics). */
  onStderr?: (line: string) => void;
}

export interface RunAgentParams {
  prompt: string;
  description?: string;
  subagentType?: string;
  projectRoot?: string;
}

export interface SearchSessionHit {
  type: 'chat' | 'agent';
  id: string;
  title: string;
  snippet: string;
  ts: number;
  score: number;
}

export interface SearchSessionsResult {
  query: string;
  count: number;
  results: SearchSessionHit[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcError {
  code: number;
  message: string;
}

/** Minimal line-delimited duplex surface shared by socket / stdio transports. */
export interface RpcTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: Error) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

class SocketTransport implements RpcTransport {
  private buffer = '';
  private lineCbs: Array<(line: string) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closeCbs: Array<() => void> = [];

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) for (const cb of [...this.lineCbs]) cb(line);
      }
    });
    socket.on('error', (err) => { for (const cb of [...this.errorCbs]) cb(err); });
    socket.on('close', () => { for (const cb of [...this.closeCbs]) cb(); });
  }

  write(line: string): void {
    this.socket.write(`${line}\n`);
  }

  onLine(cb: (line: string) => void): void { this.lineCbs.push(cb); }
  onError(cb: (err: Error) => void): void { this.errorCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }
  close(): void { this.socket.end(); }
}

class StdioTransport implements RpcTransport {
  private lineCbs: Array<(line: string) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  private closeCbs: Array<() => void> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.trim()) for (const cb of [...this.lineCbs]) cb(line);
    });
    child.on('error', (err) => { for (const cb of [...this.errorCbs]) cb(err); });
    child.on('exit', () => { for (const cb of [...this.closeCbs]) cb(); });
  }

  write(line: string): void { this.child.stdin.write(`${line}\n`); }
  onLine(cb: (line: string) => void): void { this.lineCbs.push(cb); }
  onError(cb: (err: Error) => void): void { this.errorCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }
  close(): void {
    try { this.child.stdin.end(); } catch { /* noop */ }
    try { this.child.kill(); } catch { /* noop */ }
  }
}

function defaultElectronPath(): string {
  const fromEnv = process.env.AURAXIS_ELECTRON;
  if (fromEnv) return fromEnv;
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) return resolved;
  } catch {
    /* not resolvable from this environment */
  }
  return path.resolve(__dirname, '../../../node_modules/electron');
}

function defaultMainJs(): string {
  return process.env.AURAXIS_MAIN_JS || path.resolve(__dirname, '../../../dist-electron/main.js');
}

export class AuraxisClient {
  private readonly pending = new Map<string | number, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly cleanup: (() => void) | undefined;
  private readonly token?: string;

  constructor(
    private readonly transport: RpcTransport,
    requestTimeoutMs = 120_000,
    cleanup?: () => void,
    token?: string,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.cleanup = cleanup;
    this.token = token;

    transport.onLine((line) => {
      let msg: { id?: string | number; result?: unknown; error?: RpcError };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const id = msg.id;
      if (id === undefined) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(`Auraxis RPC error (${msg.error.code}): ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    });
    transport.onError((err) => this.failAll(`Auraxis runtime error: ${err.message}`));
    transport.onClose(() => this.failAll('Auraxis runtime closed'));
  }

  private failAll(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Auraxis client is closed'));
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Auraxis RPC timeout: ${method}`));
      }, effectiveTimeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.transport.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    });
  }

  async ping(): Promise<{ pong: boolean; time: number }> {
    return this.request('ping');
  }

  async runAgent(params: RunAgentParams): Promise<unknown> {
    return this.request('agent.run', this.token ? { ...params, token: this.token } : params);
  }

  async searchSessions(query: string, limit?: number): Promise<SearchSessionsResult> {
    return this.request('session.search', this.token ? { query, limit, token: this.token } : { query, limit });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll('Auraxis client closed');
    try {
      this.transport.close();
    } catch {
      /* already closed */
    }
    try {
      this.cleanup?.();
    } catch {
      /* best-effort */
    }
  }
}

/** Spawn the Auraxis runtime, read its advertised port, and connect. */
export async function createAuraxis(options: AuraxisRuntimeOptions = {}): Promise<AuraxisClient> {
  const electronPath = options.electronPath || defaultElectronPath();
  const mainJs = options.mainJs || defaultMainJs();
  const spawnTimeoutMs = options.spawnTimeoutMs ?? 30_000;
  const runtimeEnv = { ...process.env, ...(options.env || {}) };
  // TCP 服务默认强制鉴权：未配置时客户端生成随机 token 并传给运行时。
  const sdkToken = options.token || runtimeEnv.AURAXIS_SDK_TOKEN || crypto.randomBytes(24).toString('hex');
  runtimeEnv.AURAXIS_SDK_TOKEN = sdkToken;

  const child = spawn(electronPath, [mainJs, '--sdk'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: runtimeEnv,
  });
  if (options.onStderr) {
    child.stderr.on('data', (d: Buffer) => options.onStderr!(d.toString()));
  }

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Auraxis runtime 未在超时内输出 SDK 端口'));
    }, spawnTimeoutMs);
    const onData = (d: Buffer) => {
      const m = /AURAXIS_SDK_PORT=(\d+)/.exec(d.toString());
      if (m) {
        cleanup();
        resolve(Number(m[1]));
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Auraxis runtime exited (code=${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  }).catch((err) => {
    try { child.kill(); } catch { /* noop */ }
    throw err;
  });

  const socket = net.connect(port, '127.0.0.1');
  const transport = new SocketTransport(socket);
  const client = new AuraxisClient(transport, options.requestTimeoutMs ?? 120_000, () => {
    try { child.kill(); } catch { /* noop */ }
  }, sdkToken);

  try {
    await client.request('ping', {}, Math.min(2000, options.requestTimeoutMs ?? 2000));
  } catch (err) {
    await client.close().catch(() => {});
    throw new Error(`无法连接 Auraxis runtime: ${(err as Error).message}`);
  }
  return client;
}
