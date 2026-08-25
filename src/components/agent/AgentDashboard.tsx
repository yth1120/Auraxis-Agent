import { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Button, Space, Tooltip, Progress, Popover, Badge, Select } from 'antd';
import {
  PlusCircle,
  Stop,
  PauseCircle,
  PlayCircle,
  CheckCircle,
  XCircle,
  Clock,
  ArrowsOut,
  Lightning,
  Code,
} from '@/components/common/icons';
import type { AgentInfo, AgentLogEntry } from '../../types/agent';
import { useAgentStore } from '../../stores/useAgentStore';
import clsx from 'clsx';
import { createAgent } from '../../constants/commands';
import EmptyState from '../common/EmptyState';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { useT, type I18nKey } from '../../i18n';

// ─── Status config ─────────────────────────────────────

const STATUS_CFG: Record<string, { color: string; icon: React.ReactNode; labelKey: I18nKey }> = {
  idle: { color: 'var(--text-muted)', icon: <Clock />, labelKey: 'status.idle' },
  queued: { color: 'var(--text-secondary)', icon: <Clock />, labelKey: 'status.queued' },
  running: { color: 'var(--accent)', icon: <ExecutingIndicator size={14} />, labelKey: 'status.running' },
  paused: { color: 'var(--warning)', icon: <PauseCircle />, labelKey: 'status.paused' },
  completed: { color: 'var(--success)', icon: <CheckCircle />, labelKey: 'status.completed' },
  error: { color: 'var(--danger)', icon: <XCircle />, labelKey: 'status.error' },
  stopped: { color: 'var(--warning)', icon: <PauseCircle />, labelKey: 'status.stopped' },
};

// ─── Elapsed timer hook ────────────────────────────────

function useElapsed(startTime: number, endTime?: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const base = endTime || Date.now();
    if (!endTime) {
      setElapsed((base - startTime) / 1000);
      const t = setInterval(() => setElapsed((Date.now() - startTime) / 1000), 1000);
      return () => clearInterval(t);
    }
    setElapsed((base - startTime) / 1000);
  }, [startTime, endTime]);
  return endTime ? elapsed : Math.max(0, elapsed);
}

// ─── Token formatter ──────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Mini event console entry renderer ────────────────

function EventLine({ entry }: { entry: AgentLogEntry }) {
  if (entry.type === 'tool_start') {
    const inputHint = entry.input ? Object.values(entry.input).join(' ').slice(0, 40) : '';
    return (
      <div className="flex items-center gap-1 text-2xs text-[var(--color-text-secondary)] leading-snug">
        <Lightning className="shrink-0 text-2xs text-[var(--color-text-muted)]" />
        <span className="font-mono font-medium whitespace-nowrap">{entry.toolName}</span>
        {inputHint && (
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-muted)] flex-1 min-w-0">
            {inputHint}
          </span>
        )}
      </div>
    );
  }
  if (entry.type === 'tool_end') {
    const dur = entry.durationMs != null ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
    return (
      <div className="flex items-center gap-1 text-2xs text-text-secondary leading-snug">
        <CheckCircle className="shrink-0 text-2xs" />
        <span className="font-mono font-medium whitespace-nowrap">{entry.toolName}</span>
        {dur && <span className="font-mono text-[var(--color-text-muted)] whitespace-nowrap">{dur}</span>}
      </div>
    );
  }
  if (entry.type === 'tool_error') {
    return (
      <div className="flex items-center gap-1 text-2xs text-text-secondary leading-snug">
        <XCircle className="shrink-0 text-2xs" />
        <span className="font-mono font-medium whitespace-nowrap">{entry.toolName}</span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-muted)] flex-1 min-w-0">
          {(entry.error || '').slice(0, 40)}
        </span>
      </div>
    );
  }
  return null;
}

// ─── AgentCard ─────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);
  const setAgentPriority = useAgentStore((s) => s.setAgentPriority);

  // ── Defensive: all fields fall back to safe defaults ──
  const id = agent?.id ?? '';
  const name = agent?.name ?? '-';
  const status = agent?.status ?? 'idle';
  const priority = agent?.priority ?? 'normal';
  const startTime = agent?.startTime ?? Date.now();
  const endTime = agent?.endTime;
  const toolCallCount = agent?.toolCallCount ?? 0;
  const iteration = agent?.iteration ?? 0;
  const maxIterations = agent?.maxIterations ?? 0;
  const error = agent?.error ?? '';
  const todos = agent?.plan?.todos || [];
  const totalIn = agent?.totalInputTokens ?? 0;
  const totalOut = agent?.totalOutputTokens ?? 0;
  const [showConsole, setShowConsole] = useState(false);

  const recentEvents = useMemo(() => {
    const log = agent?.log || [];
    return log.filter((e) => e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'tool_error').slice(-6);
  }, [agent?.log]);

  const elapsed = useElapsed(startTime, endTime);
  const cfg = STATUS_CFG[status] || STATUS_CFG.idle;
  const cfgLabel = t(cfg.labelKey);

  const doneCount = todos.filter((t) => t?.status === 'completed').length;
  const planPct = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;
  const activeTask = todos.find((t) => t?.status === 'in_progress');

  return (
    <Card
      size="small"
      className={clsx(
        'rounded-xl border border-[var(--color-border-dim)] shadow-xs transition-colors duration-200',
        status === 'running' && 'border-accent',
        status === 'error' && 'border-danger',
      )}
      title={
        <span className="flex items-center gap-2 text-sm">
          <Tooltip title={cfgLabel}>
            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: cfg.color }} />
          </Tooltip>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
        </span>
      }
      extra={
        <Space size={2}>
          <button
            type="button"
            onClick={() => {
              const next = priority === 'high' ? 'normal' : priority === 'normal' ? 'low' : 'high';
              setAgentPriority(id, next);
            }}
            className={clsx(
              'inline-flex items-center rounded-full h-5 px-1.5 text-2xs font-medium leading-none cursor-pointer border transition-colors duration-150',
              priority === 'high'
                ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)] border-[var(--color-danger-border)] hover:bg-[var(--color-danger-border)]'
                : priority === 'normal'
                  ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-border)] hover:bg-[var(--color-primary-strong)]'
                  : 'bg-[var(--color-bg-secondary)] text-text-secondary border-[var(--color-border-dim)] hover:bg-[var(--color-hover)]',
            )}
          >
            {priority === 'high'
              ? t('dashboard.priorityHigh')
              : priority === 'normal'
                ? t('dashboard.priorityMedium')
                : t('dashboard.priorityLow')}
          </button>
          <Tooltip title={t('dashboard.viewDetails')}>
            <Button type="text" size="small" icon={<ArrowsOut />} onClick={() => setExpanded(!expanded)} />
          </Tooltip>
          {status === 'running' && (
            <>
              <Tooltip title={t('dashboard.pause')}>
                <Button
                  type="text"
                  size="small"
                  icon={<PauseCircle />}
                  onClick={() => pauseAgent(id)}
                  aria-label={t('dashboard.pauseAgent')}
                />
              </Tooltip>
              <Tooltip title={t('dashboard.stop')}>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<Stop />}
                  onClick={() => stopAgent(id)}
                  aria-label={t('dashboard.stopAgent')}
                />
              </Tooltip>
            </>
          )}
          {status === 'paused' && (
            <Tooltip title={t('dashboard.resume')}>
              <Button
                type="text"
                size="small"
                icon={<PlayCircle />}
                onClick={() => resumeAgent(id)}
                aria-label={t('dashboard.resumeAgent')}
              />
            </Tooltip>
          )}
        </Space>
      }
    >
      <div className="flex flex-col gap-2">
        {/* Progress bar */}
        {todos.length > 0 && (
          <div className="flex items-center gap-2">
            <Progress
              percent={planPct}
              size="small"
              showInfo={false}
              status={status === 'running' ? 'active' : 'normal'}
            />
            <span className="text-xs text-[var(--color-text-muted)] font-mono whitespace-nowrap">
              {doneCount}/{todos.length}
            </span>
          </div>
        )}

        {/* Active task */}
        {activeTask && (
          <div className="text-xs text-text-secondary flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
            <ExecutingIndicator size={14} className="mr-1" />
            {activeTask.activeForm || activeTask.content}
          </div>
        )}

        {/* Meta row */}
        <div className="flex gap-3 text-xs text-[var(--color-text-secondary)]">
          <Tooltip title={t('dashboard.runtime')}>
            <span className="inline-flex items-center gap-1">
              <Clock /> {elapsed.toFixed(1)}s
            </span>
          </Tooltip>
          <Tooltip title={t('dashboard.tools')}>
            <span className="inline-flex items-center gap-1">
              <Lightning /> {toolCallCount}
            </span>
          </Tooltip>
          <span className="inline-flex items-center gap-1">
            {t('dashboard.rounds', { current: iteration, max: maxIterations })}
          </span>
          {(totalIn > 0 || totalOut > 0) && (
            <Tooltip title={t('dashboard.tokens', { in: totalIn.toLocaleString(), out: totalOut.toLocaleString() })}>
              <span className="font-mono text-2xs text-[var(--color-text-muted)] bg-[var(--color-bg-elevated)] px-1 py-px rounded-[5px]">
                {formatTokens(totalIn + totalOut)} tok
              </span>
            </Tooltip>
          )}
          {recentEvents.length > 0 && (
            <Tooltip title={showConsole ? t('dashboard.collapseEvents') : t('dashboard.expandEvents')}>
              <button
                className="border-none bg-transparent cursor-pointer inline-flex items-center text-2xs text-[var(--color-text-muted)] p-[1px_3px] rounded-[5px] transition-colors duration-fast ease-out hover:text-accent hover:bg-[var(--color-bg-elevated)]"
                onClick={() => setShowConsole(!showConsole)}
                aria-label={t('dashboard.eventsConsole')}
              >
                <Code />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Mini event console */}
        {showConsole && recentEvents.length > 0 && (
          <div className="mt-1 px-2 py-1 bg-[var(--color-bg-elevated)] rounded-md border border-[var(--color-border-dim)] max-h-[100px] overflow-y-auto flex flex-col gap-0.5">
            {recentEvents.map((entry, i) => (
              <EventLine key={i} entry={entry} />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-xs text-text-secondary bg-[var(--color-danger-soft)] px-2 py-1 rounded-md">
            {error.slice(0, 80)}
          </div>
        )}

        {/* Expanded detail */}
        {expanded && todos.length > 0 && (
          <div className="mt-1 pt-2 border-t border-[var(--color-border-dim)] flex flex-col gap-1">
            {todos.map((t, i) => (
              <div
                key={i}
                className={clsx(
                  'flex items-start gap-2 text-xs',
                  t?.status === 'pending' && 'text-[var(--color-text-muted)]',
                  t?.status === 'completed' && 'text-[var(--color-text-secondary)] line-through',
                  t?.status === 'in_progress' && 'text-[var(--color-text-primary)]',
                )}
              >
                <span
                  className={clsx(
                    'shrink-0 mt-1 text-xs',
                    t?.status === 'pending' && 'text-[var(--color-text-muted)]',
                    t?.status === 'completed' && 'text-text-secondary',
                    t?.status === 'in_progress' && 'text-text-primary',
                  )}
                >
                  {t?.status === 'completed' ? (
                    <CheckCircle />
                  ) : t?.status === 'in_progress' ? (
                    <ExecutingIndicator size={14} />
                  ) : (
                    <Clock />
                  )}
                </span>
                <span>{t?.content ?? '-'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Dashboard ─────────────────────────────────────────

export default function AgentDashboard() {
  const t = useT();
  const agents = useAgentStore((s) => s.agents || []);
  const stopAllAgents = useAgentStore((s) => s.stopAllAgents);
  const refreshStates = useAgentStore((s) => s.refreshStates);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);
  const setMaxConcurrent = useAgentStore((s) => s.setMaxConcurrent);
  const maxConcurrent = useAgentStore((s) => s.maxConcurrent);

  const [conflicts, setConflicts] = useState<{ filePath?: string; agentIds?: string[] }[]>([]);

  useEffect(() => {
    refreshStates();
    const t = setInterval(refreshStates, 5000);
    return () => clearInterval(t);
  }, [refreshStates]);

  // Poll for conflicts
  useEffect(() => {
    const check = () => {
      window.electronAPI?.conflict
        ?.getConflicts()
        .then((r) => {
          if (r.ok) setConflicts((r.data as { filePath?: string; agentIds?: string[] }[]) || []);
        })
        .catch((err) => {
          console.error('[AgentDashboard] getConflicts failed:', err?.message || err);
        });
    };
    check();
    const t = setInterval(check, 3000);
    return () => clearInterval(t);
  }, []);

  const handleNewAgent = useCallback(() => {
    createAgent({ name: `Agent ${(agents || []).length + 1}`, type: 'general-purpose' });
  }, [agents]);

  const activeCount = (agents || []).filter((a) => a?.status === 'running').length;
  const pausedCount = (agents || []).filter((a) => a?.status === 'paused').length;
  const queuedCount = (agents || []).filter((a) => a?.status === 'queued').length;
  const terminal = (agents || []).filter(
    (a) => a?.status === 'completed' || a?.status === 'error' || a?.status === 'stopped',
  );
  const completedCount = (agents || []).filter((a) => a?.status === 'completed').length;
  const totalTools = (agents || []).reduce((sum, a) => sum + (a?.toolCallCount || 0), 0);
  const goalCount = (agents || []).filter((a) => a?.goal).length;

  const handlePauseAll = () => (agents || []).filter((a) => a?.status === 'running').forEach((a) => pauseAgent(a.id));
  const handleResumeAll = () => (agents || []).filter((a) => a?.status === 'paused').forEach((a) => resumeAgent(a.id));

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
            onChange={(v) => setMaxConcurrent(v)}
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
                  {conflicts.map((c, i) => (
                    <div
                      key={i}
                      style={{
                        marginBottom: 6,
                        padding: '4px 0',
                        borderBottom: i < conflicts.length - 1 ? '1px solid var(--border-hairline)' : 'none',
                      }}
                    >
                      <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-danger)', fontWeight: 600 }}>
                        {c.filePath}
                      </div>
                      <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {t('dashboard.conflictBy', { agents: (c.agentIds || []).join(', ') })}
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

      {(agents || []).length > 0 && (
        <div className="grid grid-cols-4 gap-px px-3 py-2 border-b border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] shrink-0">
          {[
            [t('dashboard.taskTotal'), String((agents || []).length)],
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
        {(agents || []).length === 0 ? (
          <div className="flex justify-center py-10">
            <EmptyState title={t('agentDash.noRunning')} description={t('agentDash.multiAgentHint')} />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {(agents || []).map((agent) => (
              <AgentCard key={agent?.id ?? Math.random()} agent={agent} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
