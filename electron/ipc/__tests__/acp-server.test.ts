import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { AcpServer, type AcpDeps, type AcpRpcMessage } from '../../acp-server';

function makeServer(deps: Partial<AcpDeps> = {}) {
  const sent: AcpRpcMessage[] = [];
  const runAgent = deps.runAgent ?? vi.fn(async () => ({ output: { result: 'ok' } }));
  const onShutdown = deps.onShutdown ?? vi.fn();
  const server = new AcpServer({ runAgent, onShutdown }, (m) => sent.push(m));
  return { server, sent, runAgent, onShutdown };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('acp-server', () => {
  it('handles initialize with capabilities and agent info', () => {
    const { server, sent } = makeServer();
    server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: { major: 0, minor: 1 } } });
    const res = sent[0];
    expect(res.id).toBe(1);
    expect((res.result as any).protocolVersion).toEqual({ major: 0, minor: 1 });
    expect((res.result as any).agentCapabilities.promptTypes).toEqual(['text', 'plan']);
    expect((res.result as any).agentCapabilities.transcriptTypes).toEqual(['text', 'plan']);
    expect((res.result as any).agentCapabilities.fileTypes).toEqual(['text']);
    expect((res.result as any).agentInfo.name).toBe('auraxis');
  });

  it('creates a session and runs a prompt with streaming notifications', async () => {
    const { server, sent } = makeServer();
    server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:/proj' } });
    const sessionId = (sent[0].result as any).sessionId as string;

    server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: { text: '重构' } } });
    await flush();

    expect(sent[1]).toMatchObject({ id: 3, result: { sessionId, sequenceId: 1 } });
    expect(sent[2]).toMatchObject({ method: 'session/update', params: { sessionId, state: 'running' } });
    const message = sent[3];
    expect(message.method).toBe('request/agent_message');
    expect((message.params as any).message.content[0].text).toBe('ok');
    expect(sent[4]).toMatchObject({ method: 'session/update', params: { sessionId, state: 'idle' } });
  });

  it('extracts string output when runAgent returns a string', async () => {
    const { server, sent } = makeServer({ runAgent: async () => ({ output: '直接答案' }) });
    server.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent[0].result as any).sessionId;
    server.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: { text: 'x' } } });
    await flush();
    const msg = sent.find((m) => m.method === 'request/agent_message');
    expect((msg!.params as any).message.content[0].text).toBe('直接答案');
  });

  it('cancel aborts the running agent', async () => {
    const runAgent = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise((resolve) => {
        signal?.addEventListener('abort', resolve, { once: true });
      });
      return { output: null, error: 'cancelled' };
    });
    const { server, sent } = makeServer({ runAgent });
    server.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent[0].result as any).sessionId;
    server.handle({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: { text: 'run' } } });
    await flush();
    server.handle({ jsonrpc: '2.0', id: 3, method: 'session/cancel', params: { sessionId } });
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sent.some((m) => m.method === 'session/update' && (m.params as any).state === 'idle')).toBe(true);
  });

  it('session/delete makes later prompts fail with session not found', () => {
    const { server, sent } = makeServer();
    server.handle({ jsonrpc: '2.0', id: 1, method: 'session/new' });
    const sessionId = (sent[0].result as any).sessionId;
    server.handle({ jsonrpc: '2.0', id: 2, method: 'session/delete', params: { sessionId } });
    server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: { text: 'x' } } });
    expect((sent[2].error as any).code).toBe(-32001);
  });

  it('reports unknown methods and invalid requests', () => {
    const { server, sent } = makeServer();
    server.handle({ jsonrpc: '2.0', id: 9, method: 'nope' });
    expect((sent[0].error as any).code).toBe(-32601);
    server.handle({ foo: 1 });
    expect((sent[1].error as any).code).toBe(-32600);
  });

  it('shutdown responds and triggers onShutdown', () => {
    const { server, sent, onShutdown } = makeServer();
    server.handle({ jsonrpc: '2.0', id: 10, method: 'shutdown' });
    expect(sent[0]).toMatchObject({ id: 10, result: {} });
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('session/read_file and session/update_file stay inside the project root', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acp-fs-'));
    try {
      const { server, sent } = makeServer();
      await server.handle({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: dir } });
      const sessionId = (sent[0].result as any).sessionId as string;
      const filePath = path.join(dir, 'sub', 'a.txt');

      await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/update_file',
        params: { sessionId, filePath, content: 'hello acp' },
      });
      expect(readFileSync(filePath, 'utf8')).toBe('hello acp');

      await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/read_file',
        params: { sessionId, filePath },
      });
      expect((sent.at(-1)?.result as any).content).toBe('hello acp');

      await server.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'session/read_file',
        params: { sessionId, filePath: path.join(os.tmpdir(), 'outside.txt') },
      });
      expect(String((sent.at(-1)?.error as any)?.message)).toContain('项目目录');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
