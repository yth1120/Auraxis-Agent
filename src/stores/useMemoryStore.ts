import { create } from 'zustand';
import type { BeliefRejection, EvidenceRecord, SignalRecord } from '../../electron/ipc/memory-db';
import type { MemoryReadResult } from '../../electron/ipc/memory-read';

export interface MemoryItem {
  id: string;
  project_path: string;
  type: 'decision' | 'problem' | 'architecture' | 'preference' | 'progress' | 'context';
  title: string;
  content: string;
  tags: string;
  timestamp: number;
  session_id: string | null;
  importance: number;
  is_active: number;
}

export interface BeliefAuditPayload {
  belief: {
    id: string;
    kind: string;
    title: string;
    text: string;
    status: string;
    legacy: number;
    importance: number;
    updated_at: number;
  };
  evidence: {
    evidence: EvidenceRecord;
    support_strength: number;
    signals: SignalRecord[];
  }[];
  revisions: {
    prev_status: string | null;
    next_status: string;
    reason: string | null;
    actor: string;
    ts: number;
  }[];
}

export interface MemoryStore {
  activeMemories: MemoryItem[];
  searchResults: MemoryItem[];
  evidenceItems: EvidenceRecord[];
  auditMap: Record<string, BeliefAuditPayload>;
  lastReadResult: MemoryReadResult | null;
  rejections: BeliefRejection[];
  searchQuery: string;
  isLoading: boolean;

  loadMemories: (projectPath: string) => Promise<void>;
  searchMemories: (projectPath: string, query: string) => Promise<void>;
  archiveMemory: (id: string) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  loadEvidence: (projectPath: string) => Promise<void>;
  auditBelief: (id: string) => Promise<void>;
  runReadTrace: (projectPath: string, query: string, budgetTokens?: number) => Promise<MemoryReadResult | null>;
  eraseScope: (projectPath: string) => Promise<boolean>;
  reindex: (projectPath: string) => Promise<{ signals: number; rejected: number } | null>;
  loadRejections: (projectPath: string) => Promise<void>;
  clearSearch: () => void;
}

export const useMemoryStore = create<MemoryStore>()((set) => ({
  activeMemories: [],
  searchResults: [],
  evidenceItems: [],
  auditMap: {},
  lastReadResult: null,
  rejections: [],
  searchQuery: '',
  isLoading: false,

  loadMemories: async (projectPath) => {
    if (!projectPath || !window.electronAPI?.memory) return;
    set({ isLoading: true });
    try {
      const result = await window.electronAPI.memory.getByProject(projectPath);
      if (result.ok && result.data) {
        set({ activeMemories: result.data as MemoryItem[] });
      }
    } catch {
      /* ignore */
    }
    set({ isLoading: false });
  },

  searchMemories: async (projectPath, query) => {
    if (!projectPath || !window.electronAPI?.memory) return;
    set({ searchQuery: query });
    if (!query.trim()) {
      set({ searchResults: [] });
      return;
    }
    try {
      const result = await window.electronAPI.memory.search(projectPath, query);
      if (result.ok && result.data) {
        set({ searchResults: result.data as MemoryItem[] });
      }
    } catch {
      /* ignore */
    }
  },

  archiveMemory: async (id) => {
    if (!window.electronAPI?.memory) return;
    try {
      await window.electronAPI.memory.archive(id);
      set((s) => ({
        activeMemories: s.activeMemories.filter((m) => m.id !== id),
        searchResults: s.searchResults.filter((m) => m.id !== id),
      }));
    } catch {
      console.error('[useMemoryStore] archiveMemory failed');
    }
  },

  deleteMemory: async (id) => {
    if (!window.electronAPI?.memory) return;
    try {
      await window.electronAPI.memory.delete(id);
      set((s) => ({
        activeMemories: s.activeMemories.filter((m) => m.id !== id),
        searchResults: s.searchResults.filter((m) => m.id !== id),
      }));
    } catch {
      console.error('[useMemoryStore] deleteMemory failed');
    }
  },

  loadEvidence: async (projectPath) => {
    if (!projectPath || !window.electronAPI?.memory) return;
    try {
      const result = await window.electronAPI.memory.evidenceList(projectPath);
      if (result.ok && result.data) set({ evidenceItems: result.data });
    } catch {
      /* ignore */
    }
  },

  auditBelief: async (id) => {
    if (!id || !window.electronAPI?.memory) return;
    try {
      const result = await window.electronAPI.memory.beliefAudit(id);
      if (result.ok && result.data) {
        set((s) => ({ auditMap: { ...s.auditMap, [id]: result.data as BeliefAuditPayload } }));
      }
    } catch {
      /* ignore */
    }
  },

  runReadTrace: async (projectPath, query, budgetTokens = 900) => {
    if (!projectPath || !window.electronAPI?.memory) return null;
    try {
      const result = await window.electronAPI.memory.readForQuery(projectPath, query, { budgetTokens });
      if (result.ok && result.data) {
        set({ lastReadResult: result.data });
        return result.data;
      }
    } catch {
      /* ignore */
    }
    return null;
  },

  eraseScope: async (projectPath) => {
    if (!projectPath || !window.electronAPI?.memory) return false;
    try {
      const result = await window.electronAPI.memory.erase(projectPath);
      if (result.ok) {
        set({ activeMemories: [], evidenceItems: [], auditMap: {}, lastReadResult: null, rejections: [] });
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  },

  reindex: async (projectPath) => {
    if (!projectPath || !window.electronAPI?.memory) return null;
    try {
      const result = await window.electronAPI.memory.reindex(projectPath);
      if (result.ok && result.data) return result.data;
    } catch {
      /* ignore */
    }
    return null;
  },

  loadRejections: async (projectPath) => {
    if (!projectPath || !window.electronAPI?.memory) return;
    try {
      const result = await window.electronAPI.memory.rejections(projectPath);
      if (result.ok && result.data) set({ rejections: result.data });
    } catch {
      /* ignore */
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [] }),
}));
