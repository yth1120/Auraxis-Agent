import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { Input, Modal } from 'antd';
import type { InputRef } from 'antd';
import {
  MagnifyingGlass as SearchOutlined,
  Lightning as ThunderboltOutlined,
  Stop as StopOutlined,
  SidebarSimple as MenuFoldOutlined,
  PlusCircle as PlusCircleOutlined,
  ArrowUUpLeft as UndoOutlined,
  ChatCircle,
  GearSix,
  FileText,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useT, slashCommandDescKey } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useUndoStore } from '../../stores/useUndoStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { executeCommand, createAgent } from '../../constants/commands';
import { listSlashCommands, findPluginCommand } from '../../utils/slashCommands';

function parseTreePaths(treeText: string): string[] {
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
      const dirPath = dirStack.map((d) => d.name).join('/');
      paths.push(dirPath ? `${dirPath}/${name}` : name);
    }
  }
  return paths;
}

interface CommandItem {
  id: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  shortcut?: string;
  searchText: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [fileHits, setFileHits] = useState<
    { name: string; path: string; isDirectory: boolean; snippet?: string; matchType?: 'name' | 'content' }[]
  >([]);
  const inputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // 命令面板也承担「打开文件」：拉取项目文件树供搜索。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const projectPath = useSettingsStore.getState().projectPath;
    if (!projectPath) {
      setFilePaths([]);
      return;
    }
    window.electronAPI?.context
      ?.getFileStructure(projectPath)
      .then((r) => {
        if (!cancelled && r.ok && r.data) setFilePaths(parseTreePaths(r.data).slice(0, 200));
      })
      .catch(() => {
        if (!cancelled) setFilePaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 文件内容搜索：查询 >=2 字符时按内容/文件名搜索项目（防抖 250ms）。
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const projectPath = useSettingsStore.getState().projectPath;
    if (q.length < 2 || !projectPath) {
      setFileHits([]);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI?.file
        ?.search(q, projectPath)
        .then((r) => setFileHits(r.ok ? (r.data ?? []) : []))
        .catch(() => setFileHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, query]);

  // Esc must close the palette even before the input gains focus — the global
  // app shortcut handler skips Escape while an input is focused, so relying on
  // antd's panel-level keydown alone is timing-dependent.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const items = useMemo((): CommandItem[] => {
    const all: CommandItem[] = [];

    // ── Slash commands (read from the unified registry) ──
    for (const cmd of listSlashCommands()) {
      all.push({
        id: `cmd-${cmd.name}`,
        icon: <ThunderboltOutlined />,
        title: `/${cmd.name}`,
        description: t(slashCommandDescKey(cmd.name)),
        searchText: `${cmd.name} ${t(slashCommandDescKey(cmd.name))}`,
        action: () => {
          const execCtx = {
            clearMessages: () => useChatStore.getState().clearMessages(),
            setSelectedModel: (model: string) => useChatStore.getState().setSelectedModel(model),
            setInputValue: (value: string) => useChatStore.getState().setInputValue(value),
            toggleTheme: () => useAppStore.getState().toggleTheme(),
            theme: useAppStore.getState().theme,
          };
          let executed = executeCommand(cmd.name, '', execCtx);
          if (!executed) {
            const pluginCmd = findPluginCommand(cmd.name);
            try {
              if (pluginCmd) executed = pluginCmd.execute('', execCtx);
            } catch {
              /* surface as fill-in */
            }
          }
          if (!executed) {
            useChatStore.getState().setInputValue(`/${cmd.name} `);
            useChatStore.getState().requestComposerFocus();
          }
          onClose();
        },
      });
    }

    // ── Agent actions (hidden in chat mode — pure conversation surface) ──
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

    // ── Keyboard shortcuts ──
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

    // ── 会话（本地历史） ──
    for (const s of useSessionStore.getState().sessions.slice(0, 8)) {
      all.push({
        id: `session-${s.id}`,
        icon: <ChatCircle />,
        title: s.title || t('palette.untitled'),
        description: t('palette.session'),
        searchText: `${s.title} ${t('palette.session')}`,
        action: () => {
          useChatStore.getState().switchSession(s.id);
          onClose();
        },
      });
    }

    // ── 设置面板直达 ──
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

    // ── 项目文件 ──
    const projectPath = useSettingsStore.getState().projectPath;
    if (projectPath) {
      const norm = (p: string) => p.replace(/\\/g, '/');
      const seen = new Set(filePaths.map((p) => norm(`${projectPath}/${p}`)));
      for (const rel of filePaths.slice(0, 30)) {
        const name = rel.split(/[/\\]/).pop() || rel;
        all.push({
          id: `file-${rel}`,
          icon: <FileText />,
          title: name,
          description: rel,
          searchText: `${name} ${rel} ${t('palette.file')}`,
          action: () => {
            const app = useAppStore.getState();
            if (app.sidebarMode === 'chat') app.setSidebarMode('code');
            app.setActiveToolView('none');
            app.setRightPanelView('file-tree');
            if (!app.showRightPanel) app.toggleRightPanel();
            app.requestOpenFile(`${projectPath}/${rel}`);
            onClose();
          },
        });
      }
      for (const hit of fileHits) {
        const normalized = norm(hit.path);
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
  }, [onClose, t, filePaths, fileHits]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items
      .map((item) => {
        let score = 0;
        const title = item.title.toLowerCase();
        const desc = item.description.toLowerCase();
        const search = item.searchText.toLowerCase();
        if (title === q) score += 100;
        else if (title.startsWith(q)) score += 60;
        else if (title.includes(q)) score += 40;
        else if (search.includes(q)) score += 20;
        else if (desc.includes(q)) score += 10;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }, [items, query]);

  useEffect(() => {
    setSelected(0);
  }, [filtered]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((p) => Math.min(p + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((p) => Math.max(p - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        filtered[selected]?.action();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [filtered, selected, onClose],
  );

  const modal = (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      centered
      className="command-palette-modal"
      transitionName=""
      maskTransitionName=""
      styles={{ mask: { background: 'var(--glass-mask)' }, body: { padding: 0 } }}
    >
      <div className="pt-4 px-4">
        <Input
          ref={inputRef}
          prefix={<SearchOutlined className="text-muted" />}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          bordered={false}
          size="large"
          className="text-lg"
        />
      </div>
      <div className="max-h-[320px] overflow-y-auto p-2 pb-4">
        {filtered.length === 0 ? (
          <div className="text-center p-6 text-muted text-sm">{t('palette.empty')}</div>
        ) : (
          filtered.map((item, i) => {
            const prefix = item.id.split('-')[0] ?? '';
            const groupKey =
              prefix === 'cmd'
                ? t('palette.group.commands')
                : prefix === 'agent'
                  ? t('palette.group.agents')
                  : prefix === 'session'
                    ? t('palette.group.sessions')
                    : prefix === 'settings'
                      ? t('palette.group.settings')
                      : prefix === 'file'
                        ? t('palette.group.files')
                        : t('palette.group.shortcuts');
            const showHeader = i === 0 || filtered[i - 1]?.id.split('-')[0] !== prefix;
            return (
              <Fragment key={item.id}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-text-faint tracking-[0.06em] uppercase">
                    {groupKey}
                  </div>
                )}
                <div
                  onClick={item.action}
                  onMouseEnter={() => setSelected(i)}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors duration-fast ease-out',
                    i === selected ? 'bg-accent-soft' : 'hover:bg-accent-soft',
                  )}
                >
                  <span className="text-lg text-secondary w-[22px] text-center shrink-0">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{item.title}</div>
                    <div className="text-2xs text-muted mt-1">{item.description}</div>
                  </div>
                  {item.shortcut && (
                    <span className="font-mono text-2xs text-muted bg-primary-soft py-1 px-2 rounded-md whitespace-nowrap">
                      {item.shortcut}
                    </span>
                  )}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      <div className="border-t border-dim p-2 px-4 flex gap-4 text-2xs text-muted">
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">↑↓</kbd> {t('palette.nav')}
        </span>
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">Enter</kbd> {t('palette.select')}
        </span>
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">Esc</kbd> {t('palette.close')}
        </span>
      </div>
    </Modal>
  );

  return createPortal(modal, document.body);
}
