import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.AURAXIS_SESSION_LOG_DIR || '' },
}));

let root: string;
let cacheDir: string;

async function loadSessionLog() {
  vi.resetModules();
  return await import('../../session-log');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-agent-prune-'));
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-agent-prune-cache-'));
  process.env.AURAXIS_SESSION_LOG_DIR = root;
  process.env.AURAXIS_SESSION_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  delete process.env.AURAXIS_SESSION_LOG_DIR;
  delete process.env.AURAXIS_SESSION_CACHE_DIR;
  for (const dir of [root, cacheDir]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  vi.resetModules();
});

describe('pruneAgentCache', () => {
  it('removes projection rows for agent runs whose log file is gone', async () => {
    const { appendAgentLog, listAgentLogs, pruneAgentCache } = await loadSessionLog();
    await appendAgentLog('agent-keep', [{ type: 'text_chunk', text: 'keep me', timestamp: 1 }]);
    await appendAgentLog('agent-drop', [{ type: 'text_chunk', text: 'drop me', timestamp: 2 }]);
    expect((await listAgentLogs()).map((s) => s.id).sort()).toEqual(['agent-drop', 'agent-keep']);

    await fs.unlink(path.join(root, 'agent-agent-drop.jsonl'));
    const removed = await pruneAgentCache();

    expect(removed).toBeGreaterThanOrEqual(1);
    const ids = (await listAgentLogs()).map((s) => s.id);
    expect(ids).toContain('agent-keep');
    expect(ids).not.toContain('agent-drop');
  });
});
