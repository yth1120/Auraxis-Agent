import { useCallback, useEffect, useRef, useState } from 'react';
import { message, Modal } from 'antd';
import { MagnifyingGlass as SearchOutlined, SidebarSimple as SidebarSimpleIcon } from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore, type Session } from '../../stores/useSessionStore';
import { useProjectStore, type Project } from '../../stores/useProjectStore';
import WorkSidebarPanel from '../work/WorkSidebarPanel';
import { useSettingsStore } from '../../stores/useSettingsStore';
import SkillsDirectory from '../skills/SkillsDirectory';
import { useAuthStore } from '../../stores/useAuthStore';
import clsx from 'clsx';
import logoPng from '../../assets/auraxis-logo.png';
import { useT } from '../../i18n';
import { SessionRow, SIDEBAR_TOP_NAV } from './SiderNavRows';
import SiderAccountMenu from './SiderAccountMenu';
import SiderRootsModal from './SiderRootsModal';
import SiderChatPanel from './SiderChatPanel';
import SiderCodePanel, { type SiderDragState } from './SiderCodePanel';

/* Agent status → status-dot icon (Code-mode task list). */
/* ── Component ────────────────────────────────────────── */

interface SiderNavProps {
  collapsed: boolean;
}

export default function SiderNav({ collapsed }: SiderNavProps) {
  const t = useT();
  /* Hide content immediately on collapse — avoids squeeze during Allotment animation. */
  const [visualCollapsed, setVisualCollapsed] = useState(collapsed);
  useEffect(() => {
    if (collapsed) {
      // Keep the content laid out while the drawer slides shut (clipped by the
      // parent), then hide labels after the width transition completes.
      const timer = setTimeout(() => setVisualCollapsed(true), 280);
      return () => clearTimeout(timer);
    }
    setVisualCollapsed(false);
  }, [collapsed]);

  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const accountName = useAuthStore((s) => s.name);
  const accountEmail = useAuthStore((s) => s.email);
  const accountAvatar = useAuthStore((s) => s.avatar);
  const logout = useAuthStore((s) => s.logout);
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const activeToolView = useAppStore((s) => s.activeToolView);
  const openToolView = useAppStore((s) => s.openToolView);

  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const projects = useProjectStore((s) => s.projects);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const settingsProjectPath = useSettingsStore((s) => s.projectPath);
  const projectGroupBy = useProjectStore((s) => s.view.groupBy);
  const projectOrderBy = useProjectStore((s) => s.view.orderBy);
  const workspaceOrder = useProjectStore((s) => s.workspaceOrder);
  const sessionOrder = useProjectStore((s) => s.sessionOrder);

  // Code-mode parallel-agent task list
  const agents = useAgentStore((s) => s.agents.filter((a) => (a.surface ?? 'code') !== 'work'));
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const setCurrentAgent = useAgentStore((s) => s.setCurrentAgent);
  const agentPermissions = useAgentStore((s) => s.agentPermissions);

  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [showAllSessions, setShowAllSessions] = useState<Set<string>>(new Set());
  const [skillsDirOpen, setSkillsDirOpen] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const dragStateRef = useRef<SiderDragState>(null);
  const [rootsModalProject, setRootsModalProject] = useState<Project | null>(null);
  const [rootsModalRoots, setRootsModalRoots] = useState<string[]>([]);
  const [rootsModalWritable, setRootsModalWritable] = useState<string[]>([]);

  const openRootsModal = (p: Project) => {
    const roots = p.roots.length > 0 ? [...p.roots] : [p.path];
    setRootsModalProject(p);
    setRootsModalRoots(roots);
    setRootsModalWritable(p.writableRoots.length > 0 ? [...p.writableRoots] : roots);
  };

  const addRootFromPicker = async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    const dir = result?.ok ? result.data : null;
    if (dir && !rootsModalRoots.includes(dir)) {
      setRootsModalRoots((prev) => [...prev, dir]);
      setRootsModalWritable((prev) => [...prev, dir]);
    }
  };

  const saveRootsModal = () => {
    const p = rootsModalProject;
    if (!p) return;
    const store = useProjectStore.getState();
    for (const r of rootsModalRoots) {
      if (!p.roots.includes(r)) store.addProjectRoot(p.id, r);
    }
    for (const r of p.roots) {
      if (!rootsModalRoots.includes(r)) store.removeProjectRoot(p.id, r);
    }
    for (const r of rootsModalRoots) {
      store.setRootWritable(p.id, r, rootsModalWritable.includes(r));
    }
    setRootsModalProject(null);
    message.success(t('sidebar.projectRootsSaved'));
  };

  const labelCls = visualCollapsed ? 'max-w-0 opacity-0 ml-0' : 'max-w-[200px] opacity-100 ml-2';
  /* ── Project workspaces （项目工作区） ── */
  useEffect(() => {
    const st = useProjectStore.getState();
    for (const s of sessions) {
      if (s.projectRoot) st.ensureProject(s.projectRoot);
    }
    for (const a of agents) {
      if (a.projectRoot) st.ensureProject(a.projectRoot);
    }
    const active = settingsProjectPath ? st.ensureProject(settingsProjectPath) : null;
    if (active && st.currentProjectId !== active.id) {
      st.selectProject(active.id);
    }
  }, [sessions, agents, settingsProjectPath]);

  useEffect(() => {
    if (!currentProjectId) return;
    setExpandedProjects((prev) => {
      if (prev.has(currentProjectId)) return prev;
      const next = new Set(prev);
      next.add(currentProjectId);
      return next;
    });
  }, [currentProjectId]);

  const toggleProjectExpanded = useCallback((id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleShowAllSessions = useCallback((id: string) => {
    setShowAllSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startSessionInProject = useCallback((path: string) => {
    useSettingsStore.getState().setProjectPath(path);
    useChatStore.getState().setCurrentProjectPath(path);
    useAppStore.getState().setSidebarMode('chat');
    useAppStore.getState().setActiveToolView('none');
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  }, []);

  const toggleProject = useCallback((key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /* ── Chat-mode actions ─────────────────────────────── */
  const handleNewSession = useCallback(() => {
    useAppStore.getState().setSidebarMode('chat');
    useAppStore.getState().setActiveToolView('none');
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  }, []);
  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (renamingThreadId) return;
      // Clicking a conversation is an explicit "show me chat" gesture: leave
      // Agent mode entirely so the sidebar and the main surface agree.
      useAppStore.getState().setSidebarMode('chat');
      useAppStore.getState().setActiveToolView('none');
      useChatStore.getState().switchSession(threadId);
    },
    [renamingThreadId],
  );
  const handleForkThread = useCallback(
    (e: React.MouseEvent, threadId: string) => {
      e.stopPropagation();
      useAppStore.getState().setSidebarMode('chat');
      useAppStore.getState().setActiveToolView('none');
      const newId = useSessionStore.getState().forkSession(threadId);
      if (!newId) {
        message.error(t('sidebar.forkFailed'));
        return;
      }
      useChatStore.getState().switchSession(newId);
      message.success(t('sidebar.forked'));
    },
    [t],
  );
  const handleArchiveThread = useCallback(
    (e: React.MouseEvent, threadId: string) => {
      e.stopPropagation();
      const wasCurrent = threadId === currentSessionId;
      useSessionStore.getState().toggleArchive(threadId);
      if (wasCurrent) {
        const s = useSessionStore.getState();
        const archived = s.sessions.some((x) => x.id === threadId && x.archived);
        if (archived) {
          // 归档当前会话后自动进入新会话，避免停留在已归档的旧对话。
          useChatStore.getState().clearMessages();
          useSessionStore.getState().newSession();
        }
      }
    },
    [currentSessionId],
  );
  const handleDeleteThread = useCallback(
    (e: React.MouseEvent, threadId: string) => {
      e.stopPropagation();
      useSessionStore.getState().deleteSession(threadId);
      if (threadId === currentSessionId) {
        // 删除当前会话后自动新建一个空会话，避免界面停留在已删除的旧对话上。
        useChatStore.getState().clearMessages();
        useSessionStore.getState().newSession();
      }
    },
    [currentSessionId],
  );
  const handleStartRename = useCallback((e: React.MouseEvent, threadId: string, currentTitle: string) => {
    e.stopPropagation();
    setRenamingThreadId(threadId);
    setRenameValue(currentTitle);
  }, []);
  const handleFinishRename = useCallback(() => {
    if (renamingThreadId && renameValue.trim()) {
      useSessionStore.getState().renameSession(renamingThreadId, renameValue.trim());
    }
    setRenamingThreadId(null);
    setRenameValue('');
  }, [renamingThreadId, renameValue]);

  const handleMoveSession = useCallback((id: string, path: string) => {
    useSessionStore.getState().moveSessionToProject(id, path);
  }, []);

  const handleSessionDragStart = (e: React.DragEvent, s: Session) => {
    e.stopPropagation();
    dragStateRef.current = { kind: 'session', id: s.id, root: s.projectRoot || '' };
  };
  const handleSessionDragOver = (e: React.DragEvent, s: Session) => {
    if (dragStateRef.current?.kind !== 'session') return;
    e.preventDefault();
    setDragOverKey(s.id);
  };
  const handleSessionDrop = (e: React.DragEvent, s: Session) => {
    e.preventDefault();
    const dragged = dragStateRef.current;
    if (dragged?.kind === 'session' && dragged.id !== s.id) {
      const targetRoot = s.projectRoot || '';
      if (dragged.root !== targetRoot) useSessionStore.getState().moveSessionToProject(dragged.id, targetRoot);
      useProjectStore.getState().reorderSession(targetRoot, dragged.id, s.id);
    }
    dragStateRef.current = null;
    setDragOverKey(null);
  };
  const handleSessionDragEnd = () => {
    dragStateRef.current = null;
    setDragOverKey(null);
  };

  const renderSessionRow = (s: Session) => (
    <SessionRow
      key={s.id}
      session={s}
      projects={projects}
      isActive={s.id === currentSessionId}
      isRenaming={renamingThreadId === s.id}
      renameValue={renameValue}
      onSelect={handleSelectThread}
      onStartRename={handleStartRename}
      onChangeRename={setRenameValue}
      onFinishRename={handleFinishRename}
      onCancelRename={() => {
        setRenamingThreadId(null);
        setRenameValue('');
      }}
      onFork={handleForkThread}
      onArchive={handleArchiveThread}
      onMove={handleMoveSession}
      onDelete={handleDeleteThread}
      onDragStart={handleSessionDragStart}
      onDragOver={handleSessionDragOver}
      onDrop={handleSessionDrop}
      onDragEnd={handleSessionDragEnd}
      dropActive={dragOverKey === s.id}
    />
  );

  /* ── Code panel (parallel Agent task list) ─────────── */
  const handleNewTask = useCallback(() => {
    const app = useAppStore.getState();
    app.setSidebarMode(app.sidebarMode === 'chat' ? 'code' : app.sidebarMode);
    useAppStore.getState().setActiveToolView('none');
    useAgentStore.getState().setCurrentAgent(null);
    useChatStore.getState().setPendingNewTask(true);
  }, []);

  /** Render one top-nav item (新建/技能/插件/定时). */
  const renderTopItem = (f: (typeof SIDEBAR_TOP_NAV)[number]) => {
    const onClick = () => {
      if (f.key === 'new') {
        if (sidebarMode !== 'chat') handleNewTask();
        else handleNewSession();
      } else if (f.key === 'skills') setSkillsDirOpen(true);
      else openToolView(f.key);
    };
    return (
      <button
        key={f.key}
        className={clsx(
          'ax-sidebar-item h-8',
          activeToolView === f.key && 'ax-sidebar-item-active',
          visualCollapsed ? 'justify-center p-0 w-9 mx-auto overflow-hidden' : 'px-[10px]',
        )}
        onClick={onClick}
        title={t(f.labelKey)}
      >
        <span className="ax-sidebar-icon">{f.icon}</span>
        <span className={clsx('label-collapsible', labelCls)}>{t(f.labelKey)}</span>
      </button>
    );
  };

  const confirmLogout = () => {
    Modal.confirm({
      title: t('auth.logoutConfirmTitle'),
      content: t('auth.logoutConfirmBody'),
      okText: t('auth.logout'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => {
        void logout();
      },
    });
  };

  return (
    <nav
      className={clsx(
        'sider-nav ax-sidebar flex flex-col h-full shrink-0 min-w-[260px] p-1 pb-2 overflow-hidden',
        visualCollapsed && 'sider-nav-collapsed',
        collapsed && 'sider-nav-hidden',
        sidebarMode !== 'chat' && 'code-mode',
      )}
    >
      <div
        className={clsx(
          'ax-logo w-full shrink-0',
          visualCollapsed ? 'justify-center px-0 pb-2' : 'px-[10px] pb-3 pt-1',
        )}
      >
        <img src={logoPng} alt="Auraxis" />
        {!visualCollapsed && <span className="ax-wordmark">Auraxis</span>}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="ax-header-action shrink-0"
            onClick={() => {
              useAppStore.getState().setGlobalSearchOpen(true);
            }}
            title={t('sidebar.globalSearch')}
            aria-label={t('sidebar.globalSearch')}
          >
            <SearchOutlined />
          </button>
          <button
            className="ax-header-action shrink-0"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
            aria-label={sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
          >
            <SidebarSimpleIcon weight={sidebarCollapsed ? 'regular' : 'fill'} />
          </button>
        </div>
      </div>

      <div
        className={clsx(
          'scroll-thin flex flex-col flex-1 sider-scroll-area-inner mt-1 overflow-y-auto overflow-x-hidden',
        )}
      >
        {/* ── Top functions: normal in-flow items, scroll with the sidebar ── */}
        <div className={clsx('shrink-0 flex flex-col gap-0.5', visualCollapsed ? 'px-0 pb-1' : 'px-0 pb-2.5')}>
          {/* 「工具」按钮已移除：技能 / 插件中心 / 定时任务直接常驻显示。 */}
          {SIDEBAR_TOP_NAV.filter((f) => f.key === 'new' || sidebarMode !== 'chat').map(renderTopItem)}
        </div>
        {sidebarMode === 'work' ? (
          !visualCollapsed && <WorkSidebarPanel />
        ) : sidebarMode !== 'chat' ? (
          !visualCollapsed && (
            <SiderCodePanel
              sessions={sessions}
              projects={projects}
              agents={agents}
              currentAgentId={currentAgentId}
              currentProjectId={currentProjectId}
              settingsProjectPath={settingsProjectPath}
              projectGroupBy={projectGroupBy}
              projectOrderBy={projectOrderBy}
              workspaceOrder={workspaceOrder}
              sessionOrder={sessionOrder}
              agentPermissions={agentPermissions}
              expandedProjects={expandedProjects}
              showAllSessions={showAllSessions}
              renamingProjectId={renamingProjectId}
              renameProjectValue={renameProjectValue}
              onToggleProjectExpanded={toggleProjectExpanded}
              onToggleShowAllSessions={toggleShowAllSessions}
              onRenameStart={(id, value) => {
                setRenamingProjectId(id);
                setRenameProjectValue(value);
              }}
              onRenameChange={setRenameProjectValue}
              onRenameCommit={(id, value) => {
                if (value.trim()) useProjectStore.getState().renameProject(id, value.trim());
                setRenamingProjectId(null);
                setRenameProjectValue('');
              }}
              onRenameCancel={() => {
                setRenamingProjectId(null);
                setRenameProjectValue('');
              }}
              onStartSession={startSessionInProject}
              onOpenRoots={openRootsModal}
              onSelectAgent={(id) => {
                const target = useAgentStore.getState().agents.find((x) => x.id === id);
                if (target?.projectRoot) {
                  const project = useProjectStore.getState().ensureProject(target.projectRoot);
                  if (project) useProjectStore.getState().selectProject(project.id);
                }
                setCurrentAgent(id);
              }}
              renderSessionRow={renderSessionRow}
              dragStateRef={dragStateRef}
              dragOverKey={dragOverKey}
              setDragOverKey={setDragOverKey}
            />
          )
        ) : (
          <SiderChatPanel
            collapsed={visualCollapsed}
            sessions={sessions}
            collapsedProjects={collapsedProjects}
            toggleProject={toggleProject}
            onSelectProject={(path) => {
              const project = useProjectStore.getState().ensureProject(path);
              if (project) useProjectStore.getState().selectProject(project.id);
            }}
            renderSessionRow={renderSessionRow}
          />
        )}
      </div>

      <SiderAccountMenu
        collapsed={visualCollapsed}
        accountName={accountName}
        accountEmail={accountEmail}
        accountAvatar={accountAvatar}
        onOpenAccount={() => {
          useAppStore.getState().setSettingsInitialKey('account');
          setShowSettings(true);
        }}
        onOpenSettings={() => {
          useAppStore.getState().setSettingsInitialKey('general');
          setShowSettings(true);
        }}
        onLogout={confirmLogout}
      />

      <SkillsDirectory open={skillsDirOpen} onClose={() => setSkillsDirOpen(false)} />

      <SiderRootsModal
        open={!!rootsModalProject}
        roots={rootsModalRoots}
        writable={rootsModalWritable}
        onCancel={() => setRootsModalProject(null)}
        onSave={saveRootsModal}
        onAddRoot={() => void addRootFromPicker()}
        onRemoveRoot={(root) => {
          setRootsModalRoots((prev) => prev.filter((r) => r !== root));
          setRootsModalWritable((prev) => prev.filter((r) => r !== root));
        }}
        onToggleWritable={(root, checked) => {
          setRootsModalWritable((prev) =>
            checked ? (prev.includes(root) ? prev : [...prev, root]) : prev.filter((r) => r !== root),
          );
        }}
      />
    </nav>
  );
}
