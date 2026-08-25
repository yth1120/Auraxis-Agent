import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JsonlSessionStore } from '../../session-store';
import type { SessionEvent } from '../../contracts/session-types';

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
});
