import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentInfo, AgentStore, AgentStatus } from '../types/agent';
import type { AgentInfo as BackendAgentInfo } from '../types/advanced';
import type { AgentRuntimeEvent } from '../types/tools';
import { useAppStore } from './useAppStore';
import {
  agentIpc,
  isRecord,
  logEntryFromEvent,
  normalizeTodos,
  toBackendPatch,
  type BackendAgentSnapshot,
} from './agentStoreHelpers';

/** Agent ids explicitly removed by the user — late backend broadcasts must
 *  not resurrect them (delete/complete race). */
const removedAgentIds = new Set<string>();

// ─── Store ─────────────────────────────────────────

export const useAgentStore = create<AgentStore>()(
  persist(
    (set, get) => ({
      agents: [],
      isLoading: false,
      maxConcurrent: 3,
      currentAgentId: null,
      lastAgentIdBySurface: {},
      agentPermissions: {},

      // ── Local mutations ──────────────────────────

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
        removedAgentIds.add(id);
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

      // ── IPC-backed actions ───────────────────────

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
        const after = useAgentStore.getState();
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
        removedAgentIds.clear();
        set({ agents: [], currentAgentId: null, agentPermissions: {} });
      },

      // ── Module-level subscription ──────────────────

      subscribeToUpdates: () => {
        const api = agentIpc();
        if (!api?.onUpdated) return () => {};

        const unsub = api.onUpdated((updated: BackendAgentInfo) => {
          const snapshot = updated as BackendAgentSnapshot;
          const id = updated.id || snapshot.agentId;
          if (!id) return;
          if (removedAgentIds.has(id)) return;

          // CRITICAL: attach per-agent event listener BEFORE touching state.
          // This runs synchronously inside the ipcRenderer 'agent:updated'
          // handler, so any subsequent `agent:event:${id}` message (e.g. the
          // first text_chunk from the planning phase) is already subscribed.
          // Skipping this synchronous attach loses the opening events of the
          // run while React schedules a re-render.
          const status = updated.status as string;
          const active = status === 'running' || status === 'queued' || status === 'paused';
          if (active) ensureEventSub(id);
          else scheduleEventSubCleanup(id);

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
type ChunkKind = 'text' | 'thinking';
const pendingChunks = new Map<string, Array<{ kind: ChunkKind; text: string }>>();
let rafScheduled = false;

function flushChunks() {
  rafScheduled = false;
  if (pendingChunks.size === 0) return;
  const append = useAgentStore.getState().appendAgentLog;
  for (const [id, chunks] of pendingChunks) {
    if (chunks.length === 0) continue;
    // Coalesce consecutive same-kind chunks, preserving order.
    const entries: { type: ChunkKind; text: string; timestamp: number }[] = [];
    for (const c of chunks) {
      const last = entries[entries.length - 1];
      if (last && last.type === c.kind) last.text += c.text;
      else entries.push({ type: c.kind, text: c.text, timestamp: Date.now() });
    }
    append(
      id,
      entries.filter((e) => e.text),
    );
  }
  pendingChunks.clear();
}

function queueChunk(id: string, text: string, kind: ChunkKind) {
  if (!text) return;
  const existing = pendingChunks.get(id);
  if (existing) existing.push({ kind, text });
  else pendingChunks.set(id, [{ kind, text }]);
  if (!rafScheduled) {
    rafScheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flushChunks);
    } else {
      setTimeout(flushChunks, 16);
    }
  }
}

// RAF batches for tool stream output: appends go onto the matching tool_start
// entry so the Agent execution view renders a live terminal instead of one
// progress line per chunk.
const pendingToolProgress = new Map<string, Map<string, string>>();
let toolRafScheduled = false;

function flushToolProgress() {
  toolRafScheduled = false;
  if (pendingToolProgress.size === 0) return;
  const entries = [...pendingToolProgress.entries()];
  pendingToolProgress.clear();
  useAgentStore.setState((s) => ({
    agents: s.agents.map((a) => {
      const chunks = entries.find(([id]) => id === a.id)?.[1];
      if (!chunks) return a;
      let log = a.log;
      let changed = false;
      for (const [toolCallId, text] of chunks) {
        const idx = log.findIndex((e) => e.type === 'tool_start' && e.toolCallId === toolCallId);
        if (idx >= 0) {
          log = log.map((e, i) => (i === idx ? { ...e, streamOutput: (e.streamOutput || '') + text } : e));
          changed = true;
        }
      }
      return changed ? { ...a, log } : a;
    }),
  }));
}

function queueToolProgress(id: string, toolCallId: string, text: string) {
  if (!text) return;
  let map = pendingToolProgress.get(id);
  if (!map) {
    map = new Map();
    pendingToolProgress.set(id, map);
  }
  map.set(toolCallId, (map.get(toolCallId) || '') + text);
  if (!toolRafScheduled) {
    toolRafScheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flushToolProgress);
    } else {
      setTimeout(flushToolProgress, 16);
    }
  }
}

const eventSubs = new Map<string, () => void>();
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ensureEventSub(id: string) {
  const pendingCleanup = cleanupTimers.get(id);
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    cleanupTimers.delete(id);
  }
  if (eventSubs.has(id)) return;
  const api = agentIpc();
  if (!api?.onEvent) return;
  const unsub = api.onEvent(id, (event: AgentRuntimeEvent) => {
    if (event.type === 'text_chunk') {
      queueChunk(id, event.text || '', 'text');
      return;
    }
    if (event.type === 'thinking_chunk') {
      queueChunk(id, event.chunk || event.text || '', 'thinking');
      return;
    }
    if (event.type === 'tool_progress') {
      const text = event.progress || '';
      if (!text) return;
      // Raw command output belongs to the running tool's terminal; only
      // planning/liveness pings stay as standalone progress lines.
      if (event.toolName !== 'Planning' && event.toolCallId) {
        queueToolProgress(id, event.toolCallId, text);
      } else {
        useAgentStore.getState().appendAgentLog(id, [{ type: 'progress', timestamp: Date.now(), text }]);
      }
      return;
    }
    if (event.type === 'plan_created' || event.type === 'plan_updated') {
      // Scheduler-path plan lifecycle. The raw event carries the backend
      // TaskPlan ({tasks}) — normalize to the {todos} shape the header
      // progress bar and the inspector's TaskChecklist render.
      const raw = event.plan;
      if (raw) {
        const taskTodos = (raw.tasks ?? [])
          .filter(
            (t): t is { description: string; status: string } =>
              isRecord(t) && typeof t.description === 'string' && typeof t.status === 'string',
          )
          .map((t) => ({ content: t.description, status: t.status, activeForm: `执行: ${t.description}` }));
        const todos = normalizeTodos(raw.todos) ?? (taskTodos.length > 0 ? taskTodos : undefined);
        if (todos) {
          const plan: AgentInfo['plan'] = { todos };
          useAgentStore.setState((s) => ({
            agents: s.agents.map((a) => (a.id === id ? { ...a, plan } : a)),
          }));
        }
      }
      return;
    }
    if (event.type === 'usage') {
      useAgentStore.setState((s) => ({
        agents: s.agents.map((a) =>
          a.id === id
            ? {
                ...a,
                totalInputTokens: (a.totalInputTokens || 0) + (event.inputTokens || 0),
                totalOutputTokens: (a.totalOutputTokens || 0) + (event.outputTokens || 0),
                totalReasoningTokens: (a.totalReasoningTokens || 0) + (event.reasoningTokens || 0),
                totalCacheHitTokens: (a.totalCacheHitTokens || 0) + (event.cacheHitTokens || 0),
                totalCacheMissTokens: (a.totalCacheMissTokens || 0) + (event.cacheMissTokens || 0),
              }
            : a,
        ),
      }));
      return;
    }
    // Flush pending chunks before appending a non-chunk event to preserve
    // temporal ordering (tool_start/tool_end must appear after prior text).
    if (pendingChunks.has(id)) {
      flushChunks();
    }
    if (
      (event.type === 'tool_end' || event.type === 'tool_error' || event.type === 'tool_aborted') &&
      event.toolCallId
    ) {
      // Carry the live terminal payload onto the settled row.
      const agent = useAgentStore.getState().agents.find((a) => a.id === id);
      const start = agent?.log.find((e) => e.type === 'tool_start' && e.toolCallId === event.toolCallId);
      if (start?.streamOutput) event.streamOutput = start.streamOutput;
    }
    const entry = logEntryFromEvent(event);
    if (entry) {
      useAgentStore.getState().appendAgentLog(id, [entry]);
    }
    if (
      event.type === 'tool_end' &&
      (event.toolName === 'Write' || event.toolName === 'Edit' || event.toolName === 'Bash')
    ) {
      try {
        useAppStore.getState().incrementFileTreeVersion();
      } catch {
        /* non-critical */
      }
    }
  });
  eventSubs.set(id, unsub);
}

function scheduleEventSubCleanup(id: string) {
  if (!eventSubs.has(id)) return;
  if (cleanupTimers.has(id)) return;
  // Defer teardown — late-arriving `done`/`error` events from a completing
  // agent should still reach the UI.
  const timer = setTimeout(() => {
    cleanupTimers.delete(id);
    const unsub = eventSubs.get(id);
    if (unsub) {
      unsub();
      eventSubs.delete(id);
    }
  }, 2000);
  cleanupTimers.set(id, timer);
}

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
      for (const timer of cleanupTimers.values()) clearTimeout(timer);
      cleanupTimers.clear();
      for (const unsub of eventSubs.values()) unsub();
      eventSubs.clear();
      pendingChunks.clear();
    };
  })();
}
