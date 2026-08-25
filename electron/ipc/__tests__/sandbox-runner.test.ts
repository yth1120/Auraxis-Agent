import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runSandboxedCommand, sandboxScriptPath, sandboxBackend, isSandboxSupported } from '../../sandbox-runner';

const canRun = process.platform === 'win32' && sandboxScriptPath() !== null;
const canRunAc = process.platform === 'win32' && sandboxScriptPath('appcontainer') !== null;
// GitHub 托管 Windows Server 对受限令牌/AppContainer 的组查询与超时清理
// 行为与本地桌面不一致（whoami /groups 退出码、ACL 恢复时序），这类
// 真实 OS 集成用例保留在本地 Windows 验证，CI 上跳过避免环境性抖动。
const isCI = !!process.env.CI;
// 当前平台的原生沙箱后端（Windows=restricted，Linux=linux，macOS=macos）。
const platformBackend =
  process.platform === 'win32'
    ? 'restricted'
    : process.platform === 'linux'
      ? 'linux'
      : process.platform === 'darwin'
        ? 'macos'
        : 'restricted';

describe.runIf(canRun)('sandbox-runner — Windows 原生沙箱', () => {
  it('runs a command under the restricted token and streams stdout', async () => {
    const res = await runSandboxedCommand({
      argv: ['cmd.exe', '/c', 'echo sandbox-ok'],
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
    });
    expect(res.supported).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.error).toBeUndefined();
    const out: string[] = [];
    await runSandboxedCommand({
      argv: ['cmd.exe', '/c', 'echo sandbox-stream'],
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
      onStdout: (c) => out.push(c),
    });
    expect(out.join('')).toContain('sandbox-stream');
  }, 90_000);

  it.skipIf(isCI)(
    'drops to medium integrity and disables administrative access',
    async () => {
      const out: string[] = [];
      const res = await runSandboxedCommand({
        argv: ['cmd.exe', '/c', 'whoami /groups'],
        cwd: os.tmpdir(),
        timeoutMs: 30_000,
        onStdout: (c) => out.push(c),
      });
      expect(res.exitCode).toBe(0);
      expect(res.error).toBeUndefined();
      const groups = out.join('');
      // The integrity label must be Medium (S-1-16-8192), not High.
      expect(groups).toContain('8192');
      expect(groups).not.toContain('12288');
    },
    60_000,
  );

  it('admin-only commands fail under the restricted token', async () => {
    const res = await runSandboxedCommand({
      argv: ['cmd.exe', '/c', 'net session'],
      cwd: os.tmpdir(),
      timeoutMs: 30_000,
    });
    expect(res.exitCode).not.toBe(0);
  }, 60_000);

  it('kills the whole job tree on timeout', async () => {
    const started = Date.now();
    const res = await runSandboxedCommand({
      argv: ['cmd.exe', '/c', 'ping -n 30 127.0.0.1'],
      cwd: os.tmpdir(),
      timeoutMs: 2_000,
    });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe.skipIf(isSandboxSupported(platformBackend))('sandbox-runner — 平台不支持', () => {
  it('reports unsupported on non-Windows or missing launcher', async () => {
    const res = await runSandboxedCommand({
      argv: ['echo', 'x'],
      cwd: path.resolve(os.tmpdir()),
      timeoutMs: 1_000,
    });
    expect(res.supported).toBe(false);
  });
});

describe('sandbox-runner — backend selection', () => {
  it('defaults to the platform backend and honors the override', () => {
    const orig = process.env.AURAXIS_SANDBOX_BACKEND;
    delete process.env.AURAXIS_SANDBOX_BACKEND;
    expect(sandboxBackend()).toBe(platformBackend);
    process.env.AURAXIS_SANDBOX_BACKEND = 'appcontainer';
    expect(sandboxBackend()).toBe('appcontainer');
    if (orig === undefined) delete process.env.AURAXIS_SANDBOX_BACKEND;
    else process.env.AURAXIS_SANDBOX_BACKEND = orig;
  });

  it('resolves linux/macos launcher scripts', () => {
    expect(sandboxScriptPath('linux')?.endsWith('sandbox-linux.sh')).toBe(true);
    expect(sandboxScriptPath('macos')?.endsWith('sandbox-macos.sh')).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('marks linux/macos backends unsupported on win32', () => {
    expect(isSandboxSupported('linux')).toBe(false);
    expect(isSandboxSupported('macos')).toBe(false);
  });
});

describe.runIf(canRunAc)(
  'sandbox-runner — AppContainer 原生沙箱',
  () => {
    const acProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auraxis-ac-project-'));

    /**
     * AppContainer profile creation + ACL propagation is a system-level
     * operation that can race under parallel test load. Retry once after a
     * short settle window, and always carry stderr through for diagnosis.
     */
    async function runAc(
      argv: string[],
      opts: { timeoutMs?: number; onStdout?: (c: string) => void } = {},
      attempts = 2,
    ) {
      let lastErr = '';
      for (let i = 0; i < attempts; i++) {
        const out: string[] = [];
        const err: string[] = [];
        const res = await runSandboxedCommand({
          backend: 'appcontainer',
          argv,
          cwd: acProjectRoot,
          projectRoot: acProjectRoot,
          timeoutMs: opts.timeoutMs ?? 30_000,
          onStdout: (c) => {
            out.push(c);
            opts.onStdout?.(c);
          },
          onStderr: (c) => err.push(c),
        });
        lastErr = err.join('');
        if (res.exitCode === 0 && !res.error) {
          return { res, stdout: out.join(''), stderr: lastErr };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { res: null, stdout: '', stderr: lastErr };
    }

    afterAll(async () => {
      // A just-exited launcher/watcher may still hold the directory as its CWD;
      // retry briefly so a stale handle doesn't fail the whole suite.
      for (let i = 0; i < 50; i++) {
        try {
          fs.rmSync(acProjectRoot, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    });

    it('runs a command in the AppContainer and streams stdout', async () => {
      const out: string[] = [];
      const { res, stderr } = await runAc(['cmd.exe', '/c', 'echo ac-ok'], { onStdout: (c) => out.push(c) });
      expect(res, stderr).not.toBeNull();
      expect(res!.supported).toBe(true);
      expect(res!.exitCode, stderr).toBe(0);
      expect(res!.error).toBeUndefined();
      expect(out.join('')).toContain('ac-ok');
    }, 60_000);

    it('runs at Low integrity with an AppContainer-scoped token', async () => {
      const { res, stdout, stderr } = await runAc(['cmd.exe', '/c', 'whoami /groups']);
      expect(res, stderr).not.toBeNull();
      expect(res!.exitCode, stderr).toBe(0);
      const groups = stdout;
      expect(groups).toContain('S-1-16-4096'); // Low integrity
      expect(groups).not.toContain('S-1-16-12288'); // not High
    }, 60_000);

    it('allows writes only inside the granted scratch TEMP', async () => {
      const { res, stderr } = await runAc([
        'cmd.exe',
        '/c',
        'echo scratch-ok>%TEMP%\\probe.txt && type %TEMP%\\probe.txt',
      ]);
      expect(res, stderr).not.toBeNull();
      expect(res!.exitCode, stderr).toBe(0);
      expect(res!.error).toBeUndefined();
    }, 60_000);

    it('denies writes to normal user-writable paths outside the grant', async () => {
      const probe = path.join(os.tmpdir(), `auraxis-ac-deny-${process.pid}-${Date.now()}.txt`);
      const res = await runSandboxedCommand({
        backend: 'appcontainer',
        argv: ['cmd.exe', '/c', `echo denied>${probe}`],
        cwd: acProjectRoot,
        projectRoot: acProjectRoot,
        timeoutMs: 30_000,
      });
      expect(res.exitCode).not.toBe(0);
      expect(fs.existsSync(probe)).toBe(false);
    }, 60_000);

    it.skipIf(isCI)(
      'kills the whole job tree on timeout and restores the project ACL',
      async () => {
        const started = Date.now();
        const res = await runSandboxedCommand({
          backend: 'appcontainer',
          // ping is blocked by the AppContainer network policy, so use a plain sleep.
          argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'],
          cwd: acProjectRoot,
          projectRoot: acProjectRoot,
          timeoutMs: 2_000,
        });
        expect(res.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(15_000);

        // The detached cleanup watcher restores the ACL shortly after the runner
        // kills the launcher process — poll briefly for the revoke to land.
        const deadline = Date.now() + 10_000;
        let acl = execFileSync('icacls', [acProjectRoot], { encoding: 'utf8' });
        while (/S-1-15-2-/.test(acl) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          acl = execFileSync('icacls', [acProjectRoot], { encoding: 'utf8' });
        }
        expect(acl).not.toMatch(/S-1-15-2-/);
      },
      60_000,
    );
  },
  300_000,
);
