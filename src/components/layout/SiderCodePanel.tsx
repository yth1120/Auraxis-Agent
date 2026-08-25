import { type ReactNode } from 'react';
import { Dropdown, Input, Popconfirm, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import clsx from 'clsx';
import {
  Check as CheckOutlined,
  Trash as DeleteOutlined,
  PencilSimple as EditOutlined,
  Folder as FolderOutlined,
  FolderOpen as FolderOpenOutlined,
  Plus as PlusOutlined,
  ShieldCheck,
  SlidersHorizontal,
} from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useProjectStore } from '../../stores/useProjectStore';
import type { Project } from '../../stores/useProjectStore';
import type { Session } from '../../stores/useSessionStore';
import type { AgentInfo } from '../../types/agent';
import type { PermissionRequest } from '../../types/advanced';
import { AgentRow, rowKey } from './SiderNavRows';
import { useT } from '../../i18n';
import { buildTaskGroups, orderedProjects, unassignedSessionsOf, orderSessionsByKey } from './SiderCodePanelData';
import { useSiderProjectProfiles } from './useSiderProjectProfiles';

export type SiderDragState = { kind: 'workspace'; id: string } | { kind: 'session'; id: string; root: string } | null;

interface SiderCodePanelProps {
  sessions: Session[];
  projects: Project[];
  agents: AgentInfo[];
  currentAgentId: string | null;
  currentProjectId: string | null;
  settingsProjectPath: string | null;
  projectGroupBy: 'workspace' | 'flat';
  projectOrderBy: 'manual' | 'updated';
  workspaceOrder: string[];
  sessionOrder: Record<string, string[]>;
  agentPermissions: Record<string, PermissionRequest[]>;
  expandedProjects: Set<string>;
  showAllSessions: Set<string>;
  renamingProjectId: string | null;
  renameProjectValue: string;
  onToggleProjectExpanded: (id: string) => void;
  onToggleShowAllSessions: (id: string) => void;
  onRenameStart: (id: string, value: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: string, value: string) => void;
  onRenameCancel: () => void;
  onStartSession: (path: string) => void;
  onOpenRoots: (project: Project) => void;
  onSelectAgent: (id: string) => void;
  renderSessionRow: (session: Session) => ReactNode;
  dragStateRef: { current: SiderDragState };
  dragOverKey: string | null;
  setDragOverKey: (key: string | null) => void;
}

export default function SiderCodePanel({
  sessions,
  projects,
  agents,
  currentAgentId,
  currentProjectId,
  settingsProjectPath,
  projectGroupBy,
  projectOrderBy,
  workspaceOrder,
  sessionOrder,
  agentPermissions,
  expandedProjects,
  showAllSessions,
  renamingProjectId,
  renameProjectValue,
  onToggleProjectExpanded,
  onToggleShowAllSessions,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onStartSession,
  onOpenRoots,
  onSelectAgent,
  renderSessionRow,
  dragStateRef,
  dragOverKey,
  setDragOverKey,
}: SiderCodePanelProps) {
  const t = useT();
  const { projectProfileMenu, applyProjectProfile, addProjectWorkspace } = useSiderProjectProfiles();

  const renderAgentRow = (a: AgentInfo) => (
    <AgentRow
      key={a.id}
      agent={a}
      isActive={a.id === currentAgentId}
      pendingCount={agentPermissions[a.id]?.length ?? 0}
      onSelect={onSelectAgent}
    />
  );

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

  const sortSessions = (key: string, list: Session[]) => orderSessionsByKey(key, list, sessionOrder, projectOrderBy);
  const projectList = orderedProjects(projects, workspaceOrder);
  const taskGroupMap = buildTaskGroups(agents);
  const taskGroups = [...taskGroupMap.entries()];
  const activeSessions = sessions.filter((s) => !s.archived);
  const archivedSessions = sessions.filter((s) => s.archived);
  const unassignedSessions = unassignedSessionsOf(activeSessions, projects);

  return (
    <div className="flex flex-col px-0 sider-code-panel">
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
          onClick={() => void addProjectWorkspace()}
          title={t('sidebar.addWorkspace')}
          aria-label={t('sidebar.addWorkspace')}
        >
          <FolderOpenOutlined size={16} />
        </button>
      </div>

      {projectGroupBy === 'flat' ? (
        <div className="flex flex-col gap-1 px-0 pb-1">
          {sortSessions('__flat__', activeSessions).length === 0 ? (
            <div className="px-[18px] py-2 text-2xs text-text-faint">{t('sidebar.noSessions')}</div>
          ) : (
            sortSessions('__flat__', activeSessions).map(renderSessionRow)
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
          {projectList.map((p) => {
            const isCurrent =
              p.id === currentProjectId || (settingsProjectPath !== null && p.path === settingsProjectPath);
            const projectTasks = taskGroupMap.get(p.path) ?? [];
            const count = activeSessions.filter((s) => s.projectRoot === p.path).length + projectTasks.length;
            const expanded = expandedProjects.has(p.id);
            const projectSessions = sortSessions(
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
                    if (dragged?.kind === 'workspace' && dragged.id !== p.id)
                      useProjectStore.getState().reorderWorkspace(dragged.id, p.id);
                    dragStateRef.current = null;
                    setDragOverKey(null);
                  }}
                  onDragEnd={() => {
                    dragStateRef.current = null;
                    setDragOverKey(null);
                  }}
                  data-drop-active={dragOverKey === `ws-${p.id}` || undefined}
                  onClick={() => {
                    onToggleProjectExpanded(p.id);
                    useProjectStore.getState().selectProject(p.id);
                    const store = useAgentStore.getState();
                    const active = store.agents.find((a) => a.id === store.currentAgentId);
                    if (active?.projectRoot && active.projectRoot !== p.path) store.setCurrentAgent(null);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={rowKey(() => {
                    onToggleProjectExpanded(p.id);
                    useProjectStore.getState().selectProject(p.id);
                    const store = useAgentStore.getState();
                    const active = store.agents.find((a) => a.id === store.currentAgentId);
                    if (active?.projectRoot && active.projectRoot !== p.path) store.setCurrentAgent(null);
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
                      onChange={(e) => onRenameChange(e.target.value)}
                      onBlur={() => onRenameCommit(p.id, renameProjectValue)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onRenameCommit(p.id, renameProjectValue);
                        if (e.key === 'Escape') onRenameCancel();
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
                              onStartSession(p.path);
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
                              onRenameStart(p.id, p.name);
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
                              onOpenRoots(p);
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
                          onCancel={(e) => e?.stopPropagation()}
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
                        onClick={() => onToggleShowAllSessions(p.id)}
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
}
