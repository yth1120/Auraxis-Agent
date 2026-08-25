import type { MenuProps } from 'antd';
import { message } from 'antd';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useUndoStore } from '../../stores/useUndoStore';
import type { I18nKey } from '../../i18n';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function buildFileMenuItems(t: Translate): MenuProps['items'] {
  return [
    {
      key: 'new-chat',
      label: t('menu.newChat'),
      onClick: () => {
        const appState = useAppStore.getState();
        if (appState.sidebarMode !== 'chat') {
          appState.setActiveToolView('none');
          useAgentStore.getState().setCurrentAgent(null);
          useChatStore.getState().setPendingNewTask(true);
        }
        useSessionStore.getState().newSession();
        useChatStore.getState().clearMessages();
      },
    },
    {
      key: 'clear-chat',
      label: t('menu.clearChat'),
      onClick: () => useChatStore.getState().clearMessages(),
    },
    { type: 'divider' },
    {
      key: 'settings',
      label: t('menu.settings'),
      onClick: () => {
        useAppStore.getState().setSettingsInitialKey('general');
        useAppStore.getState().setShowSettings(true);
      },
    },
  ];
}

export function buildEditMenuItems(t: Translate): MenuProps['items'] {
  return [
    {
      key: 'undo',
      label: t('menu.undo'),
      onClick: () => {
        const { undoLast, undos } = useUndoStore.getState();
        if (undos.length > 0) undoLast();
      },
    },
  ];
}

export function buildViewMenuItems(t: Translate): MenuProps['items'] {
  return [
    {
      key: 'toggle-sidebar',
      label: t('menu.toggleSidebar'),
      onClick: () => useAppStore.getState().toggleSidebar(),
    },
    {
      key: 'toggle-right-panel',
      label: t('menu.toggleRightPanel'),
      onClick: () => useAppStore.getState().toggleRightPanel(),
    },
    { type: 'divider' },
    {
      key: 'toggle-theme',
      label: t('menu.toggleTheme'),
      onClick: () => useAppStore.getState().toggleTheme(),
    },
  ];
}

export function buildHelpMenuItems(t: Translate): MenuProps['items'] {
  return [
    {
      key: 'about',
      label: t('menu.about'),
      onClick: () => message.info('Auraxis v3.2.0'),
    },
  ];
}
