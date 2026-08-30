/** agent-scheduler-queue.ts — scheduler queue and instance construction helpers. */
import type { AgentObserver } from './agent-loop';
import type { AgentConfig, AgentInstance } from './agent-scheduler-types';
import { PRIORITY_ORDER } from './agent-scheduler-support';

export type SchedulerPermissionCheck = (
  toolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
  agentId?: string,
) => Promise<boolean>;

export function createQueuedInstance(
  config: AgentConfig,
  projectPath: string,
  checkPermission: SchedulerPermissionCheck | undefined,
  queuePosition: number,
): AgentInstance {
  return {
    agentId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    config,
    status: 'queued',
    priority: config.priority || 'normal',
    queuePosition,
    startTime: Date.now(),
    projectPath,
    abortController: new AbortController(),
    observer: {} as AgentObserver,
    checkPermission,
    toolCallCount: 0,
    iterations: 0,
    messagesCount: 0,
    log: [],
    logBuffer: [],
    maxIterations: config.maxIterations ?? 200,
  };
}

export function countRunning(instances: Map<string, AgentInstance>): number {
  return [...instances.values()].filter((i) => i.status === 'running').length;
}

export function enqueuePending(queue: AgentConfig[], config: AgentConfig): number {
  queue.push(config);
  return queue.length;
}

export function removePending(queue: AgentConfig[], config: AgentConfig): boolean {
  const idx = queue.findIndex((c) => c === config);
  if (idx < 0) return false;
  queue.splice(idx, 1);
  return true;
}

export function reorderPending(queue: AgentConfig[], config: AgentConfig, newPosition: number): boolean {
  const idx = queue.findIndex((c) => c === config);
  if (idx < 0) return false;
  const [item] = queue.splice(idx, 1);
  queue.splice(Math.max(0, Math.min(newPosition, queue.length)), 0, item);
  return true;
}

export function sortPending(queue: AgentConfig[]): void {
  queue.sort((a, b) => (PRIORITY_ORDER[b.priority || 'normal'] || 2) - (PRIORITY_ORDER[a.priority || 'normal'] || 2));
}

export function findQueuedForConfig(
  instances: Map<string, AgentInstance>,
  config: AgentConfig,
): [string, AgentInstance] | undefined {
  return [...instances.entries()].find(([, inst]) => inst.status === 'queued' && inst.config === config);
}

export function releasePauseWaiter(inst: AgentInstance): void {
  if (inst.pauseResolve) {
    inst.pauseResolve();
    inst.pauseResolve = undefined;
    inst.pauseSettled = undefined;
  }
}
