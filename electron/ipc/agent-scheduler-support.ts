/** agent-scheduler-support.ts — scheduler helper functions. */
import type { BrowserWindow } from 'electron';
import type { AgentInstance } from './agent-scheduler-types';
import { taskPlanToFrontendPlan } from './agent-scheduler-types';

export function genId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function broadcast(win: BrowserWindow | null, agentId: string, event: unknown) {
  if (win && !win.isDestroyed() && isRecord(event)) {
    win.webContents.send(`agent:event:${agentId}`, { ...event, agentId });
  }
}

/** Send agent:updated for frontend real-time state sync. */
export function notifyFrontend(win: BrowserWindow | null, inst: AgentInstance) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:updated', {
      id: inst.agentId,
      agentId: inst.agentId,
      name: inst.config.name,
      description: inst.config.displayDescription || inst.config.description || '',
      projectPath: inst.projectPath,
      type: 'general-purpose',
      status: inst.status,
      priority: inst.priority,
      startTime: inst.startTime,
      endTime: inst.endTime,
      iteration: inst.iterations,
      maxIterations: inst.maxIterations,
      goal: inst.config.goal,
      toolCallCount: inst.toolCallCount,
      messagesCount: inst.messagesCount,
      model: inst.config.model,
      surface: inst.config.surface,
      workTier: inst.config.workTier,
      delivery: inst.delivery,
      error: inst.error,
      result: inst.result,
      plan: taskPlanToFrontendPlan(inst.plan),
    });
  }
}

export const PRIORITY_ORDER: Record<string, number> = { high: 3, normal: 2, low: 1 };
