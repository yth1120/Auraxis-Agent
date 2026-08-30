/** useAgentStore.ts — Zustand agent store wiring.
 *
 * Local mutations and IPC actions live in `agentStoreActions.ts`; persistent
 * merge/hydration options remain here because they describe the public store.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentInfo, AgentStore } from '../types/agent';
import { createAgentStoreActions, isAgentTombstoned } from './agentStoreActions';
import { createAgentStoreBuffers } from './agentStoreBuffers';
import { createAgentEventRuntime } from './agentStoreEvents';
import { useAppStore } from './useAppStore';
import { agentIpc, toBackendPatch, type BackendAgentSnapshot } from './agentStoreHelpers';

export const useAgentStore = create<AgentStore>()(
  persist(
    (set, get) => ({
      agents: [],
      isLoading: false,
      maxConcurrent: 3,
      currentAgentId: null,
      lastAgentIdBySurface: {},
      agentPermissions: {},

      ...createAgentStoreActions(set, get),

      subscribeToUpdates: () => {
        const api = agentIpc();
        if (!api?.onUpdated) return () => {};

        const unsub = api.onUpdated((updated: AgentInfo) => {
          const snapshot = updated as BackendAgentSnapshot;
          const id = updated.id || snapshot.agentId;
          if (!id) return;
          if (isAgentTombstoned(id)) return;

          // CRITICAL: attach per-agent event listener BEFORE touching state.
          // This runs synchronously inside the ipcRenderer 'agent:updated'
          // handler, so any subsequent `agent:event:${id}` message (e.g. the
          // first text_chunk from the planning phase) is already subscribed.
          // Skipping this synchronous attach loses the opening events of the
          // run while React schedules a re-render.
          const status = updated.status as string;
          const active = status === 'running' || status === 'queued' || status === 'paused';
          if (active) agentEvents.ensureEventSub(id);
          else agentEvents.scheduleEventSubCleanup(id);

          const patch = toBackendPatch(snapshot);
          set((s) => {
            const exists = s.agents.some((a) => a.id === id);
            if (exists) {
              return {
                agents: s.agents.map((a) => {
                  if (a.id !== id) return a;
                  return { ...a, ...patch, log: a.log };
                }),
              };
            }
            // Auto-add: sub-agent spawned from main chat Agent tool
            return {
              agents: [
                ...s.agents,
                {
                  id,
                  name: patch.name ?? 'Sub-Agent',
                  description: patch.description ?? '',
                  type: patch.type ?? 'general-purpose',
                  status: patch.status ?? 'running',
                  priority: patch.priority ?? 'normal',
                  projectRoot: patch.projectRoot ?? '',
                  startTime: patch.startTime ?? Date.now(),
                  endTime: patch.endTime,
                  iteration: patch.iteration ?? 0,
                  maxIterations: patch.maxIterations ?? 200,
                  toolCallCount: patch.toolCallCount ?? 0,
                  messagesCount: patch.messagesCount ?? 0,
                  surface: patch.surface,
                  totalInputTokens: 0,
                  totalOutputTokens: 0,
                  plan: patch.plan ?? null,
                  model: patch.model,
                  error: patch.error,
                  result: patch.result,
                  workTier: patch.workTier,
                  delivery: patch.delivery,
                  log: [],
                },
              ],
            };
          });
        });

        return unsub;
      },
    }),
    {
      name: 'auraxis-agent-storage',
      partialize: (state) => ({
        agents: state.agents
          .filter(
            (a) =>
              a.status === 'running' ||
              a.status === 'paused' ||
              a.status === 'queued' ||
              a.status === 'completed' ||
              a.status === 'error' ||
              a.status === 'stopped' ||
              a.status === 'review',
          )
          .map((a) => ({ ...a, log: [] })), // Don't persist streaming logs
        maxConcurrent: state.maxConcurrent,
        // Keep the selected task across renderer reloads: losing it is what
        // made a finished task appear to "jump back to the new-chat screen".
        currentAgentId: state.currentAgentId,
        lastAgentIdBySurface: state.lastAgentIdBySurface,
      }),
      // App restart: the backend restores running/paused/queued tasks from
      // its own disk snapshots (via refreshStates), so live entries must not
      // be resurrected from localStorage or they'd duplicate. Terminal
      // history (completed/error/stopped) is NOT stored by the backend and
      // must survive the restart — keep those entries.
      // NOTE: this must happen in `merge` (pure data transform) — the store
      // binding is still in its TDZ when onRehydrateStorage's callback runs.
      merge: (persisted, current) => {
        const persistedAgents = (persisted as { agents?: AgentInfo[] } | undefined)?.agents;
        const agents = Array.isArray(persistedAgents) ? persistedAgents : [];
        const persistedSelection =
          (persisted as { currentAgentId?: string | null } | undefined)?.currentAgentId ?? null;
        return {
          ...current,
          ...(persisted as Partial<AgentStore>),
          agents: agents.filter(
            (a) => a.status === 'completed' || a.status === 'error' || a.status === 'stopped' || a.status === 'review',
          ),
          // Restore the selection. A running task is not in `agents` yet —
          // refreshStates() re-attaches it from the backend right after boot.
          currentAgentId: persistedSelection,
        };
      },
    },
  ),
);

// RAF batches: collect streaming chunks (text + thinking) arriving in the
// same frame and flush them as a single appendAgentLog call. Without this, a
// fast LLM stream fires dozens of setState per second and re-renders the
// entire agent list each time. Buffered per agent in arrival order so a
// text↔thinking switch flushes as separate entries (appendAgentLog merges
// only same-kind neighbors).
const agentBuffers = createAgentStoreBuffers({
  getAppend: () => useAgentStore.getState().appendAgentLog,
  setState: (patch) => useAgentStore.setState(patch),
});

const agentEvents = createAgentEventRuntime({
  getState: () => useAgentStore.getState(),
  setState: (patch) => useAgentStore.setState(patch),
  appendLog: (id, entries) => useAgentStore.getState().appendAgentLog(id, entries),
  buffers: agentBuffers,
});
// ─── Module-level subscription (auto-inits, HMR-safe) ───

if (typeof window !== 'undefined') {
  const subscriptionWindow = window as typeof window & { __auraxis_agent_sub?: () => void };
  const prev = subscriptionWindow.__auraxis_agent_sub;
  if (prev) prev(); // Clean previous subscription (HMR)
  subscriptionWindow.__auraxis_agent_sub = (() => {
    const unsubUpdates = useAgentStore.getState().subscribeToUpdates();
    // 模式切换不丢任务：先记住当前模式选中的任务，再恢复目标模式上次的
    // 选中项；没有历史选中才清空。这样 Code↔Work 来回切换不会回到新建界面。
    const unsubMode = useAppStore.subscribe((state, prev) => {
      if (state.sidebarMode === prev.sidebarMode) return;
      const surface = state.sidebarMode === 'chat' ? null : state.sidebarMode;
      const { currentAgentId, agents, lastAgentIdBySurface } = useAgentStore.getState();
      if (currentAgentId) {
        const agent = agents.find((a) => a.id === currentAgentId);
        const agentSurface = agent?.surface ?? 'code';
        if (agentSurface === 'work' || agentSurface === 'code') {
          useAgentStore.setState({
            lastAgentIdBySurface: { ...lastAgentIdBySurface, [agentSurface]: currentAgentId },
          });
        }
      }
      if (!surface) {
        useAgentStore.setState({ currentAgentId: null });
        return;
      }
      const saved = useAgentStore.getState().lastAgentIdBySurface[surface];
      const savedAgent = saved ? useAgentStore.getState().agents.find((a) => a.id === saved) : null;
      useAgentStore.setState({ currentAgentId: savedAgent ? saved : null });
    });
    // Pull restored snapshots (task history / paused agents) from the backend.
    void useAgentStore.getState().refreshStates();
    // Backend maxConcurrent resets to its default on every app launch; push the
    // persisted value at startup so 前端显示与后端调度永远一致.
    agentIpc()
      ?.setMaxConcurrent?.(useAgentStore.getState().maxConcurrent)
      ?.catch?.(() => {});
    return () => {
      unsubUpdates();
      unsubMode();
      agentEvents.disposeAll();
      agentBuffers.clearPendingChunks();
    };
  })();
}
