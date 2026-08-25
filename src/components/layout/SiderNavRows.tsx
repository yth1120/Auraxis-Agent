import { memo, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Popconfirm, Tooltip, Input, Dropdown } from 'antd';
import {
  CalendarCheck,
  Archive as ArchiveOutlined,
  CheckCircle as CheckCircleOutlined,
  ClipboardCheck,
  Clock as ClockCircleOutlined,
  XCircle as CloseCircleOutlined,
  Trash as DeleteOutlined,
  PencilSimple as EditOutlined,
  GitFork as ForkOutlined,
  FolderOpen as FolderOpenOutlined,
  MapPin,
  PauseCircle as PauseCircleOutlined,
  PlayCircle as PlayCircleOutlined,
  Blocks,
  Stop as StopOutlined,
  Wrench,
  NEW_CHAT_ICON,
} from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSessionStore, type Session } from '../../stores/useSessionStore';
import type { Project } from '../../stores/useProjectStore';
import clsx from 'clsx';
import { t, useT, type I18nKey } from '../../i18n';
import { getContentText } from '../../types/chat';
import type { AgentStatus } from '../../types/agent';
import ExecutingIndicator from '../common/ExecutingIndicator';

export const AGENT_STATUS_ICON: Record<AgentStatus, ReactNode> = {
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
export const AGENT_STATUS_COLOR: Record<string, string> = {
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
export const SIDEBAR_TOP_NAV: {
  key: 'new' | 'skills' | 'scheduled' | 'plugins';
  labelKey: I18nKey;
  icon: ReactNode;
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

export const rowKey = (fn: () => void) => (e: KeyboardEvent) => {
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
  onStartRename: (e: MouseEvent, id: string, title: string) => void;
  onChangeRename: (value: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onFork: (e: MouseEvent, id: string) => void;
  onArchive: (e: MouseEvent, id: string) => void;
  onMove: (id: string, path: string) => void;
  onDelete: (e: MouseEvent, id: string) => void;
  onDragStart?: (e: DragEvent, s: Session) => void;
  onDragOver?: (e: DragEvent, s: Session) => void;
  onDrop?: (e: DragEvent, s: Session) => void;
  onDragEnd?: () => void;
  dropActive?: boolean;
}

export const SessionRow = memo(function SessionRow({
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

export const AgentRow = memo(function AgentRow({ agent: a, isActive, pendingCount, onSelect }: AgentRowProps) {
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
