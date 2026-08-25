import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CaretRight, ChatTeardropDots as MessageOutlined } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { Session } from '../../stores/useSessionStore';
import { groupSessionsByProject, groupSessionsByTime } from '../../utils/groupSessions';

export default function SiderChatPanel({
  collapsed,
  sessions,
  collapsedProjects,
  toggleProject,
  onSelectProject,
  renderSessionRow,
}: {
  collapsed: boolean;
  sessions: Session[];
  collapsedProjects: Set<string>;
  toggleProject: (key: string) => void;
  onSelectProject?: (path: string) => void;
  renderSessionRow: (session: Session) => ReactNode;
}) {
  const t = useT();
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
      {!collapsed && <div className="ax-sidebar-label !px-[18px] !pb-[6px]">{t('nav.chat')}</div>}
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
                    if (pg.projectRoot) onSelectProject?.(pg.projectRoot);
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
}
