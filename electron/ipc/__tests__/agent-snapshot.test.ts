import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  saveAgentSnapshot,
  loadAgentSnapshots,
  removeAgentSnapshot,
  pruneSnapshots,
  type AgentSnapshotRecord,
} from '../../agent-snapshot';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-snapshots-'));
  process.env.AURAXIS_SNAPSHOT_DIR = root;
});

afterEach(async () => {
  delete process.env.AURAXIS_SNAPSHOT_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

function record(id: string, startTime: number, status: AgentSnapshotRecord['status']): AgentSnapshotRecord {
  return {
    id,
    name: `任务 ${id}`,
    type: 'general-purpose',
    model: 'deepseek-v4-pro',
    projectPath: '/tmp/project',
    priority: 'normal',
    maxIterations: 200,
    status,
    startTime,
    iteration: 0,
    toolCallCount: 0,
    messagesCount: 0,
    log: [],
  };
}

describe('agent-snapshot', () => {
  it('round-trips save and load with savedState', async () => {
    const r = record('agent-1', Date.now(), 'paused');
    r.savedState = {
      messages: [{ role: 'user', content: 'hi' }],
      plan: null,
      iteration: 3,
      toolCallCount: 5,
      allText: 'progress',
    };
    await saveAgentSnapshot(r);

    const loaded = await loadAgentSnapshots();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('agent-1');
    expect(loaded[0].status).toBe('paused');
    expect(loaded[0].savedState?.iteration).toBe(3);
  });

  it('remove deletes only the target snapshot', async () => {
    await saveAgentSnapshot(record('agent-a', Date.now(), 'completed'));
    await saveAgentSnapshot(record('agent-b', Date.now() + 1, 'error'));
    await removeAgentSnapshot('agent-a');
    const loaded = await loadAgentSnapshots();
    expect(loaded.map((r) => r.id)).toEqual(['agent-b']);
  });

  it('prune keeps only the most recent snapshots', async () => {
    for (let i = 0; i < 5; i++) {
      await saveAgentSnapshot(record(`agent-${i}`, 1000 + i, 'stopped'));
    }
    await pruneSnapshots(3);
    const loaded = await loadAgentSnapshots();
    expect(loaded).toHaveLength(3);
    expect(loaded[0].id).toBe('agent-4');
  });
});
