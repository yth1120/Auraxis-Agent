import { useEffect, useRef } from 'react';
import { Check, ClockCounterClockwise, Stop, X } from '@/components/common/icons';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { TerminalTask } from '@/types/electron-api';
import { t, type I18nKey } from '@/i18n';

export function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function statusLabel(
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

export function StatusIcon({ task }: { task: TerminalTask }) {
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

function terminalTheme() {
  return {
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
  };
}

export function TerminalSurface({
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
    if (!paused) requestFitRef.current();
  }, [paused]);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.electronAPI?.terminal;
    if (!el || !api) return;

    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 1.45,
      cursorBlink: true,
      convertEol: true,
      theme: terminalTheme(),
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

    const unsubscribeData = api.onData(id, (data) => term.write(data));
    const unsubscribeExit = api.onExit(id, (info) => {
      term.write(`\r\n\x1b[90m${t('terminal.processExited', { code: info.exitCode })}\x1b[0m\r\n`);
    });
    const inputDisposable = term.onData((data) => {
      void api.input(id, data);
    });

    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
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

    const observer = new ResizeObserver(() => {
      if (pausedRef.current) return;
      requestFit();
    });
    observer.observe(el);

    registerClear(() => term.clear());

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      requestFitRef.current = () => {};
      observer.disconnect();
      inputDisposable.dispose();
      unsubscribeData();
      unsubscribeExit();
      void api.kill(id);
      term.dispose();
    };
  }, [onReady, registerClear, registerFocus]);

  return <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden border border-[var(--color-border-dim)]" />;
}

/** Read-only mirror of the selected agent's persistent shell session. */
export function AgentShellSurface({ agentId, paused }: { agentId: string; paused?: boolean }) {
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
      theme: terminalTheme(),
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
    void api.attach(agentId).then((result) => {
      if (disposed) return;
      if (!result.ok) {
        term.write(`\x1b[90m${result.error || t('terminal.noPersistentShell')}\x1b[0m\r\n`);
        return;
      }
      if (result.buffer) term.write(result.buffer);
      if (result.exited) term.write(`\r\n\x1b[90m${t('terminal.sessionExited')}\x1b[0m\r\n`);
    });
    const unsubscribeData = api.onData(agentId, (data) => term.write(data));
    const unsubscribeExit = api.onExit(agentId, () => {
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

    const observer = new ResizeObserver(() => {
      if (pausedRef.current) return;
      requestFit();
    });
    observer.observe(el);

    term.attachCustomKeyEventHandler((event) => {
      if (!event.ctrlKey) return true;
      const key = event.key.toLowerCase();
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
      observer.disconnect();
      unsubscribeData();
      unsubscribeExit();
      void api.detach(agentId);
      term.dispose();
    };
  }, [agentId]);

  return <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden border border-[var(--color-border-dim)]" />;
}
