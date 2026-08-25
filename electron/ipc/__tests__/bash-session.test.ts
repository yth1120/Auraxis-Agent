import { describe, it, expect, beforeEach, vi } from 'vitest';

const pty = vi.hoisted(() => ({
  list: vi.fn(() => []),
  create: vi.fn(),
  write: vi.fn(() => true),
  read: vi.fn(async () => null),
  close: vi.fn(),
}));

vi.mock('../pty-tool', () => ({
  ptyRegistry: pty,
}));

import { runBashPersistent, parseExitMarker } from '../bash-session';

function ctx(overrides: Record<string, unknown> = {}) {
  return { requestId: 'req-1', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  pty.list.mockReturnValue([]);
  pty.write.mockReturnValue(true);
  pty.read.mockResolvedValue(null);
});

describe('runBashPersistent', () => {
  it('无 owner 时返回 null', async () => {
    expect(await runBashPersistent('ls', 'C:/', ctx({ agentId: '', requestId: '' }))).toBeNull();
  });

  it('创建会话并执行包装命令，解析退出码', async () => {
    const onProgress = vi.fn();
    pty.read.mockResolvedValueOnce({ output: 'hello\n__AURAXIS_EXIT_0__\n' } as any);
    const r = await runBashPersistent('echo hello', 'C:/proj', ctx({ onProgress }));

    expect(pty.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'req-1', cwd: 'C:/proj' }));
    expect(pty.write).toHaveBeenCalledWith(
      'bash-req-1',
      'req-1',
      expect.stringContaining("{ eval 'echo hello'; } 2>&1; echo -e"),
      true,
    );
    expect(onProgress).toHaveBeenCalledWith('hello\n__AURAXIS_EXIT_0__\n');
    expect(r).toMatchObject({
      output: { stdout: 'hello', exitCode: 0 },
    });
  });

  it('写入失败返回 null', async () => {
    pty.write.mockReturnValueOnce(false);
    expect(await runBashPersistent('ls', 'C:/', ctx())).toBeNull();
  });

  it('会话消失返回 null', async () => {
    pty.read.mockResolvedValueOnce(null);
    expect(await runBashPersistent('ls', 'C:/', ctx())).toBeNull();
  });

  it('输出无退出码时返回错误', async () => {
    pty.read.mockResolvedValue({ output: 'nothing here' } as any);
    const r = await runBashPersistent('ls', 'C:/', ctx());
    expect(r!.error).toContain('未返回退出码');
  });

  it('信号中止时关闭会话并返回取消错误', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runBashPersistent('ls', 'C:/', ctx({ abortSignal: ctrl.signal }));
    expect(r).toMatchObject({ error: '用户手动中止' });
    expect(pty.close).toHaveBeenCalledWith('bash-req-1', 'req-1');
  });

  it('异常时回退 one-shot 并尝试关闭', async () => {
    pty.list.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await runBashPersistent('ls', 'C:/', ctx())).toBeNull();
    expect(pty.close).toHaveBeenCalled();
  });
});

describe('stripEcho（经 runBashPersistent 输出）', () => {
  it('剥掉回显的包装块，保留多行命令输出', async () => {
    pty.read.mockResolvedValueOnce({
      output: '{ eval \'ls\'; } 2>&1; echo -e "\\n__AURAXIS_EXIT_$?__"\nfile1\nfile2\n__AURAXIS_EXIT_0__\n',
    } as any);
    const r = await runBashPersistent('ls', 'C:/', ctx());
    expect(r!.output.stdout).toBe('file1\nfile2');
  });
});

describe('parseExitMarker', () => {
  it('取最后一个真实标记', () => {
    const parsed = parseExitMarker('a\n__AURAXIS_EXIT_1__\nb\n__AURAXIS_EXIT_2__\n');
    expect(parsed).toEqual({ exitCode: 2, text: 'a\n__AURAXIS_EXIT_1__\nb' });
  });
});
