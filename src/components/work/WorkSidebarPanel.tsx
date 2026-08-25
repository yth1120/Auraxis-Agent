import clsx from 'clsx';
import { ListChecks, ShieldCheck } from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { useT } from '../../i18n';
import type { AgentInfo } from '../../types/agent';
import { workProgress } from './workUtils';

const STATUS_DOT: Record<string, string> = {
  running: 'bg-primary',
  queued: 'bg-[var(--color-text-faint)]',
  paused: 'bg-warning',
  review: 'bg-warning',
  completed: 'bg-success',
  error: 'bg-danger',
  stopped: 'bg-[var(--color-text-faint)]',
};

function Row({ agent, active }: { agent: AgentInfo; active: boolean }) {
  const t = useT();
  const { pct } = workProgress(agent);
  const pending = useAgentStore((s) => (s.agentPermissions[agent.id] ?? []).length);

  return (
    <button
      type="button"
      onClick={() => useAgentStore.getState().setCurrentAgent(agent.id)}
      className={clsx(
        'flex flex-col gap-1 w-full min-w-0 px-2.5 py-2 rounded-xl text-left cursor-pointer transition-colors duration-150',
        active ? 'bg-primary-soft' : 'bg-transparent hover:bg-[var(--color-hover)]',
      )}
      data-active={active || undefined}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span
          className={clsx(
            'w-1.5 h-1.5 rounded-full shrink-0',
            STATUS_DOT[agent.status] ?? 'bg-[var(--color-text-faint)]',
          )}
        />
        <span
          className={clsx(
            'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs',
            active ? 'font-semibold text-text-primary' : 'font-medium text-text-secondary',
          )}
        >
          {agent.name || agent.description || '—'}
        </span>
        {pending > 0 && (
          <span
            className="shrink-0 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-warning-soft text-warning text-2xs font-semibold leading-none"
            title={t('work.pendingPerm', { n: pending })}
          >
            <ShieldCheck size={9} className="mr-0.5" />
            {pending}
          </span>
        )}
      </span>
      {agent.description && agent.description !== agent.name && (
        <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap pl-[10px] text-2xs text-text-muted">
          {agent.description}
        </span>
      )}
      <span className="flex items-center gap-1.5 pl-[10px]">
        <span className="flex-1 h-[3px] rounded-full bg-[var(--color-bg-inset)] overflow-hidden">
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
    </button>
  );
}

function Group({ title, items, currentAgentId }: { title: string; items: AgentInfo[]; currentAgentId: string | null }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-[18px] pt-2.5 pb-[5px] text-2xs font-semibold text-text-muted tracking-[0.06em]">{title}</div>
      <div className="flex flex-col gap-0.5 px-0">
        {items.map((a) => (
          <Row key={a.id} agent={a} active={a.id === currentAgentId} />
        ))}
      </div>
    </div>
  );
}

export default function WorkSidebarPanel() {
  const t = useT();
  const agents = useAgentStore((s) => s.agents.filter((a) => a.surface === 'work'));
  const currentAgentId = useAgentStore((s) => s.currentAgentId);

  const active = agents.filter((a) => a.status === 'running' || a.status === 'queued' || a.status === 'paused');
  const reviewing = agents.filter((a) => a.status === 'review');
  const done = agents.filter((a) => a.status === 'completed' || a.status === 'error' || a.status === 'stopped');

  return (
    <div className="flex flex-col px-0 sider-code-panel">
      <div className="shrink-0 flex items-center gap-1.5 px-[18px] pt-2.5 pb-[6px]">
        <ListChecks size={13} className="text-text-muted" />
        <span className="text-2xs font-semibold text-text-muted tracking-[0.06em]">{t('work.title')}</span>
      </div>
      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-transparent text-text-faint">
            <ListChecks size={16} />
          </span>
          <span className="text-2xs text-text-muted leading-[1.6]">{t('work.sidebar.empty')}</span>
        </div>
      ) : (
        <>
          <Group title={t('work.sidebar.active')} items={active} currentAgentId={currentAgentId} />
          <Group title={t('work.sidebar.review')} items={reviewing} currentAgentId={currentAgentId} />
          <Group title={t('work.sidebar.done')} items={done} currentAgentId={currentAgentId} />
        </>
      )}
    </div>
  );
}
