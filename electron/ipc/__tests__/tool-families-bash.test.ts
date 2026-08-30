import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';

const childMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock('child_process', () => ({
  spawn: childMocks.spawn,
  execSync: childMocks.execSync,
  spawnSync: childMocks.spawnSync,
}));
vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));
vi.mock('../bash-session', () => ({
  runBashPersistent: vi.fn(async () => null),
}));
vi.mock('../../sandbox-runner', () => ({
  isSandboxSupported: vi.fn(() => true),
  runSandboxedCommand: vi.fn(async () => ({ exitCode: 0, error: undefined, timedOut: false })),
}));
vi.mock('../task-monitor', () => ({
  startBashTask: vi.fn(() => 'task-1'),
  finishBashTask: vi.fn(),
  setTaskStopper: vi.fn(),
  stopTask: vi.fn(() => false),
  listTasks: vi.fn(() => []),
}));
vi.mock('../../skill-store', () => ({
  ensureSkillsDirectory: vi.fn(async () => {}),
  listSkills: vi.fn(async () => ({ skills: [], complete: true })),
  readSkill: vi.fn(async () => null),
  writeSkill: vi.fn(),
}));
vi.mock('../../attachments', () => ({
  attachmentMimeFor: vi.fn(() => 'image/png'),
  storeAttachment: vi.fn(async () => ({ id: 'a', mime: 'image/png', bytes: 1 })),
  attachmentDataUrl: vi.fn(() => 'data:image/png;base64,AA=='),
  MAX_ATTACHMENT_BYTES: 1024,
}));
vi.mock('../../fts', () => ({ sessionQuerySearch: vi.fn(async () => []) }));
vi.mock('../../spill', () => ({ readSpill: vi.fn(async () => ({ content: '', bytes: 0 })) }));
vi.mock('../../web-search', () => ({
  searchWithProvider: vi.fn(async () => ({ results: [], providerId: 'ddg', usedFallback: false })),
}));
vi.mock('../../lsp-client', () => ({ queryLsp: vi.fn(async () => ({ ok: false })) }));
vi.mock('../settings-store', () => ({ readSettings: vi.fn(async () => ({})) }));
vi.mock('../ask-handlers', () => ({ askUser: vi.fn(async () => 'answer') }));
vi.mock('../pty-tool', () => ({
  runPtyTool: vi.fn(async () => ({ output: {} })),
  ptyRegistry: {
    list: vi.fn(() => []),
    create: vi.fn(),
    write: vi.fn(() => true),
    read: vi.fn(async () => null),
    close: vi.fn(),
    clearOwner: vi.fn(),
  },
}));
vi.mock('../dynamic-plugin', () => ({
  mountDynamicPlugin: vi.fn(() => ({ ok: true })),
  unmountDynamicPlugin: vi.fn(() => ({ ok: true })),
  getDynamicTool: vi.fn(() => undefined),
  executeDynamicTool: vi.fn(async () => ({ output: null })),
}));
vi.mock('../../tool-registry', () => ({
  executeMcpTool: vi.fn(),
  getAllTools: vi.fn(() => []),
  invalidateMcpToolCache: vi.fn(),
}));
vi.mock('../../runtime-inspect', () => ({
  inspectRuntime: vi.fn(async () => ({ tools: [], plugins: [], dynamicPlugins: [], skills: [] })),
}));
vi.mock('../goal-store', () => ({
  getGoal: vi.fn(async () => null),
  createGoal: vi.fn(async () => null),
  editGoal: vi.fn(async () => null),
  pauseGoal: vi.fn(async () => null),
  resumeGoal: vi.fn(async () => null),
  completeGoal: vi.fn(async () => null),
  blockGoal: vi.fn(async () => null),
}));

import { executeToolCall, abortTool } from '../tool-handlers';
import { isSandboxSupported, runSandboxedCommand } from '../../sandbox-runner';
import { finishBashTask } from '../task-monitor';

function fakeChild() {
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn(() => {
    c.killed = true;
  });
  c.pid = 1234;
  c.exitCode = null;
  c.killed = false;
  return c;
}

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: os.tmpdir(),
    requestId: 'bash-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

let lastChild: any;

beforeEach(() => {
  vi.clearAllMocks();
  childMocks.spawn.mockImplementation(() => {
    lastChild = fakeChild();
    return lastChild;
  });
  childMocks.execSync.mockImplementation(() => {
    throw new Error('not found');
  });
  vi.mocked(isSandboxSupported).mockReturnValue(true);
  vi.mocked(runSandboxedCommand).mockResolvedValue({ exitCode: 0, error: undefined, timedOut: false, supported: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Bash — 参数校验', () => {
  it('workspace-write 下拒绝越界 workdir', async () => {
    // 跨平台越界路径：项目根（os.tmpdir()）的父目录之外。
    const outside = path.resolve(os.tmpdir(), '..', `auraxis-outside-${process.pid}`);
    const r = await executeToolCall(
      'Bash',
      { command: 'ls', workdir: outside },
      ctx({ sandboxMode: 'workspace-write' }),
    );
    expect(r.error).toContain('工作目录超出项目边界');
  });

  it('sandbox_permissions 与 justification 配对校验', async () => {
    expect((await executeToolCall('Bash', { command: 'ls', sandbox_permissions: 'full' }, ctx())).error).toContain(
      'justification',
    );
    expect((await executeToolCall('Bash', { command: 'ls', justification: 'x' }, ctx())).error).toContain(
      '仅在同时设置',
    );
    expect(
      (await executeToolCall('Bash', { command: 'ls', sandbox_permissions: 'bogus', justification: 'x' }, ctx())).error,
    ).toContain('无效的 sandbox_permissions');
  });

  it('受限沙箱下拒绝后台执行', async () => {
    const r = await executeToolCall('Bash', { command: 'ls', run_in_background: true }, ctx({ sandboxMode: 'read' }));
    expect(r.error).toContain('受限沙箱模式暂不支持后台');
  });

  it('原生沙箱不可用时拒绝受限执行', async () => {
    vi.mocked(isSandboxSupported).mockReturnValueOnce(false);
    const r = await executeToolCall('Bash', { command: 'ls' }, ctx({ sandboxMode: 'workspace-write' }));
    expect(r.error).toContain('原生沙箱不可用');
  });
});

describe('Pwsh — 本地 PowerShell 执行', () => {
  it('validates command and routes to the platform shell', async () => {
    expect((await executeToolCall('Pwsh', {}, ctx())).error).toContain('缺少 command');
    if (process.platform === 'win32') {
      const promise = executeToolCall('Pwsh', { command: 'Write-Output hi', workdir: '.', timeout: 1000 }, ctx());
      await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
      expect(childMocks.spawn.mock.calls[0][0]).toBe('powershell.exe');
      lastChild.stdout.emit('data', Buffer.from('hi\n'));
      lastChild.emit('close', 0);
      const result = await promise;
      expect(result.output).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
    } else {
      // POSIX：execSync 默认抛错 → pwsh 未找到，直接返回不可用且不 spawn。
      const result = await executeToolCall('Pwsh', { command: 'Write-Output hi', workdir: '.', timeout: 1000 }, ctx());
      expect(result.error).toContain('pwsh 不可用');
      expect(childMocks.spawn).not.toHaveBeenCalled();
    }
  });

  it('uses pwsh when detected and rejects invalid timeout', async () => {
    childMocks.execSync.mockRestore();
    vi.mocked(childMocks.execSync).mockImplementation(() => '');
    const promise = executeToolCall('Pwsh', { command: 'Get-Date', timeout: -1 }, ctx());
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
    expect(childMocks.spawn.mock.calls[0][0]).toBe('pwsh');
    lastChild.emit('close', 0);
    await promise;
  });

  it('covers the Windows powershell.exe fallback on any host', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      childMocks.spawn.mockClear();
      childMocks.execSync.mockImplementation(() => {
        throw new Error('not found');
      });
      const promise = executeToolCall('Pwsh', { command: 'Write-Output hi', workdir: '.', timeout: 1000 }, ctx());
      await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
      expect(childMocks.spawn.mock.calls[0][0]).toBe('powershell.exe');
      lastChild.emit('close', 0);
      await promise;
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it.runIf(process.platform === 'win32')('routes Pwsh through the native sandbox in workspace-write mode', async () => {
    vi.mocked(runSandboxedCommand).mockImplementation(async ({ onStdout }: any) => {
      onStdout('sandboxed');
      return { exitCode: 0, error: undefined, timedOut: false, supported: true };
    });
    const r = await executeToolCall(
      'Pwsh',
      { command: 'Write-Output hi', workdir: '.', timeout: 1000 },
      ctx({ sandboxMode: 'workspace-write', autoApprove: false }),
    );
    expect(r.output).toMatchObject({ stdout: 'sandboxed', exitCode: 0 });
    expect(runSandboxedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'workspace-write',
        argv: expect.arrayContaining([expect.stringContaining('powershell'), '-NoProfile', '-NonInteractive']),
      }),
    );
  });
});

describe('Bash — 一次性执行', () => {
  it('covers the Windows shell fallback chain on any host', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      childMocks.spawn.mockClear();
      const promise = executeToolCall('Bash', { command: 'echo hi', timeout: 1000 }, ctx());
      await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
      expect(typeof childMocks.spawn.mock.calls[0][0]).toBe('string');
      lastChild.emit('close', 0);
      await promise;
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('正常输出与退出码', async () => {
    const p = executeToolCall('Bash', { command: 'echo hi', timeout: 10000 }, ctx());
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
    lastChild.stdout.emit('data', Buffer.from('hello'));
    lastChild.stderr.emit('data', Buffer.from('warn'));
    lastChild.emit('close', 0);
    const r = await p;
    expect(r.output).toMatchObject({ stdout: 'hello', stderr: 'warn', exitCode: 0 });
    expect(finishBashTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ exitCode: 0 }));
  });

  it('spawn 错误透传', async () => {
    const p = executeToolCall('Bash', { command: 'ls' }, ctx());
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
    lastChild.emit('error', new Error('EACCES'));
    const r = await p;
    expect(r.error).toContain('EACCES');
  });

  it('abortTool 触发用户中止', async () => {
    const p = executeToolCall('Bash', { command: 'sleep 10' }, ctx({ toolCallId: 'bash-tc' }));
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
    expect(abortTool('bash-tc')).toBe(true);
    lastChild.emit('close', null);
    const r = await p;
    expect(r.error).toBe('用户手动中止');
    expect(abortTool('bash-tc')).toBe(false);
  });

  it('命令超时强制终止', async () => {
    vi.useFakeTimers();
    const p = executeToolCall('Bash', { command: 'sleep 100', timeout: 1000 }, ctx());
    await vi.waitFor(() => expect(childMocks.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1000);
    expect(lastChild.kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.error).toContain('命令超时');
  });
});

describe('Bash — 后台任务', () => {
  it('run_in_background 立即返回任务 id，关闭时缓存结果', async () => {
    const r = await executeToolCall('Bash', { command: 'npm run build', run_in_background: true }, ctx());
    expect(r.output).toMatchObject({ background: true, taskId: 'task-1' });
    lastChild.emit('close', 0);
    await vi.waitFor(() => expect(finishBashTask).toHaveBeenCalled());
    expect(finishBashTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ exitCode: 0 }));
  });
});

describe('Bash — 原生沙箱路径', () => {
  it('沙箱不可用时报错', async () => {
    vi.mocked(isSandboxSupported).mockReturnValueOnce(false);
    const r = await executeToolCall('Bash', { command: 'ls' }, ctx({ sandboxMode: 'read' }));
    expect(r.error).toContain('原生沙箱不可用');
  });

  it('沙箱执行成功并转发输出', async () => {
    vi.mocked(runSandboxedCommand).mockImplementation(async ({ onStdout, onStderr }: any) => {
      onStdout('out');
      onStderr('err');
      return { exitCode: 0, error: undefined, timedOut: false, supported: true };
    });
    const r = await executeToolCall('Bash', { command: 'ls' }, ctx({ sandboxMode: 'workspace-write' }));
    expect(r.output).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 0 });
    expect(runSandboxedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'workspace-write',
        argv: expect.arrayContaining([expect.stringContaining('bash'), '-c', 'ls']),
      }),
    );
  });

  it('沙箱错误与超时透传', async () => {
    vi.mocked(runSandboxedCommand).mockResolvedValueOnce({
      exitCode: 2,
      error: 'sandbox boom',
      timedOut: true,
      supported: true,
    });
    const r = await executeToolCall('Bash', { command: 'ls' }, ctx({ sandboxMode: 'read' }));
    expect(r.error).toBe('sandbox boom');
  });
});
