import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { spawn } from 'child_process';
import { isSandboxSupported, runSandboxedCommand, sandboxBackend, sandboxScriptPath } from '../sandbox-runner';

vi.mock('electron', () => ({
  app: { getAppPath: vi.fn(() => process.cwd()), getPath: vi.fn(() => '') },
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../text-encoding', () => ({
  createOutputDecoder: () => ({
    decode: (chunk: Buffer) => chunk.toString('utf8'),
    flush: () => '',
  }),
}));

vi.mock('../safe-env', () => ({
  safeProcessEnv: vi.fn(() => ({})),
}));

const spawnMock = vi.mocked(spawn);
const appGetAppPathMock = vi.mocked(app.getAppPath);

let tempDir: string;

type SandboxBackendName = 'restricted' | 'appcontainer' | 'linux' | 'macos';

/** 当前平台对应的默认沙箱后端（测试在三平台 CI 上都要可运行）。 */
function currentBackend(): SandboxBackendName {
  if (process.platform === 'win32') return 'restricted';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

const BACKEND_SPEC: Record<SandboxBackendName, { file: string; envKey: string }> = {
  restricted: { file: 'sandbox-windows.ps1', envKey: 'AURAXIS_SANDBOX_PS1' },
  appcontainer: { file: 'sandbox-appcontainer.ps1', envKey: 'AURAXIS_APPCONTAINER_PS1' },
  linux: { file: 'sandbox-linux.sh', envKey: 'AURAXIS_LINUX_SCRIPT' },
  macos: { file: 'sandbox-macos.sh', envKey: 'AURAXIS_MACOS_SCRIPT' },
};

function provisionScript(backend: SandboxBackendName): void {
  const spec = BACKEND_SPEC[backend];
  const script = path.join(tempDir, spec.file);
  writeFileSync(script, '#', 'utf8');
  process.env[spec.envKey] = script;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'auraxis-sandbox-test-'));
  appGetAppPathMock.mockReturnValue(tempDir);
});

afterEach(() => {
  delete process.env.AURAXIS_SANDBOX_BACKEND;
  delete process.env.AURAXIS_SANDBOX_PS1;
  delete process.env.AURAXIS_APPCONTAINER_PS1;
  delete process.env.AURAXIS_LINUX_SCRIPT;
  delete process.env.AURAXIS_MACOS_SCRIPT;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('sandbox-runner — backend and script resolution', () => {
  it('resolves backend from env and defaults to the current platform', () => {
    expect(sandboxBackend()).toBe(currentBackend());
    process.env.AURAXIS_SANDBOX_BACKEND = 'appcontainer';
    expect(sandboxBackend()).toBe('appcontainer');
    process.env.AURAXIS_SANDBOX_BACKEND = 'linux';
    expect(sandboxBackend()).toBe(process.platform === 'win32' ? 'restricted' : 'linux');
  });

  it('uses env scripts and finds repo layout/package paths', () => {
    const script = path.join(tempDir, 'sandbox-windows.ps1');
    writeFileSync(script, '#', 'utf8');
    process.env.AURAXIS_SANDBOX_PS1 = script;
    expect(sandboxScriptPath('restricted')).toBe(script);

    delete process.env.AURAXIS_SANDBOX_PS1;
    const repoLayout = path.join(tempDir, 'electron', 'sandbox-windows.ps1');
    mkdirSync(path.dirname(repoLayout), { recursive: true });
    writeFileSync(repoLayout, '#', 'utf8');
    expect(sandboxScriptPath('restricted')).toBe(repoLayout);

    const packaged = path.join(tempDir, 'sandbox', 'sandbox-linux.sh');
    mkdirSync(path.dirname(packaged), { recursive: true });
    writeFileSync(packaged, '#', 'utf8');
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = path.join(tempDir, 'sandbox');
    expect(sandboxScriptPath('linux')).not.toBeNull();
  });

  it('reports platform support and missing script as unsupported', () => {
    const backend = currentBackend();
    provisionScript(backend);
    expect(isSandboxSupported(backend)).toBe(true);
    for (const other of (['restricted', 'linux', 'macos'] as const).filter((b) => b !== backend)) {
      expect(isSandboxSupported(other)).toBe(false);
    }
  });
});

describe('sandbox-runner — command execution', () => {
  it('rejects mismatched platform and missing scripts', async () => {
    // 用与当前平台不匹配的后端，任何平台上都应直接拒绝。
    const mismatched = process.platform === 'win32' ? 'linux' : 'restricted';
    expect(await runSandboxedCommand({ argv: [], cwd: tempDir, backend: mismatched })).toMatchObject({
      supported: false,
    });
  });

  it('streams output, handles close success and spawn errors', async () => {
    const backend = currentBackend();
    provisionScript(backend);
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);
    const onStdout = vi.fn();
    const promise = runSandboxedCommand({
      argv: ['echo', 'hello'],
      cwd: tempDir,
      projectRoot: tempDir,
      backend,
      onStdout,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.emit('close', 0);
    expect(await promise).toMatchObject({ supported: true, exitCode: 0 });
    expect(onStdout).toHaveBeenCalledWith('hello\n');

    const errorChild = fakeChild();
    spawnMock.mockReturnValue(errorChild as never);
    const errorPromise = runSandboxedCommand({ argv: [], cwd: tempDir, backend });
    // linux/macos 后端在 spawn 前会先 mkdtemp 写目录，第二次 spawn 是异步的；
    // 必须等第二次调用真正发生，否则 error 事件会在监听器挂上之前被 emit。
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    errorChild.emit('error', new Error('spawn failed'));
    expect(await errorPromise).toMatchObject({ supported: true, error: expect.stringContaining('spawn failed') });
  });

  it('covers appcontainer write dir and launch-error fail-closed branches', async () => {
    provisionScript('appcontainer');
    if (process.platform !== 'win32') {
      // 非 Windows 上 appcontainer 直接 fail-closed，spawn 不应发生。
      expect(
        await runSandboxedCommand({
          argv: [],
          cwd: tempDir,
          projectRoot: tempDir,
          mode: 'read',
          backend: 'appcontainer',
        }),
      ).toMatchObject({ supported: false, error: expect.stringContaining('不适用于当前平台') });
      return;
    }
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);
    const promise = runSandboxedCommand({
      argv: [],
      cwd: tempDir,
      projectRoot: tempDir,
      mode: 'read',
      backend: 'appcontainer',
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('SANDBOX_LAUNCH_ERROR\n'));
    child.emit('close', 0);
    expect(await promise).toMatchObject({ error: expect.stringContaining('fail-closed') });
  });

  it('resolves linux/macos platform backends and runs shell spawns', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const script = path.join(tempDir, 'sandbox-linux.sh');
      writeFileSync(script, '#', 'utf8');
      process.env.AURAXIS_LINUX_SCRIPT = script;
      expect(sandboxBackend()).toBe('linux');
      expect(sandboxScriptPath('linux')).toBe(script);
      expect(isSandboxSupported('linux')).toBe(true);

      const child = fakeChild();
      spawnMock.mockReturnValue(child as never);
      const promise = runSandboxedCommand({ argv: ['echo', 'x'], cwd: tempDir, backend: 'linux' });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      child.emit('close', 0);
      expect(await promise).toMatchObject({ supported: true, exitCode: 0 });
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('kills timeout and abort paths', async () => {
    const backend = currentBackend();
    provisionScript(backend);

    const timeoutChild = fakeChild();
    spawnMock.mockReturnValue(timeoutChild as never);
    const timeoutPromise = runSandboxedCommand({
      argv: [],
      cwd: tempDir,
      backend,
      timeoutMs: 1,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 5));
    // POSIX 后端用进程组 process.kill 终止整棵树；Windows 直接 kill 子进程。
    if (process.platform === 'win32') expect(timeoutChild.kill).toHaveBeenCalled();
    timeoutChild.emit('close', 0);
    expect(await timeoutPromise).toMatchObject({ timedOut: true });

    const abortChild = fakeChild();
    spawnMock.mockReturnValue(abortChild as never);
    const ctrl = new AbortController();
    const abortPromise = runSandboxedCommand({
      argv: [],
      cwd: tempDir,
      backend,
      signal: ctrl.signal,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    ctrl.abort();
    if (process.platform === 'win32') expect(abortChild.kill).toHaveBeenCalled();
    abortChild.emit('close', 0);
    expect(await abortPromise).toMatchObject({ supported: true });
  });
});
