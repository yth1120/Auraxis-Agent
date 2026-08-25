/**
 * sandbox-runner.ts — spawns commands through the native Windows sandbox
 * launcher (restricted token + medium integrity + Job Object). Output is
 * streamed through the inherited stdio pipes so the existing Bash UX works.
 */
import { errorText } from './errors';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { createOutputDecoder } from './text-encoding';
import { safeProcessEnv } from './safe-env';

export type SandboxBackend = 'restricted' | 'appcontainer' | 'linux' | 'macos';

export interface SandboxCommandOptions {
  argv: string[];
  cwd: string;
  /** Project root — used by the AppContainer backend for the read grant. */
  projectRoot?: string;
  /** Confined-mode semantics: read = project read-only, workspace-write = project writable. */
  mode?: 'read' | 'workspace-write';
  backend?: SandboxBackend;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  env?: Record<string, string>;
}

export interface SandboxCommandResult {
  supported: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  error?: string;
}

export function sandboxBackend(): SandboxBackend {
  const override = process.env.AURAXIS_SANDBOX_BACKEND;
  if (override === 'appcontainer' || override === 'restricted') return override;
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'darwin') return 'macos';
  return 'restricted';
}

export function sandboxScriptPath(backend: SandboxBackend = sandboxBackend()): string | null {
  const envKey =
    backend === 'appcontainer'
      ? 'AURAXIS_APPCONTAINER_PS1'
      : backend === 'restricted'
        ? 'AURAXIS_SANDBOX_PS1'
        : `AURAXIS_${backend.toUpperCase()}_SCRIPT`;
  if (process.env[envKey]) return process.env[envKey]!;
  const fileName =
    backend === 'appcontainer'
      ? 'sandbox-appcontainer.ps1'
      : backend === 'restricted'
        ? 'sandbox-windows.ps1'
        : backend === 'linux'
          ? 'sandbox-linux.sh'
          : 'sandbox-macos.sh';
  const appPath =
    typeof app !== 'undefined' && app && typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  const dev = path.join(appPath, 'electron', fileName);
  if (existsSync(dev)) return dev;
  // Direct-main.js launches (Playwright smoke/e2e) resolve appPath to
  // dist-electron; fall back to the repo layout so the native sandbox is
  // still available without an env override.
  const cwdDev = path.join(process.cwd(), 'electron', fileName);
  if (cwdDev !== dev && existsSync(cwdDev)) return cwdDev;
  const runtimeProcess = process as NodeJS.Process & { resourcesPath?: string };
  const packaged = path.join(runtimeProcess.resourcesPath ?? '', 'sandbox', fileName);
  if (existsSync(packaged)) return packaged;
  return null;
}

export function isSandboxSupported(backend: SandboxBackend = sandboxBackend()): boolean {
  if (backend === 'restricted' || backend === 'appcontainer') {
    return process.platform === 'win32' && sandboxScriptPath(backend) !== null;
  }
  if (backend === 'linux') return process.platform === 'linux' && sandboxScriptPath(backend) !== null;
  if (backend === 'macos') return process.platform === 'darwin' && sandboxScriptPath(backend) !== null;
  return false;
}

export async function runSandboxedCommand(opts: SandboxCommandOptions): Promise<SandboxCommandResult> {
  return new Promise((resolve) => {
    const resolvedBackend =
      opts.backend ??
      (opts.mode && process.platform === 'win32' && sandboxScriptPath('appcontainer')
        ? 'appcontainer'
        : sandboxBackend());
    const backend = resolvedBackend;
    const mode = opts.mode ?? 'read';
    const isWinBackend = backend === 'restricted' || backend === 'appcontainer';
    if (
      (isWinBackend && process.platform !== 'win32') ||
      (backend === 'linux' && process.platform !== 'linux') ||
      (backend === 'macos' && process.platform !== 'darwin')
    ) {
      resolve({ supported: false, exitCode: null, error: `原生沙箱后端 ${backend} 不适用于当前平台` });
      return;
    }
    void (async () => {
      const script = sandboxScriptPath(backend);
      if (!script) {
        resolve({ supported: false, exitCode: null, error: `未找到沙箱脚本 ${backend}（原生沙箱不可用）` });
        return;
      }

      let writeDir = '';
      if (backend === 'appcontainer' || backend === 'linux' || backend === 'macos') {
        try {
          writeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-sandbox-'));
        } catch (e: unknown) {
          resolve({ supported: true, exitCode: null, error: `创建沙箱写目录失败: ${errorText(e)}` });
          return;
        }
      }

      let child;
      if (isWinBackend) {
        const psArgs = [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-ChildArgvJson',
          JSON.stringify(opts.argv),
          '-Cwd',
          opts.cwd,
        ];
        if (backend === 'appcontainer') {
          psArgs.push('-ProjectRoot', opts.projectRoot ?? opts.cwd, '-WriteDir', writeDir, '-Mode', mode);
        }
        child = spawn('powershell.exe', psArgs, {
          cwd: opts.cwd,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: opts.env ?? safeProcessEnv(),
        });
      } else {
        const shell = process.platform === 'darwin' ? '/bin/bash' : 'bash';
        const shArgs = [
          script,
          '--argv-json',
          JSON.stringify(opts.argv),
          '--cwd',
          opts.cwd,
          '--project-root',
          opts.projectRoot ?? opts.cwd,
          '--write-dir',
          writeDir,
          '--mode',
          mode,
        ];
        // detached: true creates a process group so timeout/abort can SIGKILL
        // the whole sandbox tree (bwrap --die-with-parent or seatbelt child).
        child = spawn(shell, shArgs, {
          cwd: opts.cwd,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env: opts.env ?? safeProcessEnv(),
        });
      }

      // Fail closed: if the native launcher cannot start, the command must be
      // rejected instead of silently falling back to an unsandboxed spawn.
      let currentChild: ChildProcess | null = child;

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
      const stdoutDecoder = createOutputDecoder();
      const stderrDecoder = createOutputDecoder();

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          if (process.platform !== 'win32' && currentChild!.pid) {
            process.kill(-currentChild!.pid, 'SIGKILL');
          } else {
            currentChild!.kill();
          }
        } catch {
          /* gone */
        }
        forceKillTimer = setTimeout(() => {
          try {
            if (currentChild!.pid && isWinBackend) {
              // AppContainer backend: the Job Object already kills the whole
              // tree when the launcher dies, and /T would also kill the
              // detached ACL-restore watcher. Only force-kill the launcher.
              const taskkillArgs =
                backend === 'appcontainer'
                  ? ['/F', '/PID', String(currentChild!.pid)]
                  : ['/F', '/PID', String(currentChild!.pid), '/T'];
              spawn('taskkill', taskkillArgs, { windowsHide: true, shell: true });
            }
          } catch {
            /* best effort */
          }
        }, 2_000);
      }, opts.timeoutMs ?? 120_000);

      const cleanupWriteDir = async () => {
        if (writeDir) {
          try {
            await fs.rm(writeDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      };

      const finish = (res: SandboxCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer !== null) clearTimeout(forceKillTimer);
        void cleanupWriteDir().then(() => resolve(res));
      };

      const attachChild = (proc: ChildProcess) => {
        currentChild = proc;
        proc.stdout?.on('data', (d: Buffer) => {
          const chunk = stdoutDecoder.decode(d);
          if (stdout.length < 50_000) stdout += chunk;
          opts.onStdout?.(chunk);
        });
        proc.stderr?.on('data', (d: Buffer) => {
          const chunk = stderrDecoder.decode(d);
          if (stderr.length < 50_000) stderr += chunk;
          opts.onStderr?.(chunk);
        });
        proc.on('error', (e: unknown) =>
          finish({
            supported: true,
            exitCode: null,
            error: `沙箱启动失败: ${e instanceof Error ? e.message : String(e)}`,
          }),
        );
        proc.on('close', (code: number | null) => {
          const stderrTail = stderrDecoder.flush();
          if (stderrTail) stderr += stderrTail;
          const stdoutTail = stdoutDecoder.flush();
          if (stdoutTail) {
            stdout += stdoutTail;
            opts.onStdout?.(stdoutTail);
          }
          // Git Bash（msys2）在受限令牌下无法创建 \BaseNamedObjects\msys-*
          // 内核对象，启动即崩（0xC0000022）。此时必须拒绝执行，绝不降级到非沙箱模式。
          const launchError =
            stderr.includes('SANDBOX_LAUNCH_ERROR') || stderr.includes('fatal error - NtCreateDirectoryObject');
          if (launchError && isWinBackend) {
            finish({ supported: true, exitCode: null, error: '原生沙箱启动失败，已拒绝执行（fail-closed）' });
            return;
          }
          finish({
            supported: true,
            exitCode: code,
            ...(timedOut ? { timedOut: true } : {}),
            ...(launchError ? { error: stderr.trim().slice(0, 500) } : {}),
          });
        });
      };
      attachChild(child);

      opts.signal?.addEventListener(
        'abort',
        () => {
          if (settled) return;
          try {
            if (process.platform !== 'win32' && currentChild!.pid) {
              process.kill(-currentChild!.pid, 'SIGKILL');
            } else {
              currentChild!.kill();
            }
          } catch {
            /* gone */
          }
        },
        { once: true },
      );
    })();
  });
}
