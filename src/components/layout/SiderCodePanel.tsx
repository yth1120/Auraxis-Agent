import { type ReactNode } from 'react';
import type { Project } from '../../stores/useProjectStore';
import type { Session } from '../../stores/useSessionStore';
import type { AgentInfo } from '../../types/agent';
import type { PermissionRequest } from '../../types/advanced';
import { AgentRow } from './SiderNavRows';
import { useT } from '../../i18n';
import { buildTaskGroups, orderedProjects, unassignedSessionsOf, orderSessionsByKey } from './SiderCodePanelData';
import { useSiderProjectProfiles } from './useSiderProjectProfiles';
import { SiderCodePanelHeader } from './SiderCodePanelHeader';
import { SiderCodeProjectRow } from './SiderCodeProjectRow';
import type { SiderDragState } from './SiderCodePanelTypes';

export type { SiderDragState } from './SiderCodePanelTypes';

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

  const sortSessions = (key: string, list: Session[]) => orderSessionsByKey(key, list, sessionOrder, projectOrderBy);
  const projectList = orderedProjects(projects, workspaceOrder);
  const taskGroupMap = buildTaskGroups(agents);
  const taskGroups = [...taskGroupMap.entries()];
  const activeSessions = sessions.filter((s) => !s.archived);
  const archivedSessions = sessions.filter((s) => s.archived);
  const unassignedSessions = unassignedSessionsOf(activeSessions, projects);

  return (
    <div className="flex flex-col px-0 sider-code-panel">
      <SiderCodePanelHeader
        projectGroupBy={projectGroupBy}
        projectOrderBy={projectOrderBy}
        onAddWorkspace={() => void addProjectWorkspace()}
      />

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
            const isCurrent =
              p.id === currentProjectId || (settingsProjectPath !== null && p.path === settingsProjectPath);

            return (
              <SiderCodeProjectRow
                key={p.id}
                project={p}
                isCurrent={isCurrent}
                count={count}
                expanded={expanded}
                renaming={renaming}
                renameValue={renameProjectValue}
                showAll={showAll}
                dragOverActive={dragOverKey === `ws-${p.id}`}
                projectSessions={projectSessions}
                visibleSessions={visibleSessions}
                projectTasks={projectTasks}
                renderSessionRow={renderSessionRow}
                renderAgentRow={renderAgentRow}
                dragStateRef={dragStateRef}
                setDragOverKey={setDragOverKey}
                projectProfileMenu={projectProfileMenu}
                onApplyProjectProfile={applyProjectProfile}
                onToggleProjectExpanded={onToggleProjectExpanded}
                onToggleShowAllSessions={onToggleShowAllSessions}
                onRenameStart={onRenameStart}
                onRenameChange={onRenameChange}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onStartSession={onStartSession}
                onOpenRoots={onOpenRoots}
              />
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
