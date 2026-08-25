import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  PermissionRequest,
  PermissionRule,
  MCPServerConfig,
  MCPStatus,
  AgentInfo,
  AgentLogEntry,
} from '../types/advanced';
import type { PermissionBridgeStatus } from '../services/replBridge';

export interface AdvancedStore {
  // ─── Permissions ──────────────────
  permissionQueue: PermissionRequest[];
  permissionRules: PermissionRule[];
  permissionStatus: PermissionBridgeStatus;
  enqueuePermission: (req: PermissionRequest) => void;
  dequeuePermission: (requestId: string) => void;
  setPermissionStatus: (status: PermissionBridgeStatus) => void;
  addPermissionRule: (rule: PermissionRule) => void;
  setPermissionRules: (rules: PermissionRule[]) => void;
  removePermissionRule: (id: string) => void;
  clearPermissionRules: () => void;

  // ─── MCP ──────────────────────────
  mcpServers: MCPServerConfig[];
  mcpStatuses: MCPStatus[];
  setMcpServers: (servers: MCPServerConfig[]) => void;
  updateMcpStatus: (status: MCPStatus) => void;

  // ─── Agents ───────────────────────
  runningAgents: AgentInfo[];
  addAgent: (agent: AgentInfo) => void;
  updateAgent: (id: string, updates: Partial<AgentInfo>) => void;
  removeAgent: (id: string) => void;
  appendAgentLog: (id: string, entries: AgentLogEntry[]) => void;
}

export const useAdvancedStore = create<AdvancedStore>()(
  persist(
    (set) => ({
      // ─── Permissions ────────────
      permissionQueue: [],
      permissionRules: [],
      permissionStatus: 'idle',

      enqueuePermission: (req) =>
        set((s) => {
          const queue = [...s.permissionQueue, req];
          return { permissionQueue: queue, permissionStatus: 'waiting' };
        }),

      dequeuePermission: (requestId) =>
        set((s) => {
          const queue = s.permissionQueue.filter((r) => r.requestId !== requestId);
          return {
            permissionQueue: queue,
            permissionStatus: queue.length === 0 ? 'idle' : 'waiting',
          };
        }),

      setPermissionStatus: (status) => set({ permissionStatus: status }),

      addPermissionRule: (rule) =>
        set((s) => {
          const rules = [...s.permissionRules, rule];
          if (rules.length > 200) rules.splice(0, rules.length - 200);
          return { permissionRules: rules };
        }),

      setPermissionRules: (rules) => set({ permissionRules: rules }),

      removePermissionRule: (id) => {
        set((s) => ({ permissionRules: s.permissionRules.filter((r) => r.id !== id) }));
        if (typeof window !== 'undefined') {
          window.electronAPI?.permission?.removeRule(id).then((r) => {
            if (r?.ok && r.data) set({ permissionRules: r.data });
          });
        }
      },

      clearPermissionRules: () => {
        set({ permissionRules: [] });
        if (typeof window !== 'undefined') {
          window.electronAPI?.permission?.clearRules();
        }
      },

      // ─── MCP ────────────────────
      mcpServers: [],
      mcpStatuses: [],

      setMcpServers: (servers) => set({ mcpServers: servers }),

      updateMcpStatus: (status) =>
        set((s) => ({
          mcpStatuses: [...s.mcpStatuses.filter((st) => st.serverId !== status.serverId), status],
        })),

      // ─── Agents ─────────────────
      runningAgents: [],

      addAgent: (agent) => set((s) => ({ runningAgents: [...s.runningAgents, agent] })),

      updateAgent: (id, updates) =>
        set((s) => ({
          runningAgents: s.runningAgents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
        })),

      removeAgent: (id) =>
        set((s) => ({
          runningAgents: s.runningAgents.filter((a) => a.id !== id),
        })),

      appendAgentLog: (id, entries) =>
        set((s) => ({
          runningAgents: s.runningAgents.map((a) => {
            if (a.id !== id) return a;
            const currentLog = a.log || [];
            const merged = [...currentLog];
            for (const entry of entries) {
              const last = merged[merged.length - 1];
              if (last && last.type === 'text' && entry.type === 'text') {
                merged[merged.length - 1] = { ...last, text: (last.text || '') + (entry.text || '') };
              } else {
                merged.push({ ...entry });
              }
            }
            return { ...a, log: merged.slice(-500) };
          }),
        })),
    }),
    {
      name: 'auraxis-advanced-storage',
      partialize: (state) => ({
        permissionRules: state.permissionRules,
        mcpServers: state.mcpServers,
      }),
    },
  ),
);
