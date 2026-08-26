import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

vi.mock('../../session-projection-cache', async () => {
  const actual = await vi.importActual<typeof import('../../session-projection-cache')>(
    '../../session-projection-cache',
  );
  return { ...actual, sqliteAvailable: () => false };
});

import {
  tokenize,
  addFtsDoc,
  removeFtsDoc,
  searchFts,
  rebuildFts,
  flushFts,
  sessionQuerySearch,
  resetFtsDb,
  refreshSessionFts,
  scheduleSessionFtsRefresh,
} from '../../fts';

let ftsDir: string;
let chatDir: string;
let sessionDir: string;
let snapDir: string;

beforeEach(async () => {
  ftsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-fts-'));
  chatDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-fts-chat-'));
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-fts-session-'));
  snapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-fts-snap-'));
  process.env.AURAXIS_FTS_DIR = ftsDir;
  process.env.AURAXIS_CHAT_LOG_DIR = chatDir;
  process.env.AURAXIS_SESSION_LOG_DIR = sessionDir;
  process.env.AURAXIS_SNAPSHOT_DIR = snapDir;
  resetFtsDb();
});

afterEach(async () => {
  resetFtsDb();
  delete process.env.AURAXIS_FTS_DIR;
  delete process.env.AURAXIS_CHAT_LOG_DIR;
  delete process.env.AURAXIS_SESSION_LOG_DIR;
  delete process.env.AURAXIS_SNAPSHOT_DIR;
  for (const dir of [ftsDir, chatDir, sessionDir, snapDir]) {
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

describe('fts', () => {
  async function waitForFtsHit(query: string, id: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await searchFts(query)).some((h) => h.id === id)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`FTS hit "${id}" for "${query}" not found within ${timeoutMs}ms`);
  }

  it('tokenizes CJK bigrams and latin words', () => {
    const tokens = tokenize('静水流深 think');
    expect(tokens).toContain('静水');
    expect(tokens).toContain('水流');
    expect(tokens).toContain('流深');
    expect(tokens).toContain('think');
  });

  it('indexes docs and ranks search hits with snippets', async () => {
    await addFtsDoc({ type: 'chat', id: 's1', title: '会话一', text: '今天讨论了登录模块的静水流深设计', ts: 1000 });
    await addFtsDoc({ type: 'chat', id: 's2', title: '会话二', text: '无关内容', ts: 2000 });
    await flushFts();
    const hits = await searchFts('静水流深');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('s1');
    expect(hits[0].snippet).toContain('静水流深');
    expect(await searchFts('不存在的词')).toEqual([]);
  });

  it('rebuilds the index from chat, session and snapshot logs', async () => {
    await fs.writeFile(
      path.join(chatDir, 'session-a.jsonl'),
      '{"seq":1,"type":"user","ts":1,"data":{"text":"登录模块需要重构"}}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(sessionDir, 'agent-1.jsonl'),
      '{"type":"text_chunk","ts":2,"text":"修复了登录超时 bug"}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(snapDir, 'agent-1.json'),
      JSON.stringify({ name: '修复任务', result: '登录修复完成', startTime: 3 }),
      'utf8',
    );

    const indexed = await rebuildFts();
    expect(indexed).toBeGreaterThanOrEqual(2);
    const hits = await searchFts('登录');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('sessionQuerySearch returns bounded model-facing hits', async () => {
    await addFtsDoc({
      type: 'chat',
      id: 's-mem',
      title: '登录模块讨论',
      text: '我们决定登录模块使用静水流深方案',
      ts: 5000,
    });
    await addFtsDoc({ type: 'agent', id: 'a-mem', title: '修复任务', text: '登录超时 bug 已修复', ts: 6000 });
    await flushFts();
    const hits = await sessionQuerySearch('登录');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.title)).toEqual(expect.arrayContaining(['登录模块讨论', '修复任务']));
    expect(hits[0].snippet).toContain('登录');
    const capped = await sessionQuerySearch('登录', 99);
    expect(capped.length).toBeLessThanOrEqual(20);
  });

  it('removeFtsDoc 删除后不再出现在搜索结果', async () => {
    const id = `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await addFtsDoc({ type: 'chat', id, title: '待删除会话', text: '独一无二的关键词 zzqqxxyy 讨论', ts: 1000 });
    expect((await searchFts('zzqqxxyy')).some((h) => h.id === id)).toBe(true);

    await removeFtsDoc(id);

    expect((await searchFts('zzqqxxyy')).some((h) => h.id === id)).toBe(false);
    await flushFts();
  });

  it('refreshSessionFts indexes one chat log without a full rebuild', async () => {
    await fs.writeFile(
      path.join(chatDir, 'session-inc.jsonl'),
      '{"seq":1,"type":"user","ts":10,"data":{"text":"增量索引测试"}}\n' +
        '{"seq":2,"type":"assistant_chunk","ts":11,"data":{"text":"收到，开始处理"}}\n',
      'utf8',
    );

    await refreshSessionFts('session-inc', 'chat');
    const hits = await searchFts('增量索引');
    expect(hits.some((h) => h.id === 'session-inc')).toBe(true);
    expect(hits.find((h) => h.id === 'session-inc')?.snippet).toContain('增量索引');
  }, 30_000);

  it('refreshSessionFts indexes agent logs under the agent- prefix', async () => {
    await fs.writeFile(
      path.join(sessionDir, 'agent-run-9.jsonl'),
      '{"type":"text_chunk","timestamp":20,"text":"agent 会话里提到了静水流深方案"}\n',
      'utf8',
    );

    await refreshSessionFts('run-9', 'agent');
    const hits = await searchFts('静水流深');
    expect(hits.some((h) => h.id === 'agent-run-9')).toBe(true);
  }, 30_000);

  it('refreshSessionFts removes the doc when the log becomes empty', async () => {
    await fs.writeFile(
      path.join(chatDir, 'session-gone.jsonl'),
      '{"seq":1,"type":"user","ts":1,"data":{"text":"将被清空 qqwweerr"}}\n',
      'utf8',
    );
    await refreshSessionFts('session-gone', 'chat');
    expect((await searchFts('qqwweerr')).some((h) => h.id === 'session-gone')).toBe(true);

    await fs.writeFile(path.join(chatDir, 'session-gone.jsonl'), '', 'utf8');
    await refreshSessionFts('session-gone', 'chat');
    expect((await searchFts('qqwweerr')).some((h) => h.id === 'session-gone')).toBe(false);
  }, 30_000);

  it('scheduleSessionFtsRefresh debounces bursts and indexes after the quiet window', async () => {
    await fs.writeFile(
      path.join(chatDir, 'session-debounce.jsonl'),
      '{"seq":1,"type":"user","ts":30,"data":{"text":"定时刷新关键词 zxcvbn"}}\n',
      'utf8',
    );
    scheduleSessionFtsRefresh('session-debounce', 'chat');
    scheduleSessionFtsRefresh('session-debounce', 'chat'); // second call resets the timer

    expect((await searchFts('zxcvbn')).some((h) => h.id === 'session-debounce')).toBe(false);
    await waitForFtsHit('zxcvbn', 'session-debounce');
  });
});
