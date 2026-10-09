/**
 * useAppShortcuts.ts — 全局键盘快捷键与缩放（自 App.tsx 拆出）。
 *
 * 快捷键动作按 `binding.description` 建表，避免一长串 if-else；Escape 与
 * Ctrl+F 属于"始终可用"的前置分支，单独处理。
 */
import { useEffect } from 'react';
import { Modal } from 'antd';
import { t } from '../i18n';
import { isCtrlOrCmd, isInputFocused, matchBinding, type KeyBinding } from '../constants/keybindings';
import { useAppStore } from '../stores/useAppStore';
import { useChatStore } from '../stores/useChatStore';
import { useKeybindingsStore } from '../stores/useKeybindingsStore';
import { useSessionStore } from '../stores/useSessionStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useUndoStore } from '../stores/useUndoStore';

type ShortcutHandler = (e: KeyboardEvent) => void;

function focusPane(name: string): void {
  const el = document.querySelector(`[data-pane="${name}"]`) as HTMLElement | null;
  el?.focus();
}

/** 打开右侧面板的某个视图（Chat 模式下不生效）。 */
function openRightPanelView(
  view: 'inspector' | 'diff' | 'preview' | 'timeline' | 'summary' | 'plan' | 'file-tree',
): void {
  if (useAppStore.getState().sidebarMode === 'chat') return;
  const app = useAppStore.getState();
  app.setRightPanelView(view);
  if (!app.showRightPanel) app.toggleRightPanel();
}

function confirmClearChat(): void {
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
}

/** 描述 → 动作。返回 undefined 表示该绑定未注册动作。 */
/** 导出供一致性用例使用：`binding.description` 同时是显示文案的查表键与这里的派发键。 */
export const SHORTCUT_ACTIONS: Record<string, ShortcutHandler> = {
  清空对话: (e) => {
    e.preventDefault();
    confirmClearChat();
  },
  切换侧边栏: (e) => {
    e.preventDefault();
    useAppStore.getState().toggleSidebar();
  },
  切换右侧面板: (e) => {
    e.preventDefault();
    if (useAppStore.getState().sidebarMode === 'chat') return;
    useAppStore.getState().toggleRightPanel();
  },
  聚焦侧边栏: (e) => {
    e.preventDefault();
    focusPane('sider');
  },
  聚焦主内容区: (e) => {
    e.preventDefault();
    focusPane('main');
  },
  聚焦右侧面板: (e) => {
    e.preventDefault();
    focusPane('right');
  },
  '右侧面板：执行详情': (e) => {
    e.preventDefault();
    openRightPanelView('inspector');
  },
  '右侧面板：变更': (e) => {
    e.preventDefault();
    openRightPanelView('diff');
  },
  '右侧面板：预览': (e) => {
    e.preventDefault();
    openRightPanelView('preview');
  },
  '右侧面板：时间线': (e) => {
    e.preventDefault();
    openRightPanelView('timeline');
  },
  '右侧面板：概览': (e) => {
    e.preventDefault();
    openRightPanelView('summary');
  },
  '右侧面板：计划': (e) => {
    e.preventDefault();
    openRightPanelView('plan');
  },
  '右侧面板：文件': (e) => {
    e.preventDefault();
    openRightPanelView('file-tree');
  },
  打开集成终端: (e) => {
    e.preventDefault();
    if (useAppStore.getState().sidebarMode === 'chat') return;
    useAppStore.getState().openToolView('terminal');
  },
  新建对话: (e) => {
    e.preventDefault();
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  },
  打开设置: (e) => {
    e.preventDefault();
    useAppStore.getState().setSettingsInitialKey('general');
    useAppStore.getState().setShowSettings(true);
  },
  关闭当前标签页: (e) => {
    e.preventDefault();
    const app = useAppStore.getState();
    const tab = app.tabs.find((tb) => tb.id === app.activeTabId);
    if (tab && tab.type !== 'chat') app.closeTab(tab.id);
  },
  撤销最近操作: (e) => {
    e.preventDefault();
    const { undoLast, undos } = useUndoStore.getState();
    if (undos.length > 0) undoLast();
  },
};

/** Escape：停止生成 → 关右栏 → 关工具视图 → 关设置。 */
function handleEscape(): void {
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
  if (appState.showSettings) appState.setShowSettings(false);
}

function dispatchShortcut(e: KeyboardEvent, binding: KeyBinding): void {
  if (binding.key === 'Escape') {
    handleEscape();
    return;
  }
  SHORTCUT_ACTIONS[binding.description]?.(e);
}

/**
 * 全局快捷键。`onTogglePalette` 由 App 注入，用于命令面板的开关回调。
 * 打开命令面板的动作同时派发自定义事件，供无状态消费者复用。
 */
export function useAppShortcuts(onTogglePalette: () => void): void {
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

      for (const binding of useKeybindingsStore.getState().getActive()) {
        if (!matchBinding(e, binding)) continue;
        if (binding.description === '打开命令面板') {
          e.preventDefault();
          onTogglePalette();
          return;
        }
        if (binding.key === 'Escape' || SHORTCUT_ACTIONS[binding.description]) {
          dispatchShortcut(e, binding);
        }
        return;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onTogglePalette]);
}

/** Ctrl+= / Ctrl+- / Ctrl+0 与 Ctrl+滚轮缩放；级别持久化到设置。 */
export function useZoomShortcuts(): void {
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
}
