import type { ReactNode } from 'react';
import {
  ArrowUUpLeft as UndoOutlined,
  ChatCircle,
  FileText,
  GearSix,
  Lightning as ThunderboltOutlined,
  PlusCircle as PlusCircleOutlined,
  SidebarSimple as MenuFoldOutlined,
  Stop as StopOutlined,
} from '@/components/common/icons';
import { slashCommandDescKey, type I18nKey } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useUndoStore } from '../../stores/useUndoStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { executeCommand, createAgent } from '../../constants/commands';
import { listSlashCommands, findPluginCommand } from '../../utils/slashCommands';

export interface CommandItem {
  id: string;
  icon: ReactNode;
  title: string;
  description: string;
  shortcut?: string;
  searchText: string;
  action: () => void;
}

export function parseTreePaths(treeText: string): string[] {
  const lines = treeText.split('\n').filter(Boolean);
  const paths: string[] = [];
  const dirStack: { name: string; depth: number }[] = [];
  for (const line of lines) {
    const stripped = line.replace(/^[│\s]+/, '');
    const depth = (line.match(/^(?:│ {3}| {4})*/)?.[0]?.length ?? 0) / 4;
    const name = stripped.replace(/^[├└]── /, '');
    if (!name) continue;
    while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= depth) dirStack.pop();
    if (name.endsWith('/')) {
      dirStack.push({ name: name.slice(0, -1), depth });
    } else {
      const dirPath = dirStack.map((dir) => dir.name).join('/');
      paths.push(dirPath ? `${dirPath}/${name}` : name);
    }
  }
  return paths;
}

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function buildCommandItems({
  filePaths,
  fileHits,
  onClose,
  t,
}: {
  filePaths: string[];
  fileHits: { name: string; path: string; isDirectory: boolean; snippet?: string; matchType?: 'name' | 'content' }[];
  onClose: () => void;
  t: Translate;
}): CommandItem[] {
  const all: CommandItem[] = [];

  for (const command of listSlashCommands()) {
    all.push({
      id: `cmd-${command.name}`,
      icon: <ThunderboltOutlined />,
      title: `/${command.name}`,
      description: t(slashCommandDescKey(command.name)),
      searchText: `${command.name} ${t(slashCommandDescKey(command.name))}`,
      action: () => {
        const execContext = {
          clearMessages: () => useChatStore.getState().clearMessages(),
          setSelectedModel: (model: string) => useChatStore.getState().setSelectedModel(model),
          setInputValue: (value: string) => useChatStore.getState().setInputValue(value),
          toggleTheme: () => useAppStore.getState().toggleTheme(),
          theme: useAppStore.getState().theme,
        };
        let executed = executeCommand(command.name, '', execContext);
        if (!executed) {
          const pluginCommand = findPluginCommand(command.name);
          try {
            if (pluginCommand) executed = pluginCommand.execute('', execContext);
          } catch {
            /* surface as fill-in */
          }
        }
        if (!executed) {
          useChatStore.getState().setInputValue(`/${command.name} `);
          useChatStore.getState().requestComposerFocus();
        }
        onClose();
      },
    });
  }

  if (useAppStore.getState().sidebarMode !== 'chat') {
    all.push(
      {
        id: 'agent-create-explore',
        icon: <PlusCircleOutlined />,
        title: t('palette.createExplore'),
        description: t('palette.createExplore.desc'),
        searchText: t('palette.createExplore.search'),
        action: () => {
          void createAgent({ name: 'Explore Agent', type: 'Explore' }).then((id) => {
            if (id) useAgentStore.getState().setCurrentAgent(id);
          });
          onClose();
        },
      },
      {
        id: 'agent-create-plan',
        icon: <PlusCircleOutlined />,
        title: t('palette.createPlan'),
        description: t('palette.createPlan.desc'),
        searchText: t('palette.createPlan.search'),
        action: () => {
          void createAgent({ name: 'Plan Agent', type: 'Plan' }).then((id) => {
            if (id) useAgentStore.getState().setCurrentAgent(id);
          });
          onClose();
        },
      },
      {
        id: 'agent-create-gp',
        icon: <PlusCircleOutlined />,
        title: t('palette.createGeneral'),
        description: t('palette.createGeneral.desc'),
        searchText: t('palette.createGeneral.search'),
        action: () => {
          void createAgent({ name: 'General Agent', type: 'general-purpose' }).then((id) => {
            if (id) useAgentStore.getState().setCurrentAgent(id);
          });
          onClose();
        },
      },
    );
  }

  all.push(
    {
      id: 'shortcut-clear',
      icon: <ThunderboltOutlined />,
      title: t('palette.clearChat'),
      description: t('palette.clearChat.desc'),
      shortcut: 'Ctrl+L',
      searchText: t('palette.clearChat.search'),
      action: () => {
        useChatStore.getState().clearMessages();
        onClose();
      },
    },
    {
      id: 'shortcut-sidebar',
      icon: <MenuFoldOutlined />,
      title: t('palette.toggleSidebar'),
      description: t('palette.toggleSidebar.desc'),
      shortcut: 'Ctrl+B',
      searchText: t('palette.toggleSidebar.search'),
      action: () => {
        useAppStore.getState().toggleSidebar();
        onClose();
      },
    },
    {
      id: 'shortcut-undo',
      icon: <UndoOutlined />,
      title: t('palette.undo'),
      description: t('palette.undo.desc'),
      shortcut: 'Ctrl+Z',
      searchText: t('palette.undo.search'),
      action: () => {
        const { undoLast, undos } = useUndoStore.getState();
        if (undos.length > 0) undoLast();
        onClose();
      },
    },
    {
      id: 'shortcut-stop',
      icon: <StopOutlined />,
      title: t('palette.stop'),
      description: t('palette.stop.desc'),
      shortcut: 'Esc',
      searchText: t('palette.stop.search'),
      action: () => {
        useChatStore.getState().stopStreaming();
        onClose();
      },
    },
  );

  for (const session of useSessionStore.getState().sessions.slice(0, 8)) {
    all.push({
      id: `session-${session.id}`,
      icon: <ChatCircle />,
      title: session.title || t('palette.untitled'),
      description: t('palette.session'),
      searchText: `${session.title} ${t('palette.session')}`,
      action: () => {
        useChatStore.getState().switchSession(session.id);
        onClose();
      },
    });
  }

  const settingsItems: { key: string; label: string; group: string }[] = [
    { key: 'appearance', label: t('settings.item.appearance'), group: t('settings.nav.general') },
    { key: 'keybindings', label: t('settings.item.keybindings'), group: t('settings.nav.general') },
    { key: 'permissions', label: t('settings.item.permissions'), group: t('settings.nav.security') },
    { key: 'account', label: t('settings.item.account'), group: t('settings.nav.security') },
    { key: 'memory', label: t('settings.item.memory'), group: t('settings.nav.modelRuntime') },
    { key: 'project-rules', label: t('settings.item.projectRules'), group: t('settings.nav.modelRuntime') },
    { key: 'custom-models', label: t('settings.item.customModels'), group: t('settings.nav.modelRuntime') },
    { key: 'mcp', label: t('settings.item.mcp'), group: t('settings.nav.modelRuntime') },
    { key: 'plugins', label: t('settings.item.plugins'), group: t('settings.nav.modelRuntime') },
    { key: 'coverage', label: t('settings.item.coverage'), group: t('settings.nav.advanced') },
    { key: 'about', label: t('settings.item.about'), group: t('settings.nav.about') },
  ];
  for (const item of settingsItems) {
    all.push({
      id: `settings-${item.key}`,
      icon: <GearSix />,
      title: item.label,
      description: `${item.group} · ${t('palette.openSettings')}`,
      searchText: `${item.label} ${item.group} ${t('palette.openSettings')}`,
      action: () => {
        const app = useAppStore.getState();
        app.setSettingsInitialKey(item.key);
        app.setShowSettings(true);
        onClose();
      },
    });
  }

  const projectPath = useSettingsStore.getState().projectPath;
  if (projectPath) {
    const normalize = (path: string) => path.replace(/\\/g, '/');
    const seen = new Set(filePaths.map((path) => normalize(`${projectPath}/${path}`)));
    for (const relative of filePaths.slice(0, 30)) {
      const name = relative.split(/[/\\]/).pop() || relative;
      all.push({
        id: `file-${relative}`,
        icon: <FileText />,
        title: name,
        description: relative,
        searchText: `${name} ${relative} ${t('palette.file')}`,
        action: () => {
          const app = useAppStore.getState();
          if (app.sidebarMode === 'chat') app.setSidebarMode('code');
          app.setActiveToolView('none');
          app.setRightPanelView('file-tree');
          if (!app.showRightPanel) app.toggleRightPanel();
          app.requestOpenFile(`${projectPath}/${relative}`);
          onClose();
        },
      });
    }
    for (const hit of fileHits) {
      const normalized = normalize(hit.path);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      all.push({
        id: `file-hit-${hit.path}`,
        icon: <FileText />,
        title: hit.name,
        description: hit.snippet ? `${hit.path} · ${hit.snippet.slice(0, 60)}` : hit.path,
        searchText: `${hit.name} ${hit.path} ${hit.snippet ?? ''} ${t('palette.file')}`,
        action: () => {
          const app = useAppStore.getState();
          if (app.sidebarMode === 'chat') app.setSidebarMode('code');
          app.setRightPanelView('file-tree');
          if (!app.showRightPanel) app.toggleRightPanel();
          app.requestOpenFile(hit.path);
          onClose();
        },
      });
    }
  }

  return all;
}
