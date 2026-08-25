/**
 * shell-executor.ts — ShellExecutor capability seam.
 *
 * Any consumer that needs to run a local command (hooks, Code Mode, future
 * tool backends) goes through this interface instead of spawning directly.
 * `nodeShellExecutor` is the default implementation; tests and future
 * sandboxed/remote backends can swap it via setShellExecutor.
 */
import { spawn } from 'child_process';
import { safeProcessEnv } from '../safe-env';

export interface ShellExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When true, the command is interpreted by the platform shell. */
  shell?: boolean;
  /** Text written to the child's stdin before it closes. */
  stdin?: string;
  /** Per-stream output cap in bytes (default 1 MiB). */
  outputCap?: number;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellExecutor {
  run(req: ShellExecRequest): Promise<ShellExecResult>;
}

const DEFAULT_OUTPUT_CAP = 1024 * 1024;

export const nodeShellExecutor: ShellExecutor = {
  run(req: ShellExecRequest): Promise<ShellExecResult> {
    return new Promise((resolve) => {
      const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : 30_000;
      const outputCap = req.outputCap && req.outputCap > 0 ? req.outputCap : DEFAULT_OUTPUT_CAP;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(req.command, req.args ?? [], {
          cwd: req.cwd ?? process.cwd(),
          env: req.env ?? safeProcessEnv(),
          shell: req.shell ?? false,
          signal: req.signal,
          windowsHide: true,
        });
      } catch {
        resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, truncated: false });
        return;
      }

      if (req.stdin && child.stdin) {
        // 子进程可能在 stdin 刷新前退出：EPIPE 以异步事件抛出，
        // 仅靠 try/catch 拦不住，必须显式吞掉流错误。
        child.stdin.on('error', () => { /* stdin closed */ });
        try {
          child.stdin.write(req.stdin);
          child.stdin.end();
        } catch { /* stdin closed */ }
      } else if (child.stdin) {
        try { child.stdin.end(); } catch { /* noop */ }
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;

      const append = (target: { value: string }, chunk: string) => {
        if (target.value.length >= outputCap) { truncated = true; return; }
        const remaining = outputCap - target.value.length;
        target.value += chunk.slice(0, remaining);
        if (chunk.length > remaining) truncated = true;
      };
      const out = { value: stdout };
      const err = { value: stderr };

      child.stdout?.on('data', (d: Buffer) => append(out, d.toString()));
      child.stderr?.on('data', (d: Buffer) => append(err, d.toString()));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (e) => {
        clearTimeout(timer);
        err.value = err.value ? `${err.value}\n${e.message}` : e.message;
        resolve({ stdout: out.value, stderr: err.value, exitCode: null, timedOut, truncated });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: out.value, stderr: err.value, exitCode: code, timedOut, truncated });
      });
    });
  },
};

let activeExecutor: ShellExecutor = nodeShellExecutor;

export function getShellExecutor(): ShellExecutor {
  return activeExecutor;
}

/** Test/embedding seam — swap the implementation without touching consumers. */
export function setShellExecutor(impl: ShellExecutor): void {
  activeExecutor = impl;
}
