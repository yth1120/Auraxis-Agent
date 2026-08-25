import { useCallback, useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import {
  ArrowClockwise,
  CaretDown,
  Check,
  ClockCounterClockwise,
  Eraser,
  Plus,
  Stop,
  TerminalWindow,
  X,
} from '@/components/common/icons';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useTerminalTasksStore } from '@/stores/useTerminalTasksStore';
import { useAgentStore } from '@/stores/useAgentStore';
import type { TerminalTask } from '@/types/electron-api';
import { t, useT, type I18nKey } from '@/i18n';
import clsx from 'clsx';

function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function statusLabel(
  translate: (key: I18nKey, vars?: Record<string, string | number>) => string,
  task: TerminalTask,
  elapsedMs: number,
): string {
  switch (task.status) {
    case 'running':
      return formatDuration(elapsedMs);
    case 'success':
      return translate('terminal.status.exitCode0', { duration: formatDuration(task.durationMs) });
    case 'failed':
      return task.exitCode != null
        ? translate('terminal.status.exitCode', { duration: formatDuration(task.durationMs), code: task.exitCode })
        : formatDuration(task.durationMs);
    case 'stopped':
      return translate('terminal.status.stopped');
    case 'timeout':
      return translate('terminal.status.timeout');
  }
}

function StatusIcon({ task }: { task: TerminalTask }) {
  switch (task.status) {
    case 'running':
      return <ExecutingIndicator size={12} />;
    case 'success':
      return <Check size={12} className="text-[var(--color-success)] shrink-0" />;
    case 'failed':
      return <X size={12} className="text-danger shrink-0" />;
    case 'stopped':
      return <Stop size={12} weight="fill" className="text-text-muted shrink-0" />;
    case 'timeout':
      return <ClockCounterClockwise size={12} className="text-warning shrink-0" />;
  }
}

function TerminalSurface({
  registerClear,
  registerFocus,
  onReady,
  paused,
}: {
  registerClear: (fn: () => void) => void;
  registerFocus: (fn: () => void) => void;
  onReady: (id: string) => void;
  paused?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const requestFitRef = useRef<() => void>(() => {});

  useEffect(() => {
    pausedRef.current = paused;
    // Sizes observed while paused were skipped, so the ResizeObserver will
    // not necessarily fire again once the drag/settle ends. Explicitly refit
    // so the terminal never stays at a stale row/col grid.
    if (!paused) requestFitRef.current();
  }, [paused]);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.electronAPI?.terminal;
    if (!el || !api) return;

    // A fresh id per effect run: React StrictMode (dev) mounts → unmounts →
    // remounts the same component, and reusing one id made the killed first
    // session's late onExit tear down the live second session.
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.45,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#111216',
        foreground: '#F1F1EE',
        cursor: '#F1F1EE',
        selectionBackground: 'rgba(241,241,238,0.32)',
        black: '#111216',
        brightBlack: '#6F727A',
        red: '#F87171',
        green: '#34D399',
        yellow: '#FBBF24',
        blue: '#6C8CFF',
        magenta: '#C084FC',
        cyan: '#38BDF8',
        white: '#F1F1EE',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* size measurement race */
    }

    const cwd = useSettingsStore.getState().projectPath || undefined;
    void api.create({ id, cwd, cols: term.cols, rows: term.rows });
    onReady(id);
    registerFocus(() => term.focus());

    const unsubData = api.onData(id, (data) => term.write(data));
    const unsubExit = api.onExit(id, (info) => {
      term.write(`\r\n\x1b[90m${t('terminal.processExited', { code: info.exitCode })}\x1b[0m\r\n`);
    });
    const inputDisposable = term.onData((data) => {
      void api.input(id, data);
    });

    // Ctrl/Cmd+Shift+V → paste from the system clipboard.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) void api.input(id, text);
          })
          .catch(() => {
            /* clipboard denied */
          });
        return false;
      }
      return true;
    });

    // Coalesce rapid resize events (e.g. dragging the drawer) to one pass per
    // frame, and only round-trip IPC when the cell grid actually changed —
    // otherwise every pointermove triggers a fit + resize churn that shows
    // up as continuous flicker in the terminal surface.
    let rafId: number | null = null;
    let lastCols = -1;
    let lastRows = -1;
    const requestFit = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          fit.fit();
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            void api.resize(id, term.cols, term.rows);
          }
        } catch {
          /* hidden */
        }
      });
    };
    requestFitRef.current = requestFit;

    const ro = new ResizeObserver(() => {
      // While the user drags the drawer (or it animates open/closed), the
      // size changes every frame — refitting the xterm canvas per frame
      // clears and repaints it continuously, which reads as flicker. Skip
      // the work; the final size is applied when pause is released.
      if (pausedRef.current) return;
      requestFit();
    });
    ro.observe(el);

    registerClear(() => term.clear());

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      requestFitRef.current = () => {};
      ro.disconnect();
      inputDisposable.dispose();
      unsubData();
      unsubExit();
      void api.kill(id);
      term.dispose();
    };
  }, [onReady, registerClear, registerFocus]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full rounded-xl overflow-hidden border border-[var(--color-border-dim)]"
    />
  );
}

/** Read-only mirror of the selected agent's persistent shell session. */
function AgentShellSurface({ agentId, paused }: { agentId: string; paused?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const requestFitRef = useRef<() => void>(() => {});

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) requestFitRef.current();
  }, [paused]);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.electronAPI?.agentShell;
    if (!el || !api) return;

    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.45,
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#111216',
        foreground: '#F1F1EE',
        cursor: '#F1F1EE',
        selectionBackground: 'rgba(241,241,238,0.32)',
        black: '#111216',
        brightBlack: '#6F727A',
        red: '#F87171',
        green: '#34D399',
        yellow: '#FBBF24',
        blue: '#6C8CFF',
        magenta: '#C084FC',
        cyan: '#38BDF8',
        white: '#F1F1EE',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* size measurement race */
    }

    let disposed = false;
    void api.attach(agentId).then((r) => {
      if (disposed) return;
      if (!r.ok) {
        term.write(`\x1b[90m${r.error || t('terminal.noPersistentShell')}\x1b[0m\r\n`);
        return;
      }
      if (r.buffer) term.write(r.buffer);
      if (r.exited) term.write(`\r\n\x1b[90m${t('terminal.sessionExited')}\x1b[0m\r\n`);
    });
    const unsubData = api.onData(agentId, (data) => term.write(data));
    const unsubExit = api.onExit(agentId, () => {
      term.write(`\r\n\x1b[90m${t('terminal.agentShellExited')}\x1b[0m\r\n`);
    });

    let rafId: number | null = null;
    const requestFit = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
    };
    requestFitRef.current = requestFit;

    const ro = new ResizeObserver(() => {
      if (pausedRef.current) return;
      requestFit();
    });
    ro.observe(el);

    // Read-only: only control characters reach the session (Ctrl-C / Ctrl-Z /
    // Ctrl-D), so the user can interrupt a runaway command without typing.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c') {
        void api.write(agentId, '\x03');
        return false;
      }
      if (key === 'z') {
        void api.write(agentId, '\x1a');
        return false;
      }
      if (key === 'd') {
        void api.write(agentId, '\x04');
        return false;
      }
      return true;
    });

    return () => {
      disposed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      requestFitRef.current = () => {};
      ro.disconnect();
      unsubData();
      unsubExit();
      void api.detach(agentId);
      term.dispose();
    };
  }, [agentId]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full rounded-xl overflow-hidden border border-[var(--color-border-dim)]"
    />
  );
}

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
  const currentAgent = useAgentStore((s) => s.agents.find((a) => a.id === s.currentAgentId));
  const agentCandidates = useAgentStore((s) =>
    s.agents.filter((a) => a.status === 'running' || a.status === 'queued' || a.status === 'paused'),
  );
  const prevAgentIdRef = useRef<string | null>(null);

  // Auto-follow only after the drawer is already open: selecting an agent
  // shows its persistent shell; leaving agent mode returns to the local
  // terminal. On the initial mount we always stay on the interactive local
  // terminal — never surprise the user with a read-only agent mirror where
  // typing appears to do nothing. Manual toggles stay untouched.
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

  const runningCount = tasks.filter((t) => t.status === 'running').length;
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
    void api.input(id, line).then((r) => {
      // Terminal session already exited — recreate it so the replay works.
      if (!r.ok) setSessionKey((k) => k + 1);
    });
  };

  return (
    <div className="h-full w-full flex flex-col">
      {/* ── Header: icon · title · mode · actions ── */}
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
            onClick={() => setSessionKey((k) => k + 1)}
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

      {/* ── Body: task list + terminal surface ── */}
      <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 gap-2">
        {viewMode === 'local' && tasks.length > 0 && (
          <div className="shrink-0 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 h-9">
              <button
                type="button"
                className="flex items-center gap-1.5 h-full cursor-pointer border-none bg-transparent"
                onClick={() => setTasksOpen((v) => !v)}
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
                {tasks.map((task, i) => {
                  const elapsed = task.status === 'running' ? Date.now() - task.startedAt : (task.durationMs ?? 0);
                  return (
                    <div
                      key={task.id}
                      className={clsx(
                        'flex items-center gap-2 px-3 h-8 hover:bg-[var(--color-hover)]',
                        i > 0 && 'border-t border-[var(--color-border-dim)]/40',
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
                        className={`text-2xs shrink-0 font-mono ${task.status === 'failed' ? 'text-danger' : task.status === 'running' ? 'text-[var(--color-success)]' : 'text-text-muted'}`}
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
                {agentCandidates.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={clsx(
                      'max-w-[180px] truncate h-6 px-2.5 rounded-full text-2xs font-medium border-none cursor-pointer transition-colors duration-150',
                      shellAgentId === a.id
                        ? 'bg-primary-soft text-primary'
                        : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
                    )}
                    onClick={() => setShellAgentId(a.id)}
                    title={`${a.description || a.name} · ${a.status}`}
                  >
                    {a.name.split(':')[1]?.trim() || a.name}
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
