import { useMemo, useState, type ReactNode } from 'react';
import { Input } from 'antd';
import ExecutingIndicator from '../common/ExecutingIndicator';
import {
  ArrowRight,
  CaretDown,
  Check as CheckIcon,
  Circle as CircleIcon,
  Clock,
  ListChecks,
  PencilSimple,
  WarningCircle,
  X,
} from '@/components/common/icons';
import clsx from 'clsx';
import { useChatStore } from '@/stores/useChatStore';
import { useAgentStore } from '@/stores/useAgentStore';
import type { AgentQueueItem } from '@/types/chat';
import GoalBar from './GoalBar';
import { useT, type I18nKey } from '@/i18n';

/**
 * Input dock: Todo bar → Goal bar → Queue bar, stacked above the
 * composer. Empty docks render nothing — strict-hide keeps the surface calm.
 */

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

const TODO_STATUS_LABEL_KEY: Record<TodoStatus, I18nKey> = {
  pending: 'dock.status.pending',
  in_progress: 'dock.status.inProgress',
  completed: 'dock.status.completed',
  blocked: 'dock.status.blocked',
};

const TODO_ORDER: TodoStatus[] = ['in_progress', 'pending', 'blocked', 'completed'];

function TodoIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckIcon className="text-text-secondary" />;
  if (status === 'in_progress') return <ExecutingIndicator size={14} />;
  if (status === 'blocked') return <WarningCircle className="!text-danger" />;
  return <CircleIcon className="text-text-faint" />;
}

function TodoDock() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const currentAgent = useAgentStore((s) => {
    if (!s.currentAgentId) return null;
    return s.agents.find((a) => a.id === s.currentAgentId) ?? null;
  });

  const todos = useMemo(() => {
    const planTodos = currentAgent?.plan?.todos;
    if (planTodos && planTodos.length > 0) return planTodos ?? [];
    const log = currentAgent?.log ?? [];
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry?.todos && entry.todos.length > 0) return entry.todos;
    }
    return [];
  }, [currentAgent]);

  const summary = useMemo(() => {
    const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, blocked: 0 };
    for (const t of todos) {
      const key = t.status as TodoStatus;
      if (key in counts) counts[key] += 1;
    }
    const parts = TODO_ORDER.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${t(TODO_STATUS_LABEL_KEY[k])}`);
    return parts.length > 0 ? parts.join(' · ') : t('dock.allDone');
  }, [todos, t]);

  if (todos.length === 0) return null;

  return (
    <div className="w-full max-w-[var(--content-max-width)] mx-auto mb-1.5">
      <div className="flex items-center gap-2 h-8 px-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
        <button
          type="button"
          className="flex flex-1 min-w-0 items-center gap-2 h-full border-none bg-transparent cursor-pointer text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <ListChecks size={14} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-xs font-medium text-text-primary">{t('dock.todo')}</span>
          <span className="flex-1 min-w-0 truncate text-xs text-text-muted">{summary}</span>
          <CaretDown
            size={12}
            className={clsx('shrink-0 text-text-faint transition-transform duration-150', open && 'rotate-180')}
          />
        </button>
      </div>
      {open && (
        <div className="mt-1 max-h-[180px] overflow-y-auto rounded-lg border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] px-3 py-1.5">
          {todos.map((t, i) => (
            <div key={`${i}-${t.content}`} className="flex items-start gap-2 py-1 text-xs">
              <span className="shrink-0 mt-[3px] text-xs">
                <TodoIcon status={t.status} />
              </span>
              <span
                className={clsx(
                  'flex-1 min-w-0 leading-relaxed text-text-secondary',
                  t.status === 'pending' && 'text-text-muted',
                  t.status === 'completed' && 'text-text-muted line-through',
                  t.status === 'in_progress' && 'text-text-primary font-medium',
                )}
              >
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  editing,
  editValue,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onSendNow,
}: {
  item: AgentQueueItem;
  editing: boolean;
  editValue: string;
  onStartEdit: () => void;
  onChangeEdit: (v: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onSendNow: () => void;
}) {
  const t = useT();
  if (editing) {
    return (
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <Input
          size="small"
          autoFocus
          value={editValue}
          onChange={(e) => onChangeEdit(e.target.value)}
          onPressEnter={onSaveEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancelEdit();
          }}
          onBlur={onSaveEdit}
          className="!text-xs"
        />
        <button
          type="button"
          className="ax-icon-button !w-6 !h-6 !text-xs"
          onClick={onSaveEdit}
          aria-label={t('dock.saveQueue')}
          title={t('dock.saveQueue')}
        >
          <CheckIcon />
        </button>
        <button
          type="button"
          className="ax-icon-button !w-6 !h-6 !text-xs"
          onClick={onCancelEdit}
          aria-label={t('dock.cancelEdit')}
          title={t('dock.cancelEdit')}
        >
          <X />
        </button>
      </div>
    );
  }

  return (
    <>
      <span className="flex-1 min-w-0 truncate text-xs text-text-secondary" title={item.text}>
        {item.text}
      </span>
      <span className="shrink-0 flex items-center gap-0.5">
        <TooltipButton label={t('dock.edit')} onClick={onStartEdit}>
          <PencilSimple />
        </TooltipButton>
        <TooltipButton label={t('dock.sendNow')} onClick={onSendNow}>
          <ArrowRight />
        </TooltipButton>
        <TooltipButton label={t('dock.delete')} onClick={onDelete}>
          <X />
        </TooltipButton>
      </span>
    </>
  );
}

function TooltipButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="ax-icon-button !w-6 !h-6 !text-xs"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function QueueDock({ onSendNow }: { onSendNow: (text: string) => void }) {
  const t = useT();
  const queue = useChatStore((s) => s.agentQueue);
  const dequeueAgentMessage = useChatStore((s) => s.dequeueAgentMessage);
  const editAgentQueueItem = useChatStore((s) => s.editAgentQueueItem);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  if (queue.length === 0) return null;

  const startEdit = (item: AgentQueueItem) => {
    setEditingId(item.id);
    setEditValue(item.text);
  };
  const saveEdit = (item: AgentQueueItem) => {
    editAgentQueueItem(item.id, editValue);
    setEditingId(null);
    setEditValue('');
  };

  const rows = (
    <div className={clsx(queue.length > 1 && 'max-h-[180px] overflow-y-auto')}>
      {queue.map((item) => (
        <div
          key={item.id}
          className={clsx('flex items-center gap-2 px-3 min-h-[32px] text-xs', queue.length > 1 && 'py-1')}
        >
          <QueueRow
            item={item}
            editing={editingId === item.id}
            editValue={editValue}
            onStartEdit={() => startEdit(item)}
            onChangeEdit={setEditValue}
            onSaveEdit={() => saveEdit(item)}
            onCancelEdit={() => {
              setEditingId(null);
              setEditValue('');
            }}
            onDelete={() => dequeueAgentMessage(item.id)}
            onSendNow={() => {
              dequeueAgentMessage(item.id);
              onSendNow(item.text);
            }}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="w-full max-w-[var(--content-max-width)] mx-auto mb-1.5">
      {queue.length === 1 ? (
        <div className="flex items-center gap-2 h-8 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
          {rows}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 h-8 px-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)]">
            <button
              type="button"
              className="flex flex-1 min-w-0 items-center gap-2 h-full border-none bg-transparent cursor-pointer text-left"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <Clock size={14} className="shrink-0 text-text-muted" />
              <span className="shrink-0 text-xs font-medium text-text-primary">
                {t('dock.queueCount', { n: queue.length })}
              </span>
              <CaretDown
                size={12}
                className={clsx('shrink-0 text-text-faint transition-transform duration-150', open && 'rotate-180')}
              />
            </button>
          </div>
          {open && (
            <div className="mt-1 rounded-lg border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] py-1">
              {rows}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function InputDock({ onSendNow }: { onSendNow: (text: string) => void }) {
  return (
    <div className="w-full">
      <TodoDock />
      <GoalBar />
      <QueueDock onSendNow={onSendNow} />
    </div>
  );
}
