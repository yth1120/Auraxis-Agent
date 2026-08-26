import { describe, it, expect } from 'vitest';
import { PtyRegistry, runPtyTool, type PtySessionLike, type PtyFactory } from '../pty-tool';

class FakeSession implements PtySessionLike {
  written: string[] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: (() => void)[] = [];

  write(data: string): void {
    this.written.push(data);
  }
  kill(): void {
    this.killed = true;
    for (const cb of this.exitCbs.splice(0)) cb();
  }
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: () => void): void {
    this.exitCbs.push(cb);
  }
  push(data: string): void {
    for (const cb of [...this.dataCbs]) cb(data);
  }
}

function makeRegistry(): { registry: PtyRegistry; last: () => FakeSession } {
  let last = new FakeSession();
  const factory: PtyFactory = (_opts) => {
    last = new FakeSession();
    return last;
  };
  return { registry: new PtyRegistry(factory), last: () => last };
}

describe('pty-tool registry', () => {
  it('creates an owner-scoped session and lists it', () => {
    const { registry } = makeRegistry();
    const created = registry.create({ owner: 'task-a', command: 'node' });
    expect(created.command).toBe('node');
    expect(registry.list('task-a')).toHaveLength(1);
    expect(registry.list('task-b')).toHaveLength(0);
  });

  it('writes input with optional Enter', () => {
    const { registry, last } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    expect(registry.write(id, 'a', 'console.log(1)', true)).toBe(true);
    expect(last().written).toEqual(['console.log(1)\r']);
    expect(registry.write(id, 'a', 'x', false)).toBe(true);
    expect(last().written[1]).toBe('x');
  });

  it('read returns output since the last read only', async () => {
    const { registry, last } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    last().push('hello ');
    last().push('world');
    const first = await registry.read(id, 'a', 100);
    expect(first?.output).toBe('hello world');
    last().push(' again');
    const second = await registry.read(id, 'a', 100);
    expect(second?.output).toBe(' again');
  });

  it('read waits for late output within the timeout', async () => {
    const { registry, last } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    const promise = registry.read(id, 'a', 500);
    setTimeout(() => last().push('late'), 80);
    const result = await promise;
    expect(result?.output).toBe('late');
  });

  it('blocks access from another owner', async () => {
    const { registry } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    expect(registry.write(id, 'b', 'x', false)).toBe(false);
    expect(await registry.read(id, 'b', 10)).toBeNull();
    expect(registry.close(id, 'b')).toBe(false);
    expect(registry.list('b')).toHaveLength(0);
  });

  it('close removes the session; clear closes all of an owner', () => {
    const { registry, last } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    expect(registry.close(id, 'a')).toBe(true);
    expect(last().killed).toBe(true);
    registry.create({ owner: 'a', command: 'bash' });
    registry.create({ owner: 'a', command: 'python' });
    expect(registry.clearOwner('a')).toBe(2);
    expect(registry.list('a')).toHaveLength(0);
  });

  it('read times out and rejects missing sessions / invalid owners', async () => {
    const { registry } = makeRegistry();
    const { id } = registry.create({ owner: 'a', command: 'node' });
    const timedOut = await registry.read(id, 'a', 10);
    expect(timedOut).toEqual({ output: '' });
    expect(await registry.read('missing', 'a', 10)).toBeNull();
    expect(await registry.read(id, 'wrong', 10)).toBeNull();
    expect(registry.write('missing', 'a', 'x', false)).toBe(false);
    expect(registry.close('missing', 'a')).toBe(false);
    expect(registry.clearOwner('missing')).toBe(0);
  });
});

describe('runPtyTool routing', () => {
  it('routes create / write / read / close / list / clear actions', async () => {
    const { registry, last } = makeRegistry();
    const created = await runPtyTool('create', { command: 'node' }, 'a', registry);
    expect(created.error).toBeUndefined();
    const id = (created.output as { session_id: string }).session_id;

    const write = await runPtyTool('write', { session_id: id, data: '1+1', enter: true }, 'a', registry);
    expect(write.error).toBeUndefined();
    expect(last().written).toEqual(['1+1\r']);

    const list = await runPtyTool('list', {}, 'a', registry);
    expect((list.output as { sessions: unknown[] }).sessions).toHaveLength(1);

    const close = await runPtyTool('close', { session_id: id }, 'a', registry);
    expect(close.error).toBeUndefined();
    expect((await runPtyTool('list', {}, 'a', registry)).output).toEqual({ sessions: [] });
  });

  it('errors on unknown action / missing session id', async () => {
    const { registry } = makeRegistry();
    const bad = await runPtyTool('explode', {}, 'a', registry);
    expect(bad.error).toContain('未知 PTY 动作');
    const missing = await runPtyTool('write', { data: 'x' }, 'a', registry);
    expect(missing.error).toContain('session_id');
  });

  it('rejects invalid write/close/read requests and clears an owner', async () => {
    const { registry } = makeRegistry();
    const created = await runPtyTool('create', { command: 'node' }, 'a', registry);
    const id = (created.output as { session_id: string }).session_id;
    expect((await runPtyTool('write', { session_id: id, data: '' }, 'a', registry)).error).toContain('data');
    expect((await runPtyTool('read', { session_id: 'missing' }, 'a', registry)).error).toBeDefined();
    expect((await runPtyTool('close', { session_id: 'missing' }, 'a', registry)).error).toBeDefined();
    const cleared = await runPtyTool('clear', {}, 'a', registry);
    expect(cleared.error).toBeUndefined();
    expect((cleared.output as { closed: number }).closed).toBe(1);
  });
});
