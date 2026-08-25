import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Popconfirm, Tooltip, Input, message, Dropdown, Modal, Checkbox } from 'antd';
import type { MenuProps } from 'antd';
import {
  CalendarCheck,
  Archive as ArchiveOutlined,
  CaretRight,
  Check as CheckOutlined,
  Folder as FolderOutlined,
  FolderOpen as FolderOpenOutlined,
  SlidersHorizontal,
  ShieldCheck,
  ClipboardCheck,
  SignOut,
  CheckCircle as CheckCircleOutlined,
  Clock as ClockCircleOutlined,
  XCircle as CloseCircleOutlined,
  Trash as DeleteOutlined,
  PencilSimple as EditOutlined,
  GitFork as ForkOutlined,
  GearSix,
  MapPin,
  ChatTeardropDots as MessageOutlined,
  PauseCircle as PauseCircleOutlined,
  PlayCircle as PlayCircleOutlined,
  Blocks,
  MagnifyingGlass as SearchOutlined,
  Plus as PlusOutlined,
  SidebarSimple as SidebarSimpleIcon,
  Stop as StopOutlined,
  Wrench,
  NEW_CHAT_ICON,
} from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore, type Session } from '../../stores/useSessionStore';
import { useProjectStore, type Project } from '../../stores/useProjectStore';
import WorkSidebarPanel from '../work/WorkSidebarPanel';
import { useSettingsStore } from '../../stores/useSettingsStore';
import SkillsDirectory from '../skills/SkillsDirectory';
import ExecutingIndicator from '../common/ExecutingIndicator';
import Avatar from '../auth/Avatar';
import { useAuthStore } from '../../stores/useAuthStore';
import type { AgentStatus } from '../../types/agent';
import clsx from 'clsx';
import logoPng from '../../assets/auraxis-logo.png';
import { t, useT, type I18nKey } from '../../i18n';
import type { PermissionProfile } from '../../types/electron-api';
import { getContentText } from '../../types/chat';
import { groupSessionsByTime, groupSessionsByProject } from '../../utils/groupSessions';

/* Agent status → status-dot icon (Code-mode task list). */
const AGENT_STATUS_ICON: Record<AgentStatus, React.ReactNode> = {
  idle: <ClockCircleOutlined />,
  queued: <ClockCircleOutlined />,
  running: <ExecutingIndicator size={14} />,
  paused: <PauseCircleOutlined />,
  completed: <CheckCircleOutlined />,
  error: <CloseCircleOutlined />,
  stopped: <StopOutlined />,
  review: <ClipboardCheck size={14} />,
};

/* Agent status → Tailwind text color */
const AGENT_STATUS_COLOR: Record<string, string> = {
  running: 'text-primary',
  completed: 'text-success',
  error: 'text-danger',
  paused: 'text-warning',
  stopped: 'text-warning',
  review: 'text-warning',
};

/* Sidebar top functions: new chat first, then skills/plugins/scheduled.
   These are normal in-flow items (they scroll with the sidebar), not a fixed
   bar. The former 工具 group header was removed — the items sit directly in
   the list. */
const SIDEBAR_TOP_NAV: {
  key: 'new' | 'skills' | 'scheduled' | 'plugins';
  labelKey: I18nKey;
  icon: React.ReactNode;
}[] = [
  { key: 'new', labelKey: 'nav.newChat', icon: NEW_CHAT_ICON },
  { key: 'skills', labelKey: 'nav.skills', icon: <Wrench /> },
  { key: 'plugins', labelKey: 'nav.plugins', icon: <Blocks /> },
  { key: 'scheduled', labelKey: 'nav.scheduled', icon: <CalendarCheck /> },
];

/* ── Helpers ───────────────────────────────────────────── */

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return t('time.justNow');
  if (sec < 60) return t('time.secondsAgo', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('time.daysAgo', { n: day });
  return new Date(ts).toLocaleDateString('zh-CN');
}

const rowKey = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/* ── Memoized rows: during streaming only the touched session/task re-renders ── */

interface SessionRowProps {
  session: Session;
  projects: Project[];
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  onSelect: (id: string) => void;
  onStartRename: (e: React.MouseEvent, id: string, title: string) => void;
  onChangeRename: (value: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onFork: (e: React.MouseEvent, id: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onMove: (id: string, path: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onDragStart?: (e: React.DragEvent, s: Session) => void;
  onDragOver?: (e: React.DragEvent, s: Session) => void;
  onDrop?: (e: React.DragEvent, s: Session) => void;
  onDragEnd?: () => void;
  dropActive?: boolean;
}

const SessionRow = memo(function SessionRow({
  session: s,
  projects,
  isActive,
  isRenaming,
  renameValue,
  onSelect,
  onStartRename,
  onChangeRename,
  onFinishRename,
  onCancelRename,
  onFork,
  onArchive,
  onMove,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dropActive,
}: SessionRowProps) {
  const t = useT();
  const lastMsg = s.messages[s.messages.length - 1];
  let preview = '';
  if (lastMsg) {
    const raw = getContentText(lastMsg.content).replace(/\n/g, ' ').trim();
    preview = raw.length > 36 ? raw.slice(0, 36) + '…' : raw;
  }
  return (
    <div
      className={clsx(
        'ax-sidebar-item group w-full h-8 py-1.5 text-sm font-normal',
        isActive && 'ax-sidebar-item-active',
        s.archived && 'opacity-55',
        dropActive && 'bg-[var(--color-hover)]',
      )}
      data-active={isActive || undefined}
      draggable
      onDragStart={(e) => onDragStart?.(e, s)}
      onDragOver={(e) => onDragOver?.(e, s)}
      onDrop={(e) => onDrop?.(e, s)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(s.id)}
      role="button"
      tabIndex={0}
      onKeyDown={rowKey(() => onSelect(s.id))}
    >
      {isRenaming ? (
        <Input
          size="small"
          value={renameValue}
          onChange={(e) => onChangeRename(e.target.value)}
          onBlur={onFinishRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onFinishRename();
            if (e.key === 'Escape') onCancelRename();
          }}
          className="[&_.ant-input]:!h-[22px] [&_.ant-input]:!text-xs [&_.ant-input]:!px-[6px]"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="flex-1 min-w-0 flex flex-col gap-[1px]">
          <div className="flex items-center w-full">
            <span className="flex items-center gap-[3px] flex-1 min-w-0">
              {s.pinned && <MapPin weight="fill" size={9} className="text-primary shrink-0" />}
              <span
                className={clsx(
                  'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
                  isActive && 'text-text-primary font-medium',
                )}
              >
                {s.title}
              </span>
            </span>
            <span className="ml-auto shrink-0 text-2xs text-text-muted font-normal">{relativeTime(s.updated)}</span>
          </div>
          {preview && (
            <div className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap leading-[1.4]">
              {preview}
            </div>
          )}
        </div>
      )}
      {!isRenaming && (
        <span className="flex items-center gap-1 shrink-0 ml-1 opacity-0 group-hover:opacity-100">
          <Tooltip title={s.pinned ? t('sidebar.unpin') : t('sidebar.pin')} placement="top">
            <button
              className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                useSessionStore.getState().togglePin(s.id);
              }}
              aria-label={s.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            >
              <MapPin
                weight={s.pinned ? 'fill' : 'regular'}
                style={{ fontSize: 14 }}
                className={s.pinned ? 'text-primary' : undefined}
              />
            </button>
          </Tooltip>
          <Tooltip title={t('sidebar.rename')} placement="top">
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => onStartRename(e, s.id, s.title)}
            >
              <EditOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
          <Tooltip title={t('sidebar.forkTip')} placement="top">
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => onFork(e, s.id)}
              aria-label={t('sidebar.fork')}
            >
              <ForkOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
          <Tooltip title={s.archived ? t('sidebar.unarchive') : t('sidebar.archive')} placement="top">
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => onArchive(e, s.id)}
              aria-label={s.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
            >
              <ArchiveOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
          {projects.length > 1 && (
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              transitionName=""
              menu={{
                items: projects
                  .filter((p) => p.path !== s.projectRoot)
                  .map((p) => ({ key: p.path, label: p.name, onClick: () => onMove(s.id, p.path) })),
              }}
            >
              <button
                className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                onClick={(e) => e.stopPropagation()}
                aria-label={t('sidebar.moveTo')}
                title={t('sidebar.moveTo')}
              >
                <FolderOpenOutlined style={{ fontSize: 14 }} />
              </button>
            </Dropdown>
          )}
          <Popconfirm
            title={t('sidebar.deleteChatConfirm')}
            onConfirm={(e) => {
              e?.stopPropagation();
              onDelete(e as any, s.id);
            }}
            onCancel={(e) => {
              e?.stopPropagation();
            }}
            okText={t('sidebar.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true, type: 'primary', style: { color: '#fff' } }}
          >
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <DeleteOutlined style={{ fontSize: 14 }} />
            </button>
          </Popconfirm>
        </span>
      )}
    </div>
  );
});

interface AgentRowProps {
  agent: import('../../types/agent').AgentInfo;
  isActive: boolean;
  pendingCount: number;
  onSelect: (id: string) => void;
}

const AgentRow = memo(function AgentRow({ agent: a, isActive, pendingCount, onSelect }: AgentRowProps) {
  const t = useT();
  const statusColor = AGENT_STATUS_COLOR[a.status] || '';
  return (
    <div
      className={clsx('ax-sidebar-item group w-full h-8 py-1.5', isActive && 'ax-sidebar-item-active')}
      data-active={isActive || undefined}
      onClick={() => onSelect(a.id)}
      role="button"
      tabIndex={0}
      onKeyDown={rowKey(() => onSelect(a.id))}
      title={a.description || a.name}
    >
      <span className={clsx('shrink-0 flex items-center justify-center w-5 h-5 text-sm text-text-muted', statusColor)}>
        {AGENT_STATUS_ICON[a.status] || <ClockCircleOutlined />}
      </span>
      <span className="flex-1 min-w-0 flex items-center gap-[6px]">
        <span
          className={clsx(
            'flex-1 min-w-0 text-sm overflow-hidden text-ellipsis whitespace-nowrap',
            isActive ? 'text-text-primary font-medium' : 'text-text-secondary',
          )}
        >
          {a.name}
        </span>
        {pendingCount > 0 && (
          <span className="shrink-0 text-2xs font-semibold leading-[1.5] px-[6px] rounded-full text-text-on-accent bg-warning whitespace-nowrap">
            {t('sidebar.pending', { n: pendingCount })}
          </span>
        )}
      </span>
      <span className="shrink-0 flex items-center opacity-0 group-hover:opacity-100">
        {a.status === 'running' && (
          <Tooltip title={t('sidebar.pause')} placement="top">
            <button
              className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                useAgentStore.getState().pauseAgent(a.id);
              }}
              aria-label={t('sidebar.pause')}
            >
              <PauseCircleOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
        )}
        {a.status === 'paused' && (
          <Tooltip title={t('sidebar.resume')} placement="top">
            <button
              className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                useAgentStore.getState().resumeAgent(a.id);
              }}
              aria-label={t('sidebar.resume')}
            >
              <PlayCircleOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
        )}
        {a.status === 'running' || a.status === 'queued' || a.status === 'paused' ? (
          <Tooltip title={t('sidebar.stop')} placement="top">
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                useAgentStore.getState().stopAgent(a.id);
              }}
              aria-label={t('sidebar.stop')}
            >
              <StopOutlined style={{ fontSize: 14 }} />
            </button>
          </Tooltip>
        ) : (
          <Popconfirm
            title={t('sidebar.deleteTaskConfirm')}
            onConfirm={(e) => {
              e?.stopPropagation();
              useAgentStore.getState().removeAgent(a.id);
            }}
            onCancel={(e) => {
              e?.stopPropagation();
            }}
            okText={t('sidebar.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true, type: 'primary', style: { color: '#fff' } }}
          >
            <button
              className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => e.stopPropagation()}
              aria-label={t('sidebar.deleteTask')}
            >
              <DeleteOutlined style={{ fontSize: 14 }} />
            </button>
          </Popconfirm>
        )}
      </span>
    </div>
  );
});

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
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const dragStateRef = useRef<{ kind: 'workspace'; id: string } | { kind: 'session'; id: string; root: string } | null>(
    null,
  );
  const [projectProfiles, setProjectProfiles] = useState<PermissionProfile[]>([]);
  const [projectProfileOverrides, setProjectProfileOverrides] = useState<Record<string, string>>({});
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

  /* ── 项目级权限 Profile：覆盖项随设置加载/保存 ── */
  useEffect(() => {
    let alive = true;
    const pending = window.electronAPI?.permissionProfile?.listProjectProfiles?.();
    if (pending) {
      pending
        .then((r) => {
          if (!alive || !r?.ok || !r.data) return;
          setProjectProfiles(r.data.profiles);
          setProjectProfileOverrides(r.data.overrides ?? {});
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, []);

  const applyProjectProfile = useCallback(
    async (path: string, profileId: string | null) => {
      const r = await window.electronAPI?.permissionProfile?.setProjectProfile?.(path, profileId);
      if (!r?.ok) {
        message.error(r?.error || t('sidebar.projectPermissionSaveFailed'));
        return;
      }
      setProjectProfileOverrides((prev) => {
        const next = { ...prev };
        if (profileId) {
          next[path] = profileId;
        } else {
          delete next[path];
        }
        return next;
      });
      message.success(t('sidebar.projectPermissionSaved'));
    },
    [t],
  );

  const projectProfileMenu = (path: string): MenuProps['items'] => {
    const current = projectProfileOverrides[path] ?? null;
    const items: NonNullable<MenuProps['items']> = [
      {
        key: '__global__',
        label: t('sidebar.projectPermissionGlobal'),
        icon: current === null ? <CheckOutlined size={12} className="text-primary" /> : undefined,
      },
      { type: 'divider' },
    ];
    for (const p of projectProfiles) {
      items.push({
        key: p.id,
        label: p.name,
        icon: current === p.id ? <CheckOutlined size={12} className="text-primary" /> : undefined,
      });
    }
    return items;
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

  const addProjectWorkspace = useCallback(async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    if (result?.ok && result.data) {
      const p = useProjectStore.getState().addProject(result.data);
      message.success(t('sidebar.addedWorkspace', { name: p.name }));
    }
  }, [t]);

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

  /* ── Chat panel (conversation history) ─────────────── */
  const renderChatPanel = () => {
    const activeSessions = sessions.filter((s) => !s.archived);
    const archivedSessions = sessions.filter((s) => s.archived).sort((a, b) => b.updated - a.updated);
    const sortedSessions = [...activeSessions].sort(
      (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated,
    );
    const projectGroups = groupSessionsByProject(
      sortedSessions,
      (s) => s.projectRoot,
      (s) => s.updated,
    );
    const timeGroups = groupSessionsByTime(sortedSessions, (s) => s.updated);
    const singleProject = projectGroups.length <= 1;

    const renderSessionRows = (items: Session[]) => items.map(renderSessionRow);

    return (
      <>
        {/* ── 对话 (original session list, unchanged) ── */}
        {!visualCollapsed && <div className="ax-sidebar-label !px-[18px] !pb-[6px]">{t('nav.chat')}</div>}
        <div className="flex flex-col gap-1 px-0 pb-1 sider-tree">
          {activeSessions.length === 0 ? (
            <div className="ax-sidebar-group flex flex-col items-center justify-center gap-[6px] px-4 py-10 text-center">
              <MessageOutlined className="text-[26px] text-text-faint opacity-75 mb-0.5" />
              <span className="text-sm font-medium text-text-muted">{t('sidebar.noChats')}</span>
              <span className="text-2xs text-text-muted leading-[1.5]">{t('sidebar.clickNewChat')}</span>
            </div>
          ) : singleProject ? (
            timeGroups.map((group) => (
              <div key={group.label} className="ax-sidebar-group">
                <div className="px-[18px] pt-2.5 pb-[6px] text-2xs font-semibold text-text-muted tracking-[0.06em]">
                  {group.label}
                </div>
                <div className="px-0 pb-1 flex flex-col gap-1">{renderSessionRows(group.items)}</div>
              </div>
            ))
          ) : (
            projectGroups.map((pg) => {
              const key = pg.projectRoot ?? '__unassigned__';
              const isCollapsed = collapsedProjects.has(key);
              return (
                <div key={key} className="ax-sidebar-group">
                  <button
                    className="flex items-center gap-1 w-full px-[18px] pt-2.5 pb-[6px] border-none bg-transparent text-text-muted text-2xs font-semibold tracking-[0.06em] font-body cursor-pointer text-left hover:text-text-secondary"
                    onClick={() => {
                      toggleProject(key);
                      if (pg.projectRoot) {
                        const project = useProjectStore.getState().ensureProject(pg.projectRoot);
                        if (project) useProjectStore.getState().selectProject(project.id);
                      }
                    }}
                    title={pg.projectRoot ?? t('sidebar.unspecifiedProject')}
                  >
                    <span
                      className={clsx(
                        'flex items-center justify-center w-[14px] h-[14px] shrink-0 text-text-muted',
                        !isCollapsed && 'rotate-90',
                      )}
                    >
                      <CaretRight />
                    </span>
                    <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      {pg.projectName}
                    </span>
                    <span className="shrink-0 min-w-4 text-2xs font-semibold text-center text-text-muted">
                      {pg.items.length}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="px-0 pb-1 mt-0.5 flex flex-col gap-1">{renderSessionRows(pg.items)}</div>
                  )}
                </div>
              );
            })
          )}
          {archivedSessions.length > 0 && (
            <div className="ax-sidebar-group">
              <div className="px-[18px] pt-2.5 pb-[6px] text-2xs font-semibold text-text-muted tracking-[0.06em]">
                {t('sidebar.archived')}
              </div>
              <div className="px-0 pb-1 flex flex-col gap-1">{renderSessionRows(archivedSessions)}</div>
            </div>
          )}
        </div>
      </>
    );
  };

  /* ── Code panel (parallel Agent task list) ─────────── */
  const handleNewTask = useCallback(() => {
    const app = useAppStore.getState();
    app.setSidebarMode(app.sidebarMode === 'chat' ? 'code' : app.sidebarMode);
    useAppStore.getState().setActiveToolView('none');
    useAgentStore.getState().setCurrentAgent(null);
    useChatStore.getState().setPendingNewTask(true);
  }, []);

  const renderCodePanel = () => {
    const viewItems: MenuProps['items'] = [
      {
        type: 'group',
        label: t('sidebar.groupBy'),
        children: [
          {
            key: 'groupBy-workspace',
            label: t('sidebar.groupByWorkspace'),
            icon: projectGroupBy === 'workspace' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
            onClick: () => useProjectStore.getState().setGroupBy('workspace'),
          },
          {
            key: 'groupBy-flat',
            label: t('sidebar.groupByFlat'),
            icon: projectGroupBy === 'flat' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
            onClick: () => useProjectStore.getState().setGroupBy('flat'),
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'group',
        label: t('sidebar.sort'),
        children: [
          {
            key: 'orderBy-manual',
            label: t('sidebar.orderManual'),
            icon: projectOrderBy === 'manual' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
            onClick: () => useProjectStore.getState().setOrderBy('manual'),
          },
          {
            key: 'orderBy-updated',
            label: t('sidebar.orderUpdated'),
            icon: projectOrderBy === 'updated' ? <CheckOutlined size={12} className="text-primary" /> : undefined,
            onClick: () => useProjectStore.getState().setOrderBy('updated'),
          },
        ],
      },
    ];
    const sortSessions = (list: Session[]) => {
      const pinned = list.filter((s) => s.pinned);
      const rest = list.filter((s) => !s.pinned);
      const byUpdated = (arr: Session[]) => [...arr].sort((a, b) => b.updated - a.updated);
      return projectOrderBy === 'updated' ? [...byUpdated(pinned), ...byUpdated(rest)] : [...pinned, ...rest];
    };
    const orderSessionsByKey = (key: string, list: Session[]) => {
      const order = sessionOrder[key] ?? [];
      const rank = new Map(order.map((id, i) => [id, i]));
      return [...sortSessions(list)].sort(
        (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    };
    const projectRank = new Map(workspaceOrder.map((id, i) => [id, i]));
    const orderedProjects = [...projects].sort(
      (a, b) => (projectRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (projectRank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    const taskGroupMap = new Map<string, import('../../types/agent').AgentInfo[]>();
    for (const a of agents) {
      const key = a.projectRoot || '';
      const list = taskGroupMap.get(key) ?? [];
      list.push(a);
      taskGroupMap.set(key, list);
    }
    const taskGroups = [...taskGroupMap.entries()];
    const activeSessions = sessions.filter((s) => !s.archived);
    const archivedSessions = sessions.filter((s) => s.archived);
    const projectPaths = new Set(projects.map((p) => p.path));
    // 工作区分组下：没有 projectRoot 的会话同样不能丢，归入“未分配”。
    const unassignedSessions = activeSessions.filter((s) => !s.projectRoot || !projectPaths.has(s.projectRoot));
    const renderAgentRow = (a: import('../../types/agent').AgentInfo) => (
      <AgentRow
        key={a.id}
        agent={a}
        isActive={a.id === currentAgentId}
        pendingCount={agentPermissions[a.id]?.length ?? 0}
        onSelect={(id) => {
          const target = useAgentStore.getState().agents.find((x) => x.id === id);
          if (target?.projectRoot) {
            const project = useProjectStore.getState().ensureProject(target.projectRoot);
            if (project) useProjectStore.getState().selectProject(project.id);
          }
          setCurrentAgent(id);
        }}
      />
    );
    return (
      <div className="flex flex-col px-0 sider-code-panel">
        {/* ── 项目工作区 （工作区树 + 会话） ── */}
        <div className="shrink-0 flex items-center px-[18px] pt-2.5 pb-[6px]">
          <span className="text-2xs font-semibold text-text-muted tracking-[0.06em]">{t('sidebar.projects')}</span>
          <Dropdown menu={{ items: viewItems }} trigger={['click']} placement="bottomRight" transitionName="">
            <button
              type="button"
              className="ml-auto flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
              title={t('sidebar.viewOptions')}
              aria-label={t('sidebar.viewOptions')}
            >
              <SlidersHorizontal style={{ fontSize: 14 }} />
            </button>
          </Dropdown>
          <button
            type="button"
            className="flex items-center justify-center w-6 h-6 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
            onClick={addProjectWorkspace}
            title={t('sidebar.addWorkspace')}
            aria-label={t('sidebar.addWorkspace')}
          >
            <FolderOpenOutlined size={16} />
          </button>
        </div>

        {projectGroupBy === 'flat' ? (
          <div className="flex flex-col gap-1 px-0 pb-1">
            {orderSessionsByKey('__flat__', activeSessions).length === 0 ? (
              <div className="px-[18px] py-2 text-2xs text-text-faint">{t('sidebar.noSessions')}</div>
            ) : (
              orderSessionsByKey('__flat__', activeSessions).map(renderSessionRow)
            )}
            {taskGroups.map(([root, list]) => (
              <div key={root || '__unassigned__'} className="flex flex-col gap-1">
                {root && (
                  <div className="px-[18px] pt-1 pb-0.5 text-2xs text-text-faint truncate" title={root}>
                    {root.split(/[\\/]/).pop() || root}
                  </div>
                )}
                {list.map(renderAgentRow)}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1 px-0 pb-1">
            {projects.length === 0 && (
              <div className="px-[18px] py-2 text-2xs text-text-faint">{t('sidebar.noProjects')}</div>
            )}
            {orderedProjects.map((p) => {
              const isCurrent =
                p.id === currentProjectId || (settingsProjectPath !== null && p.path === settingsProjectPath);
              const projectTasks = taskGroupMap.get(p.path) ?? [];
              const count = activeSessions.filter((s) => s.projectRoot === p.path).length + projectTasks.length;
              const expanded = expandedProjects.has(p.id);
              const projectSessions = orderSessionsByKey(
                p.path,
                activeSessions.filter((s) => s.projectRoot === p.path),
              );
              const showAll = showAllSessions.has(p.id);
              const visibleSessions = showAll ? projectSessions : projectSessions.slice(0, 5);
              const renaming = renamingProjectId === p.id;
              return (
                <div key={p.id} className="ax-sidebar-group">
                  <div
                    className={clsx(
                      'ax-sidebar-item ax-project-folder group w-full h-8 py-1.5 text-sm font-normal',
                      isCurrent && 'ax-sidebar-item-active',
                    )}
                    data-active={isCurrent || undefined}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      dragStateRef.current = { kind: 'workspace', id: p.id };
                    }}
                    onDragOver={(e) => {
                      if (dragStateRef.current?.kind === 'workspace') {
                        e.preventDefault();
                        setDragOverKey(`ws-${p.id}`);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const dragged = dragStateRef.current;
                      if (dragged?.kind === 'workspace' && dragged.id !== p.id) {
                        useProjectStore.getState().reorderWorkspace(dragged.id, p.id);
                      }
                      dragStateRef.current = null;
                      setDragOverKey(null);
                    }}
                    onDragEnd={() => {
                      dragStateRef.current = null;
                      setDragOverKey(null);
                    }}
                    data-drop-active={dragOverKey === `ws-${p.id}` || undefined}
                    onClick={() => {
                      toggleProjectExpanded(p.id);
                      useProjectStore.getState().selectProject(p.id);
                      const agentStore = useAgentStore.getState();
                      const active = agentStore.agents.find((a) => a.id === agentStore.currentAgentId);
                      if (active?.projectRoot && active.projectRoot !== p.path) {
                        agentStore.setCurrentAgent(null);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={rowKey(() => {
                      toggleProjectExpanded(p.id);
                      useProjectStore.getState().selectProject(p.id);
                      const agentStore = useAgentStore.getState();
                      const active = agentStore.agents.find((a) => a.id === agentStore.currentAgentId);
                      if (active?.projectRoot && active.projectRoot !== p.path) {
                        agentStore.setCurrentAgent(null);
                      }
                    })}
                    title={p.path}
                  >
                    <span className="ax-sidebar-icon">
                      {expanded ? <FolderOpenOutlined size={16} /> : <FolderOutlined size={16} />}
                    </span>
                    {renaming ? (
                      <Input
                        size="small"
                        value={renameProjectValue}
                        onChange={(e) => setRenameProjectValue(e.target.value)}
                        onBlur={() => {
                          if (renameProjectValue.trim())
                            useProjectStore.getState().renameProject(p.id, renameProjectValue.trim());
                          setRenamingProjectId(null);
                          setRenameProjectValue('');
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (renameProjectValue.trim())
                              useProjectStore.getState().renameProject(p.id, renameProjectValue.trim());
                            setRenamingProjectId(null);
                            setRenameProjectValue('');
                          }
                          if (e.key === 'Escape') {
                            setRenamingProjectId(null);
                            setRenameProjectValue('');
                          }
                        }}
                        className="[&_.ant-input]:!h-[22px] [&_.ant-input]:!text-xs [&_.ant-input]:!px-[6px]"
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{p.name}</span>
                        <span className="shrink-0 text-2xs text-text-muted font-normal tabular-nums">{count}</span>
                        <span className="flex items-center gap-1 shrink-0 ml-1 opacity-0 group-hover:opacity-100">
                          <Tooltip title={t('sidebar.newSessionInProject')} placement="top">
                            <button
                              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                              onClick={(e) => {
                                e.stopPropagation();
                                startSessionInProject(p.path);
                              }}
                              aria-label={t('sidebar.newSessionInProject')}
                            >
                              <PlusOutlined style={{ fontSize: 14 }} />
                            </button>
                          </Tooltip>
                          <Tooltip title={t('sidebar.renameProject')} placement="top">
                            <button
                              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingProjectId(p.id);
                                setRenameProjectValue(p.name);
                              }}
                              aria-label={t('sidebar.renameProject')}
                            >
                              <EditOutlined style={{ fontSize: 14 }} />
                            </button>
                          </Tooltip>
                          <Tooltip title={t('sidebar.projectRootsTip')} placement="top">
                            <button
                              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                              onClick={(e) => {
                                e.stopPropagation();
                                openRootsModal(p);
                              }}
                              aria-label={t('sidebar.projectRoots')}
                            >
                              <FolderOpenOutlined style={{ fontSize: 14 }} />
                            </button>
                          </Tooltip>
                          <Dropdown
                            trigger={['click']}
                            placement="bottomRight"
                            menu={{
                              items: projectProfileMenu(p.path),
                              onClick: ({ key, domEvent }) => {
                                domEvent.stopPropagation();
                                void applyProjectProfile(p.path, key === '__global__' ? null : key);
                              },
                            }}
                          >
                            <button
                              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                              onClick={(e) => e.stopPropagation()}
                              title={t('sidebar.projectPermissionTip')}
                              aria-label={t('sidebar.projectPermission')}
                            >
                              <ShieldCheck size={14} />
                            </button>
                          </Dropdown>
                          <Popconfirm
                            title={t('sidebar.removeProjectConfirm')}
                            onConfirm={(e) => {
                              e?.stopPropagation();
                              useProjectStore.getState().removeProject(p.id);
                            }}
                            onCancel={(e) => {
                              e?.stopPropagation();
                            }}
                            okText={t('sidebar.remove')}
                            cancelText={t('common.cancel')}
                            okButtonProps={{ danger: true, type: 'primary', style: { color: '#fff' } }}
                          >
                            <button
                              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-muted rounded-lg cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-primary"
                              onClick={(e) => e.stopPropagation()}
                              aria-label={t('sidebar.remove')}
                            >
                              <DeleteOutlined style={{ fontSize: 14 }} />
                            </button>
                          </Popconfirm>
                        </span>
                      </>
                    )}
                  </div>
                  {expanded && (
                    <div className="px-0 pb-1 mt-1 flex flex-col gap-1 sider-children opacity-0 animate-[projectExpandIn_0.18s_ease-out_forwards]">
                      {projectSessions.length === 0 ? (
                        <div className="pl-[10px] pr-[18px] py-2 text-2xs text-text-faint">
                          {t('sidebar.noProjectSessions')}
                        </div>
                      ) : (
                        visibleSessions.map(renderSessionRow)
                      )}
                      {projectSessions.length > 5 && (
                        <button
                          type="button"
                          className="self-start ml-[28px] px-2 py-0.5 rounded-lg border-none bg-transparent text-2xs text-text-muted cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                          onClick={() => toggleShowAllSessions(p.id)}
                        >
                          {showAll ? t('sidebar.collapse') : t('sidebar.showAll', { n: projectSessions.length })}
                        </button>
                      )}
                      {projectTasks.length > 0 && (
                        <div className="sider-children-tasks mt-1 flex flex-col gap-0.5">
                          {projectTasks.map(renderAgentRow)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {projectGroupBy === 'workspace' && (taskGroupMap.get('') ?? []).length > 0 && (
          <div className="ax-sidebar-group">
            <div className="px-[18px] pt-2.5 pb-[6px] text-2xs font-semibold text-text-muted tracking-[0.06em]">
              {t('sidebar.unassignedTasks')}
            </div>
            <div className="px-0 pb-1 flex flex-col gap-1">{(taskGroupMap.get('') ?? []).map(renderAgentRow)}</div>
          </div>
        )}
        {unassignedSessions.length > 0 && (
          <div className="ax-sidebar-group">
            <div className="px-[18px] pt-2.5 pb-[6px] text-2xs font-semibold text-text-muted tracking-[0.06em]">
              {t('sidebar.unassignedSessions')}
            </div>
            <div className="px-0 pb-1 flex flex-col gap-1">{unassignedSessions.map(renderSessionRow)}</div>
          </div>
        )}
        {archivedSessions.length > 0 && (
          <div className="ax-sidebar-group">
            <div className="px-[18px] pt-2.5 pb-[6px] text-2xs font-semibold text-text-muted tracking-[0.06em]">
              {t('sidebar.archived')}
            </div>
            <div className="px-0 pb-1 flex flex-col gap-1">{archivedSessions.map(renderSessionRow)}</div>
          </div>
        )}
      </div>
    );
  };

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
        {sidebarMode === 'work'
          ? !visualCollapsed && <WorkSidebarPanel />
          : sidebarMode !== 'chat'
            ? !visualCollapsed && renderCodePanel()
            : renderChatPanel()}
      </div>

      {/* ── 账户：头像菜单（账户信息 / 设置 / 退出） ── */}
      <div
        className={clsx(
          'mt-auto shrink-0 border-t border-[var(--color-border-dim)]',
          visualCollapsed ? 'flex flex-col items-center gap-2 px-1 pt-2.5 pb-0' : 'flex items-center px-2.5 pt-2 pb-0',
        )}
      >
        <Dropdown
          open={avatarMenuOpen}
          onOpenChange={setAvatarMenuOpen}
          trigger={['click']}
          placement="topLeft"
          overlayClassName="account-popup"
          menu={{ items: [] }}
          popupRender={() => (
            <div className="w-[236px] p-1 gap-1 bg-[var(--color-bg-elevated)] rounded-xl shadow-[var(--shadow-md)] flex flex-col opacity-0 translate-y-1 animate-[smartPanelInUp_0.18s_ease_forwards]">
              <div className="flex items-center gap-2 px-2 pt-2 pb-2 min-w-0">
                <Avatar name={accountName || accountEmail} src={accountAvatar} size={34} />
                <span className="min-w-0 flex flex-col">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-[20px] text-text-primary">
                    {accountName || t('auth.account')}
                  </span>
                  {accountEmail && (
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap text-2xs leading-[16px] text-text-muted">
                      {accountEmail}
                    </span>
                  )}
                </span>
              </div>
              <div className="mx-2 my-1 h-px bg-[var(--color-border-dim)]" />
              <button
                type="button"
                className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                onClick={() => {
                  setAvatarMenuOpen(false);
                  useAppStore.getState().setSettingsInitialKey('account');
                  setShowSettings(true);
                }}
              >
                <span className="flex flex-none w-5 items-center justify-center text-text-muted">
                  <GearSix size={16} />
                </span>
                <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">{t('auth.account')}</span>
              </button>
              <button
                type="button"
                className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                onClick={() => {
                  setAvatarMenuOpen(false);
                  useAppStore.getState().setSettingsInitialKey('general');
                  setShowSettings(true);
                }}
              >
                <span className="flex flex-none w-5 items-center justify-center text-text-muted">
                  <GearSix size={16} />
                </span>
                <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">{t('nav.settings')}</span>
              </button>
              <div className="mx-2 my-1 h-px bg-[var(--color-border-dim)]" />
              <button
                type="button"
                className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] text-danger"
                onClick={() => {
                  setAvatarMenuOpen(false);
                  confirmLogout();
                }}
              >
                <span className="flex flex-none w-5 items-center justify-center">
                  <SignOut size={16} />
                </span>
                <span className="flex-1 min-w-0 text-sm leading-[20px]">{t('auth.logout')}</span>
              </button>
            </div>
          )}
        >
          <button
            type="button"
            className={clsx(
              'flex items-center min-w-0 rounded-xl border-none bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]',
              visualCollapsed ? 'justify-center w-11 h-11' : 'gap-2.5 h-11 flex-1 px-2 text-left',
            )}
            title={accountName || accountEmail || t('auth.account')}
            aria-label={t('auth.account')}
          >
            <Avatar name={accountName || accountEmail} src={accountAvatar} size={30} />
            {!visualCollapsed && (
              <span className="min-w-0 flex flex-col">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-[20px] text-text-primary">
                  {accountName || t('auth.account')}
                </span>
                {accountEmail && (
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-2xs leading-[16px] text-text-muted">
                    {accountEmail}
                  </span>
                )}
              </span>
            )}
          </button>
        </Dropdown>
      </div>

      <SkillsDirectory open={skillsDirOpen} onClose={() => setSkillsDirOpen(false)} />

      <Modal
        open={!!rootsModalProject}
        onCancel={() => setRootsModalProject(null)}
        onOk={saveRootsModal}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        title={t('sidebar.projectRoots')}
        width={440}
        destroyOnClose
      >
        <div className="flex flex-col gap-1.5 py-1">
          {rootsModalRoots.map((root, index) => (
            <div key={root} className="flex items-center gap-2 rounded-lg bg-[var(--color-bg-secondary)] px-2 py-1.5">
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-text-secondary">
                {root}
                {index === 0 ? `（${t('sidebar.projectRootsPrimary')}）` : ''}
              </span>
              <Checkbox
                checked={rootsModalWritable.includes(root)}
                onChange={(e) => {
                  const writable = e.target.checked;
                  setRootsModalWritable((prev) =>
                    writable ? (prev.includes(root) ? prev : [...prev, root]) : prev.filter((r) => r !== root),
                  );
                }}
              >
                {t('sidebar.projectRootsWritable')}
              </Checkbox>
              {index > 0 && (
                <button
                  type="button"
                  className="border-none bg-transparent text-text-muted cursor-pointer w-5 h-5 rounded-md flex items-center justify-center hover:bg-[var(--color-hover)] hover:text-text-primary"
                  onClick={() => {
                    setRootsModalRoots((prev) => prev.filter((r) => r !== root));
                    setRootsModalWritable((prev) => prev.filter((r) => r !== root));
                  }}
                  aria-label={t('sidebar.remove')}
                >
                  <CloseCircleOutlined style={{ fontSize: 13 }} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="flex items-center justify-center gap-1.5 mt-1 h-8 rounded-lg border border-dashed border-[var(--color-border-default)] bg-transparent text-xs text-text-muted cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
            onClick={() => void addRootFromPicker()}
          >
            <PlusOutlined style={{ fontSize: 13 }} />
            {t('sidebar.projectRootsAdd')}
          </button>
        </div>
      </Modal>
    </nav>
  );
}
