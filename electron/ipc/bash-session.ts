/**
 * bash-session.ts — persistent per-agent shell （持久 PTY 会话）.
 *
 * Agent Bash calls reuse one PTY session per task, so shell state survives
 * across calls, output streams naturally, and commands are not killed by a
 * fixed per-call timeout. The command is wrapped with an exit marker so the
 * model still receives an exit code; sandboxed/read-only runs keep the
 * one-shot Bash path.
 */
import { existsSync } from 'fs';
import { ptyRegistry } from './pty-tool';

export interface BashSessionCtx {
  agentId?: string;
  requestId: string;
  onProgress?: (chunk: string) => void;
  abortSignal?: AbortSignal;
}

const EXIT_MARKER = '__AURAXIS_EXIT_';
const POLL_MS = 400;
const MAX_WAIT_MS = 30 * 60 * 1000;
const OUTPUT_CAP = 50_000;

function shellForPlatform(): string {
  if (process.platform === 'win32') {
    const candidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

/** Drop the shell's echoed wrapper from the start of the output — the whole
 *  `{ eval '…'; } 2>&1; echo -e "…"` block, including multi-line continuation
 *  lines — so the model only sees real command output. */
function stripEcho(output: string, command: string): string {
  const lines = output.split(/\r?\n/);
  const wrapStart = lines.findIndex((l) => /\{ eval '/.test(l));
  if (wrapStart >= 0) {
    const wrapEnd = lines.findIndex((l, i) => i > wrapStart && l.includes('echo -e'));
    const end = wrapEnd >= 0 ? wrapEnd : wrapStart;
    return lines.slice(end + 1).join('\n');
  }
  const firstLine = command.split('\n')[0]?.trim();
  if (!firstLine) return output;
  const idx = lines.findIndex((l) => l.includes(firstLine));
  return idx >= 0 ? lines.slice(idx + 1).join('\n') : output;
}

/** Parse the LAST `__AURAXIS_EXIT_<code>__` marker in the output.
 *  The echoed wrapper contains a literal `__AURAXIS_EXIT_$?__` (unexpanded
 *  `$?`), which never matches `\d+`; the real marker is emitted after the
 *  command completes, so the last digit marker always wins. */
export function parseExitMarker(output: string): { exitCode: number; text: string } | null {
  const re = /__AURAXIS_EXIT_(\d+)__/g;
  let m: RegExpExecArray | null;
  let last: { idx: number; code: number } | null = null;
  while ((m = re.exec(output)) !== null) {
    last = { idx: m.index, code: Number(m[1]) };
  }
  if (!last) return null;
  return {
    exitCode: last.code,
    text: output.slice(0, last.idx).replace(/[\r\n]+$/, ''),
  };
}

/**
 * Run one command in the agent's persistent shell. Returns null when the
 * persistent path is unavailable so the caller can fall back to one-shot Bash.
 */
export async function runBashPersistent(
  command: string,
  workdir: string,
  ctx: BashSessionCtx,
): Promise<{
  output: { stdout: string; stderr: string; exitCode: number | null; durationMs: number };
  error?: string;
} | null> {
  const owner = ctx.agentId || ctx.requestId;
  if (!owner) return null;
  const sessionId = `bash-${owner}`;
  const startedAt = Date.now();

  try {
    const existing = ptyRegistry.list(owner).some((s) => s.id === sessionId);
    if (!existing) {
      const shell = shellForPlatform();
      // Persistent sessions require a bash-compatible shell; cmd.exe cannot
      // run the `{ ...; }` wrapper and would hang instead of falling back.
      if (process.platform === 'win32' && /cmd\.exe$/i.test(shell)) return null;
      ptyRegistry.create({
        owner,
        id: sessionId,
        command: shell,
        cwd: workdir,
      });
    }

    // Single-line wrapper: a raw `\n` inside `{ ...; }` makes the PTY submit
    // the first half as its own line (`{ ls -la` → continuation prompt), which
    // ends in a syntax error and no real marker. `eval '<single-quoted>'`
    // keeps embedded newlines inside the quotes — bash's line reader continues
    // until the closing quote — and the whole construct stays one logical line.
    // `echo -e "\nmarker$?__"` emits the exit marker on its own line so the
    // parser's line-anchored regex can distinguish it from the command echo.
    const escaped = command.replace(/'/g, `'\\''`);
    const wrapped = `{ eval '${escaped}'; } 2>&1; echo -e "\\n${EXIT_MARKER}$?__"`;
    if (!ptyRegistry.write(sessionId, owner, wrapped, true)) return null;

    let output = '';
    let settled: { exitCode: number; text: string } | null = null;

    while (!ctx.abortSignal?.aborted) {
      const read = await ptyRegistry.read(sessionId, owner, POLL_MS);
      if (!read) return null; // session vanished (spawn failure / cleanup)
      if (read.output) {
        output += read.output;
        if (output.length > OUTPUT_CAP * 2) {
          // Keep the tail (marker + recent output) and forward only the delta.
          output = output.slice(-OUTPUT_CAP * 2);
        }
        ctx.onProgress?.(read.output);
        const parsed = parseExitMarker(output);
        if (parsed) {
          settled = parsed;
          break;
        }
      }
      const alive = ptyRegistry.list(owner).some((s) => s.id === sessionId);
      if (!alive) break;
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        ptyRegistry.close(sessionId, owner);
        return {
          output: {
            stdout: output.slice(0, OUTPUT_CAP),
            stderr: '',
            exitCode: null,
            durationMs: Date.now() - startedAt,
          },
          error: '命令执行超过 30 分钟，已终止持久会话',
        };
      }
    }

    if (ctx.abortSignal?.aborted) {
      ptyRegistry.close(sessionId, owner);
      return {
        output: { stdout: '', stderr: '', exitCode: null, durationMs: Date.now() - startedAt },
        error: '用户手动中止',
      };
    }

    const text = settled ? settled.text : output;
    return {
      output: {
        stdout: stripEcho(text, command).slice(0, OUTPUT_CAP),
        stderr: '',
        exitCode: settled?.exitCode ?? null,
        durationMs: Date.now() - startedAt,
      },
      ...(settled === null ? { error: '命令已结束但未返回退出码' } : {}),
    };
  } catch {
    // Any PTY failure falls back to the one-shot executor.
    try {
      ptyRegistry.close(sessionId, owner);
    } catch {
      /* best effort */
    }
    return null;
  }
}
