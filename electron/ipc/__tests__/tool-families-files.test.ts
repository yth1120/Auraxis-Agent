import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'auraxis-files-'));

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
vi.mock('../../attachments', () => ({
  attachmentMimeFor: vi.fn(() => 'image/png'),
  storeAttachment: vi.fn(async () => ({ id: 'att-1', mime: 'image/png', bytes: 4 })),
  attachmentDataUrl: vi.fn(() => 'data:image/png;base64,AAAA'),
  MAX_ATTACHMENT_BYTES: 1024,
}));
vi.mock('../../web-search', () => ({
  searchWithProvider: vi.fn(async () => ({ results: [], providerId: 'duckduckgo', usedFallback: false })),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({})),
}));

import { executeToolCall } from '../tool-handlers';
import { attachmentMimeFor, storeAttachment } from '../../attachments';
import { searchWithProvider } from '../../web-search';

let root = '';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    requestId: 'files-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpRoot, 'proj-'));
  writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n', 'utf-8');
  writeFileSync(path.join(root, 'b.md'), '# Title\nhello world\n', 'utf-8');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'util.ts'), 'export function add() { return 1; }\n', 'utf-8');
  writeFileSync(path.join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary');
  vi.clearAllMocks();
  vi.mocked(attachmentMimeFor).mockReturnValue('image/png');
  vi.mocked(storeAttachment).mockResolvedValue({ id: 'att-1', mime: 'image/png', bytes: 4 } as any);
  vi.mocked(searchWithProvider).mockResolvedValue({ results: [], providerId: 'duckduckgo', usedFallback: false });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('Read / ReadImage', () => {
  it('Read 支持偏移与行数并返回版本', async () => {
    const r = await executeToolCall('Read', { file_path: 'a.ts', offset: 1, limit: 1 }, ctx());
    expect(r.error).toBeUndefined();
    expect(r.output).toMatchObject({
      content: 'export const a = 1;',
      start_line: 1,
      end_line: 1,
      total_lines: 3,
    });
    expect((r.output as any).version).toHaveLength(12);
  });

  it('Read 文件不存在/中止时报错', async () => {
    expect((await executeToolCall('Read', { file_path: 'missing.ts' }, ctx())).error).toContain('读取文件失败');
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await executeToolCall('Read', { file_path: 'a.ts' }, ctx({ abortSignal: ctrl.signal }))).error).toBe(
      '操作已取消',
    );
  });

  it('非 full 沙箱且未授权时拒绝越权路径', async () => {
    await expect(
      executeToolCall('Read', { file_path: '../outside.ts' }, ctx({ sandboxMode: 'read', autoApprove: false })),
    ).rejects.toThrow('路径越界');
  });

  it('ReadImage 返回图片数据，超大/非文件/不支持类型拒绝', async () => {
    const r = await executeToolCall('ReadImage', { file_path: 'img.png' }, ctx());
    expect(r.output).toMatchObject({
      mime: 'image/png',
      bytes: 4,
      attachment_id: 'att-1',
      image: 'data:image/png;base64,AAAA',
    });

    vi.mocked(storeAttachment).mockRejectedValueOnce(new Error('disk'));
    expect((await executeToolCall('ReadImage', { file_path: 'img.png' }, ctx())).error).toContain('读取图片失败');

    vi.mocked(attachmentMimeFor).mockReturnValueOnce(null as any);
    expect((await executeToolCall('ReadImage', { file_path: 'img.xyz' }, ctx())).error).toContain('不支持的文件类型');

    writeFileSync(path.join(root, 'big.png'), Buffer.alloc(2048));
    expect((await executeToolCall('ReadImage', { file_path: 'big.png' }, ctx())).error).toContain('图片过大');

    expect((await executeToolCall('ReadImage', { file_path: 'src' }, ctx())).error).toContain('不是文件');
  });
});

describe('Write / Edit', () => {
  it('multi-root：附加根可读，非可写根拒绝写入', async () => {
    const secondary = mkdtempSync(path.join(tmpRoot, 'sec-'));
    writeFileSync(path.join(secondary, 'x.ts'), 'x', 'utf-8');
    const multi = ctx({
      sandboxMode: 'workspace-write',
      autoApprove: false,
      workspaceRoots: [secondary],
      writableRoots: [root],
    });

    const read = await executeToolCall('Read', { file_path: path.join(secondary, 'x.ts') }, multi);
    expect(read.error).toBeUndefined();

    const write = await executeToolCall('Write', { file_path: path.join(secondary, 'x.ts'), content: 'y' }, multi);
    expect(write.error).toContain('写入越权');

    const primaryWrite = await executeToolCall('Write', { file_path: 'new.ts', content: 'y' }, multi);
    expect(primaryWrite.error).toBeUndefined();
    expect(readFileSync(path.join(root, 'new.ts'), 'utf-8')).toBe('y');

    rmSync(secondary, { recursive: true, force: true });
  });

  it('Write 新建与覆写', async () => {
    const created = await executeToolCall('Write', { file_path: 'new.ts', content: 'x' }, ctx());
    expect(created.output).toMatchObject({ action: 'created', size: 1 });
    expect(readFileSync(path.join(root, 'new.ts'), 'utf-8')).toBe('x');

    const overwritten = await executeToolCall('Write', { file_path: 'new.ts', content: 'yy' }, ctx());
    expect(overwritten.output).toMatchObject({ action: 'overwritten', oldContent: 'x', size: 2 });
  });

  it('Write 未授权时拒绝不安全扩展名与保留设备名', async () => {
    const ext = await executeToolCall('Write', { file_path: 'evil.exe', content: 'x' }, ctx({ autoApprove: false }));
    expect(ext.error).toContain('不允许的文件类型');
    const reserved = await executeToolCall(
      'Write',
      { file_path: 'nul.txt', content: 'x' },
      ctx({ autoApprove: false }),
    );
    expect(reserved.error).toContain('保留设备名');
  });

  it('Write 版本守卫：new 拒绝已存在，stale 拒绝过期', async () => {
    const exists = await executeToolCall('Write', { file_path: 'a.ts', content: 'x', version: 'new' }, ctx());
    expect(exists.error).toContain('版本守卫');
    const stale = await executeToolCall('Write', { file_path: 'a.ts', content: 'x', version: 'stale-hash' }, ctx());
    expect(stale.error).toContain('已被修改');
  });

  it('read-before-write：未 Read 拒绝写入，Read 后放行', async () => {
    const denied = await executeToolCall('Write', { file_path: 'b.md', content: 'z' }, ctx({ autoApprove: false }));
    expect(denied.error).toContain('read-before-write');
    await executeToolCall('Read', { file_path: 'b.md' }, ctx({ autoApprove: false }));
    const ok = await executeToolCall('Write', { file_path: 'b.md', content: 'z' }, ctx({ autoApprove: false }));
    expect(ok.error).toBeUndefined();
    expect(readFileSync(path.join(root, 'b.md'), 'utf-8')).toBe('z');
  });

  it('Edit 替换/不唯一/未找到/中止', async () => {
    const ok = await executeToolCall(
      'Edit',
      { file_path: 'a.ts', old_string: 'export const a = 1;', new_string: 'export const a = 2;' },
      ctx(),
    );
    expect(ok.error).toBeUndefined();
    expect(readFileSync(path.join(root, 'a.ts'), 'utf-8')).toContain('a = 2');

    writeFileSync(path.join(root, 'dup.ts'), 'same same same', 'utf-8');
    expect(
      (await executeToolCall('Edit', { file_path: 'dup.ts', old_string: 'same', new_string: 'x' }, ctx())).error,
    ).toContain('必须唯一');
    expect(
      (await executeToolCall('Edit', { file_path: 'dup.ts', old_string: 'nope', new_string: 'x' }, ctx())).error,
    ).toContain('未找到');

    const ctrl = new AbortController();
    ctrl.abort();
    expect(
      (
        await executeToolCall(
          'Edit',
          { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
          ctx({ abortSignal: ctrl.signal }),
        )
      ).error,
    ).toBe('操作已取消');
  });
});

describe('Delete / Grep / Glob', () => {
  it('Delete 删除文件与目录（含递归约束）', async () => {
    expect((await executeToolCall('Delete', { file_path: 'a.ts' }, ctx())).output).toMatchObject({
      deleted: expect.stringContaining('a.ts'),
      isDirectory: false,
    });
    expect((await executeToolCall('Delete', { file_path: 'src' }, ctx())).error).toContain('recursive=true');
    expect((await executeToolCall('Delete', { file_path: 'src', recursive: true }, ctx())).output).toMatchObject({
      isDirectory: true,
    });
    expect(existsSync(path.join(root, 'src'))).toBe(false);
    expect((await executeToolCall('Delete', { file_path: 'gone.ts' }, ctx())).error).toContain('文件不存在');
    expect((await executeToolCall('Delete', { file_path: '.' }, ctx())).error).toContain('路径越权');
    expect((await executeToolCall('Delete', { file_path: '../x.ts' }, ctx())).error).toContain('路径越权');
  });

  it('Grep 递归匹配、include 过滤与非法正则', async () => {
    const r = await executeToolCall('Grep', { pattern: 'export', path: 'src' }, ctx());
    expect((r.output as any).match_count).toBe(1);
    expect((r.output as any).results[0].file).toContain('util.ts');

    const filtered = await executeToolCall('Grep', { pattern: 'export', include: '*.md' }, ctx());
    expect((filtered.output as any).match_count).toBe(0);

    expect((await executeToolCall('Grep', { pattern: '[unclosed', path: 'src' }, ctx())).error).toContain('无效的正则');
  });

  it('Glob 匹配扩展名并跳过隐藏/排除目录', async () => {
    writeFileSync(path.join(root, '.hidden.ts'), 'x', 'utf-8');
    const r = await executeToolCall('Glob', { pattern: '**' }, ctx());
    const results = (r.output as any).results as string[];
    expect(results.some((p) => p.includes('util.ts'))).toBe(true);
    expect(results.some((p) => p.includes('.hidden.ts'))).toBe(false);
  });
});

describe('WebFetch / WebSearch', () => {
  it('WebFetch 阻止内网地址，自动补全协议', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const blocked = await executeToolCall('WebFetch', { url: 'http://192.168.1.1/x' }, ctx({ autoApprove: false }));
    expect(blocked.error).toContain('内部/本地网络');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html><body><script>bad()</script><p>Hello</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const ok = await executeToolCall('WebFetch', { url: 'example.com' }, ctx({ autoApprove: true }));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://example.com', expect.anything());
    expect((ok.output as any).content).toContain('Hello');
    expect((ok.output as any).content).not.toContain('bad()');
  });

  it('WebFetch HTTP 错误与网络异常', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    expect((await executeToolCall('WebFetch', { url: 'https://example.com/x' }, ctx())).error).toBe(
      'HTTP 404: Not Found',
    );

    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect((await executeToolCall('WebFetch', { url: 'https://example.com/x' }, ctx())).error).toContain('请求失败');
  });

  it('WebSearch 透传 provider 结果并包装异常', async () => {
    vi.mocked(searchWithProvider).mockResolvedValueOnce({
      results: [{ title: 'T', snippet: 'S', url: 'https://e.com' }],
      providerId: 'exa',
      usedFallback: true,
    });
    const r = await executeToolCall('WebSearch', { query: 'q' }, ctx());
    expect(r.output).toMatchObject({ query: 'q', provider: 'exa', used_fallback: true, results_count: 1 });

    vi.mocked(searchWithProvider).mockRejectedValueOnce(new Error('provider down'));
    expect((await executeToolCall('WebSearch', { query: 'q' }, ctx())).error).toContain('搜索失败');
  });
});
