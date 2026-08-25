import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppStore, LeftPanelTab, ThemeMode } from '../types/chat';
import type { WorkAutonomyTier } from '../types/advanced';

let navigating = false;
const MAX_FILE_TABS = 8;

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      theme: 'light',
      sidebarCollapsed: false,
      sidebarMode: 'chat' as const,
      workAutonomyTier: 'smart' as WorkAutonomyTier,
      showSettings: false,
      showRightPanel: false,
      sidebarWidth: 260,
      leftPanelWidth: 256,
      rightPanelWidth: 320,
      paneSizes: null,
      activeLeftPanel: 'files' as LeftPanelTab,
      glassLayoutMounted: false,
      activeToolView: 'none' as const,
      settingsInitialKey: 'general',
      globalSearchOpen: false,
      terminalHeight: 300,
      agentLogFocusRequest: null,
      trajectoryFocusRequest: null,
      lastAgentShellId: null,
      agentErrorsOnly: false,
      agentTextOnly: false,
      agentRunningOnly: false,
      agentRunningFollow: true,
      openAgentTurns: [],
      agentTurnCount: 0,
      agentRawLogRequest: 0,
      agentErrorNavRequest: null,
      openFileRequest: null,
      fileTabs: [],
      activeFilePath: null,
      fileTreeVersion: 0,
      tabs: [],
      activeTabId: null,
      rightPanelView: 'inspector' as const,
      tabHistory: [],
      tabHistoryIndex: -1,

      toggleTheme: () =>
        set((s) => ({
          theme: s.theme === 'system' ? 'light' : s.theme === 'dark' ? 'light' : 'dark',
        })),

      setTheme: (mode: ThemeMode) => set({ theme: mode }),

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      setSidebarMode: (mode) => {
        set({ sidebarMode: mode });
      },

      setWorkAutonomyTier: (tier) => set({ workAutonomyTier: tier }),

      toggleRightPanel: () => set((s) => ({ showRightPanel: !s.showRightPanel })),

      setShowSettings: (show: boolean) => set({ showSettings: show }),

      setActiveToolView: (view) => set({ activeToolView: view }),

      setGlassLayoutMounted: (v) => set({ glassLayoutMounted: !!v }),

      openToolView: (view) =>
        set((s) => ({
          activeToolView: s.activeToolView === view ? 'none' : view,
        })),

      setSettingsInitialKey: (key) => set({ settingsInitialKey: key }),

      setGlobalSearchOpen: (open) => set({ globalSearchOpen: open }),

      setTerminalHeight: (h) => set({ terminalHeight: Math.min(560, Math.max(160, Math.round(h))) }),

      requestAgentLogFocus: (agentId, toolCallId) =>
        set({ agentLogFocusRequest: { agentId, toolCallId, ts: Date.now() } }),

      clearAgentLogFocus: () => set({ agentLogFocusRequest: null }),

      requestTrajectoryFocus: (agentId, toolCallId) =>
        set({ trajectoryFocusRequest: { agentId, toolCallId, ts: Date.now() } }),

      clearTrajectoryFocus: () => set({ trajectoryFocusRequest: null }),

      setLastAgentShellId: (id) => set({ lastAgentShellId: id }),

      setAgentErrorsOnly: (v) => set({ agentErrorsOnly: v }),

      setAgentTextOnly: (v) => set({ agentTextOnly: v }),

      setAgentRunningOnly: (v) => set({ agentRunningOnly: v }),

      setAgentRunningFollow: (v) => set({ agentRunningFollow: v }),

      setOpenAgentTurns: (turns) => set({ openAgentTurns: Array.isArray(turns) ? turns : [] }),

      toggleAllAgentTurns: () =>
        set((s) => {
          const current = Array.isArray(s.openAgentTurns) ? s.openAgentTurns : [];
          // Turn iterations are 0-based (first iteration_start emits 0), so
          // "expand all" must produce 0..n-1 — 1..n silently skips round 0.
          return {
            openAgentTurns:
              current.length >= s.agentTurnCount && s.agentTurnCount > 0
                ? []
                : Array.from({ length: s.agentTurnCount }, (_, i) => i),
          };
        }),

      setAgentTurnCount: (n) => set({ agentTurnCount: n }),

      requestAgentRawLog: () => set({ agentRawLogRequest: Date.now() }),

      requestAgentErrorNav: (dir) => set({ agentErrorNavRequest: { ts: Date.now(), dir } }),

      clearAgentErrorNav: () => set({ agentErrorNavRequest: null }),

      setSidebarWidth: (w: number) => set({ sidebarWidth: Math.max(0, Math.min(420, w)) }),

      setLeftPanelWidth: (w: number) => set({ leftPanelWidth: Math.max(200, Math.min(420, w)) }),

      setRightPanelWidth: (w: number) => set({ rightPanelWidth: Math.max(320, Math.min(2400, w)) }),

      setPaneSizes: (sizes: number[]) => set({ paneSizes: sizes }),

      setActiveLeftPanel: (tab: LeftPanelTab) => set({ activeLeftPanel: tab }),

      incrementFileTreeVersion: () => set((s) => ({ fileTreeVersion: s.fileTreeVersion + 1 })),

      requestOpenFile: (path) => set({ openFileRequest: { path, requestId: Date.now() } }),

      clearOpenFileRequest: () => set({ openFileRequest: null }),

      openFileTab: (path) =>
        set((s) => {
          if (s.fileTabs.some((t) => t.path === path)) {
            return { activeFilePath: path };
          }
          const name = path.split(/[/\\]/).pop() || path;
          let tabs = s.fileTabs;
          if (tabs.length >= MAX_FILE_TABS) {
            const evictIdx = tabs[0].path === s.activeFilePath && tabs.length > 1 ? 1 : 0;
            tabs = tabs.filter((_, i) => i !== evictIdx);
          }
          return { fileTabs: [...tabs, { path, name }], activeFilePath: path };
        }),

      closeFileTab: (path) =>
        set((s) => {
          const idx = s.fileTabs.findIndex((t) => t.path === path);
          if (idx < 0) return s;
          const tabs = s.fileTabs.filter((t) => t.path !== path);
          let active = s.activeFilePath;
          if (active === path) {
            const next = tabs[idx] ?? tabs[idx - 1];
            active = next ? next.path : null;
          }
          return { fileTabs: tabs, activeFilePath: active };
        }),

      setActiveFilePath: (path) => set({ activeFilePath: path }),

      clearFileTabs: () => set({ fileTabs: [], activeFilePath: null }),

      addTab: (tab) => {
        const id = Math.random().toString(36).slice(2, 11);
        set((s) => {
          const newHistory = [...s.tabHistory.slice(0, s.tabHistoryIndex + 1), id];
          return {
            tabs: [...s.tabs, { ...tab, id }],
            activeTabId: id,
            tabHistory: newHistory,
            tabHistoryIndex: newHistory.length - 1,
          };
        });
        return id;
      },

      closeTab: (tabId: string) => {
        set((s) => {
          const newTabs = s.tabs.filter((t) => t.id !== tabId);
          const newActive = s.activeTabId === tabId ? (newTabs[newTabs.length - 1]?.id ?? null) : s.activeTabId;
          const newHistory = s.tabHistory.filter((h) => h !== tabId);
          const newIndex = newActive ? newHistory.lastIndexOf(newActive) : -1;
          return {
            tabs: newTabs,
            activeTabId: newActive,
            tabHistory: newHistory,
            tabHistoryIndex: newIndex >= 0 ? newIndex : newHistory.length - 1,
          };
        });
      },

      setActiveTab: (tabId: string) => {
        set((s) => {
          const exists = s.tabs.some((t) => t.id === tabId);
          if (!exists) return s;
          if (navigating) return { activeTabId: tabId };
          const newHistory = [...s.tabHistory.slice(0, s.tabHistoryIndex + 1), tabId];
          return {
            activeTabId: tabId,
            tabHistory: newHistory,
            tabHistoryIndex: newHistory.length - 1,
          };
        });
      },

      updateTab: (tabId: string, updates) => {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
        }));
      },

      closeAllTabs: () => {
        set({ tabs: [], activeTabId: null, tabHistory: [], tabHistoryIndex: -1 });
      },

      setRightPanelView: (view) => {
        set({ rightPanelView: view });
      },

      goBack: () => {
        const { tabHistoryIndex, tabHistory, tabs } = get();
        let idx = tabHistoryIndex - 1;
        while (idx >= 0) {
          const targetId = tabHistory[idx];
          if (tabs.some((t) => t.id === targetId)) {
            navigating = true;
            set({ activeTabId: targetId, tabHistoryIndex: idx });
            navigating = false;
            return;
          }
          idx--;
        }
        // Every earlier entry is closed — clamp so the 后退 button disables
        // instead of staying enabled as a dead no-op.
        set({ tabHistoryIndex: -1 });
      },

      goForward: () => {
        const { tabHistoryIndex, tabHistory, tabs } = get();
        let idx = tabHistoryIndex + 1;
        while (idx < tabHistory.length) {
          const targetId = tabHistory[idx];
          if (tabs.some((t) => t.id === targetId)) {
            navigating = true;
            set({ activeTabId: targetId, tabHistoryIndex: idx });
            navigating = false;
            return;
          }
          idx++;
        }
        // Every later entry is closed — clamp so 前进 disables.
        set({ tabHistoryIndex: tabHistory.length - 1 });
      },

      canGoBack: () => {
        const { tabHistoryIndex } = get();
        return tabHistoryIndex > 0;
      },

      canGoForward: () => {
        const { tabHistoryIndex, tabHistory } = get();
        return tabHistoryIndex < tabHistory.length - 1;
      },
    }),
    {
      name: 'auraxis-app-storage',
      version: 3,
      // Version bumps must never brick hydration: keep old persisted values
      // (partialize defines what is persisted).
      migrate: (persisted) => persisted as any,
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarMode: state.sidebarMode,
        theme: state.theme,
        sidebarWidth: state.sidebarWidth,
        leftPanelWidth: state.leftPanelWidth,
        rightPanelWidth: state.rightPanelWidth,
        // paneSizes intentionally not persisted — initialSizes is computed from
        // sidebarWidth + rightPanelWidth + the current viewport so the layout
        // adapts when reopening at a different window size.
        activeLeftPanel: state.activeLeftPanel,
        rightPanelView: state.rightPanelView,
        terminalHeight: state.terminalHeight,
        agentErrorsOnly: state.agentErrorsOnly,
        agentTextOnly: state.agentTextOnly,
        agentRunningOnly: state.agentRunningOnly,
        agentRunningFollow: state.agentRunningFollow,
      }),
    },
  ),
);
