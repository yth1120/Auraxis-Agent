import { spawn, execSync } from 'child_process';
import path from 'path';
import { statSync } from 'fs';
import { createOutputDecoder } from '../../text-encoding';
import { devLog } from '../shared';
import { runBashPersistent } from '../bash-session';
import { startBashTask, finishBashTask } from '../task-monitor';
import { registerAbort, unregisterAbort } from './abort-registry';
import { cacheTaskResult } from './task-cache';
import { resolvePath, fixWindowsNullRedirect, type ToolContext, type ToolResult } from './path-utils';
import { safeProcessEnv } from '../../safe-env';

// ─── Resolve best shell on Windows ──────────────────────
let _winShell: { bin: string; args: string[] } | null | undefined;
// Track which shells have already failed at spawn time so we can fall back
const _failedShells = new Set<string>();

function getWinShell(): { bin: string; args: string[] } | null {
  if (_winShell !== undefined && !_failedShells.has(_winShell?.bin || '')) return _winShell;

  // Git Bash: supports Unix commands natively, best DX
  const gitBashPaths = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  for (const p of gitBashPaths) {
    if (_failedShells.has(p)) continue;
    try {
      statSync(p);
      _winShell = { bin: p, args: ['-c'] };
      return _winShell!;
    } catch {}
  }
  // Try bash in PATH
  if (!_failedShells.has('bash.exe')) {
    try {
      execSync('where bash.exe 2>nul', { stdio: 'pipe', timeout: 3000, windowsHide: true });
      _winShell = { bin: 'bash.exe', args: ['-c'] };
      return _winShell;
    } catch {}
  }

  // cmd.exe fallback: supports dir/type/findstr
  if (!_failedShells.has('cmd.exe')) {
    try {
      execSync('where cmd.exe 2>nul', { stdio: 'pipe', timeout: 3000, windowsHide: true });
      _winShell = { bin: 'cmd.exe', args: ['/c'] };
      return _winShell;
    } catch {}
  }

  // Last resort: PowerShell
  _winShell = null;
  return null;
}

function markShellFailed(bin: string) {
  _failedShells.add(bin);
  _winShell = undefined;
}

// ─── Bash ──────────────────────────────────────────────
export function spawnBashChild(
  shellBin: string,
  shellArgs: string[],
  finalCmd: string,
  workdir: string,
  timeout: number,
  ctx: ToolContext,
  resolve: (result: ToolResult) => void,
) {
  const isWin = process.platform === 'win32';
  const startTime = Date.now();

  // shell: false — shellBin is an absolute executable path; with shell: true
  // Node hands the unquoted path to cmd.exe, which chokes on the space in
  // "C:\Program Files\Git\bin\bash.exe" ("'C:\Program' 不是内部或外部命令").
  const child = spawn(shellBin, [...shellArgs, finalCmd], {
    cwd: workdir,
    timeout,
    env: safeProcessEnv({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }),
    windowsHide: true,
    shell: false,
  });

  const taskId = startBashTask({
    command: finalCmd,
    cwd: workdir,
    toolCallId: ctx.toolCallId,
    requestId: ctx.requestId,
    agentId: ctx.agentId,
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let userAborted = false;
  let timedOut = false;
  const stdoutDecoder = createOutputDecoder();
  const stderrDecoder = createOutputDecoder();

  // ── Throttled progress buffer ─────────────────────────
  // Accumulate stdout/stderr chunks and flush every 50ms so
  // the frontend MicroTerminal renders smoothly without jank
  // when high-throughput commands (npm install, cargo build)
  // produce thousands of lines per second.
  let progressBuf = '';
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const PROGRESS_FLUSH_MS = 50;

  function flushProgress() {
    if (progressBuf && ctx.onProgress) {
      ctx.onProgress(progressBuf);
      progressBuf = '';
    }
    progressTimer = null;
  }

  function emitProgress(chunk: string) {
    progressBuf += chunk;
    if (progressTimer === null) {
      progressTimer = setTimeout(flushProgress, PROGRESS_FLUSH_MS);
    }
  }

  // ── Force‑kill after grace period ──────────────────────
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  function forceKill() {
    if (child.exitCode !== null || child.killed) return;
    try {
      if (isWin && child.pid) {
        spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true, shell: true });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* best effort */
    }
  }

  if (ctx.toolCallId) {
    registerAbort(ctx.toolCallId, {
      abort: () => {
        userAborted = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(forceKill, 3_000);
      },
    });
  }

  const cleanup = () => {
    clearTimeout(killTimer);
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      flushProgress();
    }
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    unregisterAbort(ctx.toolCallId);
  };

  const finish = (exitCode: number | null, error?: string, wasTimedOut = false) => {
    if (settled) return;
    settled = true;
    stdout += stdoutDecoder.flush();
    stderr += stderrDecoder.flush();
    // Flush any remaining buffered progress before resolving
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      flushProgress();
    }
    cleanup();
    const durationMs = Date.now() - startTime;
    const cmdPreview = finalCmd.slice(0, 120);
    if (error || exitCode !== 0) {
      console.error(
        `[AURAXIS] [Bash:ERR] cmd="${cmdPreview}" exitCode=${exitCode} stderrLen=${stderr.length} error=${error || ''} duration=${durationMs}ms`,
      );
    } else {
      devLog(
        `[AURAXIS] [Bash:OK] cmd="${cmdPreview}" exitCode=${exitCode} stdoutLen=${stdout.length} duration=${durationMs}ms`,
      );
    }
    finishBashTask(taskId, { exitCode, error, userAborted, timedOut: wasTimedOut });
    resolve({
      output: {
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 50000),
        exitCode,
        durationMs,
      },
      ...(userAborted ? { error: '用户手动中止' } : {}),
      ...(error && !userAborted ? { error } : {}),
    });
  };

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = isWin ? stdoutDecoder.decode(data) : data.toString('utf8');
    if (stdout.length < 50000) stdout += chunk;
    emitProgress(chunk);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const chunk = isWin ? stderrDecoder.decode(data) : data.toString('utf8');
    if (stderr.length < 50000) stderr += chunk;
    emitProgress(chunk);
  });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    finish(code ?? null, undefined, timedOut);
  });
  child.on('error', (err) => finish(-1, err.message));

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      forceKill();
      finish(-1, `命令超时 (${timeout / 1000}s) — 已强制终止`, true);
    }, 3_000);
  }, timeout);
}

/** Start a Bash command in the background and return a task id immediately. */
function runBashBackground(command: string, workdir: string, ctx: ToolContext): ToolResult {
  const isWin = process.platform === 'win32';
  const resolved = isWin ? getWinShell() : null;
  const shellBin = isWin ? (resolved?.bin ?? 'powershell.exe') : '/bin/bash';
  const shellArgs = isWin ? (resolved?.args ?? ['-NoProfile']) : ['-c'];
  const finalCmd =
    isWin && !resolved
      ? `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
      : command;
  const taskId = startBashTask({
    command: finalCmd,
    cwd: workdir,
    toolCallId: ctx.toolCallId,
    requestId: ctx.requestId,
    agentId: ctx.agentId,
  });
  const startTime = Date.now();
  const child = spawn(shellBin, [...shellArgs, finalCmd], {
    cwd: workdir,
    env: safeProcessEnv({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }),
    windowsHide: true,
    shell: false,
  });
  const abortBackground = () => {
    if (child.exitCode !== null || child.killed) return;
    try {
      if (isWin && child.pid) {
        spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], { windowsHide: true, shell: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* best effort */
    }
  };
  // Register under both the returned task id (TaskStop) and the tool call id
  // (terminal panel stopTask → abortTool) so either path can stop it.
  registerAbort(taskId, { abort: abortBackground });
  if (ctx.toolCallId) registerAbort(ctx.toolCallId, { abort: abortBackground });
  let stdout = '';
  let stderr = '';
  const stdoutDecoder = createOutputDecoder();
  const stderrDecoder = createOutputDecoder();
  child.stdout?.on('data', (data: Buffer) => {
    if (stdout.length < 50000) stdout += isWin ? stdoutDecoder.decode(data) : data.toString('utf8');
  });
  child.stderr?.on('data', (data: Buffer) => {
    if (stderr.length < 50000) stderr += isWin ? stderrDecoder.decode(data) : data.toString('utf8');
  });
  const done = (exitCode: number | null, error?: string) => {
    stdout += stdoutDecoder.flush();
    stderr += stderrDecoder.flush();
    unregisterAbort(taskId);
    if (ctx.toolCallId) unregisterAbort(ctx.toolCallId);
    finishBashTask(taskId, { exitCode, error });
    cacheTaskResult(
      taskId,
      {
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 50000),
        exitCode,
        durationMs: Date.now() - startTime,
        background: true,
        ...(error ? { error } : {}),
      },
      error || (exitCode !== 0 && exitCode !== null) ? 'error' : 'completed',
    );
  };
  child.on('close', (code) => done(code ?? null));
  child.on('error', (err) => done(-1, err.message));
  return {
    output: {
      taskId,
      background: true,
      message: '命令已在后台启动。用 TaskOutput 读取结果，用 TaskStop 停止。',
    },
  };
}

export async function runBash(
  params: {
    command: string;
    workdir?: string;
    timeout?: number;
    description?: string;
    run_in_background?: boolean;
    sandbox_permissions?: string;
    justification?: string;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const workdir = params.workdir ? resolvePath(params.workdir, ctx.projectRoot) : ctx.projectRoot;
  // Workspace-write / read must stay inside the project boundary. Absolute
  // command bodies still rely on the native backend + approval, but the cwd
  // escape (e.g. `workdir: /etc`) is hard-denied here.
  if ((ctx.sandboxMode === 'workspace-write' || ctx.sandboxMode === 'read') && ctx.projectRoot) {
    const root = path.resolve(ctx.projectRoot);
    const cwd = path.resolve(workdir);
    if (cwd !== root && !cwd.startsWith(root + path.sep)) {
      return { output: null, error: `沙箱拒绝: 工作目录超出项目边界（${workdir}）` };
    }
  }
  // 提权配对: sandbox_permissions ⇔ justification.
  const sandboxPermissions = typeof params.sandbox_permissions === 'string' ? params.sandbox_permissions.trim() : '';
  const justification = typeof params.justification === 'string' ? params.justification.trim() : '';
  if (sandboxPermissions && !justification) {
    return { output: null, error: '设置 sandbox_permissions 时必须同时提供 justification（一句话说明为什么需要提权）' };
  }
  if (!sandboxPermissions && justification) {
    return { output: null, error: 'justification 仅在同时设置 sandbox_permissions 时有效' };
  }
  if (sandboxPermissions && !['read', 'workspace-write', 'full'].includes(sandboxPermissions)) {
    return { output: null, error: `无效的 sandbox_permissions: ${sandboxPermissions}` };
  }
  // 命令应运行到自然结束或用户主动停止.
  // The 10-minute ceiling still protects against truly hung processes, but
  // long builds/tests no longer die at the old 2-minute default.
  const timeout = params.timeout && params.timeout > 0 ? Math.min(params.timeout, 600000) : 600000;
  const isWin = process.platform === 'win32';

  if (params.run_in_background === true) {
    if (ctx.sandboxMode === 'read' || ctx.sandboxMode === 'workspace-write') {
      return { output: null, error: '受限沙箱模式暂不支持后台 Bash；请使用前台执行或切换到允许的配置。' };
    }
    return runBashBackground(params.command, workdir, ctx);
  }

  // ── Persistent shell path ────────────────────────
  // Agent tasks reuse one PTY session per agent so shell state survives,
  // output streams natively, and long commands are not killed by a fixed
  // timeout. Sandboxed runs keep the isolated one-shot path.
  if (ctx.agentId && ctx.sandboxMode !== 'read' && ctx.sandboxMode !== 'workspace-write') {
    try {
      const persistent = await runBashPersistent(params.command, workdir, ctx);
      if (persistent) return persistent;
    } catch {
      /* PTY unavailable — fall through to one-shot */
    }
  }

  // ── Native sandbox path (Windows restricted token + Job Object) ──
  if (ctx.sandboxMode === 'read' || ctx.sandboxMode === 'workspace-write') {
    return new Promise<ToolResult>((resolve) => {
      void spawnBashSandboxed(params.command, workdir, timeout, ctx, resolve);
    });
  }

  if (!isWin) {
    return new Promise((resolve) => {
      spawnBashChild('/bin/bash', ['-c'], params.command, workdir, timeout, ctx, resolve);
    });
  }

  // Windows: try shells in order, falling back on ENOENT.
  // When shell:true is set, ENOENT should no longer occur for paths with
  // spaces, but we keep the retry chain for resilience against edge cases
  // (uninstalled Git, missing PATH entries, etc.).
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resolved = getWinShell();
    let shellBin: string;
    let shellArgs: string[];
    let finalCmd: string;

    if (resolved) {
      shellBin = resolved.bin;
      shellArgs = resolved.args;
      finalCmd = fixWindowsNullRedirect(params.command);
    } else {
      shellBin = 'powershell.exe';
      shellArgs = ['-NoProfile'];
      finalCmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${params.command}`;
    }

    const result = await new Promise<ToolResult>((resolve) => {
      spawnBashChild(shellBin, shellArgs, finalCmd, workdir, timeout, ctx, resolve);
    });

    // If spawn itself failed with ENOENT (unlikely with shell:true, but
    // still possible), mark this shell as bad and try the next one.
    if (result.error && result.error.includes('ENOENT') && isWin && resolved) {
      markShellFailed(shellBin);
      continue;
    }

    return result;
  }

  return { output: null, error: '无法在 Windows 上启动任何 shell (bash/cmd/powershell)' };
}

/**
 * Windows native-sandboxed Bash: restricted token + medium integrity + Job
 * Object via sandbox-windows.ps1. Streaming, task tracking, progress
 * throttling and abort semantics mirror the regular Bash path.
 */
export async function spawnBashSandboxed(
  command: string,
  workdir: string,
  timeout: number,
  ctx: ToolContext,
  resolve: (result: ToolResult) => void,
  forcedShell?: { bin: string; args: string[] },
) {
  const { isSandboxSupported, runSandboxedCommand } = await import('../../sandbox-runner');
  if (!isSandboxSupported()) {
    resolve({ output: null, error: '原生沙箱不可用：未找到 sandbox-windows.ps1（沙箱模式拒绝执行）' });
    return;
  }

  const isWin = process.platform === 'win32';
  const resolved = forcedShell ? null : isWin ? getWinShell() : null;
  let shellBin: string;
  let shellArgs: string[];
  let finalCmd: string;
  if (forcedShell) {
    shellBin = forcedShell.bin;
    shellArgs = forcedShell.args;
    finalCmd = command;
  } else if (resolved) {
    shellBin = resolved.bin;
    shellArgs = resolved.args;
    finalCmd = fixWindowsNullRedirect(command);
  } else if (!isWin) {
    shellBin = '/bin/bash';
    shellArgs = ['-c'];
    finalCmd = command;
  } else {
    shellBin = 'powershell.exe';
    shellArgs = ['-NoProfile'];
    finalCmd = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`;
  }

  const startTime = Date.now();
  const taskId = startBashTask({
    command: finalCmd,
    cwd: workdir,
    toolCallId: ctx.toolCallId,
    requestId: ctx.requestId,
    agentId: ctx.agentId,
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let userAborted = false;
  let progressBuf = '';
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  const flushProgress = () => {
    if (progressBuf && ctx.onProgress) {
      ctx.onProgress(progressBuf);
      progressBuf = '';
    }
    progressTimer = null;
  };
  const emitProgress = (chunk: string) => {
    progressBuf += chunk;
    if (progressTimer === null) progressTimer = setTimeout(flushProgress, 50);
  };
  const cleanup = () => {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      flushProgress();
    }
    unregisterAbort(ctx.toolCallId);
  };

  const finish = (exitCode: number | null, error?: string, wasTimedOut = false) => {
    if (settled) return;
    settled = true;
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      flushProgress();
    }
    cleanup();
    const durationMs = Date.now() - startTime;
    finishBashTask(taskId, { exitCode, error, userAborted, timedOut: wasTimedOut });
    resolve({
      output: {
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 50000),
        exitCode,
        durationMs,
      },
      ...(userAborted ? { error: '用户手动中止' } : {}),
      ...(error && !userAborted ? { error } : {}),
    });
  };

  if (ctx.toolCallId) {
    registerAbort(ctx.toolCallId, {
      abort: () => {
        userAborted = true;
        abortController.abort();
      },
    });
  }

  const res = await runSandboxedCommand({
    argv: [shellBin, ...shellArgs, finalCmd],
    cwd: workdir,
    projectRoot: ctx.projectRoot,
    mode: ctx.sandboxMode === 'workspace-write' ? 'workspace-write' : 'read',
    timeoutMs: timeout,
    signal: abortController.signal,
    onStdout: (chunk: string) => {
      if (stdout.length < 50000) stdout += chunk;
      emitProgress(chunk);
    },
    onStderr: (chunk: string) => {
      if (stderr.length < 50000) stderr += chunk;
      emitProgress(chunk);
    },
  });

  if (res.error) {
    finish(res.exitCode, res.error, res.timedOut);
    return;
  }
  finish(res.exitCode, undefined, res.timedOut);
}
