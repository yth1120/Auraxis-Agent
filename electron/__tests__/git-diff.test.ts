import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * git 变更范围：命令拼装 + 输出解析 + 内容读取的容错。
 * 只 mock 掉 execFile（不碰真实仓库），文件读取走真实临时目录。
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

import { buildGitDiffs, detectBaseRef, parsePorcelain, isGitUnavailableError } from '../git-diff';

type FakeResult = { stdout?: string | Buffer; error?: Error };

/** 让 execFile 按参数返回预设结果；未命中即视为命令失败。 */
function respond(impl: (args: string[]) => FakeResult) {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string | Buffer) => void) => {
      const r = impl(args);
      queueMicrotask(() => cb(r.error ?? null, r.stdout ?? ''));
    },
  );
}

function errorWith(stderr: string): Error {
  const err = new Error('command failed') as Error & { stderr?: string };
  err.stderr = stderr;
  return err;
}

const testDir = path.join(os.tmpdir(), 'auraxis-gitdiff-test-' + Date.now());

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('parsePorcelain', () => {
  it('解析状态码与路径，忽略过短片段', () => {
    const raw = 'M  src/a.ts\0?? src/b.ts\0\0';
    expect(parsePorcelain(raw)).toEqual([
      { code: 'M ', relPath: 'src/a.ts' },
      { code: '??', relPath: 'src/b.ts' },
    ]);
  });

  it('重命名条目只取新路径（旧路径那一段不能当成独立条目）', () => {
    // porcelain -z 的重命名是「状态 + 新路径 + 旧路径」
    const raw = 'R  src/new.ts\0src/old.ts\0M  src/c.ts\0';
    expect(parsePorcelain(raw)).toEqual([
      { code: 'R ', relPath: 'src/new.ts' },
      { code: 'M ', relPath: 'src/c.ts' },
    ]);
  });
});

describe('detectBaseRef', () => {
  it('按 main → master 顺序探测，返回第一个存在的', async () => {
    respond((args) =>
      args[0] === 'rev-parse' && args[3] === 'master^{commit}' ? { stdout: 'sha\n' } : { error: errorWith('bad rev') },
    );
    await expect(detectBaseRef(testDir)).resolves.toBe('master');
  });

  it('都没有时返回 null', async () => {
    respond(() => ({ error: errorWith('bad rev') }));
    await expect(detectBaseRef(testDir)).resolves.toBeNull();
  });
});

describe('未提交（uncommitted）', () => {
  it('未跟踪文件：旧内容为空，新内容取工作区；已删除文件：新内容为空', async () => {
    fs.writeFileSync(path.join(testDir, 'new.ts'), 'export const a = 1;\n', 'utf-8');
    const status = '?? new.ts\0 D old.ts\0';

    respond((args) => {
      if (args[0] === 'status') return { stdout: status };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      if (args[0] === 'show') return { stdout: 'export const old = 1;\n' };
      return { error: errorWith('unexpected') };
    });

    const diffs = await buildGitDiffs('uncommitted', testDir);
    expect(diffs.map((d) => d.path)).toEqual(['new.ts', 'old.ts']);

    const added = diffs.find((d) => d.path === 'new.ts')!;
    expect(added.oldContent).toBe('');
    expect(added.newContent).toBe('export const a = 1;\n');

    const deleted = diffs.find((d) => d.path === 'old.ts')!;
    expect(deleted.oldContent).toBe('export const old = 1;\n');
    expect(deleted.newContent).toBe('');
  });

  it('二进制文件内容被扣下，以 skipped 呈现', async () => {
    fs.writeFileSync(path.join(testDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    respond((args) => {
      if (args[0] === 'status') return { stdout: '?? bin.dat\0' };
      if (args[0] === 'rev-parse') return { stdout: 'sha\n' };
      return { error: errorWith('unexpected') };
    });

    const diffs = await buildGitDiffs('uncommitted', testDir);
    expect(diffs).toEqual([{ path: 'bin.dat', skipped: 'binary' }]);
  });

  it('不是 git 仓库时给出可识别的错误类型', async () => {
    respond(() => ({ error: errorWith('fatal: not a git repository (or any of the parent directories)') }));
    await expect(buildGitDiffs('uncommitted', testDir)).rejects.toSatisfy(isGitUnavailableError);
  });
});

describe('整分支（branch）', () => {
  it('缺少基线分支时直接报错，不返回空列表', async () => {
    respond(() => ({ error: errorWith('bad rev') }));
    await expect(buildGitDiffs('branch', testDir)).rejects.toThrow(/基线分支/);
  });

  it('以 merge-base 为旧侧、HEAD 为新侧；重命名条目跳过多余的原路径段', async () => {
    respond((args) => {
      if (args[0] === 'rev-parse')
        return args[3] === 'main^{commit}' ? { stdout: 'sha\n' } : { error: errorWith('bad rev') };
      if (args[0] === 'merge-base') return { stdout: 'base-sha\n' };
      if (args[0] === 'diff') return { stdout: 'M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0' };
      if (args[0] === 'show') {
        const spec = args[1];
        if (spec.startsWith('base-sha:')) return { stdout: 'before\n' };
        return { stdout: 'after\n' };
      }
      return { error: errorWith('unexpected') };
    });

    const diffs = await buildGitDiffs('branch', testDir);
    expect(diffs.map((d) => d.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(diffs[0]).toEqual({ path: 'src/a.ts', oldContent: 'before\n', newContent: 'after\n' });
  });
});
