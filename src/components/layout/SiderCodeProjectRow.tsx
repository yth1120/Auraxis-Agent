import type { ReactNode } from 'react';
import { Dropdown, Input, Popconfirm, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import clsx from 'clsx';
import {
  Trash as DeleteOutlined,
  PencilSimple as EditOutlined,
  Folder as FolderOutlined,
  FolderOpen as FolderOpenOutlined,
  Plus as PlusOutlined,
  ShieldCheck,
} from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useProjectStore, type Project } from '../../stores/useProjectStore';
import type { Session } from '../../stores/useSessionStore';
import type { AgentInfo } from '../../types/agent';
import { rowKey } from './SiderNavRows';
import { useT } from '../../i18n';
import type { SiderDragState } from './SiderCodePanelTypes';

interface SiderCodeProjectRowProps {
  project: Project;
  isCurrent: boolean;
  count: number;
  expanded: boolean;
  renaming: boolean;
  renameValue: string;
  showAll: boolean;
  dragOverActive: boolean;
  projectSessions: Session[];
  visibleSessions: Session[];
  projectTasks: AgentInfo[];
  renderSessionRow: (session: Session) => ReactNode;
  renderAgentRow: (agent: AgentInfo) => ReactNode;
  dragStateRef: { current: SiderDragState };
  setDragOverKey: (key: string | null) => void;
  projectProfileMenu: (path: string) => MenuProps['items'];
  onApplyProjectProfile: (path: string, profileKey: string | null) => void;
  onToggleProjectExpanded: (id: string) => void;
  onToggleShowAllSessions: (id: string) => void;
  onRenameStart: (id: string, value: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: string, value: string) => void;
  onRenameCancel: () => void;
  onStartSession: (path: string) => void;
  onOpenRoots: (project: Project) => void;
}

export function SiderCodeProjectRow({
  project: p,
  isCurrent,
  count,
  expanded,
  renaming,
  renameValue,
  showAll,
  dragOverActive,
  projectSessions,
  visibleSessions,
  projectTasks,
  renderSessionRow,
  renderAgentRow,
  dragStateRef,
  setDragOverKey,
  projectProfileMenu,
  onApplyProjectProfile,
  onToggleProjectExpanded,
  onToggleShowAllSessions,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onStartSession,
  onOpenRoots,
}: SiderCodeProjectRowProps) {
  const t = useT();

  const activateProject = () => {
    onToggleProjectExpanded(p.id);
    useProjectStore.getState().selectProject(p.id);
    const store = useAgentStore.getState();
    const active = store.agents.find((a) => a.id === store.currentAgentId);
    if (active?.projectRoot && active.projectRoot !== p.path) store.setCurrentAgent(null);
  };

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
        data-drop-active={dragOverActive || undefined}
        onClick={activateProject}
        role="button"
        tabIndex={0}
        onKeyDown={rowKey(activateProject)}
        title={p.path}
      >
        <span className="ax-sidebar-icon">
          {expanded ? <FolderOpenOutlined size={16} /> : <FolderOutlined size={16} />}
        </span>
        {renaming ? (
          <Input
            size="small"
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={() => onRenameCommit(p.id, renameValue)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit(p.id, renameValue);
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
                    void onApplyProjectProfile(p.path, key === '__global__' ? null : key);
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
            <div className="pl-[10px] pr-[18px] py-2 text-2xs text-text-faint">{t('sidebar.noProjectSessions')}</div>
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
            <div className="sider-children-tasks mt-1 flex flex-col gap-0.5">{projectTasks.map(renderAgentRow)}</div>
          )}
        </div>
      )}
    </div>
  );
}
