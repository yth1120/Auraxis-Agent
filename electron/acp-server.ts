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
import { resolveInsideRoot } from './ipc/path-security';
import { isRecord } from './utils/guards';

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

  private reply(msg: AcpRpcMessage, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: msg.id ?? null, result });
  }

  private fail(msg: AcpRpcMessage, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  }

  /** Look up the session named in `params.sessionId`; reports the error itself. */
  private requireSession(msg: AcpRpcMessage): AcpSession | null {
    const params = msg.params ?? {};
    const session = this.sessions.get(String(params.sessionId ?? ''));
    if (session) return session;
    this.fail(msg, -32001, 'Session not found');
    return null;
  }

  async handle(raw: unknown): Promise<void> {
    const msg = raw as AcpRpcMessage;
    if (!msg || msg.jsonrpc !== '2.0') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    try {
      await this.dispatch(msg);
    } catch (e: unknown) {
      this.fail(msg, -32603, errorText(e));
    }
  }

  private async dispatch(msg: AcpRpcMessage): Promise<void> {
    switch (msg.method) {
      case 'initialize':
        return this.handleInitialize(msg);
      case 'session/new':
        return this.handleSessionNew(msg);
      case 'session/prompt':
        return this.handleSessionPrompt(msg);
      case 'session/read_file':
        return this.handleSessionReadFile(msg);
      case 'session/update_file':
        return this.handleSessionUpdateFile(msg);
      case 'session/cancel':
        return this.handleSessionCancel(msg);
      case 'session/delete':
        return this.handleSessionDelete(msg);
      case 'shutdown':
        this.reply(msg, {});
        this.deps.onShutdown?.();
        return;
      default:
        this.fail(msg, -32601, `Method not found: ${msg.method}`);
    }
  }

  private handleInitialize(msg: AcpRpcMessage): void {
    const params = msg.params ?? {};
    const clientVersion = params.protocolVersion ?? { major: 0, minor: 1 };
    this.reply(msg, {
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
    });
  }

  private handleSessionNew(msg: AcpRpcMessage): void {
    const id = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const params = msg.params ?? {};
    this.sessions.set(id, {
      id,
      seq: 0,
      abort: new AbortController(),
      projectRoot: typeof params.cwd === 'string' ? params.cwd : undefined,
      running: false,
    });
    this.reply(msg, { sessionId: id });
  }

  private handleSessionPrompt(msg: AcpRpcMessage): void {
    const session = this.requireSession(msg);
    if (!session) return;
    const params = msg.params ?? {};
    const prompt = isRecord(params.prompt) ? params.prompt : {};
    const text = typeof prompt.text === 'string' ? prompt.text : '';
    const promptType: 'text' | 'plan' = prompt.type === 'plan' ? 'plan' : 'text';
    if (!text.trim()) {
      this.fail(msg, -32602, 'prompt.text is required');
      return;
    }
    if (session.running) {
      this.fail(msg, -32002, '上一个 prompt 仍在运行中');
      return;
    }
    session.seq += 1;
    const sequenceId = session.seq;
    session.running = true;
    this.reply(msg, { sessionId: session.id, sequenceId });
    void this.runPrompt(session, sequenceId, text, promptType);
  }

  private async handleSessionReadFile(msg: AcpRpcMessage): Promise<void> {
    const session = this.requireSession(msg);
    if (!session) return;
    const params = msg.params ?? {};
    const filePath = await this.resolveFilePath(session, typeof params.filePath === 'string' ? params.filePath : '');
    const content = await fs.readFile(filePath, 'utf8');
    this.reply(msg, { content });
  }

  private async handleSessionUpdateFile(msg: AcpRpcMessage): Promise<void> {
    const session = this.requireSession(msg);
    if (!session) return;
    const params = msg.params ?? {};
    if (typeof params.content !== 'string') {
      this.fail(msg, -32602, 'content is required');
      return;
    }
    const filePath = await this.resolveFilePath(session, typeof params.filePath === 'string' ? params.filePath : '');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, params.content, 'utf8');
    this.reply(msg, {});
  }

  private handleSessionCancel(msg: AcpRpcMessage): void {
    const params = msg.params ?? {};
    this.sessions.get(String(params.sessionId ?? ''))?.abort.abort();
    this.reply(msg, {});
  }

  private handleSessionDelete(msg: AcpRpcMessage): void {
    const params = msg.params ?? {};
    const session = this.sessions.get(String(params.sessionId ?? ''));
    if (session) {
      session.abort.abort();
      this.sessions.delete(session.id);
    }
    this.reply(msg, {});
  }

  private async resolveFilePath(session: AcpSession, raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('filePath is required');
    }
    // Fail closed: a session created without a project root must not be able
    // to reach arbitrary absolute paths on disk.
    if (!session.projectRoot) {
      throw new Error('会话未设置项目目录（session/new 缺少 cwd），拒绝文件访问');
    }
    return resolveInsideRoot(raw, path.resolve(session.projectRoot));
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
