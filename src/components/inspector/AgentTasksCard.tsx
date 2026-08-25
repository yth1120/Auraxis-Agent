import clsx from 'clsx';
import { useT, type I18nKey } from '../../i18n';
import { useAgentStore } from '../../stores/useAgentStore';
import { AGENT_STATUS_META, formatElapsed } from './WorkspaceInspectorUtils';

export default function AgentTasksCard({ now }: { now: number }) {
  const tPanel = useT();
  const agents = useAgentStore((s) => s.agents);
  const currentAgentId = useAgentStore((s) => s.currentAgentId);

  return (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="flex items-center justify-between mb-1.5">
        <span className="text-2xs font-semibold text-text-muted tracking-wide">{tPanel('inspector.allTasks')}</span>
        <span className="text-2xs text-text-muted">
          {tPanel('inspector.runningCount', { n: agents.filter((a) => a.status === 'running').length })}
          {agents.filter((a) => a.status === 'queued').length > 0 &&
            ` · ${tPanel('inspector.queuedCount', { n: agents.filter((a) => a.status === 'queued').length })}`}
        </span>
      </header>
      <ul className="list-none m-0 p-0 flex flex-col gap-[2px]">
        {agents.map((agent) => {
          const meta = AGENT_STATUS_META[agent.status] ?? {
            labelKey: 'status.stopped' as I18nKey,
            cls: 'bg-[var(--color-text-faint)]',
          };
          const active = agent.id === currentAgentId;
          const busy = agent.status === 'running' || agent.status === 'paused' || agent.status === 'queued';
          return (
            <li
              key={agent.id}
              className={clsx(
                'flex items-center gap-2 px-2 py-[6px] rounded-md cursor-pointer hover:bg-[var(--color-hover)]',
                active && 'bg-primary-soft',
              )}
              onClick={() => useAgentStore.getState().setCurrentAgent(agent.id)}
            >
              <span className={clsx('shrink-0 w-1.5 h-1.5 rounded-full', meta.cls)} />
              <span
                className={clsx(
                  'flex-1 min-w-0 truncate text-xs',
                  active ? 'font-medium text-text-primary' : 'text-text-secondary',
                )}
              >
                {agent.description || agent.name}
              </span>
              <span className="shrink-0 text-2xs text-text-muted tabular-nums">
                {agent.status === 'running'
                  ? formatElapsed(Math.max(0, Math.floor((now - (agent.startTime || now)) / 1000)))
                  : tPanel(meta.labelKey)}
              </span>
              {busy && (
                <span className="shrink-0 flex items-center gap-0.5">
                  {agent.status === 'running' && (
                    <button
                      type="button"
                      className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAgentStore.getState().pauseAgent(agent.id);
                      }}
                    >
                      {tPanel('inspector.pause')}
                    </button>
                  )}
                  {agent.status === 'paused' && (
                    <button
                      type="button"
                      className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAgentStore.getState().resumeAgent(agent.id);
                      }}
                    >
                      {tPanel('inspector.resume')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      void useAgentStore.getState().stopAgent(agent.id);
                    }}
                  >
                    {tPanel('inspector.stop')}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
