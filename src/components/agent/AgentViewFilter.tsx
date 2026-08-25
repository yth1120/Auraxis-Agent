import clsx from 'clsx';
import { useMemo } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { AgentInfo } from '../../types/agent';
import { useT } from '../../i18n';

/** Shared 全部 / 仅失败 segmented control for agent execution views. */
export default function AgentViewFilter({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const agentErrorsOnly = useAppStore((s) => s.agentErrorsOnly);
  const setAgentErrorsOnly = useAppStore((s) => s.setAgentErrorsOnly);

  const failed = useMemo(() => {
    let count = 0;
    for (const e of agent.log) {
      if (e.type === 'tool_error') count += 1;
    }
    return count;
  }, [agent.log]);

  return (
    <div className="flex items-center rounded-full bg-[var(--color-bg-inset)] p-0.5">
      {(
        [
          ['all', t('agentFilter.all')],
          ['errors', `${t('agentFilter.errors')}${failed > 0 ? ` (${failed})` : ''}`],
        ] as const
      ).map(([key, label]) => {
        const active = key === 'errors' ? agentErrorsOnly : !agentErrorsOnly;
        return (
          <button
            key={key}
            type="button"
            className={clsx(
              'h-6 px-2.5 rounded-full text-xs font-medium border-none cursor-pointer transition-colors duration-150',
              active
                ? key === 'errors'
                  ? 'bg-danger-soft text-danger'
                  : 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                : 'text-text-muted bg-transparent hover:text-text-secondary',
            )}
            onClick={() => {
              setAgentErrorsOnly(key === 'errors');
            }}
            title={key === 'errors' ? t('agentFilter.title.errors') : t('agentFilter.title.all')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
