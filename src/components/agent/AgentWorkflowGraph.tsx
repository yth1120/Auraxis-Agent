import { useMemo } from 'react';
import clsx from 'clsx';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { Check, Clock, WarningCircle } from '@/components/common/icons';
import type { AgentPlan } from '../../types/agent';
import { useT, type I18nKey } from '../../i18n';

type TodoItem = { content: string; status: string; activeForm?: string };

const STATUS_ICON: Record<string, React.ReactNode> = {
  pending: <Clock size={12} />,
  in_progress: <ExecutingIndicator size={12} />,
  completed: <Check size={12} />,
  verified: <Check size={12} />,
  blocked: <WarningCircle size={12} />,
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'workflow.status.pending',
  in_progress: 'workflow.status.in_progress',
  completed: 'workflow.status.completed',
  verified: 'workflow.status.verified',
  blocked: 'workflow.status.blocked',
};

function statusTone(status: string): string {
  switch (status) {
    case 'in_progress':
      return 'bg-primary-soft text-primary border-primary-border';
    case 'completed':
    case 'verified':
      return 'bg-success-soft text-success border-success-soft';
    case 'blocked':
      return 'bg-danger-soft text-danger border-danger-border';
    default:
      return 'bg-[var(--color-bg-secondary)] text-text-muted border-border-dim';
  }
}

interface Props {
  plan: AgentPlan | null;
  onTaskClick?: (taskId: string) => void;
}

/**
 * 垂直步骤流: a scannable plan with state dots, connecting
 * lines and a progress summary. Replaces the old ReactFlow DAG, which read as
 * heavy machinery instead of an execution story.
 */
export default function AgentWorkflowGraph({ plan, onTaskClick }: Props) {
  const t = useT();
  const todos = useMemo<TodoItem[]>(() => plan?.todos ?? [], [plan]);
  if (todos.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-muted)]">
        {t('workflow.empty')}
      </div>
    );
  }

  const done = todos.filter((todo) => todo.status === 'completed' || todo.status === 'verified').length;
  const pct = Math.round((done / todos.length) * 100);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 px-1 pb-2 shrink-0">
        <div className="flex-1 h-1 rounded-full bg-[var(--color-bg-inset)] overflow-hidden">
          <div className="h-full rounded-full bg-primary [transition:width_0.35s_ease]" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-2xs text-text-muted tabular-nums shrink-0">
          {done}/{todos.length}
        </span>
      </div>

      <ol className="list-none m-0 p-0 flex-1 min-h-0 overflow-y-auto pr-1">
        {todos.map((todo, index) => {
          const status = todo.status || 'pending';
          const active = status === 'in_progress';
          return (
            <li
              key={index}
              className={clsx('relative flex gap-2.5 min-h-[44px]', onTaskClick && 'cursor-pointer')}
              onClick={onTaskClick ? () => onTaskClick(String(index)) : undefined}
              role={onTaskClick ? 'button' : undefined}
              tabIndex={onTaskClick ? 0 : undefined}
              onKeyDown={
                onTaskClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onTaskClick(String(index)) : undefined
              }
            >
              <div className="flex flex-col items-center shrink-0">
                <span
                  className={clsx('flex items-center justify-center w-6 h-6 rounded-full border', statusTone(status))}
                >
                  {STATUS_ICON[status] ?? STATUS_ICON.pending}
                </span>
                {index < todos.length - 1 && <span className="w-px flex-1 my-0.5 bg-[var(--color-border-default)]" />}
              </div>
              <div className={clsx('flex flex-col min-w-0 pt-[2px] pb-2')}>
                <span
                  className={clsx(
                    'text-xs leading-[20px] break-words',
                    active ? 'font-semibold text-primary' : 'text-text-secondary',
                    status === 'completed' || status === 'verified' ? 'text-text-muted' : '',
                  )}
                >
                  {todo.content}
                </span>
                <span className="text-2xs text-text-faint">
                  {STATUS_LABEL[status] ? t(STATUS_LABEL[status] as I18nKey) : status}
                  {todo.activeForm && active ? ` · ${todo.activeForm}` : ''}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
