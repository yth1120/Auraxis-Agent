/**
 * acp-server.ts — minimal Agent Client Protocol server （ACP 协议）.
 *
 * Exposes Auraxis agents to ACP clients (Zed, VS Code, etc.) over newline-
 * delimited JSON-RPC 2.0 on stdio. Supported methods:
 *   initialize / session/new / session/prompt / session/cancel /
 *   session/delete / session/read_file / session/update_file / shutdown
 * Server notifications: session/update (running/idle), request/agent_message,
 * request/error. Text + plan prompts; text file read/write inside the session
 * project root.
 */
import { errorText } from './errors';
import { createInterface } from 'readline';
import { promises as fs } from 'fs';
import path from 'path';

export interface AcpRunAgentParams {
  prompt: string;
  sessionId: string;
  projectRoot?: string;
  promptType?: 'text' | 'plan';
  signal?: AbortSignal;
}

export interface AcpDeps {
  runAgent: (params: AcpRunAgentParams) => Promise<{ output?: unknown; error?: string }>;
  /** Called after a `shutdown` request so the host can exit. */
  onShutdown?: () => void;
}

export interface AcpRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface AcpSession {
  id: string;
  seq: number;
  abort: AbortController;
  projectRoot?: string;
  /** True while a session/prompt run is in flight — one prompt at a time. */
  running: boolean;
}

function finalText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    for (const k of ['result', 'answer', 'output', 'text']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return JSON.stringify(output, null, 2);
}

export class AcpServer {
  private sessions = new Map<string, AcpSession>();

  constructor(
    private deps: AcpDeps,
    private send: (msg: AcpRpcMessage) => void,
  ) {}

  async handle(raw: unknown): Promise<void> {
    const msg = raw as AcpRpcMessage;
    if (!msg || msg.jsonrpc !== '2.0') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    try {
      switch (msg.method) {
        case 'initialize': {
          const params = msg.params ?? {};
          const clientVersion = params.protocolVersion ?? { major: 0, minor: 1 };
          this.send({
            jsonrpc: '2.0',
            id: msg.id ?? null,
            result: {
              protocolVersion: clientVersion,
              agentCapabilities: {
                transcriptTypes: ['text', 'plan'],
                promptTypes: ['text', 'plan'],
                fileTypes: ['text'],
                capabilities: [],
              },
              agentInfo: {
                name: 'auraxis',
                description: 'Auraxis coding agent',
                version: '0.0.1',
                url: '',
              },
            },
          });
          return;
        }
        case 'session/new': {
          const id = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const params = msg.params ?? {};
          this.sessions.set(id, {
            id,
            seq: 0,
            abort: new AbortController(),
            projectRoot: typeof params.cwd === 'string' ? params.cwd : undefined,
            running: false,
          });
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: { sessionId: id } });
          return;
        }
        case 'session/prompt': {
          const p = msg.params ?? {};
          const session = this.sessions.get(String(p.sessionId ?? ''));
          if (!session) {
            this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Session not found' } });
            return;
          }
          const prompt = isRecord(p.prompt) ? p.prompt : {};
          const text = typeof prompt.text === 'string' ? prompt.text : '';
          const promptType: 'text' | 'plan' = prompt.type === 'plan' ? 'plan' : 'text';
          if (!text.trim()) {
            this.send({
              jsonrpc: '2.0',
              id: msg.id ?? null,
              error: { code: -32602, message: 'prompt.text is required' },
            });
            return;
          }
          if (session.running) {
            this.send({
              jsonrpc: '2.0',
              id: msg.id ?? null,
              error: { code: -32002, message: '上一个 prompt 仍在运行中' },
            });
            return;
          }
          session.seq += 1;
          const sequenceId = session.seq;
          const sessionId = session.id;
          session.running = true;
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: { sessionId, sequenceId } });
          void this.runPrompt(session, sequenceId, text, promptType);
          return;
        }
        case 'session/read_file': {
          const p = msg.params ?? {};
          const session = this.sessions.get(String(p.sessionId ?? ''));
          if (!session) {
            this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Session not found' } });
            return;
          }
          const filePath = this.resolveFilePath(session, typeof p.filePath === 'string' ? p.filePath : '');
          const content = await fs.readFile(filePath, 'utf8');
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: { content } });
          return;
        }
        case 'session/update_file': {
          const p = msg.params ?? {};
          const session = this.sessions.get(String(p.sessionId ?? ''));
          if (!session) {
            this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32001, message: 'Session not found' } });
              return;
            }
          if (typeof p.content !== 'string') {
            this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: 'content is required' } });
            return;
          }
          const filePath = this.resolveFilePath(session, typeof p.filePath === 'string' ? p.filePath : '');
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, p.content, 'utf8');
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
          return;
        }
        case 'session/cancel': {
          const p = msg.params ?? {};
          const session = this.sessions.get(String(p.sessionId ?? ''));
          if (session) session.abort.abort();
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
          return;
        }
        case 'session/delete': {
          const p = msg.params ?? {};
          const session = this.sessions.get(String(p.sessionId ?? ''));
          if (session) {
            session.abort.abort();
            this.sessions.delete(session.id);
          }
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
          return;
        }
        case 'shutdown':
          this.send({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
          this.deps.onShutdown?.();
          return;
        default:
          this.send({
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          });
      }
    } catch (e: unknown) {
      this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: errorText(e) } });
    }
  }

  private resolveFilePath(session: AcpSession, raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('filePath is required');
    }
    const resolved = path.resolve(raw);
    // Fail closed: a session created without a project root must not be able
    // to reach arbitrary absolute paths on disk.
    if (!session.projectRoot) {
      throw new Error('会话未设置项目目录（session/new 缺少 cwd），拒绝文件访问');
    }
    const root = path.resolve(session.projectRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('filePath 必须位于会话项目目录内');
    }
    return resolved;
  }

  private async runPrompt(
    session: AcpSession,
    sequenceId: number,
    text: string,
    promptType: 'text' | 'plan',
  ): Promise<void> {
    this.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: session.id, state: 'running' },
    });
    try {
      const res = await this.deps.runAgent({
        prompt: text,
        sessionId: session.id,
        projectRoot: session.projectRoot,
        promptType,
        signal: session.abort.signal,
      });
      if (session.abort.signal.aborted) {
        // No agent_message on cancel; the finally block emits the single
        // terminal 'idle' update.
        return;
      }
      if (res.error) {
        this.send({
          jsonrpc: '2.0',
          method: 'request/error',
          params: { sessionId: session.id, sequenceId, error: { code: 1, message: res.error } },
        });
      } else {
        this.send({
          jsonrpc: '2.0',
          method: 'request/agent_message',
          params: {
            sessionId: session.id,
            sequenceId,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: finalText(res.output) }],
            },
          },
        });
      }
    } catch (e: unknown) {
      this.send({
        jsonrpc: '2.0',
        method: 'request/error',
        params: { sessionId: session.id, sequenceId, error: { code: -32000, message: errorText(e) } },
      });
    } finally {
      session.running = false;
      this.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: session.id, state: 'idle' },
      });
    }
  }
}

export function startAcpServer(deps: AcpDeps): () => void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (msg: AcpRpcMessage) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const server = new AcpServer(deps, send);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void server.handle(raw);
  });
  return () => rl.close();
}
