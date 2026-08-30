import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// AG-3 / AG-4 regression: terminal agents must be reclaimed so the scheduler's
// `instances` Map and agent-handlers' `agents` Map don't grow without bound.

const ipcDir = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ipcDir, rel), 'utf-8');

// Mirror of the prune decision (time window + count cap over terminal agents).
type Inst = { id: string; status: string; endTime?: number };
function prune(list: Inst[], now: number, olderThanMs: number, maxKeep: number): string[] {
  const isTerminal = (s: string) => s === 'completed' || s === 'error' || s === 'stopped';
  const dropped = new Set<string>();
  for (const i of list) {
    if (isTerminal(i.status) && i.endTime && now - i.endTime > olderThanMs) dropped.add(i.id);
  }
  const survivingTerminals = list
    .filter((i) => isTerminal(i.status) && !dropped.has(i.id))
    .sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0));
  for (let k = 0; k < survivingTerminals.length - maxKeep; k++) dropped.add(survivingTerminals[k].id);
  return list.filter((i) => !dropped.has(i.id)).map((i) => i.id);
}

describe('agent prune — decision logic', () => {
  const now = 10_000_000;

  it('drops terminal agents older than the time window, keeps fresh + running', () => {
    const list: Inst[] = [
      { id: 'old', status: 'completed', endTime: now - 7200_000 }, // 2h ago → drop
      { id: 'fresh', status: 'completed', endTime: now - 1000 }, // just now → keep
      { id: 'running', status: 'running' }, // never dropped
      { id: 'queued', status: 'queued' }, // not terminal → keep
    ];
    const kept = prune(list, now, 3600_000, 50);
    expect(kept).toEqual(['fresh', 'running', 'queued']);
  });

  it('enforces the count cap by dropping the oldest terminal agents', () => {
    const list: Inst[] = Array.from({ length: 5 }, (_, k) => ({
      id: `a${k}`,
      status: 'completed',
      endTime: now - (5 - k) * 1000, // a0 oldest … a4 newest
    }));
    const kept = prune(list, now, 3600_000, 2); // keep only 2 newest
    expect(kept).toEqual(['a3', 'a4']);
  });

  it('never drops running agents even past the window', () => {
    const list: Inst[] = [{ id: 'r', status: 'running', endTime: now - 9_999_999 }];
    expect(prune(list, now, 3600_000, 0)).toEqual(['r']);
  });
});

describe('agent prune — wiring is in place', () => {
  it('scheduler pruneStale drops terminal instances (AG-4) and is called on completion', () => {
    const src = read('agent-scheduler-class-impl.ts');
    const cleanup = read('agent-scheduler-cleanup.ts');
    const pruneMatch = src.match(/pruneStale\([^)]*\)\s*:\s*number\s*\{[\s\S]*?\n {2}\}/);
    expect(pruneMatch).toBeTruthy();
    expect(pruneMatch![0]).toContain('pruneAgentInstances');
    expect(cleanup).toContain('instances.delete(id)');
    // Triggered when an agent completes or errors.
    expect(src).toContain('this.pruneStale();');
    expect((src.match(/this\.pruneStale\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('sub-agent map is pruned on each new runSubAgent (AG-3)', () => {
    const src = read('agent-subagent-registry.ts');
    expect(src).toContain('export function pruneSubAgents');
    expect(src).toContain('pruneSubAgents();');
    // Prune call sits before the new sub-agent is inserted.
    const pruneIdx = src.indexOf('pruneSubAgents();');
    const setIdx = src.indexOf('agents.set(agent.id, agent);');
    expect(pruneIdx).toBeGreaterThan(0);
    expect(pruneIdx).toBeLessThan(setIdx);
  });
});
