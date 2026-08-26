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
  it('resolves backend from env and defaults to Windows restricted', () => {
    expect(sandboxBackend()).toBe('restricted');
    process.env.AURAXIS_SANDBOX_BACKEND = 'appcontainer';
    expect(sandboxBackend()).toBe('appcontainer');
    process.env.AURAXIS_SANDBOX_BACKEND = 'linux';
    expect(sandboxBackend()).toBe('restricted');
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
    const script = path.join(tempDir, 'sandbox-windows.ps1');
    writeFileSync(script, '#', 'utf8');
    process.env.AURAXIS_SANDBOX_PS1 = script;
    expect(isSandboxSupported('restricted')).toBe(true);
    expect(isSandboxSupported('linux')).toBe(false);
    expect(isSandboxSupported('macos')).toBe(false);
  });
});

describe('sandbox-runner — command execution', () => {
  it('rejects mismatched platform and missing scripts', async () => {
    expect(await runSandboxedCommand({ argv: [], cwd: tempDir, backend: 'linux' })).toMatchObject({
      supported: false,
    });
  });

  it('streams output, handles close success and spawn errors', async () => {
    const script = path.join(tempDir, 'sandbox-windows.ps1');
    writeFileSync(script, '#', 'utf8');
    const child = fakeChild();
    spawnMock.mockReturnValue(child as never);
    const onStdout = vi.fn();
    const promise = runSandboxedCommand({
      argv: ['echo', 'hello'],
      cwd: tempDir,
      projectRoot: tempDir,
      backend: 'restricted',
      onStdout,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.emit('close', 0);
    expect(await promise).toMatchObject({ supported: true, exitCode: 0 });
    expect(onStdout).toHaveBeenCalledWith('hello\n');

    const errorChild = fakeChild();
    spawnMock.mockReturnValue(errorChild as never);
    const errorPromise = runSandboxedCommand({ argv: [], cwd: tempDir, backend: 'restricted' });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    errorChild.emit('error', new Error('spawn failed'));
    expect(await errorPromise).toMatchObject({ supported: true, error: expect.stringContaining('spawn failed') });
  });

  it('covers appcontainer write dir and launch-error fail-closed branches', async () => {
    const script = path.join(tempDir, 'sandbox-appcontainer.ps1');
    writeFileSync(script, '#', 'utf8');
    process.env.AURAXIS_APPCONTAINER_PS1 = script;
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
    const script = path.join(tempDir, 'sandbox-windows.ps1');
    writeFileSync(script, '#', 'utf8');
    process.env.AURAXIS_SANDBOX_PS1 = script;

    const timeoutChild = fakeChild();
    spawnMock.mockReturnValue(timeoutChild as never);
    const timeoutPromise = runSandboxedCommand({
      argv: [],
      cwd: tempDir,
      backend: 'restricted',
      timeoutMs: 1,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 5));
    expect(timeoutChild.kill).toHaveBeenCalled();
    timeoutChild.emit('close', 0);
    expect(await timeoutPromise).toMatchObject({ timedOut: true });

    const abortChild = fakeChild();
    spawnMock.mockReturnValue(abortChild as never);
    const ctrl = new AbortController();
    const abortPromise = runSandboxedCommand({
      argv: [],
      cwd: tempDir,
      backend: 'restricted',
      signal: ctrl.signal,
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    ctrl.abort();
    expect(abortChild.kill).toHaveBeenCalled();
    abortChild.emit('close', 0);
    expect(await abortPromise).toMatchObject({ supported: true });
  });
});
