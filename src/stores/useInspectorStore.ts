import { create } from 'zustand';
import type { PlanData, AgentTask, TaskStatus } from '../types/chat';

export interface SystemMessageEntry {
  id: string;
  content: string;
  level: 'info' | 'warning' | 'error';
  timestamp: number;
}

/** Raw TodoWrite item as emitted by the agent loop. */
export interface RawTodo {
  content: string;
  status: string;
  activeForm?: string;
}

/** Normalize TodoWrite todos into the workspace TaskChecklist model. */
export function mapTodosToTasks(todos: RawTodo[]): AgentTask[] {
  return todos.map((t, i) => {
    const status: TaskStatus = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'pending';
    const title = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    return { id: `task-${i}`, title, status };
  });
}

export interface InspectorStore {
  /** Plan-first task checklist (TodoWrite-driven) */
  tasks: AgentTask[];
  /** Plans awaiting or having received approval */
  plans: PlanData[];
  /** System messages routed from the agent loop (context compression, retries, etc.) */
  systemMessages: SystemMessageEntry[];
  /** Count of currently running tool executions (for collapse hint) */
  activeToolCount: number;
  /** Timestamp of most recent tool activity (for pulse animation cooldown) */
  lastToolActivity: number;

  setTasks: (tasks: AgentTask[]) => void;
  addPlan: (plan: PlanData) => void;
  updatePlan: (planId: string, updates: Partial<PlanData>) => void;
  removePlan: (planId: string) => void;
  addSystemMessage: (msg: SystemMessageEntry) => void;
  setActiveToolCount: (n: number) => void;
  incrementActiveTools: () => void;
  decrementActiveTools: () => void;
  touchToolActivity: () => void;
  clear: () => void;
}

/**
 * Pick the plan approval that owns the current composer. With concurrent
 * agents, a pending plan for another task must NOT hijack this input — the
 * user switches to that agent to approve it. Unowned (legacy query-path)
 * plans still show as a fallback when no agent is selected.
 */
export function selectPendingPlan(plans: PlanData[], currentAgentId: string | null): PlanData | undefined {
  const pending = plans.filter((p) => p.status === 'pending');
  if (pending.length === 0) return undefined;
  if (currentAgentId) {
    return pending.find((p) => p.agentId === currentAgentId);
  }
  return pending.find((p) => !p.agentId) ?? pending[0];
}

export const useInspectorStore = create<InspectorStore>()((set) => ({
  tasks: [],
  plans: [],
  systemMessages: [],
  activeToolCount: 0,
  lastToolActivity: 0,

  setTasks: (tasks) => set({ tasks }),

  addPlan: (plan) =>
    set((s) => ({
      plans: [...s.plans.filter((p) => p.planId !== plan.planId), plan],
    })),

  updatePlan: (planId, updates) =>
    set((s) => ({
      plans: s.plans.map((p) => (p.planId === planId ? { ...p, ...updates } : p)),
    })),

  removePlan: (planId) => set((s) => ({ plans: s.plans.filter((p) => p.planId !== planId) })),

  addSystemMessage: (msg) =>
    set((s) => ({
      systemMessages: [...s.systemMessages.slice(-99), msg],
    })),

  setActiveToolCount: (n) => set({ activeToolCount: Math.max(0, n) }),

  incrementActiveTools: () => set((s) => ({ activeToolCount: s.activeToolCount + 1, lastToolActivity: Date.now() })),

  decrementActiveTools: () => set((s) => ({ activeToolCount: Math.max(0, s.activeToolCount - 1) })),

  touchToolActivity: () => set({ lastToolActivity: Date.now() }),

  clear: () => set({ tasks: [], plans: [], systemMessages: [], activeToolCount: 0, lastToolActivity: 0 }),
}));
