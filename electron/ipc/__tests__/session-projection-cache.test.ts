import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JsonlSessionStore } from '../../session-store';
import { SessionProjectionCache, SqliteProjectionCache, sqliteAvailable } from '../../session-projection-cache';

let root: string;
let cacheDir: string;
let store: JsonlSessionStore;

function activeCache(): SessionProjectionCache | SqliteProjectionCache {
  return sqliteAvailable()
    ? new SqliteProjectionCache(path.join(cacheDir, 'projections.sqlite'))
    : new SessionProjectionCache(cacheDir);
}

const ev = (type: string, ts: number, text: string) => ({ type, ts, data: { text } }) as any;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-store-'));
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-cache-'));
  store = new JsonlSessionStore({ root: () => root, kind: 'chat', cacheDir });
});

afterEach(async () => {
  for (const dir of [root, cacheDir]) {
    for (let i = 0; i < 10; i++) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

describe('session projection cache', () => {
  it('serves list/project from cache without replaying the log', async () => {
    await store.append('s1', [ev('user', 1, 'hi'), ev('assistant_chunk', 2, 'hello')]);
    await store.meta('s1', { title: '缓存标题', messageCount: 2 });
    await store.list(); // warm summaries
    await store.project('s1'); // warm projection

    const readSpy = vi.fn(async () => []);
    (store as unknown as { read: unknown }).read = readSpy;

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('缓存标题');
    const p = await store.project('s1');
    expect(p?.messages).toHaveLength(2);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('rebuilds when the log grows past the cached seq', async () => {
    await store.append('s1', [ev('user', 1, 'hi')]);
    const first = await store.list();
    expect(first[0].eventCount).toBe(1);

    await store.append('s1', [ev('assistant_chunk', 2, 'hello')]);
    const second = await store.list();
    expect(second[0].eventCount).toBe(2);
    const p = await store.project('s1');
    expect(p?.messages).toHaveLength(2);
  });

  it('rebuilds a stale cache row whose lastSeq no longer matches', async () => {
    await store.append('s1', [ev('user', 1, 'hi'), ev('assistant_chunk', 2, 'hello')]);
    await store.list(); // warm the cache row
    const cache = activeCache();
    const row = await cache.read('s1');
    expect(row).not.toBeNull();
    await cache.write({ ...row!, lastSeq: (row!.lastSeq || 0) - 1 });

    const list = await store.list();
    expect(list[0].eventCount).toBe(2);
    const refreshed = await cache.read('s1');
    expect(refreshed!.lastSeq).toBe(row!.lastSeq);
  });

  it('delete removes the cache row', async () => {
    await store.append('s1', [ev('user', 1, 'hi')]);
    await store.list();
    await store.delete('s1');
    expect(await activeCache().read('s1')).toBeNull();
  });

  it('SQLite backend round-trips rows and upserts in place', async () => {
    if (!sqliteAvailable()) return; // skip when no SQLite engine is present
    const cache = new SqliteProjectionCache(path.join(cacheDir, 'roundtrip.sqlite'));
    expect(cache.available()).toBe(true);
    const row = {
      id: 'r1',
      kind: 'chat' as const,
      title: 'T',
      created: 1,
      updated: 2,
      messageCount: 1,
      eventCount: 1,
      lastSeq: 1,
    };
    await cache.write(row);
    expect(await cache.read('r1')).toMatchObject({ id: 'r1', title: 'T' });
    await cache.write({ ...row, title: 'T2', lastSeq: 2 });
    expect(await cache.read('r1')).toMatchObject({ title: 'T2', lastSeq: 2 });
    await cache.remove('r1');
    expect(await cache.read('r1')).toBeNull();
  });

  it('SQLite prune removes rows whose session is no longer valid', async () => {
    if (!sqliteAvailable()) return;
    const cache = new SqliteProjectionCache(path.join(cacheDir, 'prune.sqlite'));
    const row = (id: string) => ({
      id,
      kind: 'chat' as const,
      title: id,
      created: 1,
      updated: 1,
      messageCount: 1,
      eventCount: 1,
      lastSeq: 1,
    });
    await cache.write(row('keep'));
    await cache.write(row('drop'));

    expect(await cache.prune(['keep'])).toBe(1);
    expect(await cache.read('keep')).not.toBeNull();
    expect(await cache.read('drop')).toBeNull();
    expect(await cache.prune(['keep'])).toBe(0);
  });

  it('store.prune removes cache rows whose log file has been deleted', async () => {
    await store.append('s1', [ev('user', 1, 'hi')]);
    await store.append('s2', [ev('user', 2, 'hello')]);
    await store.list(); // warm both cache rows
    await fs.unlink(path.join(root, 's1.jsonl'));

    const removed = await store.prune();
    if (sqliteAvailable()) {
      expect(removed).toBe(1);
      expect(await activeCache().read('s1')).toBeNull();
      expect(await activeCache().read('s2')).not.toBeNull();
    } else {
      // JSON backend has no prune capability yet — best-effort no-op.
      expect(removed).toBe(0);
    }
  });
});
