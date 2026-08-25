import type { Session } from '../../stores/useSessionStore';
import type { Project } from '../../stores/useProjectStore';
import type { AgentInfo } from '../../types/agent';

export function sortSessions(list: Session[], orderBy: 'manual' | 'updated'): Session[] {
  const pinned = list.filter((s) => s.pinned);
  const rest = list.filter((s) => !s.pinned);
  const byUpdated = (arr: Session[]) => [...arr].sort((a, b) => b.updated - a.updated);
  return orderBy === 'updated' ? [...byUpdated(pinned), ...byUpdated(rest)] : [...pinned, ...rest];
}

export function orderSessionsByKey(
  key: string,
  list: Session[],
  sessionOrder: Record<string, string[]>,
  orderBy: 'manual' | 'updated',
): Session[] {
  const order = sessionOrder[key] ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...sortSessions(list, orderBy)].sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function orderedProjects(projects: Project[], workspaceOrder: string[]): Project[] {
  const projectRank = new Map(workspaceOrder.map((id, i) => [id, i]));
  return [...projects].sort(
    (a, b) => (projectRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (projectRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function buildTaskGroups(agents: AgentInfo[]): Map<string, AgentInfo[]> {
  const taskGroupMap = new Map<string, AgentInfo[]>();
  for (const a of agents) {
    const key = a.projectRoot || '';
    const list = taskGroupMap.get(key) ?? [];
    list.push(a);
    taskGroupMap.set(key, list);
  }
  return taskGroupMap;
}

export function unassignedSessionsOf(activeSessions: Session[], projects: Project[]): Session[] {
  const projectPaths = new Set(projects.map((p) => p.path));
  return activeSessions.filter((s) => !s.projectRoot || !projectPaths.has(s.projectRoot));
}
