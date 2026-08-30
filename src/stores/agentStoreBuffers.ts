/** agentStoreBuffers.ts — RAF-batched agent log writes. */
import type { AgentStore } from '../types/agent';

export interface AgentStoreBufferDeps {
  getAppend: () => AgentStore['appendAgentLog'];
  setState: (patch: Partial<AgentStore> | ((state: AgentStore) => Partial<AgentStore>)) => void;
}

export type AgentStoreBuffers = ReturnType<typeof createAgentStoreBuffers>;

export function createAgentStoreBuffers(deps: AgentStoreBufferDeps) {
  const pendingChunks = new Map<string, Array<{ kind: 'text' | 'thinking'; text: string }>>();
  let rafScheduled = false;
  const pendingToolProgress = new Map<string, Map<string, string>>();
  let toolRafScheduled = false;

  function flushChunks() {
    rafScheduled = false;
    if (pendingChunks.size === 0) return;
    const append = deps.getAppend();
    for (const [id, chunks] of pendingChunks) {
      if (chunks.length === 0) continue;
      const entries: { type: 'text' | 'thinking'; text: string; timestamp: number }[] = [];
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

  function queueChunk(id: string, text: string, kind: 'text' | 'thinking') {
    if (!text) return;
    const existing = pendingChunks.get(id);
    if (existing) existing.push({ kind, text });
    else pendingChunks.set(id, [{ kind, text }]);
    if (!rafScheduled) {
      rafScheduled = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushChunks);
      else setTimeout(flushChunks, 16);
    }
  }

  function flushToolProgress() {
    toolRafScheduled = false;
    if (pendingToolProgress.size === 0) return;
    const entries = [...pendingToolProgress.entries()];
    pendingToolProgress.clear();
    deps.setState((s) => ({
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
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushToolProgress);
      else setTimeout(flushToolProgress, 16);
    }
  }

  return {
    flushChunks,
    queueChunk,
    flushToolProgress,
    queueToolProgress,
    hasPendingChunks: (id: string) => pendingChunks.has(id),
    clearPendingChunks: () => pendingChunks.clear(),
  };
}
