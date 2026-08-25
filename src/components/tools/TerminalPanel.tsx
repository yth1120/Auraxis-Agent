import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import { ArrowClockwise, CaretDown, Eraser, Plus, Stop, TerminalWindow, X } from '@/components/common/icons';
import clsx from 'clsx';
import { useTerminalTasksStore } from '@/stores/useTerminalTasksStore';
import { useAgentStore } from '@/stores/useAgentStore';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '@/i18n';
import { AgentShellSurface, StatusIcon, TerminalSurface, statusLabel } from './TerminalPanelSurfaces';

export default function TerminalPanel({ onClose, paused }: { onClose?: () => void; paused?: boolean }) {
  const t = useT();
  const [sessionKey, setSessionKey] = useState(0);
  const [viewMode, setViewMode] = useState<'local' | 'agent'>('local');
  const [shellAgentId, setShellAgentId] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [, setTick] = useState(0);
  const clearRef = useRef<() => void>(() => {});
  const focusRef = useRef<() => void>(() => {});
  const termIdRef = useRef<string | null>(null);
  const tasks = useTerminalTasksStore((s) => s.tasks);
  const stopTask = useTerminalTasksStore((s) => s.stopTask);
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const currentAgent = useAgentStore((s) => s.agents.find((agent) => agent.id === s.currentAgentId));
  const agentCandidates = useAgentStore(
    useShallow((s) =>
      s.agents.filter((agent) => agent.status === 'running' || agent.status === 'queued' || agent.status === 'paused'),
    ),
  );
  const prevAgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevAgentIdRef.current === null) {
      prevAgentIdRef.current = currentAgentId;
      return;
    }
    if (prevAgentIdRef.current === currentAgentId) return;
    prevAgentIdRef.current = currentAgentId;
    if (currentAgentId) {
      setViewMode('agent');
      setShellAgentId(currentAgentId);
    } else {
      setViewMode('local');
      setShellAgentId(null);
    }
  }, [currentAgentId]);

  const registerClear = useCallback((fn: () => void) => {
    clearRef.current = fn;
  }, []);
  const registerFocus = useCallback((fn: () => void) => {
    focusRef.current = fn;
  }, []);
  const onReady = useCallback((id: string) => {
    termIdRef.current = id;
  }, []);

  const runningCount = tasks.filter((task) => task.status === 'running').length;
  useEffect(() => {
    if (runningCount === 0) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [runningCount]);

  const runInTerminal = (command: string) => {
    const api = window.electronAPI?.terminal;
    const id = termIdRef.current;
    if (!api || !id) return;
    focusRef.current();
    const line = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`;
    void api.input(id, line).then((result) => {
      if (!result.ok) setSessionKey((key) => key + 1);
    });
  };

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-1 shrink-0">
        <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-md bg-[var(--color-bg-inset)] text-primary">
          <TerminalWindow size={12} />
        </span>
        <span className="text-xs font-semibold text-text-primary">{t('terminal.title')}</span>
        {currentAgentId && (
          <div className="flex items-center gap-1 h-6">
            <button
              type="button"
              className={clsx(
                'flex-1 min-w-[56px] h-5 px-2 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                viewMode === 'local'
                  ? 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary',
              )}
              onClick={() => setViewMode('local')}
            >
              {t('terminal.local')}
            </button>
            <button
              type="button"
              className={clsx(
                'flex-1 min-w-[56px] h-5 px-2 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                viewMode === 'agent'
                  ? 'bg-[var(--color-bg-elevated)] text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary',
              )}
              onClick={() => setViewMode('agent')}
              title={
                currentAgent
                  ? t('terminal.persistentShellOf', { name: currentAgent.description || currentAgent.name })
                  : undefined
              }
            >
              {t('terminal.agentShell')}
            </button>
          </div>
        )}
        {runningCount > 0 && (
          <span className="inline-flex items-center h-4 px-1.5 rounded-full text-2xs font-medium bg-[var(--color-success-soft)] text-[var(--color-success)]">
            {t('terminal.running', { n: runningCount })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
            onClick={() => clearRef.current()}
            aria-label={t('terminal.clear')}
            title={t('terminal.clear')}
          >
            <Eraser size={12} />
          </button>
          <button
            type="button"
            className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
            onClick={() => setSessionKey((key) => key + 1)}
            aria-label={t('terminal.new')}
            title={t('terminal.new')}
          >
            <Plus size={12} />
          </button>
          {onClose && (
            <button
              type="button"
              className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={onClose}
              aria-label={t('terminal.close')}
              title={t('terminal.close')}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 gap-2">
        {viewMode === 'local' && tasks.length > 0 && (
          <div className="shrink-0 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 h-9">
              <button
                type="button"
                className="flex items-center gap-1.5 h-full cursor-pointer border-none bg-transparent"
                onClick={() => setTasksOpen((open) => !open)}
              >
                <CaretDown
                  size={12}
                  weight="bold"
                  className={`text-text-muted transition-transform duration-150 ${tasksOpen ? '' : '-rotate-90'}`}
                />
                <span className="text-2xs font-semibold text-text-secondary">{t('terminal.tasks')}</span>
                <span className="text-2xs text-text-faint tabular-nums">{tasks.length}</span>
              </button>
            </div>
            {tasksOpen && (
              <div className="max-h-[132px] overflow-y-auto border-t border-[var(--color-border-dim)]/60">
                {tasks.map((task, index) => {
                  const elapsed = task.status === 'running' ? Date.now() - task.startedAt : (task.durationMs ?? 0);
                  return (
                    <div
                      key={task.id}
                      className={clsx(
                        'flex items-center gap-2 px-3 h-8 hover:bg-[var(--color-hover)]',
                        index > 0 && 'border-t border-[var(--color-border-dim)]/40',
                      )}
                    >
                      <span className="shrink-0 flex items-center justify-center w-4">
                        <StatusIcon task={task} />
                      </span>
                      <Tooltip
                        placement="top"
                        mouseEnterDelay={0.4}
                        title={
                          <span className="block font-mono text-2xs whitespace-pre-wrap break-all">
                            {task.cwd ? `${task.cwd}\n${task.command}` : task.command}
                          </span>
                        }
                      >
                        <code className="flex-1 min-w-0 truncate font-mono text-xs text-[var(--color-text-secondary)]">
                          {task.command}
                        </code>
                      </Tooltip>
                      <span
                        className={`text-2xs shrink-0 font-mono ${
                          task.status === 'failed'
                            ? 'text-danger'
                            : task.status === 'running'
                              ? 'text-[var(--color-success)]'
                              : 'text-text-muted'
                        }`}
                      >
                        {statusLabel(t, task, elapsed)}
                      </span>
                      {task.status === 'running' && (
                        <button
                          type="button"
                          className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-danger-soft hover:text-danger shrink-0"
                          onClick={() => void stopTask(task.id)}
                          aria-label={t('composer.stopTask')}
                          title={t('composer.stopTask')}
                        >
                          <Stop size={12} weight="fill" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer border-none bg-transparent transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-secondary shrink-0"
                        onClick={() => runInTerminal(task.command)}
                        aria-label={t('terminal.runInTerminal')}
                        title={t('terminal.runInTerminal')}
                      >
                        <ArrowClockwise size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {viewMode === 'agent' && shellAgentId ? (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            {agentCandidates.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                {agentCandidates.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={clsx(
                      'max-w-[180px] truncate h-6 px-2.5 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                      shellAgentId === agent.id
                        ? 'bg-primary-soft text-primary'
                        : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                    )}
                    onClick={() => setShellAgentId(agent.id)}
                    title={`${agent.description || agent.name} · ${agent.status}`}
                  >
                    {agent.name.split(':')[1]?.trim() || agent.name}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 min-h-0">
              <AgentShellSurface agentId={shellAgentId} paused={paused} />
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            {window.electronAPI?.terminal ? (
              <TerminalSurface
                key={sessionKey}
                registerClear={registerClear}
                registerFocus={registerFocus}
                onReady={onReady}
                paused={paused}
              />
            ) : (
              <div className="flex items-center justify-center h-full rounded-xl border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] text-sm text-text-muted">
                {t('terminal.desktopOnly')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
