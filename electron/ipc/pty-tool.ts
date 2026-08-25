/**
 * pty-tool.ts — model-facing persistent PTY sessions （持久 PTY 会话）.
 *
 * Unlike one-shot Bash calls, a PTY session keeps shell state across tool
 * calls: interactive programs, environment, and stdin/stdout streams. Each
 * session is owner-scoped (agent task or chat) and cleaned up on close.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { safeProcessEnv } from '../safe-env';

export interface PtySessionLike {
  write(data: string): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  offData?(cb: (data: string) => void): void;
  offExit?(cb: () => void): void;
}

export type PtyFactory = (opts: {
  command: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}) => PtySessionLike | null;

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

/** node-pty when available; pipe-based child process otherwise. */
export const defaultPtyFactory: PtyFactory = (opts) => {
  let PTY: any = null;
  try { PTY = require('node-pty'); } catch { PTY = null; }
  if (PTY) {
    const pty = PTY.spawn(opts.command, [], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd || process.cwd(),
      env: { ...safeProcessEnv({ TERM: 'xterm-256color' }) },
    });
    const dataListeners = new Set<(d: string) => void>();
    const exitListeners = new Set<() => void>();
    pty.onData((d: string) => { for (const l of dataListeners) l(d); });
    pty.onExit(() => { for (const l of exitListeners) l(); });
    return {
      write: (d) => pty.write(d),
      kill: () => { try { pty.kill(); } catch { /* gone */ } },
      onData: (cb) => { dataListeners.add(cb); },
      onExit: (cb) => { exitListeners.add(cb); },
      offData: (cb) => { dataListeners.delete(cb); },
      offExit: (cb) => { exitListeners.delete(cb); },
    };
  }

  const child: ChildProcessWithoutNullStreams = spawn(opts.command, [], {
    cwd: opts.cwd || process.cwd(),
    env: { ...safeProcessEnv({ TERM: 'xterm-256color' }) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const emitter = new EventEmitter();
  child.stdout?.on('data', (d: Buffer) => emitter.emit('data', d.toString()));
  child.stderr?.on('data', (d: Buffer) => emitter.emit('data', d.toString()));
  child.on('exit', () => emitter.emit('exit'));
  return {
    write: (d) => { try { child.stdin?.write(d); } catch { /* closed */ } },
    kill: () => { try { child.kill(); } catch { /* gone */ } },
    onData: (cb) => emitter.on('data', cb),
    onExit: (cb) => emitter.on('exit', cb),
    offData: (cb) => emitter.off('data', cb),
    offExit: (cb) => emitter.off('exit', cb),
  };
};

interface InternalSession {
  backend: PtySessionLike;
  id: string;
  owner: string;
  command: string;
  createdAt: number;
  buffer: string;
  lastRead: number;
  exited: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PtyRegistry {
  private sessions = new Map<string, InternalSession>();

  constructor(private factory: PtyFactory = defaultPtyFactory) {}

  create(opts: {
    owner: string;
    id?: string;
    command?: string;
    cwd?: string;
  }): { id: string; command: string } {
    const command = opts.command?.trim() || defaultShell();
    const backend = this.factory({ command, cwd: opts.cwd });
    if (!backend) throw new Error('PTY 不可用（无法启动终端进程）');
    const id = opts.id || `pty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const session: InternalSession = {
      backend,
      id,
      owner: opts.owner,
      command,
      createdAt: Date.now(),
      buffer: '',
      lastRead: 0,
      exited: false,
    };
    backend.onData((d) => { session.buffer += d; });
    backend.onExit(() => {
      session.exited = true;
      this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    return { id, command };
  }

  private get(id: string, owner: string): InternalSession | null {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) return null;
    return s;
  }

  /** Snapshot current scrollback for a read-only UI mirror. */
  peek(id: string, owner: string): { buffer: string; exited: boolean } | null {
    const s = this.get(id, owner);
    if (!s) return null;
    return { buffer: s.buffer, exited: s.exited };
  }

  /** Subscribe to live output + exit for a read-only UI mirror. */
  subscribe(
    id: string,
    owner: string,
    onData: (data: string) => void,
    onExit?: () => void,
  ): (() => void) | null {
    const s = this.get(id, owner);
    if (!s) return null;
    s.backend.onData(onData);
    if (onExit) s.backend.onExit(onExit);
    return () => {
      s.backend.offData?.(onData);
      if (onExit) s.backend.offExit?.(onExit);
    };
  }

  write(id: string, owner: string, data: string, enter: boolean): boolean {
    const s = this.get(id, owner);
    if (!s) return false;
    s.backend.write(data + (enter ? '\r' : ''));
    return true;
  }

  async read(id: string, owner: string, timeoutMs: number): Promise<{ output: string } | null> {
    const s = this.get(id, owner);
    if (!s) return null;
    const deadline = Date.now() + Math.max(0, Math.min(timeoutMs, 30_000));
    while (s.buffer.length === s.lastRead && !s.exited && Date.now() < deadline) {
      await sleep(50);
    }
    const output = s.buffer.slice(s.lastRead);
    s.lastRead = s.buffer.length;
    return { output };
  }

  close(id: string, owner: string): boolean {
    const s = this.get(id, owner);
    if (!s) return false;
    s.backend.kill();
    this.sessions.delete(id);
    return true;
  }

  list(owner: string): { id: string; command: string; createdAt: number }[] {
    return [...this.sessions.values()]
      .filter((s) => s.owner === owner)
      .map((s) => ({ id: s.id, command: s.command, createdAt: s.createdAt }));
  }

  clearOwner(owner: string): number {
    let n = 0;
    for (const s of [...this.sessions.values()]) {
      if (s.owner === owner) {
        s.backend.kill();
        this.sessions.delete(s.id);
        n++;
      }
    }
    return n;
  }
}

export const ptyRegistry = new PtyRegistry();

export interface PtyToolResult {
  output: unknown;
  error?: string;
}

/** Route a `Pty` tool call (actions: create / write / read / close / list / clear). */
export async function runPtyTool(
  action: string,
  input: Record<string, unknown>,
  owner: string,
  registry: PtyRegistry = ptyRegistry,
): Promise<PtyToolResult> {
  switch (action) {
    case 'create': {
      try {
        const created = registry.create({
          owner,
          id: typeof input.session_id === 'string' ? input.session_id : undefined,
          command: typeof input.command === 'string' ? input.command : undefined,
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        });
        return { output: { session_id: created.id, command: created.command } };
      } catch (e: any) {
        return { output: null, error: e?.message || '创建 PTY 失败' };
      }
    }
    case 'write': {
      const id = String(input.session_id ?? '');
      const data = String(input.data ?? '');
      if (!id || !data) return { output: null, error: 'session_id 与 data 必填' };
      const ok = registry.write(id, owner, data, input.enter === true);
      return ok ? { output: { ok: true } } : { output: null, error: 'PTY 会话不存在或不属于当前任务' };
    }
    case 'read': {
      const id = String(input.session_id ?? '');
      if (!id) return { output: null, error: 'session_id 必填' };
      const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : 2000;
      const result = await registry.read(id, owner, timeoutMs);
      if (!result) return { output: null, error: 'PTY 会话不存在或不属于当前任务' };
      return { output: { output: result.output } };
    }
    case 'close': {
      const id = String(input.session_id ?? '');
      if (!id) return { output: null, error: 'session_id 必填' };
      const ok = registry.close(id, owner);
      return ok ? { output: { ok: true } } : { output: null, error: 'PTY 会话不存在或不属于当前任务' };
    }
    case 'list':
      return { output: { sessions: registry.list(owner) } };
    case 'clear':
      return { output: { closed: registry.clearOwner(owner) } };
    default:
      return { output: null, error: `未知 PTY 动作: ${action}（支持 create/write/read/close/list/clear）` };
  }
}
