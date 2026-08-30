/** agent-scheduler-query.ts — pure scheduler snapshot projections. */
import type { AgentInfo } from '../advanced-defs';
import type { AgentStateSnapshot } from './agent-loop';
import type { AgentInstance, SchedulerAgentState, SchedulerQueueItem } from './agent-scheduler-types';
import { taskPlanToFrontendPlan } from './agent-scheduler-types';

export function toAgentState(inst: AgentInstance): AgentStateSnapshot | null {
  return {
    iteration: inst.iterations,
    toolCallCount: inst.toolCallCount,
    messagesCount: inst.log.length,
    plan: inst.plan ?? null,
    surface: inst.config.surface,
  };
}

export function toSchedulerAgentState(inst: AgentInstance): SchedulerAgentState {
  return {
    agentId: inst.agentId,
    name: inst.config.name,
    description: inst.config.displayDescription || inst.config.description || '',
    type: 'general-purpose',
    status: inst.status,
    priority: inst.priority,
    startTime: inst.startTime,
    endTime: inst.endTime,
    iteration: inst.iterations,
    maxIterations: inst.maxIterations,
    toolCallCount: inst.toolCallCount,
    messagesCount: inst.log.length,
    plan: taskPlanToFrontendPlan(inst.plan),
    model: inst.config.model,
    surface: inst.config.surface,
    workTier: inst.config.workTier,
    delivery: inst.delivery,
    error: inst.error,
    result: inst.result,
  };
}

export function toSubAgentState(sa: AgentInfo): SchedulerAgentState {
  return {
    agentId: sa.id,
    name: sa.name,
    description: sa.description || '',
    type: sa.type || 'general-purpose',
    status: sa.status,
    priority: sa.priority || 'normal',
    startTime: sa.startTime,
    endTime: sa.endTime,
    iteration: sa.iterations ?? sa.iteration ?? 0,
    maxIterations: sa.maxIterations ?? 200,
    toolCallCount: sa.toolCallCount ?? 0,
    messagesCount: sa.messagesCount ?? sa.log?.length ?? 0,
    plan: null,
    model: sa.model,
    surface: 'code',
    error: sa.error,
    result: sa.result,
  };
}

export function toQueueItem(inst: AgentInstance): SchedulerQueueItem | null {
  if (inst.status === 'running' || inst.status === 'paused') {
    return {
      agentId: inst.agentId,
      name: inst.config.name,
      status: inst.status,
      priority: inst.priority,
      startTime: inst.startTime,
    };
  }
  if (inst.status === 'queued') {
    return {
      agentId: inst.agentId,
      name: inst.config.name,
      status: 'queued',
      priority: inst.priority,
      queuePosition: inst.queuePosition,
    };
  }
  return null;
}

export function toAgentInstanceSummary(inst: AgentInstance): {
  agentId: string;
  name: string;
  description: string;
  status: string;
  priority: string;
  startTime: number;
  endTime?: number;
} {
  return {
    agentId: inst.agentId,
    name: inst.config.name,
    description: inst.config.displayDescription || inst.config.description || '',
    status: inst.status,
    priority: inst.priority,
    startTime: inst.startTime,
    endTime: inst.endTime,
  };
}
