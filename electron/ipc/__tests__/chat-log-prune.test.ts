import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.AURAXIS_CHAT_LOG_DIR || '' },
}));

let root: string;
let cacheDir: string;

async function loadChatLog() {
  vi.resetModules();
  return await import('../../chat-log');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-chat-prune-'));
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-chat-prune-cache-'));
  process.env.AURAXIS_CHAT_LOG_DIR = root;
  process.env.AURAXIS_SESSION_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  delete process.env.AURAXIS_CHAT_LOG_DIR;
  delete process.env.AURAXIS_SESSION_CACHE_DIR;
  for (const dir of [root, cacheDir]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  vi.resetModules();
});

describe('pruneChatCache', () => {
  it('removes projection rows for chat sessions whose log file is gone', async () => {
    const { appendChatEvents, listChatSessions, pruneChatCache } = await loadChatLog();
    await appendChatEvents('session-chat-keep', [{ type: 'user', ts: 1, data: { text: 'keep me' } }]);
    await appendChatEvents('session-chat-drop', [{ type: 'user', ts: 2, data: { text: 'drop me' } }]);
    expect((await listChatSessions()).map((s) => s.id).sort()).toEqual(['session-chat-drop', 'session-chat-keep']);

    await fs.unlink(path.join(root, 'session-chat-drop.jsonl'));
    const removed = await pruneChatCache();

    expect(removed).toBeGreaterThanOrEqual(1);
    const ids = (await listChatSessions()).map((s) => s.id);
    expect(ids).toContain('session-chat-keep');
    expect(ids).not.toContain('session-chat-drop');
  });
});
