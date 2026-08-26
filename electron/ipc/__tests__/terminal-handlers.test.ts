import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  win: null as null | any,
}));

// 单元测试不真正拉起系统 shell：node-pty 的 CJS require 无法被 vi.mock
// 拦截，且真实 spawn 依赖运行环境（macOS CI 上 posix_spawnp 可能失败）。
// 通过 setPtyModuleForTests 注入可控的假 PTY，验证 handler 接线与生命周期。
const ptyMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));
const childMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: childMock.spawn,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((ch: string, fn: Function) => h.handlers.set(ch, fn)) },
  BrowserWindow: { fromWebContents: () => h.win },
}));
vi.mock('../pty-tool', () => ({
  ptyRegistry: {
    peek: vi.fn(() => null),
    subscribe: vi.fn(() => () => {}),
    write: vi.fn(() => false),
  },
}));

import {
  registerTerminalHandlers,
  registerAgentShellHandlers,
  setPtyModuleForTests,
  cleanupAgentShellWatchers,
  cleanupTerminalSessions,
} from '../terminal-handlers';
import { ptyRegistry } from '../pty-tool';

function makeWin() {
  return { id: 1, isDestroyed: () => false, webContents: { send: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupTerminalSessions();
  cleanupAgentShellWatchers();
  h.handlers.clear();
  h.win = makeWin();
  vi.mocked(ptyRegistry.peek).mockReturnValue(null);
  vi.mocked(ptyRegistry.subscribe).mockReturnValue(() => {});
  vi.mocked(ptyRegistry.write).mockReturnValue(false);
  ptyMock.spawn.mockImplementation(() => {
    const listeners: { data?: (d: string) => void; exit?: (info: { exitCode: number }) => void } = {};
    return {
      onData: vi.fn((cb: (d: string) => void) => {
        listeners.data = cb;
      }),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        listeners.exit = cb;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => listeners.exit?.({ exitCode: 0 })),
    };
  });
  childMock.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = vi.fn();
    return child;
  });
  setPtyModuleForTests({ spawn: ptyMock.spawn });
  registerTerminalHandlers();
  registerAgentShellHandlers();
});

const create = (payload: any) => h.handlers.get('terminal:create')!({ sender: {} }, payload);
const attach = (agentId: any) => h.handlers.get('agentShell:attach')!({ sender: {} }, agentId);

describe('terminal:create / input / resize / kill', () => {
  it('校验窗口/ID/重复', () => {
    h.win = null;
    expect(create({ id: 't1' })).toEqual({ ok: false, error: '窗口无效' });
    h.win = makeWin();
    expect(create({})).toEqual({ ok: false, error: '终端 ID 无效' });
    expect(create({ id: 't1' })).toEqual({ ok: true });
    expect(create({ id: 't1' })).toEqual({ ok: false, error: '终端已存在' });
  });

  it('创建后转发输出、退出时清理会话', async () => {
    expect(create({ id: 't2' })).toEqual({ ok: true });
    const input = h.handlers.get('terminal:input')! as any;
    const resize = h.handlers.get('terminal:resize')! as any;
    const kill = h.handlers.get('terminal:kill')! as any;

    expect(input({}, 't2', 'ls\r')).toEqual({ ok: true });
    expect(resize({}, 't2', 100, 30)).toEqual({ ok: true });
    expect(input({}, 'missing', 'x')).toEqual({ ok: false });
    expect(kill({}, 'missing')).toEqual({ ok: false });
    expect(kill({}, 't2')).toEqual({ ok: true });

    // 退出后同 ID 可重建（真实 PTY 退出可能稍慢）
    await vi.waitFor(() => expect(create({ id: 't2' })).toEqual({ ok: true }), { timeout: 8000 });
  });

  it('pipe 回退路径创建会话并在 kill 后清理', () => {
    setPtyModuleForTests(null);
    expect(create({ id: 't9' })).toEqual({ ok: true });
    const kill = h.handlers.get('terminal:kill')! as any;
    expect(kill({}, 't9')).toEqual({ ok: true });
  });
});

describe('agentShell: attach / detach / write', () => {
  const detach = () => h.handlers.get('agentShell:detach')!({}, 'a1');
  const write = (data: any) => h.handlers.get('agentShell:write')!({}, 'a1', data);

  it('校验 agentId 与窗口', () => {
    expect(h.handlers.get('agentShell:attach')!({ sender: {} }, '')).toEqual({ ok: false, error: 'agentId 无效' });
    h.win = null;
    expect(attach('a1')).toEqual({ ok: false, error: '窗口无效' });
    h.win = makeWin();
    expect(attach('a1')).toEqual({ ok: false, error: expect.stringContaining('持久 shell 会话') });
  });

  it('附加订阅并返回缓冲/退出标记，重复附加同窗复用', () => {
    vi.mocked(ptyRegistry.peek).mockReturnValue({ buffer: 'hello', exited: false } as any);
    const unsub = vi.fn();
    vi.mocked(ptyRegistry.subscribe).mockReturnValue(unsub);

    const first = attach('a1');
    expect(first).toEqual({ ok: true, buffer: 'hello', exited: false });
    expect(ptyRegistry.subscribe).toHaveBeenCalledTimes(1);

    const second = attach('a1');
    expect(second).toEqual({ ok: true, buffer: 'hello', exited: false });
    expect(ptyRegistry.subscribe).toHaveBeenCalledTimes(1);

    expect(detach()).toEqual({ ok: true });
    expect(unsub).toHaveBeenCalled();
    expect(detach()).toEqual({ ok: true });
  });

  it('订阅失败报错', () => {
    vi.mocked(ptyRegistry.peek).mockReturnValue({ buffer: '', exited: false } as any);
    vi.mocked(ptyRegistry.subscribe).mockReturnValue(null as any);
    expect(attach('a1')).toEqual({ ok: false, error: '无法订阅会话' });
  });

  it('write 仅允许控制字符', () => {
    expect(write(123)).toEqual({ ok: false, error: '参数无效' });
    expect(write('ls')).toEqual({ ok: false, error: '任务 Shell 仅允许发送控制字符' });
    vi.mocked(ptyRegistry.write).mockReturnValueOnce(true);
    expect(write('\x03')).toEqual({ ok: true });
    expect(write('\x03')).toEqual({ ok: false, error: '会话不存在' });
  });

  it('清理函数断开全部 watcher 与会话', () => {
    vi.mocked(ptyRegistry.peek).mockReturnValue({ buffer: '', exited: false } as any);
    const unsub = vi.fn();
    vi.mocked(ptyRegistry.subscribe).mockReturnValue(unsub);
    attach('a1');
    cleanupAgentShellWatchers();
    expect(unsub).toHaveBeenCalled();

    cleanupTerminalSessions();
    expect(create({ id: 't1' })).toEqual({ ok: true });
    cleanupTerminalSessions();
  });
});
