import { create } from 'zustand';
import type { UndoEntry } from '../types/undo';

const MAX_UNDOS = 50;
const SESSION_EXPIRE_MS = 5 * 60 * 1000; // 5 minutes after session end

export interface UndoStore {
  undos: UndoEntry[];
  addUndo: (entry: UndoEntry) => void;
  undoLast: () => Promise<UndoEntry | null>;
  undoById: (id: string) => Promise<void>;
  clearBySession: (sessionId: string) => void;
  getByAgentId: (agentId: string) => UndoEntry[];
  expireSession: (sessionId: string) => void; // mark for 5min expiry
}

export const useUndoStore = create<UndoStore>()((set, get) => ({
  undos: [],

  addUndo: (entry) =>
    set((s) => {
      const next = [...s.undos, entry];
      if (next.length > MAX_UNDOS) next.splice(0, next.length - MAX_UNDOS);
      return { undos: next };
    }),

  undoLast: async () => {
    const { undos } = get();
    if (undos.length === 0) return null;
    const entry = undos[undos.length - 1];
    try {
      await entry.revert();
    } catch (e) {
      console.warn('[undo] revert failed:', e);
    }
    set((s) => ({ undos: s.undos.filter((u) => u.id !== entry.id) }));
    return entry;
  },

  undoById: async (id) => {
    const entry = get().undos.find((u) => u.id === id);
    if (!entry) return;
    try {
      await entry.revert();
    } catch (e) {
      console.warn('[undo] revert failed:', e);
    }
    set((s) => ({ undos: s.undos.filter((u) => u.id !== id) }));
  },

  clearBySession: (sessionId) => set((s) => ({ undos: s.undos.filter((u) => u.sessionId !== sessionId) })),

  getByAgentId: (agentId) => get().undos.filter((u) => u.agentId === agentId),

  expireSession: (sessionId) =>
    set((s) => ({
      undos: s.undos.map((u) => (u.sessionId === sessionId ? { ...u, expiresAt: Date.now() + SESSION_EXPIRE_MS } : u)),
    })),
}));

// Clean up expired entries periodically
const _pruneInterval = setInterval(() => {
  const now = Date.now();
  useUndoStore.setState((s) => ({
    undos: s.undos.filter((u) => !u.expiresAt || u.expiresAt > now),
  }));
}, 30_000);

// HMR / test cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => clearInterval(_pruneInterval));
}
