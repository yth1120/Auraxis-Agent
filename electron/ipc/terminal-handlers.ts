/**
 * terminal-handlers.ts — real integrated terminal (node-pty, pipe fallback).
 */
import { errorText } from '../errors';
import { BrowserWindow } from 'electron';
import { secureHandle } from './trust';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { IPty } from 'node-pty';
import { safeProcessEnv } from '../safe-env';
import { ptyRegistry } from './pty-tool';

type PtyModule = { spawn: typeof import('node-pty').spawn };

let PTY: PtyModule | null = null;
try {
  PTY = require('node-pty');
} catch {
  PTY = null;
}

/** 测试注入：单元测试用可控的假 PTY 替换 node-pty，避免依赖真实系统 shell。 */
export function setPtyModuleForTests(ptyModule: unknown): void {
  PTY = ptyModule as PtyModule | null;
}

interface TerminalSession {
  kind: 'pty' | 'pipe';
  proc?: IPty;
  child?: ChildProcessWithoutNullStreams;
  win: BrowserWindow;
}

const sessions = new Map<string, TerminalSession>();
const agentShellWatchers = new Map<string, { win: BrowserWindow; unsub: () => void }>();

function agentSessionId(agentId: string): string {
  return `bash-${agentId}`;
}

function sendToWin(win: BrowserWindow, channel: string, data?: unknown) {
  if (!win.isDestroyed()) {
    try {
      win.webContents.send(channel, data);
    } catch {
      /* closed */
    }
  }
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function send(win: BrowserWindow, id: string, type: string, data?: unknown) {
  if (!win.isDestroyed()) {
    try {
      win.webContents.send(`terminal:event:${id}`, { type, data });
    } catch {
      /* closed */
    }
  }
}

export function registerTerminalHandlers() {
  secureHandle('terminal:create', (event, payload: { id?: string; cwd?: string; cols?: number; rows?: number }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return { ok: false, error: '窗口无效' };
      const id = payload?.id;
      if (!id || typeof id !== 'string') return { ok: false, error: '终端 ID 无效' };
      if (sessions.has(id)) return { ok: false, error: '终端已存在' };
      const cwd = payload.cwd || process.cwd();
      const cols = payload.cols || 80;
      const rows = payload.rows || 24;

      if (PTY) {
        const pty = PTY.spawn(defaultShell(), [], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...safeProcessEnv({ TERM: 'xterm-256color' }) },
        });
        const session: TerminalSession = { kind: 'pty', proc: pty, win };
        sessions.set(id, session);
        pty.onData((d: string) => send(win, id, 'data', d));
        pty.onExit(({ exitCode }: { exitCode: number }) => {
          // A stale session must never tear down its successor: after a fast
          // close/reopen (or React StrictMode's double-mount) the same id can
          // already belong to a new PTY by the time this late callback fires.
          if (sessions.get(id) === session) {
            sessions.delete(id);
            send(win, id, 'exit', { exitCode });
          }
        });
      } else {
        const child = spawn(defaultShell(), [], {
          cwd,
          env: { ...safeProcessEnv({ TERM: 'xterm-256color' }) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Typing into an already-exited fallback shell raises EPIPE
        // asynchronously; without a listener it would crash the main process.
        child.stdin.on('error', () => {});
        const session: TerminalSession = { kind: 'pipe', child, win };
        sessions.set(id, session);
        child.stdout.on('data', (d: Buffer) => send(win, id, 'data', d.toString()));
        child.stderr.on('data', (d: Buffer) => send(win, id, 'data', d.toString()));
        child.on('exit', (code) => {
          if (sessions.get(id) === session) {
            sessions.delete(id);
            send(win, id, 'exit', { exitCode: code });
          }
        });
        child.on('error', (err) => {
          if (sessions.get(id) === session) {
            sessions.delete(id);
            send(win, id, 'exit', { exitCode: -1, error: String(err) });
          }
        });
      }
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('terminal:input', (_e, id: string, data: string) => {
    const s = sessions.get(id);
    if (!s) return { ok: false };
    if (s.kind === 'pty') s.proc?.write(data);
    else s.child!.stdin.write(data);
    return { ok: true };
  });

  secureHandle('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    const s = sessions.get(id);
    if (s?.kind === 'pty') s.proc?.resize(cols, rows);
    return { ok: true };
  });

  secureHandle('terminal:kill', (_e, id: string) => {
    const s = sessions.get(id);
    if (!s) return { ok: false };
    try {
      if (s.kind === 'pty') s.proc?.kill();
      else s.child!.kill();
    } catch {
      /* best-effort */
    }
    sessions.delete(id);
    return { ok: true };
  });
}

/** Read-only mirror of an agent's persistent shell for the terminal drawer. */
export function registerAgentShellHandlers() {
  secureHandle('agentShell:attach', (event, agentId: string) => {
    if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'agentId 无效' };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: '窗口无效' };
    const sessionId = agentSessionId(agentId);
    const peek = ptyRegistry.peek(sessionId, agentId);
    if (!peek) return { ok: false, error: '该任务还没有持久 shell 会话' };

    const existing = agentShellWatchers.get(agentId);
    if (existing && !existing.win.isDestroyed() && existing.win.id === win.id) {
      return { ok: true, buffer: peek.buffer, exited: peek.exited };
    }

    const unsub = ptyRegistry.subscribe(
      sessionId,
      agentId,
      (data) => {
        const watcher = agentShellWatchers.get(agentId);
        if (watcher) sendToWin(watcher.win, `agentShell:data:${agentId}`, data);
      },
      () => {
        const watcher = agentShellWatchers.get(agentId);
        if (watcher) sendToWin(watcher.win, `agentShell:exit:${agentId}`, {});
        agentShellWatchers.delete(agentId);
      },
    );
    if (!unsub) return { ok: false, error: '无法订阅会话' };
    agentShellWatchers.set(agentId, { win, unsub });
    return { ok: true, buffer: peek.buffer, exited: peek.exited };
  });

  secureHandle('agentShell:detach', (_e, agentId: string) => {
    const watcher = agentShellWatchers.get(agentId);
    if (watcher) {
      watcher.unsub();
      agentShellWatchers.delete(agentId);
    }
    return { ok: true };
  });

  // Read-only mirror still allows control characters (Ctrl-C / Ctrl-Z / Ctrl-D),
  // so the user can interrupt a runaway command without typing into the shell.
  secureHandle('agentShell:write', (_e, agentId: string, data: string) => {
    if (typeof agentId !== 'string' || typeof data !== 'string') {
      return { ok: false, error: '参数无效' };
    }
    if (!/^[\u0000-\u001f]+$/.test(data)) {
      return { ok: false, error: '任务 Shell 仅允许发送控制字符' };
    }
    const ok = ptyRegistry.write(agentSessionId(agentId), agentId, data, false);
    return ok ? { ok: true } : { ok: false, error: '会话不存在' };
  });
}

export function cleanupAgentShellWatchers(): void {
  for (const [, watcher] of agentShellWatchers) watcher.unsub();
  agentShellWatchers.clear();
}

export function cleanupTerminalSessions(): void {
  for (const id of [...sessions.keys()]) {
    try {
      const s = sessions.get(id)!;
      if (s.kind === 'pty') s.proc?.kill();
      else s.child!.kill();
    } catch {
      /* best-effort */
    }
    sessions.delete(id);
  }
}
