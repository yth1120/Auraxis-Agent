import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { App as AntApp, ConfigProvider, Modal, message, notification } from 'antd';
import WorkbenchLayout from './components/layout/WorkbenchLayout';
import ErrorBoundary from './components/layout/ErrorBoundary';
import AuthGate from './components/auth/AuthGate';
import CommandPalette from './components/layout/CommandPalette';
import UndoToast from './components/common/UndoToast';
import AskUserHost from './components/common/AskUserHost';
import { t } from './i18n';

const SettingsModal = lazy(() => import('./components/settings/SettingsModal'));
import { useChatStore, initPlanListener, flushChatLogNow } from './stores/useChatStore';
import { useAppStore } from './stores/useAppStore';
import { useUndoStore } from './stores/useUndoStore';
import { useAdvancedStore } from './stores/useAdvancedStore';
import { useAgentStore } from './stores/useAgentStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { darkTheme, lightTheme } from './styles/theme';
import { matchBinding, isInputFocused, isCtrlOrCmd } from './constants/keybindings';
import { useKeybindingsStore } from './stores/useKeybindingsStore';
import { usePluginStore } from './stores/usePluginStore';
import { pluginManager } from './core/plugin-manager';
import { getCapabilitySummary } from './core/plugin-loader';
import { useWorktreeStore } from './stores/useWorktreeStore';
import { useSessionStore } from './stores/useSessionStore';
import { permissionBridge } from './services/replBridge';
import { useNotificationsSource } from './hooks/useNotificationsSource';

export default function App() {
  useNotificationsSource();

  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const settingsInitialKey = useAppStore((s) => s.settingsInitialKey);
  const theme = useAppStore((s) => s.theme);
  const enqueuePermission = useAdvancedStore((s) => s.enqueuePermission);
  const sidebarGlass = useSettingsStore((s) => s.sidebarGlass);
  const aquaGlass = useSettingsStore((s) => s.aquaGlass);
  const wallpaper = useSettingsStore((s) => s.wallpaper);
  const sidebarGlassSupported = useSettingsStore((s) => s.sidebarGlassSupported);
  const sidebarGlassReady = useSettingsStore((s) => s.sidebarGlassReady);
  const glassLayoutMounted = useAppStore((s) => s.glassLayoutMounted);
  const alwaysShowMessageActions = useSettingsStore((s) => s.alwaysShowMessageActions);

  useEffect(() => {
    document.documentElement.classList.toggle('always-show-message-actions', alwaysShowMessageActions);
  }, [alwaysShowMessageActions]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
  const themeConfig = useMemo(() => (resolvedTheme === 'light' ? lightTheme : darkTheme), [resolvedTheme]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  }, [resolvedTheme]);

  // Frosted sidebar: the app's outer layers turn transparent only when native
  // Acrylic is available, so the desktop (blurred) can show through.
  useEffect(() => {
    const glassOn =
      (sidebarGlass > 0 || aquaGlass > 0) && sidebarGlassSupported && sidebarGlassReady && glassLayoutMounted;
    document.documentElement.classList.toggle('auraxis-glass', glassOn);
    // 玻璃类与窗口材质同开同关：玻璃未真正生效时窗口保持不透明，
    // 避免透明+Acrylic 窗口在首帧露出桌面（启动/解锁瞬间全透明）。
    window.electronAPI?.setBackgroundMaterial?.(glassOn)?.catch?.(() => {});
  }, [sidebarGlass, aquaGlass, sidebarGlassSupported, sidebarGlassReady, glassLayoutMounted]);

  // Aqua glass mode: the slider writes a 0-100 level onto <html>; aqua.css
  // turns it into blur radius / frost tint. No wallpaper involved.
  useEffect(() => {
    const level = Math.max(0, Math.min(100, aquaGlass));
    document.documentElement.classList.toggle('auraxis-aqua', level > 0);
    document.documentElement.style.setProperty('--ax-aqua-level', String(level));
  }, [aquaGlass]);

  // 兜底：无论持久化 rehydrate 是否执行，挂载时都重新确认 Acrylic 能力。
  useEffect(() => {
    if (!window.electronAPI?.getGlassState) return;
    let alive = true;
    window.electronAPI
      .getGlassState()
      .then((r) => {
        if (!alive) return;
        useSettingsStore.setState({
          sidebarGlassSupported: !!(r?.ok && r.data?.supported),
          sidebarGlassReady: !!(r?.ok && r.data?.ready),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Prefetch SettingsModal chunk on idle so the first click feels instant.
  useEffect(() => {
    const win = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const prefetch = () => {
      import('./components/settings/SettingsModal');
    };
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(prefetch);
    } else {
      setTimeout(prefetch, 1500);
    }
  }, []);

  // Seed a default chat tab on first mount so the workbench isn't empty.
  useEffect(() => {
    const { tabs, addTab } = useAppStore.getState();
    if (tabs.length === 0) {
      addTab({ type: 'chat', label: t('nav.chat'), metadata: {} });
    }
  }, []);

  // ── Main-process error toasts ──
  // Surface uncaughtException / unhandledRejection from the main process.
  // Without this listener the errors disappear into stderr and users have
  // no idea why something stopped working.
  useEffect(() => {
    const unsub = window.electronAPI?.app?.onError?.((err) => {
      const text = err?.message || t('app.mainError');
      message.error({ content: t('app.mainErrorPrefix', { text }), duration: 6 });
      console.error('[main-process error]', err?.stack || err?.message);
    });
    return () => {
      unsub?.();
    };
  }, []);

  // ── Plan approval IPC — plan:generated → inspector store (composer takeover) ──
  useEffect(() => {
    const unsub = initPlanListener();
    return () => {
      unsub?.();
    };
  }, []);

  // ── Permission IPC — inline cards in chat stream ──
  useEffect(() => {
    if (!window.electronAPI?.permission) return;
    return window.electronAPI.permission.onRequest((request) => {
      permissionBridge._dispatch(request);

      // Background-agent requests route to that agent's own approval queue
      // (rendered inside AgentConversation) — never into the foreground chat.
      if (request.agentId) {
        const agentId = request.agentId;
        useAgentStore.getState().addAgentPermission(agentId, request);

        // If that task isn't on screen the user would never see the prompt —
        // the backend auto-denies at 120s and the task "mysteriously" fails.
        // Raise a clickable notification that jumps to the task view.
        const { currentAgentId, agents } = useAgentStore.getState();
        const onScreen = currentAgentId === agentId && useAppStore.getState().sidebarMode !== 'chat';
        if (!onScreen) {
          const agentName = agents.find((a) => a.id === agentId)?.name || t('app.task');
          notification.info({
            key: request.requestId,
            message: t('app.permissionPending', { name: agentName }),
            description: request.message,
            placement: 'bottomRight',
            duration: 0,
            onClick: () => {
              const app = useAppStore.getState();
              const targetSurface = useAgentStore.getState().agents.find((a) => a.id === agentId)?.surface ?? 'code';
              app.setSidebarMode(targetSurface === 'work' ? 'work' : 'code');
              useAgentStore.getState().setCurrentAgent(agentId);
              notification.destroy(request.requestId);
            },
          });
        }
        return;
      }

      enqueuePermission(request);

      // Push an inline permission card into the chat stream
      const permMsgId = `perm-${request.requestId}`;
      useChatStore.setState((s) => {
        if (s.messages.find((m) => m.id === permMsgId)) return s;
        return {
          messages: [
            ...s.messages,
            {
              id: permMsgId,
              role: 'system' as const,
              content: request.message,
              timestamp: Date.now(),
              permissionRequest: request,
              tags: ['system'],
            },
          ],
        };
      });
    });
  }, [enqueuePermission]);

  // ── Agent IPC ──
  useEffect(() => {
    if (!window.electronAPI?.agent) return;
    const prevStatuses = new Map<string, string>();

    const unsubUpdated = window.electronAPI.agent.onUpdated((agent) => {
      // Only handle native notifications here — agent state updates are
      // handled by the store-level subscribeToUpdates in useAgentStore.ts
      const prev = prevStatuses.get(agent.id);
      const settings = useSettingsStore.getState();
      // notificationMode is the UI truth: always / background-only / never.
      // Legacy persisted states without it fall back to the old boolean.
      const notifMode = settings.notificationMode ?? (settings.notifyOnAgentComplete ? 'always' : 'never');
      const inForeground = typeof document !== 'undefined' && document.hasFocus();
      const shouldNotify = notifMode === 'always' || (notifMode === 'background' && !inForeground);
      if (shouldNotify && prev !== agent.status && (agent.status === 'completed' || agent.status === 'error')) {
        try {
          const n = new Notification(agent.status === 'completed' ? t('app.agentDone') : t('app.agentError'), {
            body:
              agent.status === 'completed'
                ? t('app.agentCompletedMsg', { name: agent.name })
                : t('app.agentErrorMsg', { name: agent.name, error: agent.error || t('app.unknownError') }),
            silent: false,
          });
          n.onclick = () => {
            window.electronAPI?.focusWindow();
            n.close();
          };
        } catch {
          /* noop */
        }
      }
      prevStatuses.set(agent.id, agent.status);
    });

    return () => {
      unsubUpdated();
    };
  }, []);

  // ── Plugin bootstrap ──
  useEffect(() => {
    const bootstrap = async () => {
      if (usePluginStore.getState().seededBuiltins) return;
      if (!usePluginStore.getState().installedPlugins.some((p) => p.id === 'example-timestamp')) {
        const mod = await import('./plugins/example-timestamp');
        pluginManager.installBuiltin(mod.default, 'builtin:example-timestamp');
      }
      if (!usePluginStore.getState().installedPlugins.some((p) => p.id === 'example-uuid')) {
        const mod = await import('./plugins/example-uuid');
        pluginManager.installBuiltin(mod.default, 'builtin:example-uuid');
      }
      usePluginStore.getState().markBuiltinsSeeded();
    };
    bootstrap();
  }, []);

  // ── Runtime inspect: mirror the plugin catalog to the agent backend ──
  const installedPlugins = usePluginStore((s) => s.installedPlugins);
  useEffect(() => {
    if (!window.electronAPI?.runtime?.syncPlugins) return;
    window.electronAPI.runtime.syncPlugins(
      installedPlugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        enabled: p.enabled,
        capabilities: (() => {
          const summary = getCapabilitySummary(p);
          return summary ? [summary] : undefined;
        })(),
      })),
    );
  }, [installedPlugins]);

  // ── Session log authority: merge durable logs into the session list ──
  useEffect(() => {
    void useSessionStore.getState().syncFromLogs();
  }, []);

  // ── Flush before unload (quit/refresh): debounced storage + the buffered
  //    chat-log events can lose the last seconds of a conversation. ──
  useEffect(() => {
    const onPageHide = () => {
      flushChatLogNow();
      const s = useChatStore.getState();
      const sid = useSessionStore.getState().currentSessionId;
      if (sid && !s.isStreaming && s.messages.length > 0) {
        useSessionStore
          .getState()
          .saveSession(
            s.messages,
            s.selectedModel,
            s.currentProjectPath || useSettingsStore.getState().projectPath || undefined,
            useAppStore.getState().sidebarMode,
          );
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F — always available (even in inputs) for inline search toggle
      if (isCtrlOrCmd(e) && e.key === 'f') {
        if (!isInputFocused()) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('auraxis:toggle-message-search'));
        }
        return;
      }
      if (isInputFocused()) return;
      const active = useKeybindingsStore.getState().getActive();

      for (const binding of active) {
        if (!matchBinding(e, binding)) continue;

        // ── Command palette ──
        if (binding.description === '打开命令面板') {
          e.preventDefault();
          setPaletteOpen((p) => !p);
          return;
        }
        // ── Clear chat ──
        if (binding.description === '清空对话') {
          e.preventDefault();
          const state = useChatStore.getState();
          if (state.messages.length === 0) return;
          Modal.confirm({
            title: t('app.clearChatTitle'),
            content: t('app.clearChatBody'),
            okText: t('app.confirmClear'),
            cancelText: t('common.cancel'),
            okButtonProps: { danger: true },
            onOk: () => state.clearMessages(),
          });
          return;
        }
        // ── Toggle sidebar (Ctrl+B or Ctrl+/) ──
        if (binding.description === '切换侧边栏') {
          e.preventDefault();
          useAppStore.getState().toggleSidebar();
          return;
        }
        // ── Toggle right panel (Ctrl+Shift+I or Ctrl+Alt+B) ──
        if (binding.description === '切换右侧面板') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          useAppStore.getState().toggleRightPanel();
          return;
        }
        // ── Pane focus: Alt+1 sidebar, Alt+2 content, Alt+3 right panel ──
        if (binding.description === '聚焦侧边栏') {
          e.preventDefault();
          const sidebarEl = document.querySelector('[data-pane="sider"]') as HTMLElement | null;
          sidebarEl?.focus();
          return;
        }
        if (binding.description === '聚焦主内容区') {
          e.preventDefault();
          const contentEl = document.querySelector('[data-pane="main"]') as HTMLElement | null;
          contentEl?.focus();
          return;
        }
        if (binding.description === '聚焦右侧面板') {
          e.preventDefault();
          const panelEl = document.querySelector('[data-pane="right"]') as HTMLElement | null;
          panelEl?.focus();
          return;
        }
        // ── Right-panel tab switching (Ctrl+Shift+1..3) ──
        if (binding.description === '右侧面板：执行详情') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          const appState = useAppStore.getState();
          appState.setRightPanelView('inspector');
          if (!appState.showRightPanel) appState.toggleRightPanel();
          return;
        }
        if (binding.description === '右侧面板：审查') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          const appState = useAppStore.getState();
          appState.setRightPanelView('review');
          if (!appState.showRightPanel) appState.toggleRightPanel();
          return;
        }
        if (binding.description === '右侧面板：预览') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          const appState = useAppStore.getState();
          appState.setRightPanelView('preview');
          if (!appState.showRightPanel) appState.toggleRightPanel();
          return;
        }
        if (binding.description === '右侧面板：时间线') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          const appState = useAppStore.getState();
          appState.setRightPanelView('timeline');
          if (!appState.showRightPanel) appState.toggleRightPanel();
          return;
        }
        // ── Integrated terminal (Ctrl+`) ──
        if (binding.description === '打开集成终端') {
          e.preventDefault();
          if (useAppStore.getState().sidebarMode === 'chat') return;
          useAppStore.getState().openToolView('terminal');
          return;
        }
        // ── New session (Ctrl+N) ──
        if (binding.description === '新建对话') {
          e.preventDefault();
          useSessionStore.getState().newSession();
          useChatStore.getState().clearMessages();
          return;
        }
        // ── Open settings (Ctrl+,) ──
        if (binding.description === '打开设置') {
          e.preventDefault();
          useAppStore.getState().setSettingsInitialKey('general');
          useAppStore.getState().setShowSettings(true);
          return;
        }
        // ── Close active tab (Ctrl+W) ──
        if (binding.description === '关闭当前标签页') {
          e.preventDefault();
          const appState = useAppStore.getState();
          const tab = appState.tabs.find((t) => t.id === appState.activeTabId);
          if (tab && tab.type !== 'chat') {
            appState.closeTab(tab.id);
          }
          return;
        }
        // ── Undo (Ctrl+Z) ──
        if (binding.description === '撤销最近操作') {
          e.preventDefault();
          const { undoLast, undos } = useUndoStore.getState();
          if (undos.length > 0) undoLast();
          return;
        }
        // ── Escape — stop streaming / close panel / close settings ──
        if (binding.key === 'Escape') {
          const chatState = useChatStore.getState();
          const appState = useAppStore.getState();
          if (chatState.isStreaming) {
            chatState.stopStreaming();
            return;
          }
          if (appState.showRightPanel) {
            appState.toggleRightPanel();
            return;
          }
          if (appState.activeToolView !== 'none') {
            appState.setActiveToolView('none');
            return;
          }
          if (appState.showSettings) {
            appState.setShowSettings(false);
            return;
          }
          return;
        }
        break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // ── Worktree sandbox IPC ──
  useEffect(() => {
    if (!window.electronAPI?.worktree) return;
    const store = useWorktreeStore.getState();
    return window.electronAPI.worktree.onChanged((data) => {
      store.setWorktree({
        active: data.active,
        sandboxPath: data.sandboxPath || null,
        taskId: data.taskId || null,
      });
    });
  }, []);

  // ── UI zoom — frameless window has no menu, so register Ctrl+= / Ctrl+- /
  // Ctrl+0 and Ctrl+wheel here. Level persists in settings, restored at boot.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.zoom) return;

    const applyZoom = (delta: number | null) => {
      api
        .zoom(delta)
        .then((level) => {
          useSettingsStore.getState().setZoomLevel(level);
        })
        .catch(() => {});
    };

    // Restore persisted level (zoom(null) resets to 0, then step to target).
    const saved = useSettingsStore.getState().zoomLevel;
    if (saved !== 0) {
      api
        .zoom(null)
        .then(() => api.zoom(saved))
        .catch(() => {});
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        applyZoom(0.5);
      } else if (e.key === '-') {
        e.preventDefault();
        applyZoom(-0.5);
      } else if (e.key === '0') {
        e.preventDefault();
        applyZoom(null);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? 0.5 : -0.5);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  return (
    <ConfigProvider theme={themeConfig}>
      {/* AntApp provides the context consumed by App.useApp() — without it
          modal.confirm from useApp() is a silent no-op (e.g. the 「自动」run-mode
          confirmation never appeared). component={false} adds no extra DOM. */}
      <AntApp component={false}>
        <ErrorBoundary>
          <AuthGate>
            {/* Wallpaper backdrop: fixed behind the glass surfaces. It only
                becomes visible where the app is transparent (Aqua / acrylic). */}
            {wallpaper && (
              <div aria-hidden className="ax-wallpaper" style={{ backgroundImage: `url("${wallpaper}")` }} />
            )}
            <WorkbenchLayout />
            {showSettings && (
              <Suspense fallback={null}>
                <SettingsModal
                  open={showSettings}
                  initialKey={settingsInitialKey}
                  onClose={() => setShowSettings(false)}
                />
              </Suspense>
            )}
            <UndoToast />
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
            <AskUserHost />
          </AuthGate>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}
