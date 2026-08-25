import { memo } from 'react';
import { useT } from '../../i18n';
import { useAgentStore } from '../../stores/useAgentStore';
import { useShallow } from 'zustand/react/shallow';
import { workDeliverables } from './workUtils';

/** Work 首页顶部概览：进行中 / 待审批 / 已完成 / 交付物，替代空白首屏。 */
export default memo(function WorkHomeOverview() {
  const t = useT();
  const agents = useAgentStore(useShallow((s) => s.agents.filter((a) => (a.surface ?? 'work') === 'work')));
  const agentPermissions = useAgentStore((s) => s.agentPermissions);

  const active = agents.filter((a) => a.status === 'running' || a.status === 'queued' || a.status === 'paused').length;
  const pending =
    agents.reduce((sum, a) => sum + (agentPermissions[a.id]?.length ?? 0), 0) +
    agents.filter((a) => a.status === 'review').length;
  const completed = agents.filter((a) => a.status === 'completed').length;
  const deliverables = agents.reduce((sum, a) => sum + workDeliverables(a).length, 0);

  const stats = [
    { label: t('work.home.active'), value: active },
    { label: t('work.home.pending'), value: pending },
    { label: t('work.home.completed'), value: completed },
    { label: t('work.home.deliverables'), value: deliverables },
  ];

  return (
    <div className="flex items-center gap-2">
      {stats.map((s) => (
        <span
          key={s.label}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-2xs text-text-secondary"
        >
          <span className="font-mono font-semibold text-text-primary tabular-nums">{s.value}</span>
          <span>{s.label}</span>
        </span>
      ))}
    </div>
  );
});
