/**
 * useAppRuntimeEffects.ts — App 启动/卸载期的运行时副作用（自 App.tsx 拆出）。
 *
 * 每个子 hook 只负责一类桥接：主题/玻璃类名、主进程错误、计划与权限 IPC、
 * Agent 通知、插件引导与目录同步、会话日志同步、卸载前落盘、worktree IPC。
 * 拆分的目的是让 App 组件只保留装配，不再堆叠二十个 useEffect。
 */
import { useEffect, useState } from 'react';
import { message, notification } from 'antd';
import { t } from '../i18n';
import { useChatStore, initPlanListener, flushChatLogNow } from '../stores/useChatStore';
import { useAppStore } from '../stores/useAppStore';
import { useAgentStore } from '../stores/useAgentStore';
import { useAdvancedStore } from '../stores/useAdvancedStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { usePluginStore } from '../stores/usePluginStore';
import { useSessionStore } from '../stores/useSessionStore';
import { useWorktreeStore } from '../stores/useWorktreeStore';
import { permissionBridge } from '../services/replBridge';
import { pluginManager } from '../core/plugin-manager';
import { getCapabilitySummary } from '../core/plugin-loader';

/** 系统深色偏好（matchMedia 订阅）。 */
export function useSystemPrefersDark(): boolean {
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
  return systemDark;
}

/** `<html>` 上的 dark 类名。 */
export function useThemeClass(resolvedTheme: 'light' | 'dark'): void {
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  }, [resolvedTheme]);
}

/**
 * 无边框窗口的圆角：窗口以 `transparent: true` 创建，系统不画圆角，
 * 四角由页面自绘（见 tokens.css 的 `--ax-window-radius`）。最大化时归零，
 * 否则贴边的窗口会在屏幕角落露出透明缺口。
 */
export function useWindowCornerClass(): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.isMaximized) return;
    const apply = (maximized: boolean) => {
      document.documentElement.classList.toggle('ax-maximized', maximized);
    };
    void api
      .isMaximized()
      .then(apply)
      .catch(() => {});
    return api.onMaximizeChange?.(apply);
  }, []);
}

/**
 * Frosted sidebar / Aqua glass：外层透明只在原生 Acrylic 可用时开启，
 * 启动与解锁瞬间不会露出桌面。挂载时再确认一次 Glass 能力作为 rehydrate 兜底。
 */
export function useGlassClassEffects(): void {
  const sidebarGlass = useSettingsStore((s) => s.sidebarGlass);
  const aquaGlass = useSettingsStore((s) => s.aquaGlass);
  const sidebarGlassSupported = useSettingsStore((s) => s.sidebarGlassSupported);
  const sidebarGlassReady = useSettingsStore((s) => s.sidebarGlassReady);
  const glassLayoutMounted = useAppStore((s) => s.glassLayoutMounted);

  useEffect(() => {
    const glassOn =
      (sidebarGlass > 0 || aquaGlass > 0) && sidebarGlassSupported && sidebarGlassReady && glassLayoutMounted;
    document.documentElement.classList.toggle('auraxis-glass', glassOn);
    window.electronAPI?.setBackgroundMaterial?.(glassOn)?.catch?.(() => {});
  }, [sidebarGlass, aquaGlass, sidebarGlassSupported, sidebarGlassReady, glassLayoutMounted]);

  useEffect(() => {
    const level = Math.max(0, Math.min(100, aquaGlass));
    document.documentElement.classList.toggle('auraxis-aqua', level > 0);
    document.documentElement.style.setProperty('--ax-aqua-level', String(level));
  }, [aquaGlass]);

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
}

/** 空闲时预取 SettingsModal chunk，首次点击更快。 */
export function useSettingsPrefetch(): void {
  useEffect(() => {
    const win = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const prefetch = () => {
      void import('../components/settings/SettingsModal');
    };
    if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(prefetch);
    else setTimeout(prefetch, 1500);
  }, []);
}

/**
 * 主区固定显示对话：顶部 tab 栏已移除，辅助视图（文件 / 变更 / 预览）都在
 * 右侧工作台面板里。这里负责补默认对话标签，并把历史存档里的非对话标签清掉
 * —— 否则老存档的 activeTabId 可能停在一个再也无法切回的标签上。
 */
export function useDefaultChatTab(): void {
  useEffect(() => {
    const { tabs, activeTabId, addTab, closeTab, setActiveTab } = useAppStore.getState();
    for (const tab of tabs) {
      if (tab.type !== 'chat') closeTab(tab.id);
    }
    const chatTab = useAppStore.getState().tabs.find((tab) => tab.type === 'chat');
    if (!chatTab) {
      addTab({ type: 'chat', label: t('nav.chat'), metadata: {} });
      return;
    }
    if (activeTabId !== chatTab.id) setActiveTab(chatTab.id);
  }, []);
}

/** 主进程未捕获异常/拒绝 → 前台错误提示。 */
export function useMainProcessErrors(): void {
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
}

/** plan:generated → inspector store（composer 接管）。 */
export function usePlanListenerEffect(): void {
  useEffect(() => {
    const unsub = initPlanListener();
    return () => {
      unsub?.();
    };
  }, []);
}

/**
 * 权限请求 IPC → 内联卡片。后台 Agent 的请求进入该 Agent 自己的审批队列；
 * 若该任务不在屏幕上，额外弹一条可点击通知跳转过去。
 */
export function usePermissionRequests(): void {
  useEffect(() => {
    if (!window.electronAPI?.permission) return;
    return window.electronAPI.permission.onRequest((request) => {
      permissionBridge._dispatch(request);

      if (request.agentId) {
        const agentId = request.agentId;
        useAgentStore.getState().addAgentPermission(agentId, request);
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

      useAdvancedStore.getState().enqueuePermission(request);
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
  }, []);
}

/** Agent 完成/失败的原生桌面通知（notificationMode 决定何时弹）。 */
export function useAgentNotifications(): void {
  useEffect(() => {
    if (!window.electronAPI?.agent) return;
    const prevStatuses = new Map<string, string>();

    const unsubUpdated = window.electronAPI.agent.onUpdated((agent) => {
      const prev = prevStatuses.get(agent.id);
      const settings = useSettingsStore.getState();
      // notificationMode is the UI truth: always / background-only / never.
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
}

/** 首次启动安装内置示例插件。 */
export function usePluginBootstrap(): void {
  useEffect(() => {
    const bootstrap = async () => {
      if (usePluginStore.getState().seededBuiltins) return;
      if (!usePluginStore.getState().installedPlugins.some((p) => p.id === 'example-timestamp')) {
        const mod = await import('../plugins/example-timestamp');
        pluginManager.installBuiltin(mod.default, 'builtin:example-timestamp');
      }
      if (!usePluginStore.getState().installedPlugins.some((p) => p.id === 'example-uuid')) {
        const mod = await import('../plugins/example-uuid');
        pluginManager.installBuiltin(mod.default, 'builtin:example-uuid');
      }
      usePluginStore.getState().markBuiltinsSeeded();
    };
    void bootstrap();
  }, []);
}

/** 插件目录镜像到 agent 后端（runtime inspect）。 */
export function usePluginCatalogSync(): void {
  const installedPlugins = usePluginStore((s) => s.installedPlugins);
  useEffect(() => {
    if (!window.electronAPI?.runtime?.syncPlugins) return;
    void window.electronAPI.runtime.syncPlugins(
      installedPlugins.map((p) => {
        const summary = getCapabilitySummary(p);
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          description: p.description,
          enabled: p.enabled,
          capabilities: summary ? [summary] : undefined,
        };
      }),
    );
  }, [installedPlugins]);
}

/** 会话日志权威源：把持久化日志合并回会话列表。 */
export function useSessionLogSync(): void {
  useEffect(() => {
    void useSessionStore.getState().syncFromLogs();
  }, []);
}

/**
 * 退出/刷新前落盘：防抖存储与聊天日志缓冲的最后几秒内容可能丢失。
 */
export function useFlushBeforeUnload(): void {
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
}

/** worktree sandbox 状态 IPC → store。 */
export function useWorktreeBridge(): void {
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
}
