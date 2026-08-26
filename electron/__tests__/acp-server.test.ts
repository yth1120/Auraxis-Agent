import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { AcpServer, type AcpDeps, type AcpRpcMessage } from '../acp-server';

let root: string;
let sent: AcpRpcMessage[];
const runAgentMock = vi.fn(
  async (params: any) =>
    ({
      output: { text: `done: ${params.prompt}` },
    }) as any,
);
let runAgent: AcpDeps['runAgent'] = runAgentMock as AcpDeps['runAgent'];

function server(): AcpServer {
  return new AcpServer(
    {
      runAgent,
      onShutdown: vi.fn(),
    },
    (message) => sent.push(message),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-acp-'));
  sent = [];
  runAgent = runAgentMock as AcpDeps['runAgent'];
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async ({ prompt, promptType }) => ({
    output: { text: `done: ${prompt}`, type: promptType },
  }));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('acp-server — Agent Client Protocol', () => {
  it('rejects malformed requests and unknown methods', async () => {
    const s = server();
    await s.handle({ jsonrpc: '1.0' });
    expect(sent.at(-1)?.error?.code).toBe(-32600);
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'unknown' });
    expect(sent.at(-1)?.error?.code).toBe(-32601);
  });

  it('initializes with defaults or client protocol version', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(sent.at(-1)?.result).toMatchObject({ protocolVersion: { major: 0, minor: 1 } });
    await s.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: { major: 1, minor: 2 } },
    });
    expect(sent.at(-1)?.result).toMatchObject({ protocolVersion: { major: 1, minor: 2 } });
  });

  it('creates a session and runs a prompt', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root } });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    await s.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: { text: 'hello', type: 'plan' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId, prompt: 'hello', promptType: 'plan' }));
    expect(sent).toContainEqual(expect.objectContaining({ method: 'request/agent_message' }));
    expect(sent.at(-1)).toMatchObject({ method: 'session/update', params: { state: 'idle' } });
  });

  it('returns errors for missing sessions and empty prompts', async () => {
    const s = server();
    await s.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 'missing', prompt: { text: 'hello' } },
    });
    expect(sent.at(-1)?.error?.code).toBe(-32001);
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'session/new' });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    await s.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: { text: '   ' } },
    });
    expect(sent.at(-1)?.error?.code).toBe(-32602);
  });

  it('reads and updates files inside the session root', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: root } });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'hello', 'utf8');
    await s.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/read_file',
      params: { sessionId, filePath: file },
    });
    expect(sent.at(-1)?.result).toEqual({ content: 'hello' });
    await s.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/update_file',
      params: { sessionId, filePath: path.join(root, 'b.txt'), content: 'new' },
    });
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('new');
    await s.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/read_file',
      params: { sessionId, filePath: path.join(root, '..', 'outside.txt') },
    });
    expect(sent.at(-1)?.error?.code).toBe(-32603);
  });

  it('rejects missing file parameters and invalid update content', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'session/read_file', params: { sessionId } });
    expect(sent.at(-1)?.error?.code).toBe(-32603);
    await s.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/update_file',
      params: { sessionId, filePath: path.join(root, 'a.txt') },
    });
    expect(sent.at(-1)?.error?.code).toBe(-32602);
  });

  it('cancels and deletes a session, and reports runAgent errors', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    runAgentMock.mockImplementationOnce(async () => ({ error: 'agent failed' }));
    await s.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: { text: 'hello' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toContainEqual(expect.objectContaining({ method: 'request/error' }));
    await s.handle({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId } });
    await s.handle({ jsonrpc: '2.0', id: 4, method: 'session/delete', params: { sessionId } });
    await s.handle({ jsonrpc: '2.0', id: 5, method: 'session/prompt', params: { sessionId, prompt: { text: 'x' } } });
    expect(sent.at(-1)?.error?.code).toBe(-32001);
  });

  it('handles shutdown callback and returns result', async () => {
    const onShutdown = vi.fn();
    const custom = new AcpServer({ runAgent, onShutdown }, (message) => sent.push(message));
    await custom.handle({ jsonrpc: '2.0', id: 1, method: 'shutdown' });
    expect(sent.at(-1)?.result).toEqual({});
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('handles an aborted prompt run and missing cancel/delete sessions', async () => {
    const s = server();
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent.at(-1)?.result as { sessionId: string }).sessionId;
    runAgentMock.mockImplementationOnce(
      ({ signal }) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ output: 'later' }), 50);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve({ output: 'aborted' });
          });
        }),
    );
    await s.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: { text: 'hello' } },
    });
    await s.handle({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).not.toContainEqual(expect.objectContaining({ method: 'request/agent_message' }));
    expect(sent.at(-1)).toMatchObject({ method: 'session/update', params: { state: 'idle' } });
    await s.handle({ jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId: 'missing' } });
    await s.handle({ jsonrpc: '2.0', id: 5, method: 'session/delete', params: { sessionId: 'missing' } });
  });
});
