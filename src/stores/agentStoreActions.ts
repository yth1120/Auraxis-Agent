/** agentStoreActions.ts — Agent store mutations and IPC-backed actions. */
import type { StoreApi } from 'zustand';
import type { AgentStatus, AgentStore } from '../types/agent';
import { agentIpc, toBackendPatch, type BackendAgentSnapshot } from './agentStoreHelpers';
import { useAppStore } from './useAppStore';

type SetState = StoreApi<AgentStore>['setState'];
type GetState = StoreApi<AgentStore>['getState'];

type AgentStoreActions = Omit<
  AgentStore,
  | 'agents'
  | 'isLoading'
  | 'maxConcurrent'
  | 'currentAgentId'
  | 'lastAgentIdBySurface'
  | 'agentPermissions'
  | 'subscribeToUpdates'
>;

/** Agent ids explicitly removed by the user — late backend broadcasts must
 *  not resurrect them (delete/complete race). */
const removedAgentIds = new Set<string>();

export function tombstoneAgentId(id: string): void {
  removedAgentIds.add(id);
}

export function isAgentTombstoned(id: string): boolean {
  return removedAgentIds.has(id);
}

export function clearAgentTombstones(): void {
  removedAgentIds.clear();
}

export function createAgentStoreActions(set: SetState, get: GetState): AgentStoreActions {
  return {
    setCurrentAgent: (id) => {
      set({ currentAgentId: id });
    },

    setPlanFile: (path, agentId) =>
      set((s) => {
        const id = agentId ?? s.currentAgentId;
        if (!id) return s;
        return {
          agents: s.agents.map((a) => (a.id === id ? { ...a, planFile: path ?? undefined } : a)),
        };
      }),

    addAgentPermission: (agentId, req) =>
      set((s) => ({
        agentPermissions: {
          ...s.agentPermissions,
          [agentId]: [...(s.agentPermissions[agentId] || []).filter((r) => r.requestId !== req.requestId), req],
        },
      })),

    removeAgentPermission: (agentId, requestId) =>
      set((s) => {
        const list = (s.agentPermissions[agentId] || []).filter((r) => r.requestId !== requestId);
        const next = { ...s.agentPermissions };
        if (list.length > 0) next[agentId] = list;
        else delete next[agentId];
        return { agentPermissions: next };
      }),

    addAgent: (agent) => set((s) => ({ agents: [...s.agents, agent] })),

    updateAgent: (id, updates) =>
      set((s) => ({
        agents: s.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
      })),

    removeAgent: async (id) => {
      const api = agentIpc();
      // Tombstone the id BEFORE the IPC round-trip: the backend may have a
      // terminal status broadcast already in flight, and without this guard
      // a late agent:updated would re-add the task the user just deleted.
      tombstoneAgentId(id);
      if (api) {
        // An agentId may live in either the legacy agent-handlers Map (sub-agents
        // from the Agent tool) or scheduler.instances (sidebar-created). Hit both
        // — whichever has the entry will clean up; the other is a cheap no-op.
        await Promise.allSettled([
          api.remove ? api.remove(id) : Promise.resolve(),
          api.schedulerRemove ? api.schedulerRemove(id) : Promise.resolve(),
        ]);
      }
      set((s) => {
        const nextPerms = { ...s.agentPermissions };
        delete nextPerms[id];
        return {
          agents: s.agents.filter((a) => a.id !== id),
          currentAgentId: s.currentAgentId === id ? null : s.currentAgentId,
          agentPermissions: nextPerms,
        };
      });
    },

    appendAgentLog: (id, entries) =>
      set((s) => ({
        agents: s.agents.map((a) => {
          if (a.id !== id) return a;
          const merged = [...(a.log || [])];
          for (const entry of entries) {
            const last = merged[merged.length - 1];
            // Streaming chunks of the same kind merge into one entry;
            // a kind switch (text↔thinking) starts a new block.
            const mergeable = entry.type === 'text' || entry.type === 'thinking';
            if (last && mergeable && last.type === entry.type) {
              merged[merged.length - 1] = {
                ...last,
                text: (last.text || '') + (entry.text || ''),
              };
            } else {
              merged.push({ ...entry });
            }
          }
          return { ...a, log: merged.slice(-500) };
        }),
      })),

    startAgent: async (request, projectPath) => {
      const api = agentIpc();
      if (!api?.start) return null;
      try {
        const result = await api.start(
          {
            name: request.name,
            description: request.description,
            displayDescription: request.displayDescription,
            type: request.type,
            model: request.model,
            temperature: request.temperature,
            messages: request.messages || [],
            projectRoot: request.projectRoot || '',
            apiKey: request.apiKey || '',
            autoApprove: request.autoApprove,
            isDeepThink: request.isDeepThink ?? true,
            reasoningEffort: request.reasoningEffort ?? 'high',
            toolChoice: request.toolChoice,
            priority: request.priority || 'normal',
            maxIterations: request.maxIterations ?? 200,
            // Scheduler's AgentConfig names this `tools` — sending it as
            // `customTools` silently disabled every whitelist (plan mode's
            // read-only guarantee included).
            tools: request.customTools?.length ? request.customTools : undefined,
            mode: request.mode,
            workTier: request.workTier,
            workspaceRoots: request.workspaceRoots,
            writableRoots: request.writableRoots,
            sandboxMode: request.sandboxMode,
            surface: useAppStore.getState().sidebarMode,
            goal: request.goal,
          },
          projectPath,
        );
        if (result.ok && result.data) {
          const agentId: string = result.data.agentId;
          set((s) => {
            // The backend broadcasts agent:updated from inside startAgent,
            // and that event usually lands BEFORE this IPC promise resolves —
            // onUpdated has then already inserted the agent. Pushing again
            // here created the long-standing "one task shows twice" bug.
            if (s.agents.some((a) => a.id === agentId)) return s;
            return {
              agents: [
                ...s.agents,
                {
                  id: agentId,
                  name: request.name,
                  // UI never shows the raw instruction — it may carry the
                  // follow-up prompt wrapper. displayDescription is the
                  // user's literal words.
                  description: request.displayDescription || request.description,
                  type: request.type,
                  status: 'running' as AgentStatus,
                  priority: request.priority || 'normal',
                  projectRoot: request.projectRoot || '',
                  surface: useAppStore.getState().sidebarMode,
                  startTime: Date.now(),
                  iteration: 0,
                  maxIterations: request.maxIterations ?? 200,
                  toolCallCount: 0,
                  messagesCount: 0,
                  totalInputTokens: 0,
                  totalOutputTokens: 0,
                  model: request.model,
                  log: [],
                },
              ],
            };
          });
          return agentId;
        }
        // Surface the backend rejection (e.g. 项目目录不存在) to the caller
        // so the UI can show a real error instead of failing silently.
        throw new Error(result.error || 'Agent 启动失败');
      } catch (e) {
        console.error('[useAgentStore] startAgent failed:', (e as Error)?.message || e);
        throw e instanceof Error ? e : new Error(String(e));
      }
    },

    stopAgent: async (agentId) => {
      const api = agentIpc();
      if (!api?.schedulerStop) return;
      try {
        const r = await api.schedulerStop(agentId);
        if (!r?.ok) console.error('[useAgentStore] stopAgent rejected:', r?.error || 'unknown');
      } catch (e) {
        console.error('[useAgentStore] stopAgent IPC failed:', (e as Error)?.message || e);
      }
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id === agentId ? { ...a, status: 'stopped' as AgentStatus, endTime: Date.now() } : a,
        ),
      }));
    },

    stopAllAgents: async () => {
      const { agents, stopAgent } = get();
      await Promise.allSettled(
        agents.filter((a) => a.status === 'running' || a.status === 'queued').map((a) => stopAgent(a.id)),
      );
    },

    pauseAgent: async (agentId) => {
      const api = agentIpc();
      if (api?.pause) {
        try {
          await api.pause(agentId);
        } catch {
          console.error('[useAgentStore] pauseAgent IPC failed');
        }
      }
      set((s) => ({
        agents: s.agents.map((a) => (a.id === agentId ? { ...a, status: 'paused' as AgentStatus } : a)),
      }));
    },

    resumeAgent: async (agentId) => {
      const api = agentIpc();
      if (api?.resume) {
        try {
          await api.resume(agentId);
        } catch {
          console.error('[useAgentStore] resumeAgent IPC failed');
        }
      }
      set((s) => ({
        agents: s.agents.map((a) => (a.id === agentId ? { ...a, status: 'running' as AgentStatus } : a)),
      }));
    },

    continueAgent: async (agentId, instruction, displayInstruction) => {
      const api = agentIpc();
      if (!api?.continue) return { ok: false, error: '当前环境不支持续写' };
      try {
        const r = await api.continue(agentId, instruction, displayInstruction);
        if (!r?.ok) {
          console.error('[useAgentStore] continueAgent rejected:', r?.error || 'unknown');
          return { ok: false, error: r?.error || '续写失败' };
        }
        return { ok: true };
      } catch (e) {
        console.error('[useAgentStore] continueAgent IPC failed:', (e as Error)?.message || e);
        return { ok: false, error: (e as Error)?.message || '续写请求失败' };
      }
    },

    approveDelivery: async (agentId) => {
      const api = agentIpc();
      if (!api?.approveDelivery) return { ok: false, error: '当前环境不支持验收' };
      try {
        const r = await api.approveDelivery(agentId);
        if (!r?.ok) {
          console.error('[useAgentStore] approveDelivery rejected:', r?.error || 'unknown');
          return { ok: false, error: r?.error || '验收失败' };
        }
        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === agentId ? { ...a, status: 'completed' as AgentStatus, endTime: Date.now() } : a,
          ),
        }));
        return { ok: true };
      } catch (e) {
        console.error('[useAgentStore] approveDelivery IPC failed:', (e as Error)?.message || e);
        return { ok: false, error: (e as Error)?.message || '验收请求失败' };
      }
    },

    setAgentPriority: async (agentId, priority) => {
      const api = agentIpc();
      if (api?.setPriority) {
        try {
          await api.setPriority(agentId, priority);
        } catch {
          console.error('[useAgentStore] setPriority IPC failed');
        }
      }
      set((s) => ({
        agents: s.agents.map((a) => (a.id === agentId ? { ...a, priority } : a)),
      }));
    },

    setMaxConcurrent: async (count) => {
      const api = agentIpc();
      if (api?.setMaxConcurrent) {
        try {
          await api.setMaxConcurrent(count);
        } catch {
          console.error('[useAgentStore] setMaxConcurrent IPC failed');
        }
      }
      set({ maxConcurrent: count });
    },

    refreshStates: async () => {
      const api = agentIpc();
      if (!api?.getAll) return;
      set({ isLoading: true });
      try {
        const result = await api.getAll();
        if (result.ok && result.data) {
          set((s) => {
            const snapshots = result.data as BackendAgentSnapshot[];
            const backendMap = new Map<string, BackendAgentSnapshot>();
            for (const snapshot of snapshots) {
              const id = snapshot.agentId || snapshot.id;
              if (id) backendMap.set(id, snapshot);
            }

            // Merge backend state into existing frontend agents.
            // Backend is authoritative for live counters; frontend
            // retains fields the backend never sends (model, isDeepThink,
            // reasoningEffort, log, etc.).
            const merged = s.agents.map((existing) => {
              const be = backendMap.get(existing.id);
              if (!be) return existing;

              backendMap.delete(existing.id);

              return { ...existing, ...toBackendPatch(be) };
            });

            // Agents backend knows about but frontend doesn't
            // (e.g. scheduler-created agents before agent:updated).
            for (const [id, be] of backendMap) {
              const patch = toBackendPatch(be);
              merged.push({
                id,
                name: patch.name ?? 'Agent',
                description: patch.description ?? '',
                type: patch.type ?? 'general-purpose',
                status: patch.status ?? 'idle',
                priority: patch.priority ?? 'normal',
                startTime: patch.startTime ?? Date.now(),
                endTime: patch.endTime,
                iteration: patch.iteration ?? 0,
                maxIterations: patch.maxIterations ?? 25,
                toolCallCount: patch.toolCallCount ?? 0,
                messagesCount: patch.messagesCount ?? 0,
                surface: patch.surface,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                plan: patch.plan ?? null,
                error: patch.error,
                result: patch.result,
                workTier: patch.workTier,
                delivery: patch.delivery,
                model: patch.model,
                log: [],
              });
            }

            return { agents: merged };
          });
        }
      } catch {
        /* ignore */
      }
      set({ isLoading: false });
      // A restored selection whose task no longer exists anywhere must not
      // leave the Agent view permanently stuck on "任务不存在".
      const after = get();
      if (after.currentAgentId && !after.agents.some((a) => a.id === after.currentAgentId)) {
        set({ currentAgentId: null });
      }
    },

    clearAgents: async () => {
      const api = agentIpc();
      if (api?.clear) {
        try {
          await api.clear();
        } catch {
          /* ignore */
        }
      }
      // Scheduler tasks live in a separate registry — the legacy clear only
      // wiped sub-agents, leaving real tasks running (they then reappeared
      // via agent:updated). Clear both.
      if (api?.clearAll) {
        try {
          await api.clearAll();
        } catch {
          /* ignore */
        }
      }
      clearAgentTombstones();
      set({ agents: [], currentAgentId: null, agentPermissions: {} });
    },
  };
}
