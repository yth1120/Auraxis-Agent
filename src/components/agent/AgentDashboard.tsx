import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Popover, Select, Space } from 'antd';
import { Lightning, PauseCircle, PlayCircle, PlusCircle, Stop } from '@/components/common/icons';
import { useAgentStore } from '../../stores/useAgentStore';
import { createAgent } from '../../constants/commands';
import EmptyState from '../common/EmptyState';
import { useT } from '../../i18n';
import AgentCard from './AgentDashboardCard';

interface ConflictItem {
  filePath?: string;
  agentIds?: string[];
}

export default function AgentDashboard() {
  const t = useT();
  const agents = useAgentStore((s) => s.agents || []);
  const stopAllAgents = useAgentStore((s) => s.stopAllAgents);
  const refreshStates = useAgentStore((s) => s.refreshStates);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);
  const setMaxConcurrent = useAgentStore((s) => s.setMaxConcurrent);
  const maxConcurrent = useAgentStore((s) => s.maxConcurrent);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);

  useEffect(() => {
    refreshStates();
    const timer = setInterval(refreshStates, 5000);
    return () => clearInterval(timer);
  }, [refreshStates]);

  useEffect(() => {
    const check = () => {
      const api = window.electronAPI?.conflict;
      if (!api) return;
      api
        .getConflicts()
        .then((result) => {
          if (result.ok) setConflicts((result.data as ConflictItem[] | undefined) || []);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[AgentDashboard] getConflicts failed:', message);
        });
    };
    check();
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, []);

  const handleNewAgent = useCallback(() => {
    createAgent({ name: `Agent ${agents.length + 1}`, type: 'general-purpose' });
  }, [agents.length]);

  const activeCount = agents.filter((agent) => agent?.status === 'running').length;
  const pausedCount = agents.filter((agent) => agent?.status === 'paused').length;
  const queuedCount = agents.filter((agent) => agent?.status === 'queued').length;
  const terminal = agents.filter(
    (agent) => agent?.status === 'completed' || agent?.status === 'error' || agent?.status === 'stopped',
  );
  const completedCount = agents.filter((agent) => agent?.status === 'completed').length;
  const totalTools = agents.reduce((sum, agent) => sum + (agent?.toolCallCount || 0), 0);
  const goalCount = agents.filter((agent) => agent?.goal).length;

  const handlePauseAll = () =>
    agents.filter((agent) => agent?.status === 'running').forEach((agent) => pauseAgent(agent.id));
  const handleResumeAll = () =>
    agents.filter((agent) => agent?.status === 'paused').forEach((agent) => resumeAgent(agent.id));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border-dim)] shrink-0">
        <span className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
          <Lightning /> {t('dashboard.title')}
          {activeCount > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full h-5 px-1.5 text-2xs font-medium bg-[var(--color-violet-soft)] text-[var(--color-violet)] border border-[var(--color-violet-border)]">
              {t('dashboard.activeCount', { n: activeCount })}
            </span>
          )}
          {pausedCount > 0 && (
            <span className="ml-1 inline-flex items-center rounded-full h-5 px-1.5 text-2xs font-medium bg-[var(--color-warning-soft)] text-[var(--color-warning)] border border-[var(--color-warning-border)]">
              {t('dashboard.pausedCount', { n: pausedCount })}
            </span>
          )}
          {queuedCount > 0 && (
            <span className="ml-1 inline-flex items-center rounded-full h-5 px-1.5 text-2xs font-medium bg-[var(--color-bg-secondary)] text-text-secondary border border-[var(--color-border-dim)]">
              {t('dashboard.queuedCount', { n: queuedCount })}
            </span>
          )}
        </span>
        <Space size={4}>
          <Select
            size="small"
            value={maxConcurrent}
            style={{ width: 80 }}
            onChange={(value) => setMaxConcurrent(value)}
            options={[
              { value: 1, label: t('dashboard.concurrency', { n: 1 }) },
              { value: 2, label: t('dashboard.concurrency', { n: 2 }) },
              { value: 3, label: t('dashboard.concurrency', { n: 3 }) },
              { value: 5, label: t('dashboard.concurrency', { n: 5 }) },
              { value: 99, label: t('dashboard.unlimited') },
            ]}
          />
          <Button type="primary" size="small" icon={<PlusCircle />} onClick={handleNewAgent}>
            {t('dashboard.newAgent')}
          </Button>
          {activeCount > 0 && (
            <Button size="small" icon={<PauseCircle />} onClick={handlePauseAll}>
              {t('dashboard.pauseAll')}
            </Button>
          )}
          {pausedCount > 0 && (
            <Button size="small" icon={<PlayCircle />} onClick={handleResumeAll}>
              {t('dashboard.resumeAll')}
            </Button>
          )}
          {activeCount > 0 && (
            <Button size="small" danger icon={<Stop />} onClick={stopAllAgents}>
              {t('dashboard.stopAll')}
            </Button>
          )}
          {conflicts.length > 0 && (
            <Popover
              title={t('dashboard.fileConflict')}
              content={
                <div style={{ maxWidth: 300, fontSize: 12 }}>
                  {conflicts.map((conflict, index) => (
                    <div
                      key={index}
                      style={{
                        marginBottom: 6,
                        padding: '4px 0',
                        borderBottom: index < conflicts.length - 1 ? '1px solid var(--border-hairline)' : 'none',
                      }}
                    >
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-danger)', fontWeight: 600 }}>
                        {conflict.filePath}
                      </div>
                      <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {t('dashboard.conflictBy', { agents: (conflict.agentIds || []).join(', ') })}
                      </div>
                    </div>
                  ))}
                </div>
              }
            >
              <Badge count={conflicts.length} size="small" offset={[-4, 0]}>
                <Button size="small" icon={<Lightning style={{ color: 'var(--color-warning)' }} />}>
                  {t('dashboard.conflict')}
                </Button>
              </Badge>
            </Popover>
          )}
        </Space>
      </div>

      {agents.length > 0 && (
        <div className="grid grid-cols-4 gap-px px-3 py-2 border-b border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] shrink-0">
          {[
            [t('dashboard.taskTotal'), String(agents.length)],
            [
              t('dashboard.completionRate'),
              terminal.length > 0 ? `${Math.round((completedCount / terminal.length) * 100)}%` : '—',
            ],
            [t('dashboard.tools'), String(totalTools)],
            [t('dashboard.goalTasks'), String(goalCount)],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col items-center gap-0.5">
              <span className="text-sm font-semibold text-text-primary tabular-nums">{value}</span>
              <span className="text-2xs text-text-muted">{label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 pr-2">
        {agents.length === 0 ? (
          <div className="flex justify-center py-10">
            <EmptyState title={t('agentDash.noRunning')} description={t('agentDash.multiAgentHint')} />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {agents.map((agent) => (
              <AgentCard key={agent?.id ?? Math.random()} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
