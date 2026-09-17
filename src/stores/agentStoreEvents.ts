import type { AgentInfo, AgentStore } from '../types/agent';
import type { AgentRuntimeEvent } from '../types/tools';
import { useAppStore } from './useAppStore';
import type { AgentStoreBuffers } from './agentStoreBuffers';
import { agentIpc, isRecord, logEntryFromEvent, normalizeTodos } from './agentStoreHelpers';

export interface AgentEventRuntimeDeps {
  getState: () => AgentStore;
  setState: (patch: Partial<AgentStore> | ((state: AgentStore) => Partial<AgentStore>)) => void;
  appendLog: AgentStore['appendAgentLog'];
  buffers: AgentStoreBuffers;
}

/** 流式 chunk / 工具进度：走缓冲区，不产生独立日志行。 */
function handleChunkEvent(event: AgentRuntimeEvent, id: string, deps: AgentEventRuntimeDeps): boolean {
  if (event.type === 'text_chunk') {
    deps.buffers.queueChunk(id, event.text || '', 'text');
    return true;
  }
  if (event.type === 'thinking_chunk') {
    deps.buffers.queueChunk(id, event.chunk || event.text || '', 'thinking');
    return true;
  }
  if (event.type !== 'tool_progress') return false;
  const text = event.progress || '';
  if (!text) return true;
  // Raw command output belongs to the running tool's terminal; only
  // planning/liveness pings stay as standalone progress lines.
  if (event.toolName !== 'Planning' && event.toolCallId) {
    deps.buffers.queueToolProgress(id, event.toolCallId, text);
  } else {
    deps.appendLog(id, [{ type: 'progress', timestamp: Date.now(), text }]);
  }
  return true;
}

/** Scheduler-path plan lifecycle：TaskPlan({tasks}) → {todos} 渲染形状。 */
function handlePlanEvent(event: AgentRuntimeEvent, id: string, deps: AgentEventRuntimeDeps): boolean {
  if (event.type !== 'plan_created' && event.type !== 'plan_updated') return false;
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
      deps.setState((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, plan } : a)) }));
    }
  }
  return true;
}

/** usage 累加：输入/输出/推理/缓存命中与未命中。 */
function handleUsageEvent(event: AgentRuntimeEvent, id: string, deps: AgentEventRuntimeDeps): boolean {
  if (event.type !== 'usage') return false;
  deps.setState((s) => ({
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
  return true;
}

/** 结算事件携带运行中终端的实时输出，保持行内内容连续。 */
function attachSettledStreamOutput(event: AgentRuntimeEvent, id: string, deps: AgentEventRuntimeDeps): void {
  const settles =
    (event.type === 'tool_end' || event.type === 'tool_error' || event.type === 'tool_aborted') && !!event.toolCallId;
  if (!settles) return;
  const agent = deps.getState().agents.find((a) => a.id === id);
  const start = agent?.log.find((e) => e.type === 'tool_start' && e.toolCallId === event.toolCallId);
  if (start?.streamOutput) event.streamOutput = start.streamOutput;
}

/** Write/Edit/Bash 完成后让文件树失效重载。 */
function bumpFileTreeOnMutation(event: AgentRuntimeEvent): void {
  const mutates =
    event.type === 'tool_end' && (event.toolName === 'Write' || event.toolName === 'Edit' || event.toolName === 'Bash');
  if (!mutates) return;
  try {
    useAppStore.getState().incrementFileTreeVersion();
  } catch {
    /* non-critical */
  }
}

export function createAgentEventRuntime(deps: AgentEventRuntimeDeps) {
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
      if (handleChunkEvent(event, id, deps)) return;
      if (handlePlanEvent(event, id, deps)) return;
      if (handleUsageEvent(event, id, deps)) return;
      // Flush pending chunks before appending a non-chunk event to preserve
      // temporal ordering (tool_start/tool_end must appear after prior text).
      if (deps.buffers.hasPendingChunks(id)) {
        deps.buffers.flushChunks();
      }
      attachSettledStreamOutput(event, id, deps);
      const entry = logEntryFromEvent(event);
      if (entry) {
        deps.appendLog(id, [entry]);
      }
      bumpFileTreeOnMutation(event);
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

  function disposeAll() {
    for (const timer of cleanupTimers.values()) clearTimeout(timer);
    cleanupTimers.clear();
    for (const unsub of eventSubs.values()) unsub();
    eventSubs.clear();
    deps.buffers.clearPendingChunks();
  }
  return { ensureEventSub, scheduleEventSubCleanup, disposeAll };
}
