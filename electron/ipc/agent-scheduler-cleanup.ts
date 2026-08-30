/** agent-scheduler-cleanup.ts — scheduler memory/worktree reclamation. */
import type { AgentInstance } from './agent-scheduler-types';

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'error' || status === 'stopped';
}

/**
 * Reclaim terminal agent instances. Two policies:
 *   1. time — drop agents finished longer than olderThanMs ago;
 *   2. count cap — if more than maxKeep terminal agents remain, drop oldest.
 */
export function pruneAgentInstances(
  instances: Map<string, AgentInstance>,
  clearOwner: (agentId: string) => void,
  olderThanMs = 3600_000,
  maxKeep = 50,
): number {
  let pruned = 0;
  const now = Date.now();
  const drop = (id: string) => {
    clearOwner(id);
    instances.delete(id);
    pruned++;
  };

  for (const [id, inst] of instances) {
    if (isTerminal(inst.status) && inst.endTime && now - inst.endTime > olderThanMs) {
      drop(id);
    }
  }

  const terminals = [...instances.entries()]
    .filter(([, i]) => isTerminal(i.status))
    .sort((a, b) => (a[1].endTime ?? 0) - (b[1].endTime ?? 0));
  for (let i = 0; i < terminals.length - maxKeep; i++) {
    drop(terminals[i][0]);
  }
  return pruned;
}
