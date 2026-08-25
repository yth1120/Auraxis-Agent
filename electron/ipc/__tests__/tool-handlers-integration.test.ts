import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'auraxis-tool-int-'));

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  safeStorage: { isEncryptionAvailable: () => false, decryptString: (s: string) => s },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

import { executeToolCall } from '../tool-handlers';

function baseCtx(projectRoot: string, extra: Record<string, unknown> = {}) {
  return {
    projectRoot,
    requestId: 'int-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    ...extra,
  };
}

describe('executeToolCall — 真实工具处理器', () => {
  let root: string;

  beforeAll(() => {
    vi.stubEnv('AURAXIS_USER_DATA_DIR', tmpRoot);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpRoot, 'proj-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('StrReplaceEditor：create → view → str_replace → insert 全链路', async () => {
    const file = path.join(root, 'notes.txt');

    const created = await executeToolCall(
      'StrReplaceEditor',
      { command: 'create', path: file, file_text: 'line1\nline2\nline3' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(created.error).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('line2');

    const viewed = await executeToolCall(
      'StrReplaceEditor',
      { command: 'view', path: file },
      baseCtx(root, { autoApprove: true }),
    );
    expect(String((viewed.output as any).content)).toContain('line2');

    const replaced = await executeToolCall(
      'StrReplaceEditor',
      { command: 'str_replace', path: file, old_str: 'line2', new_str: 'LINE2' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(replaced.error).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('LINE2');
    expect(readFileSync(file, 'utf8')).not.toContain('line2');

    const inserted = await executeToolCall(
      'StrReplaceEditor',
      { command: 'insert', path: file, insert_line: 1, new_str: 'inserted' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(inserted.error).toBeUndefined();
    expect(readFileSync(file, 'utf8').split('\n')[1]).toBe('inserted');
  });

  it('str_replace 拒绝不唯一匹配与缺失匹配', async () => {
    const file = path.join(root, 'dup.txt');
    writeFileSync(file, 'same same same', 'utf8');

    const multi = await executeToolCall(
      'StrReplaceEditor',
      { command: 'str_replace', path: file, old_str: 'same', new_str: 'x' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(multi.error).toMatch(/必须唯一/);

    const missing = await executeToolCall(
      'StrReplaceEditor',
      { command: 'str_replace', path: file, old_str: 'nope', new_str: 'x' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(missing.error).toMatch(/未找到/);
  });

  it('create 拒绝覆盖已存在文件', async () => {
    const file = path.join(root, 'exist.txt');
    writeFileSync(file, 'old', 'utf8');
    const r = await executeToolCall(
      'StrReplaceEditor',
      { command: 'create', path: file, file_text: 'new' },
      baseCtx(root, { autoApprove: true }),
    );
    expect(r.error).toMatch(/已存在/);
    expect(readFileSync(file, 'utf8')).toBe('old');
  });

  it('read-before-write：未 Read 直接 Edit 被拒绝，Read 后放行', async () => {
    const file = path.join(root, 'x.md');
    writeFileSync(file, 'alpha beta', 'utf8');

    const denied = await executeToolCall(
      'Edit',
      { file_path: file, old_string: 'alpha', new_string: 'omega' },
      baseCtx(root),
    );
    expect(denied.error).toMatch(/尚未读取|read-before-write/);
    expect(readFileSync(file, 'utf8')).toBe('alpha beta');

    await executeToolCall('Read', { file_path: file, offset: 1, limit: 10 }, baseCtx(root));
    const allowed = await executeToolCall(
      'Edit',
      { file_path: file, old_string: 'alpha', new_string: 'omega' },
      baseCtx(root),
    );
    expect(allowed.error).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('omega beta');
  });

  it('携带 version 的 Edit 跳过观测门但校验版本匹配', async () => {
    const file = path.join(root, 'v.md');
    writeFileSync(file, 'v1', 'utf8');

    const stale = await executeToolCall(
      'Edit',
      { file_path: file, old_string: 'v1', new_string: 'v2', version: 'stale-hash' },
      baseCtx(root),
    );
    expect(stale.error).toMatch(/版本|version|过期/i);

    const read = await executeToolCall('Read', { file_path: file, offset: 1, limit: 5 }, baseCtx(root));
    const version = String((read.output as any).version);
    const ok = await executeToolCall(
      'Edit',
      { file_path: file, old_string: 'v1', new_string: 'v2', version },
      baseCtx(root),
    );
    expect(ok.error).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('v2');
  });

  it('Work 模式：拒绝代码文件写入，允许文档写入', async () => {
    const work = baseCtx(root, { autoApprove: true, surface: 'work', sandboxMode: 'workspace-write' });

    const codeDenied = await executeToolCall(
      'Write',
      { file_path: 'src/app.ts', content: 'export const a = 1;' },
      work,
    );
    expect(codeDenied.error).toContain('Work 模式');
    expect(codeDenied.output).toBeNull();

    const docOk = await executeToolCall('Write', { file_path: 'docs/notes.md', content: '# hi' }, work);
    expect(docOk.error).toBeUndefined();
    expect(readFileSync(path.join(root, 'docs', 'notes.md'), 'utf8')).toContain('# hi');
  });

  it('Work 模式：StrReplaceEditor / Edit / Delete 同样受文档门禁', async () => {
    const work = baseCtx(root, { autoApprove: true, surface: 'work', sandboxMode: 'workspace-write' });

    const editDenied = await executeToolCall(
      'Edit',
      { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
      work,
    );
    expect(editDenied.error).toContain('Work 模式');

    const srDenied = await executeToolCall(
      'StrReplaceEditor',
      { command: 'create', path: path.join(root, 'src', 'x.js'), file_text: 'x' },
      work,
    );
    expect(srDenied.error).toContain('Work 模式');

    const delDenied = await executeToolCall('Delete', { file_path: 'src' }, work);
    expect(delDenied.error).toContain('Work 模式');
  });
});
