/**
 * lsp-client.ts — minimal LSP client over stdio JSON-RPC （LSP 客户端）.
 *
 * One-shot queries: spawn a language server, initialize, open the target
 * document, run definition/references/implementation/hover, normalize the
 * result, and tear the server down. Server command comes from
 * AURAXIS_LSP_SERVER (e.g. "typescript-language-server --stdio") or defaults
 * to typescript-language-server; callers fall back to regex/tsc when the
 * server is unavailable.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { safeProcessEnv } from './safe-env';
import path from 'path';
import { pathToFileURL } from 'url';

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export type LspAction = 'definition' | 'references' | 'implementation' | 'hover';

export interface LspQueryInput {
  cwd: string;
  filePath: string;
  text: string;
  action: LspAction;
  position: LspPosition;
  /** Full argv of the server command. Defaults to typescript-language-server. */
  serverCommand?: string[];
  timeoutMs?: number;
}

export interface LspQueryResult {
  ok: boolean;
  locations?: LspLocation[];
  hover?: { contents: string; range?: LspRange };
  error?: string;
  /** true when the server binary is missing — caller should use fallbacks. */
  unavailable?: boolean;
}

function parseServerCommand(envValue: string | undefined): string[] | null {
  if (!envValue) return null;
  try {
    const arr = JSON.parse(envValue);
    if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr;
  } catch { /* not JSON — treat as a command string */ }
  return envValue.split(/\s+/).filter(Boolean);
}

function createMessageReader(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      if (buf.length < headerEnd + 4 + len) return;
      const body = buf.slice(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      buf = buf.slice(headerEnd + 4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch { /* malformed frame — ignore */ }
    }
  };
}

function normalize(action: LspAction, result: any): LspQueryResult {
  if (action === 'hover') {
    const contents = Array.isArray(result?.contents)
      ? result.contents.map((c: any) => (typeof c === 'string' ? c : c?.value ?? '')).join('\n')
      : typeof result?.contents === 'string'
        ? result.contents
        : result?.contents?.value ?? '';
    return { ok: true, hover: { contents, range: result?.range } };
  }
  const raw = Array.isArray(result) ? result : result ? [result] : [];
  const locations: LspLocation[] = raw
    .filter((l: any) => l && l.uri && l.range)
    .map((l: any) => ({ uri: l.uri, range: l.range }));
  return { ok: true, locations };
}

function languageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.js') return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  return 'plaintext';
}

export function queryLsp(input: LspQueryInput): Promise<LspQueryResult> {
  return new Promise((resolve) => {
    const argv = input.serverCommand
      ?? parseServerCommand(process.env.AURAXIS_LSP_SERVER)
      ?? ['typescript-language-server', '--stdio'];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: input.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: safeProcessEnv(),
      });
    } catch (e: any) {
      resolve({ ok: false, error: e?.message ?? String(e) });
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, error: 'LSP 查询超时' });
    }, input.timeoutMs ?? 10_000);

    const uri = pathToFileURL(input.filePath).href;
    const send = (obj: any) => {
      try {
        const body = JSON.stringify(obj);
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
      } catch { /* closed */ }
    };

    const onMessage = (msg: any) => {
      if (msg?.id === 1 && msg?.result) {
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              languageId: languageId(input.filePath),
              version: 1,
              text: input.text,
            },
          },
        });
        const method = input.action === 'definition'
          ? 'textDocument/definition'
          : input.action === 'references'
            ? 'textDocument/references'
            : input.action === 'implementation'
              ? 'textDocument/implementation'
              : 'textDocument/hover';
        const params: any = { textDocument: { uri }, position: input.position };
        if (input.action === 'references') params.context = { includeDeclaration: true };
        send({ jsonrpc: '2.0', id: 2, method, params });
      } else if (msg?.id === 2) {
        if (settled) return;
        settled = true;
        if (msg.error) {
          cleanup();
          resolve({ ok: false, error: msg.error.message ?? 'LSP 请求失败' });
          return;
        }
        const normalized = normalize(input.action, msg.result);
        cleanup();
        resolve(normalized);
      }
    };

    child.stdout.on('data', createMessageReader(onMessage));
    child.on('error', (e: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: false,
        unavailable: e?.code === 'ENOENT',
        error: e?.message ?? String(e),
      });
    });
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'LSP 服务器提前退出' });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: pathToFileURL(input.cwd).href,
        capabilities: {},
        workspaceFolders: null,
      },
    });

    function cleanup() {
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      try { child.kill(); } catch { /* already gone */ }
    }
  });
}
