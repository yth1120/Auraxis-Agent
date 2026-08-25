import clsx from 'clsx';
import { useT } from '../../i18n';
import ExecutingIndicator from '../common/ExecutingIndicator';
import {
  CheckCircle as CheckCircleOutlined,
  XCircle as CloseCircleOutlined,
  Clock as ClockCircleOutlined,
  MinusCircle as MinusCircleOutlined,
} from '@/components/common/icons';
import type { AgentTask, TaskStatus } from '../../types/chat';

const ICON: Record<TaskStatus, React.ReactNode> = {
  pending: <ClockCircleOutlined />,
  running: <ExecutingIndicator size={14} />,
  done: <CheckCircleOutlined />,
  error: <CloseCircleOutlined />,
  skipped: <MinusCircleOutlined />,
};

function statusIconClass(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'text-primary';
    case 'done':
      return 'text-text-secondary';
    case 'error':
      return 'text-text-secondary';
    case 'pending':
    case 'skipped':
    default:
      return 'text-muted';
  }
}

function statusTitleClass(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'font-semibold text-primary';
    case 'done':
      return 'text-muted line-through';
    case 'error':
      return 'text-text-secondary';
    case 'pending':
      return 'text-secondary';
    case 'skipped':
      return 'text-muted';
    default:
      return 'text-primary';
  }
}

interface TaskChecklistProps {
  tasks: AgentTask[];
  activeTaskId?: string;
  /** When provided, rows become clickable (Phase 3 wires this to ToolCallTimeline). */
  onSelect?: (task: AgentTask) => void;
  /** When provided, unfinished rows get a 重做此步 action. */
  onRedo?: (task: AgentTask) => void;
}

/**
 * Plan-first execution timeline: renders the agent's TodoWrite checklist as a
 * persistent, glanceable progress list. Pure/presentational — data comes from
 * useInspectorStore.tasks via WorkspaceInspector.
 */
export default function TaskChecklist({ tasks, activeTaskId, onSelect, onRedo }: TaskChecklistProps) {
  const tPanel = useT();
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = Math.round((done / tasks.length) * 100);

  return (
    <section className="px-4 py-3 mb-3 rounded-xl bg-[var(--color-bg-secondary)]" aria-label={tPanel('checklist.aria')}>
      <header className="flex items-center justify-between mb-2">
        <span className="text-2xs font-semibold text-muted tracking-wide">{tPanel('checklist.title')}</span>
        <span className="text-2xs tabular-nums text-muted">
          {done}/{tasks.length}
        </span>
      </header>
      <div className="h-1 rounded-full bg-[var(--color-bg-inset)] overflow-hidden mb-2.5">
        <div className="h-full rounded-full bg-primary [transition:width_0.35s_ease]" style={{ width: `${pct}%` }} />
      </div>
      <ol className="list-none m-0 p-0 flex flex-col gap-[2px]">
        {tasks.map((t) => (
          <li
            key={t.id}
            className={clsx(
              'flex items-start gap-2 px-2 py-[6px] rounded-md border border-transparent',
              onSelect && 'cursor-pointer hover:bg-[var(--color-hover)]',
              t.id === activeTaskId && 'bg-primary-soft border-primary',
            )}
            data-status={t.status}
            onClick={onSelect ? () => onSelect(t) : undefined}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onKeyDown={onSelect ? (e) => (e.key === 'Enter' || e.key === ' ') && onSelect(t) : undefined}
          >
            <span className={clsx('text-sm leading-[18px] shrink-0', statusIconClass(t.status))}>{ICON[t.status]}</span>
            <span className="flex flex-col min-w-0">
              <span className={clsx('text-xs leading-[18px] break-words', statusTitleClass(t.status))}>{t.title}</span>
              {t.detail && <span className="text-2xs text-muted">{t.detail}</span>}
            </span>
            {onRedo && t.status !== 'done' && (
              <button
                type="button"
                className="ml-auto shrink-0 text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  onRedo(t);
                }}
                title={tPanel('checklist.redoTip')}
              >
                {tPanel('checklist.redo')}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
