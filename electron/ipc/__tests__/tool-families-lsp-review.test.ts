import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'auraxis-lsp-'));
// 与 tool-handlers.ts 的跨平台命令解析保持一致：Windows 需要 .cmd 后缀。
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const spawnSyncMock = vi.hoisted(() =>
  vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), error: undefined })),
);

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
  spawn: vi.fn(),
  execSync: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
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
vi.mock('../../lsp-client', () => ({
  queryLsp: vi.fn(async () => ({ ok: false })),
}));

import { executeToolCall, clearWorktreeSession } from '../tool-handlers';
import { queryLsp } from '../../lsp-client';

let root = '';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    requestId: 'lr-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

function writeNotebook(
  p = 'nb.ipynb',
  cells = [{ cell_type: 'code', source: ['print(1)'], metadata: {}, execution_count: 1, outputs: [] }],
) {
  const file = path.join(root, p);
  writeFileSync(file, JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }), 'utf-8');
  return file;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot, 'proj-'));
  vi.clearAllMocks();
  clearWorktreeSession('lr-1');
  spawnSyncMock.mockReturnValue({
    status: 0,
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    error: undefined,
  } as any);
  vi.mocked(queryLsp).mockResolvedValue({ ok: false });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('NotebookEdit', () => {
  it('read 返回单元格源码/类型/执行次数', async () => {
    writeNotebook();
    const r = await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', action: 'read', cell_index: 0 }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.output).toMatchObject({ cell_index: 0, cell_type: 'code', source: 'print(1)', execution_count: 1 });
  });

  it('write / insert / delete 修改单元格', async () => {
    writeNotebook();
    const w = await executeToolCall(
      'NotebookEdit',
      { file_path: 'nb.ipynb', action: 'write', cell_index: 0, source: 'a\nb' },
      ctx(),
    );
    expect(w.error).toBeUndefined();
    let nb = JSON.parse(readFileSync(path.join(root, 'nb.ipynb'), 'utf-8'));
    expect(nb.cells[0].source).toEqual(['a', 'b']);

    const ins = await executeToolCall(
      'NotebookEdit',
      { file_path: 'nb.ipynb', action: 'insert', source: 'x\ny', cell_type: 'markdown' },
      ctx(),
    );
    expect((ins.output as any).cell_index).toBe(1);
    nb = JSON.parse(readFileSync(path.join(root, 'nb.ipynb'), 'utf-8'));
    expect(nb.cells[1].cell_type).toBe('markdown');

    const del = await executeToolCall(
      'NotebookEdit',
      { file_path: 'nb.ipynb', action: 'delete', cell_index: 0 },
      ctx(),
    );
    expect(del.error).toBeUndefined();
    nb = JSON.parse(readFileSync(path.join(root, 'nb.ipynb'), 'utf-8'));
    expect(nb.cells).toHaveLength(1);
  });

  it('越界/缺参/类型/损坏文件均被拒绝', async () => {
    writeNotebook();
    expect((await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', cell_index: 5 }, ctx())).error).toContain(
      '超出范围',
    );
    expect((await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', cell_index: -1 }, ctx())).error).toContain(
      '超出范围',
    );
    expect(
      (await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', action: 'write', cell_index: 0 }, ctx())).error,
    ).toContain('source 参数');
    expect((await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', action: 'insert' }, ctx())).error).toContain(
      'source 参数',
    );
    expect(
      (await executeToolCall('NotebookEdit', { file_path: 'nb.ipynb', action: 'explode', cell_index: 0 }, ctx())).error,
    ).toContain('未知操作');
    expect((await executeToolCall('NotebookEdit', { file_path: 'x.txt' }, ctx())).error).toContain('仅支持 .ipynb');
    expect((await executeToolCall('NotebookEdit', { file_path: 'missing.ipynb' }, ctx())).error).toContain(
      '文件不存在',
    );

    writeFileSync(path.join(root, 'bad.ipynb'), '{broken', 'utf-8');
    expect((await executeToolCall('NotebookEdit', { file_path: 'bad.ipynb' }, ctx())).error).toContain(
      'NotebookEdit 失败',
    );
    writeFileSync(path.join(root, 'nocells.ipynb'), JSON.stringify({ cells: null }), 'utf-8');
    expect((await executeToolCall('NotebookEdit', { file_path: 'nocells.ipynb' }, ctx())).error).toContain(
      '缺少 cells',
    );
  });

  it('版本守卫拒绝过期写入', async () => {
    writeNotebook();
    const r = await executeToolCall(
      'NotebookEdit',
      { file_path: 'nb.ipynb', action: 'write', cell_index: 0, source: 'x', version: 'new' },
      ctx(),
    );
    expect(r.error).toContain('版本守卫');
  });
});

describe('LSP — 定义/引用/悬停/诊断', () => {
  it('真实 LSP hover 结果优先返回', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export const x = 1;', 'utf-8');
    vi.mocked(queryLsp).mockResolvedValue({ ok: true, hover: { contents: 'const x: 1', range: null } } as any);
    const r = await executeToolCall(
      'LSP',
      { action: 'hover', file_path: 'a.ts', symbol: 'x', line: 1, column: 10 },
      ctx(),
    );
    expect(r.output).toMatchObject({ found: true, hover: 'const x: 1', source: 'lsp' });
  });

  it('真实 LSP definition 位置映射 file URI 与普通 URI', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export function add() {}', 'utf-8');
    vi.mocked(queryLsp).mockResolvedValue({
      ok: true,
      locations: [
        { uri: `file://${path.join(root, 'a.ts').replace(/\\/g, '/')}`, range: null },
        { uri: 'untitled:1', range: null },
      ],
    } as any);
    const r = await executeToolCall('LSP', { action: 'definition', file_path: 'a.ts', symbol: 'add' }, ctx());
    expect(r.output).toMatchObject({ found: true, count: 2 });
    expect((r.output as any).locations[0].file).toContain('a.ts');
    expect((r.output as any).locations[1].file).toBe('untitled:1');
  });

  it('LSP 不可用时回退到 grep 定义查找并转义特殊字符', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'export function Foo.Bar() {}', 'utf-8');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from(`${root}/a.ts:1:export function Foo.Bar() {}`),
      stderr: Buffer.from(''),
      error: undefined,
    } as any);
    const r = await executeToolCall('LSP', { action: 'definition', file_path: 'a.ts', symbol: 'Foo.Bar' }, ctx());
    expect(r.output).toMatchObject({ found: true, symbol: 'Foo.Bar' });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'grep',
      expect.arrayContaining([expect.stringContaining('Foo\\.Bar')]),
      expect.anything(),
    );
  });

  it('回退定义查找无结果与缺 symbol', async () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: undefined,
    } as any);
    const r = await executeToolCall('LSP', { action: 'definition', file_path: 'a.ts', symbol: 'nope' }, ctx());
    expect(r.output).toMatchObject({ found: false });
    expect((await executeToolCall('LSP', { action: 'definition' }, ctx())).error).toContain('symbol 参数');
  });

  it('fallback hover 返回行上下文，缺 file_path 拒绝', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'line1\nline2 target line\nline3\n', 'utf-8');
    const r = await executeToolCall('LSP', { action: 'hover', file_path: 'a.ts', line: 2 }, ctx());
    expect(r.output).toMatchObject({ found: true, source: 'fallback' });
    expect((r.output as any).hover).toContain('target');
    expect((r.output as any).context.length).toBeGreaterThan(0);
    expect((await executeToolCall('LSP', { action: 'hover' }, ctx())).error).toContain('file_path');
  });

  it('references 解析 grep -w 输出并截断', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `${root}/f.ts:${i + 1}: use add()`).join('\n');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from(lines),
      stderr: Buffer.from(''),
      error: undefined,
    } as any);
    const r = await executeToolCall('LSP', { action: 'references', symbol: 'add' }, ctx());
    expect(r.output).toMatchObject({ found: true, count: 50, hint: expect.any(String) });
    expect((await executeToolCall('LSP', { action: 'references' }, ctx())).error).toContain('symbol 参数');
  });

  it('diagnostics 解析 tsc 输出并过滤目标文件', async () => {
    writeFileSync(path.join(root, 'app.ts'), 'export const a = 1;', 'utf-8');
    spawnSyncMock.mockReturnValue({
      status: 2,
      stdout: Buffer.from(''),
      stderr: Buffer.from(
        `${path.join(root, 'app.ts')}(1,2): error TS2322: msg\n${path.join(root, 'other.ts')}(3,4): warning TS6133: w`,
      ),
      error: undefined,
    } as any);
    const r = await executeToolCall('LSP', { action: 'diagnostics', file_path: 'app.ts' }, ctx());
    expect(r.output).toMatchObject({ passed: false, errorCount: 1, warningCount: 0, totalErrors: 1, totalWarnings: 1 });
    expect((r.output as any).errors[0]).toMatchObject({ code: 'TS2322', line: 1, column: 2 });
  });

  it('diagnostics：tsconfig 全量检查 / 非 TS 文件 / 通过 / 未知操作', async () => {
    writeFileSync(path.join(root, 'tsconfig.json'), '{}', 'utf-8');
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: undefined,
    } as any);
    const full = await executeToolCall('LSP', { action: 'diagnostics' }, ctx());
    expect(full.output).toMatchObject({ passed: true, message: '类型检查通过，未发现错误。' });
    expect(spawnSyncMock.mock.calls.some((c: any) => c[0] === npxCmd && c[1].includes('--noEmit'))).toBe(true);

    spawnSyncMock.mockReturnValueOnce({
      status: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: { message: 'spawn ENOENT' },
    } as any);
    expect((await executeToolCall('LSP', { action: 'diagnostics' }, ctx())).error).toContain('诊断执行失败');

    rmSync(path.join(root, 'tsconfig.json'));
    expect(
      (await executeToolCall('LSP', { action: 'diagnostics', file_path: 'style.css' }, ctx())).output,
    ).toMatchObject({ message: expect.stringContaining('不是 TypeScript') });
    expect((await executeToolCall('LSP', { action: 'boom' }, ctx())).error).toContain('未知 LSP 操作');
  });
});

describe('ReviewArtifact', () => {
  function writePkg(scripts: Record<string, string> = {}, dir = root) {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf-8');
  }

  it('缺少或损坏 package.json 拒绝', async () => {
    expect((await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx())).error).toContain(
      '未找到 package.json',
    );
    writeFileSync(path.join(root, 'package.json'), '{broken', 'utf-8');
    expect((await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx())).error).toContain(
      '读取 package.json 失败',
    );
  });

  it('typecheck 选择脚本或 npx 回退', async () => {
    writePkg({ typecheck: 'tc' });
    await executeToolCall('ReviewArtifact', { check_type: 'typecheck' }, ctx());
    expect(spawnSyncMock).toHaveBeenLastCalledWith(npmCmd, ['run', 'tc'], expect.anything());

    writePkg({});
    await executeToolCall('ReviewArtifact', { check_type: 'typecheck' }, ctx());
    expect(spawnSyncMock).toHaveBeenLastCalledWith(npxCmd, ['tsc', '--noEmit', '--pretty', 'false'], expect.anything());
  });

  it('build / test / lint 脚本优先级', async () => {
    writePkg({});
    await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx());
    expect(spawnSyncMock).toHaveBeenLastCalledWith(npxCmd, ['tsc', '--noEmit'], expect.anything());

    writePkg({ test: 't' });
    await executeToolCall('ReviewArtifact', { check_type: 'test' }, ctx());
    expect(spawnSyncMock).toHaveBeenLastCalledWith(npmCmd, ['test'], expect.anything());

    writePkg({});
    await executeToolCall('ReviewArtifact', { check_type: 'lint' }, ctx());
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      npxCmd,
      ['eslint', '.', '--ext', '.ts,.tsx', '--max-warnings', '0'],
      expect.anything(),
    );
  });

  it('进程错误/非零退出/通过三种结果', async () => {
    writePkg({});
    spawnSyncMock.mockReturnValueOnce({
      status: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      error: { message: 'spawn ENOENT' },
    } as any);
    const procErr = await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx());
    expect(procErr.output).toMatchObject({ passed: false, summary: expect.stringContaining('进程错误') });

    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('err out'),
      error: undefined,
    } as any);
    const failed = await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx());
    expect(failed.output).toMatchObject({ passed: false, exitCode: 1, error: 'err out' });

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from('ok'),
      stderr: Buffer.from(''),
      error: undefined,
    } as any);
    const ok = await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx());
    expect(ok.output).toMatchObject({ passed: true, summary: expect.stringContaining('通过') });
  });

  it('工作树会话存在时在沙箱目录执行', async () => {
    const sandbox = path.join(root, 'sandbox-dir');
    mkdirSync(sandbox, { recursive: true });
    const { restoreWorktreeSession } = await import('../tool-handlers');
    restoreWorktreeSession('lr-1', sandbox);
    writePkg({}, sandbox);
    const r = await executeToolCall('ReviewArtifact', { check_type: 'build' }, ctx());
    expect(r.error).toBeUndefined();
    const call = spawnSyncMock.mock.calls.at(-1)! as any;
    expect(call[2].cwd).toBe(sandbox);
  });
});
