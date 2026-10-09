import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PermissionRequest, PermissionRule, MCPServerConfig, MCPStatus } from '../types/advanced';
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
