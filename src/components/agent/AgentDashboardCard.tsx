import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Progress, Space, Tooltip } from 'antd';
import clsx from 'clsx';
import {
  ArrowsOut,
  CheckCircle,
  Clock,
  Code,
  Lightning,
  PauseCircle,
  PlayCircle,
  Stop,
  XCircle,
} from '@/components/common/icons';
import type { AgentInfo, AgentLogEntry } from '../../types/agent';
import { useAgentStore } from '../../stores/useAgentStore';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { useT, type I18nKey } from '../../i18n';

const STATUS_CFG: Record<string, { color: string; icon: React.ReactNode; labelKey: I18nKey }> = {
  idle: { color: 'var(--text-muted)', icon: <Clock />, labelKey: 'status.idle' },
  queued: { color: 'var(--text-secondary)', icon: <Clock />, labelKey: 'status.queued' },
  running: { color: 'var(--accent)', icon: <ExecutingIndicator size={14} />, labelKey: 'status.running' },
  paused: { color: 'var(--warning)', icon: <PauseCircle />, labelKey: 'status.paused' },
  completed: { color: 'var(--success)', icon: <CheckCircle />, labelKey: 'status.completed' },
  error: { color: 'var(--danger)', icon: <XCircle />, labelKey: 'status.error' },
  stopped: { color: 'var(--warning)', icon: <PauseCircle />, labelKey: 'status.stopped' },
};

function useElapsed(startTime: number, endTime?: number): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const base = endTime || Date.now();
    if (!endTime) {
      setElapsed((base - startTime) / 1000);
      const timer = setInterval(() => setElapsed((Date.now() - startTime) / 1000), 1000);
      return () => clearInterval(timer);
    }
    setElapsed((base - startTime) / 1000);
  }, [startTime, endTime]);
  return endTime ? elapsed : Math.max(0, elapsed);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

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
    const duration = entry.durationMs != null ? `${(entry.durationMs / 1000).toFixed(1)}s` : '';
    return (
      <div className="flex items-center gap-1 text-2xs text-text-secondary leading-snug">
        <CheckCircle className="shrink-0 text-2xs" />
        <span className="font-mono font-medium whitespace-nowrap">{entry.toolName}</span>
        {duration && <span className="font-mono text-[var(--color-text-muted)] whitespace-nowrap">{duration}</span>}
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

export default function AgentCard({ agent }: { agent: AgentInfo }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const pauseAgent = useAgentStore((s) => s.pauseAgent);
  const resumeAgent = useAgentStore((s) => s.resumeAgent);
  const setAgentPriority = useAgentStore((s) => s.setAgentPriority);

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
    return log
      .filter((entry) => entry.type === 'tool_start' || entry.type === 'tool_end' || entry.type === 'tool_error')
      .slice(-6);
  }, [agent?.log]);

  const elapsed = useElapsed(startTime, endTime);
  const config = STATUS_CFG[status] || STATUS_CFG.idle;
  const configLabel = t(config.labelKey);

  const doneCount = todos.filter((todo) => todo?.status === 'completed').length;
  const planPct = todos.length > 0 ? Math.round((doneCount / todos.length) * 100) : 0;
  const activeTask = todos.find((todo) => todo?.status === 'in_progress');

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
          <Tooltip title={configLabel}>
            <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: config.color }} />
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
        {activeTask && (
          <div className="text-xs text-text-secondary flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
            <ExecutingIndicator size={14} className="mr-1" />
            {activeTask.activeForm || activeTask.content}
          </div>
        )}
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
        {showConsole && recentEvents.length > 0 && (
          <div className="mt-1 px-2 py-1 bg-[var(--color-bg-elevated)] rounded-md border border-[var(--color-border-dim)] max-h-[100px] overflow-y-auto flex flex-col gap-0.5">
            {recentEvents.map((entry, index) => (
              <EventLine key={index} entry={entry} />
            ))}
          </div>
        )}
        {error && (
          <div className="text-xs text-text-secondary bg-[var(--color-danger-soft)] px-2 py-1 rounded-md">
            {error.slice(0, 80)}
          </div>
        )}
        {expanded && todos.length > 0 && (
          <div className="mt-1 pt-2 border-t border-[var(--color-border-dim)] flex flex-col gap-1">
            {todos.map((todo, index) => (
              <div
                key={index}
                className={clsx(
                  'flex items-start gap-2 text-xs',
                  todo?.status === 'pending' && 'text-[var(--color-text-muted)]',
                  todo?.status === 'completed' && 'text-[var(--color-text-secondary)] line-through',
                  todo?.status === 'in_progress' && 'text-[var(--color-text-primary)]',
                )}
              >
                <span
                  className={clsx(
                    'shrink-0 mt-1 text-xs',
                    todo?.status === 'pending' && 'text-[var(--color-text-muted)]',
                    todo?.status === 'completed' && 'text-text-secondary',
                    todo?.status === 'in_progress' && 'text-text-primary',
                  )}
                >
                  {todo?.status === 'completed' ? (
                    <CheckCircle />
                  ) : todo?.status === 'in_progress' ? (
                    <ExecutingIndicator size={14} />
                  ) : (
                    <Clock />
                  )}
                </span>
                <span>{todo?.content ?? '-'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
