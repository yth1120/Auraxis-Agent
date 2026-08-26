import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { queryLsp } from '../../lsp-client';

let tmp: string;
let fixture: string;
let filePath: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-lsp-'));
  fixture = path.join(__dirname, 'fixtures', 'fake-lsp-server.cjs');
  filePath = path.join(tmp, 'src', 'app.ts');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'export const App = () => 1;\n', 'utf8');
});

afterAll(async () => {
  delete process.env.AURAXIS_LSP_SERVER;
  // The LSP child may still hold the cwd for a few ms after kill() on
  // Windows — retry so cleanup never flakes with EBUSY.
  for (let i = 0; i < 10; i++) {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

function serverArgv(): string[] {
  return ['node', fixture];
}

describe('lsp-client — stdio JSON-RPC over LSP', () => {
  it('returns normalized definition locations', async () => {
    const res = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'export const App = () => 1;\n',
      action: 'definition',
      position: { line: 0, character: 14 },
      serverCommand: serverArgv(),
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.locations?.[0]?.uri).toContain('app.ts');
    expect(res.locations?.[0]?.range.start.line).toBe(3);
  });

  it('returns normalized hover contents', async () => {
    const res = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'export const App = () => 1;\n',
      action: 'hover',
      position: { line: 0, character: 14 },
      serverCommand: serverArgv(),
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    expect(res.hover?.contents).toContain('hover info: App');
  });

  it('reports unavailable when the server binary is missing', async () => {
    const res = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'x',
      action: 'references',
      position: { line: 0, character: 0 },
      serverCommand: ['__no_such_lsp_binary__'],
      timeoutMs: 3000,
    });
    expect(res.ok).toBe(false);
    expect(res.unavailable).toBe(true);
  });

  it('normalizes references and implementation actions', async () => {
    for (const action of ['references', 'implementation'] as const) {
      const res = await queryLsp({
        cwd: tmp,
        filePath,
        text: 'export const App = () => 1;\n',
        action,
        position: { line: 0, character: 14 },
        serverCommand: serverArgv(),
        timeoutMs: 5000,
      });
      expect(res.ok).toBe(true);
      expect(res.locations?.[0]?.uri).toContain('app.ts');
    }
  });

  it('resolves the server command from AURAXIS_LSP_SERVER JSON', async () => {
    process.env.AURAXIS_LSP_SERVER = JSON.stringify(serverArgv());
    const res = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'export const App = () => 1;\n',
      action: 'definition',
      position: { line: 0, character: 14 },
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(true);
    delete process.env.AURAXIS_LSP_SERVER;
  });

  it('returns error payloads and resolves timeouts', async () => {
    const errorRes = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'x',
      action: 'definition',
      position: { line: 0, character: 0 },
      serverCommand: ['node', path.join(__dirname, 'fixtures', 'fake-lsp-error-server.cjs')],
      timeoutMs: 5000,
    });
    expect(errorRes).toMatchObject({ ok: false, error: 'bad request' });

    const timeoutRes = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'x',
      action: 'definition',
      position: { line: 0, character: 0 },
      serverCommand: ['node', '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    });
    expect(timeoutRes).toMatchObject({ ok: false, error: 'LSP 查询超时' });
  });

  it('handles an early server exit', async () => {
    const res = await queryLsp({
      cwd: tmp,
      filePath,
      text: 'x',
      action: 'definition',
      position: { line: 0, character: 0 },
      serverCommand: ['node', '-e', 'process.exit(0)'],
      timeoutMs: 500,
    });
    expect(res).toMatchObject({ ok: false, error: 'LSP 服务器提前退出' });
  });

  it('maps language ids for all supported file extensions', async () => {
    const extensions = ['tsx', 'js', 'jsx', 'py', 'go', 'rs', 'txt'];
    for (const ext of extensions) {
      const pathForExt = path.join(tmp, `app.${ext}`);
      await fs.writeFile(pathForExt, 'content', 'utf8');
      const res = await queryLsp({
        cwd: tmp,
        filePath: pathForExt,
        text: 'content',
        action: 'definition',
        position: { line: 0, character: 0 },
        serverCommand: serverArgv(),
        timeoutMs: 5000,
      });
      expect(res.ok).toBe(true);
    }
  });
});
