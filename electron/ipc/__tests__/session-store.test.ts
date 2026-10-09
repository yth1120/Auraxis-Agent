import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JsonlSessionStore } from '../../session-store';
import type { SessionEvent } from '../../contracts/session-types';

vi.mock('../../session-projection-cache', async () => {
  const actual = await vi.importActual<typeof import('../../session-projection-cache')>(
    '../../session-projection-cache',
  );
  return { ...actual, sqliteAvailable: () => false };
});

let root: string;
let store: JsonlSessionStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-session-store-'));
  store = new JsonlSessionStore({ root: () => root, kind: 'chat' });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function ev(type: SessionEvent['type'], data: Record<string, unknown>, ts = Date.now()): Omit<SessionEvent, 'seq'> {
  return { type, ts, data };
}

describe('JsonlSessionStore', () => {
  it('appends with monotonic seq and replays in order', async () => {
    await store.append('s1', [ev('user', { text: 'hi' }), ev('assistant_chunk', { text: 'yo' })]);
    await store.append('s1', [ev('system', { event: 'done' })]);
    const events = await store.read('s1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('serializes concurrent appends so seq values stay unique', async () => {
    const batch = (base: number) =>
      Array.from({ length: 50 }, (_, i) => ev('user', { text: `m${base}-${i}` }, base * 1000 + i));
    await Promise.all([store.append('s1', batch(1)), store.append('s1', batch(2))]);
    const events = await store.read('s1');
    const seqs = events.map((e) => e.seq);
    expect(seqs).toHaveLength(100);
    expect(new Set(seqs).size).toBe(100);
    expect(seqs[seqs.length - 1]).toBe(100);
  });

  it('rejects reserved debug session ids so they never pollute history', async () => {
    await store.append('__ax-nav-trace__', [ev('system', { event: 'setSidebarMode(chat)' })]);
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  it('lists sessions with metadata and derived titles', async () => {
    await store.append('s1', [ev('user', { text: '第一个用户消息' })]);
    await store.meta('s1', { title: '自定义标题', model: 'm', messageCount: 7, pinned: true });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 's1',
      title: '自定义标题',
      model: 'm',
      messageCount: 7,
      pinned: true,
      kind: 'chat',
    });
  });

  it('projects messages and tool lifecycle', async () => {
    await store.append('s1', [
      ev('user', { text: '请读文件' }),
      ev('tool', { action: 'start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' } }),
      ev('tool', { action: 'end', toolName: 'Read', toolCallId: 'c1', output: 'code' }),
      ev('assistant_chunk', { text: '读完了' }),
    ]);
    const p = await store.project('s1');
    expect(p).not.toBeNull();
    expect(p!.messages).toHaveLength(2);
    expect(p!.messages[0]).toMatchObject({ role: 'user', content: '请读文件' });
    expect(p!.messages[1].toolCalls?.[0]).toMatchObject({ toolName: 'Read', status: 'done', output: 'code' });
    expect(p!.messages[1].content).toBe('读完了');
  });

  // 中止（用户取消 / 权限被拒）是独立终态。此前投影只认 end|error，
  // 于是被中止的工具在重放里永远停在 running —— 刷新后看起来像"还在跑"。
  it('projects aborted tools as cancelled and keeps grouping + summary across replay', async () => {
    await store.append('s1', [
      ev('user', { text: '跑两个命令' }),
      ev('tool', {
        action: 'start',
        toolName: 'Bash',
        toolCallId: 'c1',
        input: { command: 'npm test' },
        stepGroupId: 'g1',
      }),
      ev('tool', {
        action: 'end',
        toolName: 'Bash',
        toolCallId: 'c1',
        output: { exitCode: 1 },
        durationMs: 42,
        stepGroupId: 'g1',
        summary: { exitCode: 1, stdoutLen: 10, stderrLen: 3 },
      }),
      ev('tool', {
        action: 'start',
        toolName: 'Bash',
        toolCallId: 'c2',
        input: { command: 'rm -rf /' },
        stepGroupId: 'g1',
      }),
      ev('tool', {
        action: 'aborted',
        toolName: 'Bash',
        toolCallId: 'c2',
        error: '用户拒绝了该工具调用权限',
        stepGroupId: 'g1',
      }),
    ]);
    const p = await store.project('s1');
    const calls = p!.messages[1].toolCalls!;
    expect(calls[0]).toMatchObject({
      id: 'c1',
      status: 'done',
      stepGroupId: 'g1',
      durationMs: 42,
      summary: { exitCode: 1 },
    });
    expect(calls[1]).toMatchObject({ id: 'c2', status: 'cancelled', stepGroupId: 'g1' });
    expect(calls[1].error).toContain('拒绝');
  });

  it('forks events up to a message boundary and stamps branchedFrom', async () => {
    await store.append('s1', [
      ev('user', { text: 'a' }),
      ev('assistant_chunk', { text: 'b' }),
      ev('user', { text: 'c' }),
    ]);
    const newId = await store.fork('s1', 'user-2');
    expect(newId).not.toBeNull();
    const forked = await store.read(newId!);
    expect(forked.map((e) => e.seq)).toEqual([1, 2, 3]); // copied events + branchedFrom meta
    const meta = forked.find((e) => e.data?.event === 'session_meta');
    expect((meta?.data.meta as any)?.branchedFrom?.sessionId).toBe('s1');
  });

  it('deletes sessions and reports missing deletes', async () => {
    await store.append('s1', [ev('user', { text: 'x' })]);
    expect(await store.delete('s1')).toBe(true);
    expect(await store.delete('s1')).toBe(false);
    expect(await store.read('s1')).toEqual([]);
  });

  it('tolerates corrupt lines during read', async () => {
    await fs.writeFile(
      path.join(root, 's1.jsonl'),
      '{"seq":1,"type":"user","ts":1,"data":{"text":"ok"}}\nbroken\n',
      'utf8',
    );
    const events = await store.read('s1');
    expect(events).toHaveLength(1);
  });

  it('supports an agent file prefix and kind', async () => {
    const agentStore = new JsonlSessionStore({ root: () => root, kind: 'agent', filePrefix: 'agent-' });
    await agentStore.append('a1', [ev('assistant_chunk', { text: 'run' })]);
    expect(await fs.readdir(root)).toEqual(['agent-a1.jsonl']);
    const list = await agentStore.list();
    expect(list[0]).toMatchObject({ id: 'a1', kind: 'agent' });
  });

  it('validates ids, empty events and reserved debug names', async () => {
    await store.append('', []);
    await store.append('bad/id', [ev('user', { text: 'x' })]);
    await store.meta('bad/id', { title: 'x' });
    await store.meta('__ax-nav-trace__', { title: 'x' });
    expect(await store.read('bad/id')).toHaveLength(1);
    expect(await store.delete('bad/id')).toBe(false);
    expect(await store.project('missing')).toBeNull();
    expect(await store.fork('missing')).toBeNull();
  });

  it('lists and projects rich event streams through the cache', async () => {
    const cached = new JsonlSessionStore({ root: () => root, kind: 'agent', cacheDir: () => root });
    await cached.append('edge', [
      ev('user', { text: '这是一个非常长的用户消息，用来测试标题截断行为是否生效' }),
      ev('system', {
        event: 'session_meta',
        meta: {
          kind: 'agent',
          title: '自定义标题',
          model: 'm',
          mode: 'code',
          pinned: true,
          messageCount: 9,
          branchedFrom: { sessionId: 's1', messageId: 'user-1', title: 't' },
        },
      }),
      ev('agent_status', { text: 'status' }),
      ev('thinking_chunk', { text: 'think' }),
      ev('tool', { action: 'start', toolName: 'Read', toolCallId: '', input: { file_path: 'a.ts' } }),
      ev('tool', { action: 'progress', toolName: 'Read' }),
      ev('tool', { action: 'end', toolName: 'Read', output: 'done' }),
      ev('tool', { action: 'error', toolName: 'Write', toolCallId: 'w', error: '' }),
      ev('system', { text: 'system text' }),
      ev('user', { text: 123 }),
      ev('assistant_chunk', { text: '' }),
    ]);

    const list = await cached.list();
    expect(list).toHaveLength(1);
    const p1 = await cached.project('edge');
    expect(p1).not.toBeNull();
    expect(p1!.messages.some((m) => m.role === 'system' && m.content === 'system text')).toBe(true);
    expect(p1!.messages.some((m) => m.toolCalls?.some((tc) => tc.toolName === 'Read' && tc.status === 'done'))).toBe(
      true,
    );
    const p2 = await cached.project('edge');
    expect(p2).not.toBeNull();
  });

  it('forks with an invalid boundary and handles cold/distinct files', async () => {
    await store.append('s1', [ev('user', { text: 'a' }), ev('assistant_chunk', { text: 'b' })]);
    await store.append('.hidden', [ev('user', { text: 'x' })]);
    await fs.writeFile(path.join(root, 'not-jsonl.txt'), 'x', 'utf8');
    const list = await store.list();
    expect(list).toHaveLength(2);
    const forked = await store.fork('s1', 'bad-boundary');
    expect(forked).not.toBeNull();
    expect(await store.prune()).toBe(0);
  });
});

// 投影缓存只按 lastSeq 校验：会话不增长就永远命中旧行。所以形状版本必须参与校验，
// 否则升级后老缓存不会被重建 —— 表现为新增字段永远为空，且不报任何错。
describe('投影形状版本', () => {
  it('版本不匹配的缓存行不会被当成命中（会重新投影）', async () => {
    await store.append('s1', [
      ev('user', { text: 'hi' }),
      ev('tool', { action: 'start', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'a.ts' } }),
    ]);
    const current = await store.read('s1');
    const lastSeq = current[current.length - 1].seq;

    const { SessionProjectionCache } = await import('../../session-projection-cache');
    const cache = new SessionProjectionCache(path.join(root, 'cache'));
    // 伪造一条 seq 相同、但形状版本过期的行，payload 里塞一段可识别的假数据。
    await cache.write({
      id: 's1',
      kind: 'chat',
      title: '陈旧缓存',
      created: 1,
      updated: 1,
      messageCount: 99,
      eventCount: 99,
      lastSeq,
      projVersion: 0,
      payload: {
        id: 's1',
        title: '陈旧缓存',
        created: 1,
        updated: 1,
        messageCount: 99,
        messages: [{ id: 'stale', role: 'user', content: '来自旧形状缓存', timestamp: 1 }],
      },
    });

    const projected = await store.project('s1');
    expect(projected?.messages.map((m) => m.content)).not.toContain('来自旧形状缓存');
    expect(projected?.messages[0].content).toBe('hi');
  });
});
