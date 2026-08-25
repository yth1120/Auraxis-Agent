import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/auraxis-userdata'), getVersion: vi.fn(() => '2.0.0') },
}));
const settingsStoreMock = vi.hoisted(() => ({ readSettings: vi.fn() }));
const modelConfigMock = vi.hoisted(() => ({
  resolveApiBase: vi.fn(),
  resolveModelApiBase: vi.fn(async () => 'https://api.example.com/v1'),
  resolveModelApiKey: vi.fn(async () => undefined),
}));
const contextManagerMock = vi.hoisted(() => ({
  compactHistory: vi.fn(),
  estimateTokens: vi.fn(() => 10),
}));
const sshStoreMock = vi.hoisted(() => ({
  listSshConnections: vi.fn(),
  saveSshConnection: vi.fn(),
  removeSshConnection: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  dialog: electronMock.dialog,
  app: electronMock.app,
}));

vi.mock('../settings-store', () => settingsStoreMock);
vi.mock('../model-config', () => modelConfigMock);
vi.mock('../context-manager', () => contextManagerMock);
vi.mock('../../ssh-store', () => sshStoreMock);

const sshMock = (() => {
  let execImpl = (_cmd: string, _opts: unknown, stream: any, cb: (err: Error | null, s: any) => void) => {
    cb(null, stream);
  };
  let failConnect = false;
  class FakeStream extends EventEmitter {
    stderr = new EventEmitter();
    emitData(d: string) {
      this.emit('data', Buffer.from(d));
    }
    emitStderr(d: string) {
      this.stderr.emit('data', Buffer.from(d));
    }
    emitClose(code: number | null) {
      this.emit('close', code);
    }
  }
  class FakeClient extends EventEmitter {
    cfg: any = null;
    ended = false;
    execResult: any = null;
    connect(cfg: any) {
      this.cfg = cfg;
      if (failConnect) {
        queueMicrotask(() => this.emit('error', new Error('connect refused')));
      } else {
        queueMicrotask(() => this.emit('ready'));
      }
      return this;
    }
    end() {
      this.ended = true;
    }
    exec(cmd: string, opts: unknown, cb?: (err: Error | null, s: any) => void) {
      if (typeof opts === 'function') {
        cb = opts as any;
        opts = {};
      }
      const stream = new FakeStream();
      this.execResult = { cmd, opts, stream };
      execImpl(cmd, opts, stream, cb!);
      return this;
    }
  }
  return {
    Client: FakeClient,
    setExecImpl(fn: typeof execImpl) {
      execImpl = fn;
    },
    setFailConnect(v: boolean) {
      failConnect = v;
    },
  };
})();

vi.mock('ssh2', () => ({
  get Client() {
    return sshMock.Client;
  },
}));

import { registerProjectHandlers } from '../project-handlers';
import { registerFileHandlers } from '../file-handlers';
import { registerContextHandlers } from '../context-handlers';
import { registerSshHandlers } from '../ssh-handlers';
import { registerStatsHandlers } from '../stats-handlers';
import { readSettings } from '../settings-store';
import { resolveModelApiBase } from '../model-config';
import { compactHistory } from '../context-manager';
import { listSshConnections, saveSshConnection, removeSshConnection } from '../../ssh-store';
import { trackSession, trackMessage, trackTokens, trackToolCall, trackLinesGenerated } from '../stats-handlers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

async function capture(register: () => void): Promise<Map<string, Handler>> {
  electronMock.handle.mockClear();
  register();
  const map = new Map<string, Handler>();
  for (const [channel, fn] of electronMock.handle.mock.calls) {
    map.set(channel as string, fn as Handler);
  }
  return map;
}

let root = '';
let outside = '';

describe('IPC 中型处理器（project/file/context/ssh/stats）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ipc-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-outside-'));
    sshMock.setFailConnect(false);
    sshMock.setExecImpl((_cmd, _opts, stream, cb) => cb(null, stream));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  describe('project-handlers', () => {
    it('getTree 返回目录树并应用 .gitignore', async () => {
      const h = await capture(registerProjectHandlers);
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x');
      await fs.writeFile(path.join(root, 'b.log'), 'x');
      await fs.writeFile(path.join(root, '.gitignore'), '*.log\n');
      const res = await h.get('project:getTree')!({}, root);
      expect(res.ok).toBe(true);
      expect(JSON.stringify(res.data)).toContain('a.ts');
      expect(JSON.stringify(res.data)).not.toContain('b.log');
    });

    it('selectDirectory — 取消返回 null，选择后返回目录', async () => {
      const h = await capture(registerProjectHandlers);
      electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      await expect(h.get('project:selectDirectory')!({})).resolves.toEqual({ ok: true, data: null });

      electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });
      await expect(h.get('project:selectDirectory')!({})).resolves.toEqual({ ok: true, data: root });
    });

    it('applyCode 创建/覆写/越权/类型拒绝', async () => {
      const h = await capture(registerProjectHandlers);
      const created = await h.get('project:applyCode')!(
        {},
        { filePath: 'src/new.ts', code: 'export {}', projectRoot: root },
      );
      expect(created).toMatchObject({ ok: true, action: 'created' });
      expect(await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf-8')).toBe('export {}');

      const overwritten = await h.get('project:applyCode')!(
        {},
        { filePath: 'src/new.ts', code: '// v2', projectRoot: root },
      );
      expect(overwritten).toMatchObject({ ok: true, action: 'overwritten' });

      await expect(
        h.get('project:applyCode')!({}, { filePath: '../evil.ts', code: 'x', projectRoot: root }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        h.get('project:applyCode')!({}, { filePath: 'app.exe', code: 'x', projectRoot: root }),
      ).resolves.toMatchObject({ ok: false });
    });

    it('previewCode 仅支持可预览类型并写入临时文件', async () => {
      const h = await capture(registerProjectHandlers);
      const res = await h.get('project:previewCode')!({}, { filePath: 'index.html', code: '<h1>x</h1>' });
      expect(res.ok).toBe(true);
      expect(res.url).toMatch(/^file:\/\//);
      await expect(fs.readFile(res.filePath, 'utf-8')).resolves.toBe('<h1>x</h1>');

      await expect(h.get('project:previewCode')!({}, { filePath: 'main.ts', code: 'x' })).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  describe('file-handlers', () => {
    it('open — 取消为空，选择后返回文件内容', async () => {
      const h = await capture(registerFileHandlers);
      electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      await expect(h.get('file:open')!({}, root)).resolves.toEqual({ ok: true, data: [] });

      const f = path.join(root, 'a.ts');
      await fs.writeFile(f, 'const a = 1;');
      electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [f] });
      const res = await h.get('file:open')!({}, root);
      expect(res.ok).toBe(true);
      expect(res.data[0]).toMatchObject({ name: 'a.ts', content: 'const a = 1;' });
    });

    it('read — 正常读取与越权拒绝', async () => {
      const h = await capture(registerFileHandlers);
      const f = path.join(root, 'a.ts');
      await fs.writeFile(f, 'hello');
      await expect(h.get('file:read')!({}, f, root)).resolves.toEqual({ ok: true, data: 'hello' });
      const evil = path.join(outside, 'x.ts');
      await fs.writeFile(evil, 'x');
      await expect(h.get('file:read')!({}, evil, root)).resolves.toMatchObject({ ok: false });
    });

    it('estimateTokens — 文本/二进制/超大文件分类', async () => {
      const h = await capture(registerFileHandlers);
      const text = path.join(root, 'a.ts');
      await fs.writeFile(text, 'const a = 1;');
      const bin = path.join(root, 'b.bin');
      await fs.writeFile(bin, Buffer.from([0x61, 0x00, 0x62]));
      const big = path.join(root, 'big.ts');
      await fs.writeFile(big, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

      const res = await h.get('file:estimateTokens')!({}, [text, bin, big], root);
      expect(res.ok).toBe(true);
      expect(res.data[0].tokens).toBeGreaterThan(0);
      expect(res.data[1]).toMatchObject({ skipped: 'binary' });
      expect(res.data[2]).toMatchObject({ skipped: 'too-large' });
      await expect(h.get('file:estimateTokens')!({}, 'not-array', root)).resolves.toMatchObject({ ok: false });
    });

    it('readPreview — 图片返回 base64，不支持类型拒绝', async () => {
      const h = await capture(registerFileHandlers);
      const png = path.join(root, 'img.png');
      await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const res = await h.get('file:readPreview')!({}, png, root);
      expect(res.ok).toBe(true);
      expect(res.data.mime).toBe('image/png');
      expect(res.data.base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));

      const txt = path.join(root, 'a.txt');
      await fs.writeFile(txt, 'x');
      await expect(h.get('file:readPreview')!({}, txt, root)).resolves.toMatchObject({ ok: false });
    });

    it('write/delete/rename/createFolder/createFile 的边界检查', async () => {
      const h = await capture(registerFileHandlers);
      const f = path.join(root, 'a.ts');
      await expect(h.get('file:write')!({}, f, 'content', root)).resolves.toEqual({ ok: true });
      await expect(fs.readFile(f, 'utf-8')).resolves.toBe('content');

      const evil = path.join(outside, 'x.ts');
      await expect(h.get('file:write')!({}, evil, 'x', root)).resolves.toMatchObject({ ok: false });
      await expect(h.get('file:write')!({}, path.join(root, 'a.exe'), 'x', root)).resolves.toMatchObject({ ok: false });

      await expect(h.get('file:delete')!({}, f, root)).resolves.toEqual({ ok: true });
      await expect(fs.access(f)).rejects.toThrow();
      await expect(h.get('file:delete')!({}, root, root)).resolves.toMatchObject({ ok: false });

      const renamed = path.join(root, 'b.ts');
      await fs.writeFile(f, 'x');
      await expect(h.get('file:rename')!({}, f, renamed, root)).resolves.toEqual({ ok: true });
      await expect(h.get('file:rename')!({}, renamed, evil, root)).resolves.toMatchObject({ ok: false });

      const dir = path.join(root, 'sub');
      await expect(h.get('file:createFolder')!({}, dir, root)).resolves.toEqual({ ok: true });
      await expect(h.get('file:createFolder')!({}, path.join(outside, 'sub'), root)).resolves.toMatchObject({
        ok: false,
      });

      const nf = path.join(root, 'new.ts');
      await expect(h.get('file:createFile')!({}, nf, root)).resolves.toEqual({ ok: true });
      await expect(h.get('file:createFile')!({}, path.join(root, 'new.exe'), root)).resolves.toMatchObject({
        ok: false,
      });
    });

    it('search — 关键字匹配与空关键字', async () => {
      const h = await capture(registerFileHandlers);
      await fs.mkdir(path.join(root, 'api'));
      await fs.writeFile(path.join(root, 'login.ts'), 'x');
      await fs.writeFile(path.join(root, 'api', 'login.ts'), 'x');
      const res = await h.get('file:search')!({}, 'login', root);
      expect(res.ok).toBe(true);
      expect(res.data.length).toBeGreaterThanOrEqual(2);
      await expect(h.get('file:search')!({}, '', root)).resolves.toEqual({ ok: true, data: [] });
    });
  });

  describe('context-handlers', () => {
    it('compact — 组装配置并返回压缩结果', async () => {
      const h = await capture(registerContextHandlers);
      vi.mocked(readSettings).mockResolvedValue({ selectedModel: 'deepseek-v4-pro', deepseekApiKey: 'sk-1' });
      vi.mocked(resolveModelApiBase).mockResolvedValue('https://api.example.com/v1');
      vi.mocked(compactHistory).mockResolvedValue({
        messages: [{ role: 'user', content: 'sum' }],
        messagesRemoved: 2,
        tokensSaved: 50,
        wasTruncated: false,
        roundsRemoved: 2,
        summaryInjected: true,
      });
      const res = await h.get('context:compact')!(
        {},
        {
          projectRoot: root,
          messages: [{ role: 'user', content: 'long text' }],
        },
      );
      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({ messagesRemoved: 2, tokensSaved: 50, tokensBefore: 10 });

      vi.mocked(compactHistory).mockRejectedValue(new Error('ctx'));
      await expect(h.get('context:compact')!({}, { messages: [] })).resolves.toEqual({ ok: false, error: 'ctx' });
    });

    it('getProjectContext — 读取 AGENTS.md / 文件树 / package.json', async () => {
      const h = await capture(registerContextHandlers);
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'AGENTS.md'), '# 项目规范');
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }),
      );
      await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x');
      const res = await h.get('context:getProjectContext')!({}, root);
      expect(res.ok).toBe(true);
      expect(res.data.instructionsMd).toContain('项目规范');
      expect(res.data.fileTree).toContain('a.ts');
      expect(res.data.packageJson).toContain('"name": "demo"');
    });

    it('getFileStructure 与 readFile', async () => {
      const h = await capture(registerContextHandlers);
      await fs.writeFile(path.join(root, 'x.ts'), 'code');
      const tree = await h.get('context:getFileStructure')!({}, root);
      expect(tree.ok).toBe(true);
      expect(tree.data).toContain('x.ts');

      await expect(h.get('context:readFile')!({}, path.join(root, 'x.ts'), root)).resolves.toEqual({
        ok: true,
        data: 'code',
      });
      await expect(h.get('context:readFile')!({}, path.join(root, 'x.ts'))).resolves.toMatchObject({ ok: false });
      await expect(h.get('context:readFile')!({}, path.join(outside, 'x.ts'), root)).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  describe('ssh-handlers', () => {
    it('list/save/remove 与参数校验', async () => {
      const h = await capture(registerSshHandlers);
      vi.mocked(listSshConnections).mockResolvedValue([{ id: 'c1' } as any]);
      await expect(h.get('ssh:list')!({})).resolves.toMatchObject({ ok: true });

      vi.mocked(saveSshConnection).mockResolvedValue([]);
      await expect(h.get('ssh:save')!({}, { host: 'example.com', port: 2222 })).resolves.toMatchObject({ ok: true });
      expect(saveSshConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'example.com',
          port: 2222,
          username: 'root',
        }),
      );
      await expect(h.get('ssh:save')!({}, { host: '  ' })).resolves.toEqual({ ok: false, error: '主机地址无效' });

      vi.mocked(removeSshConnection).mockResolvedValue([]);
      await expect(h.get('ssh:remove')!({}, 'c1')).resolves.toMatchObject({ ok: true });
    });

    it('test — 成功输出、非零退出码、连接失败', async () => {
      const h = await capture(registerSshHandlers);
      sshMock.setExecImpl((_cmd, _opts, stream, cb) => {
        cb(null, stream);
        stream.emitData('ssh-ok\n');
        stream.emitStderr('host');
        stream.emitClose(0);
      });
      await expect(h.get('ssh:test')!({}, { host: 'h', username: 'u' })).resolves.toEqual({
        ok: true,
        data: { output: 'ssh-ok\nhost' },
      });

      sshMock.setExecImpl((_cmd, _opts, stream, cb) => {
        cb(null, stream);
        stream.emitClose(3);
      });
      await expect(h.get('ssh:test')!({}, { host: 'h', username: 'u' })).resolves.toMatchObject({
        ok: false,
        error: '退出码 3',
      });

      sshMock.setFailConnect(true);
      await expect(h.get('ssh:test')!({}, { host: 'h', username: 'u' })).resolves.toMatchObject({
        ok: false,
        error: 'connect refused',
      });
    });

    it('exec — 输出返回、执行错误、keyPath 与代理配置', async () => {
      const h = await capture(registerSshHandlers);
      const key = path.join(root, 'id_rsa');
      await fs.writeFile(key, 'KEY');
      sshMock.setExecImpl((_cmd, _opts, stream, cb) => {
        cb(null, stream);
        stream.emitData('ls\n');
        stream.emitClose(0);
      });
      const res = await h.get('ssh:exec')!({}, { host: 'h', username: 'u', keyPath: key, useAgent: true }, 'ls');
      expect(res.ok).toBe(true);
      expect(res.data.output).toBe('ls\n');

      sshMock.setExecImpl((_cmd, _opts, _stream, cb) => {
        cb(new Error('exec failed'), null as any);
      });
      await expect(h.get('ssh:exec')!({}, { host: 'h', username: 'u' }, 'ls')).resolves.toMatchObject({
        ok: false,
        error: 'exec failed',
      });
    });
  });

  describe('stats-handlers', () => {
    it('get/reset 与 track 系列', async () => {
      const h = await capture(registerStatsHandlers);
      await h.get('stats:reset')!({});

      await trackSession();
      await trackMessage();
      await trackTokens(100, 50);
      await trackToolCall(true, 1000);
      await trackToolCall(false, 500);
      await trackLinesGenerated(2500);

      const res = await h.get('stats:get')!({});
      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        sessions: 1,
        messages: '1',
        totalTokens: '150',
        toolCalls: '2',
        successRate: '50%',
        avgDuration: '0.8s',
        linesGenerated: '2.5K',
        activeDays: 1,
      });
      expect(res.data.heatmapDays.length).toBe(371);

      await h.get('stats:reset')!({});
      const after = await h.get('stats:get')!({});
      expect(after.data.sessions).toBe(0);
    });
  });
});
