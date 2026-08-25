import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';

export interface TimelineTick {
  id: string;
  title?: string;
  summary: string;
  timestamp?: number;
  /** Index into the source list (used by the scrub callback). */
  index: number;
}

interface TimelineScrubberProps {
  /** One tick per user prompt — the anchors the rail navigates between. */
  ticks: TimelineTick[];
  /** Viewport top ratio (0..1) — drives the active-prompt highlight. */
  scrollRatio?: number;
  onScrubTo: (index: number, mode: 'click' | 'drag') => void;
  className?: string;
}

const MAX_DOTS = 50;
/** Hover must be held briefly before the flyout opens — the rail is a thin
 *  right-edge strip, so an instant pop on mouseover feels twitchy. */
const OPEN_DELAY_MS = 260;
const CLOSE_DELAY_MS = 180;

/**
 * Prompt Timeline Dock — VS Code "Sessions" prompt-timeline dock pattern.
 * At rest it is a quiet right-edge handle: one dot per user prompt (capped at
 * 50 with an overflow marker). Hover/click/arrow keys expand a flyout that
 * lists every prompt; Enter/Space or a click smooth-scrolls the transcript,
 * Escape dismisses, and the active prompt stays highlighted as you scroll.
 */
export default function TimelineScrubber({ ticks, scrollRatio = 0, onScrubTo, className }: TimelineScrubberProps) {
  const tScrub = useT();
  const railRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);

  const clearTimers = () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  };

  const scheduleOpen = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimers, []);

  const activeIndex = useMemo(() => {
    if (ticks.length === 0) return -1;
    return Math.min(ticks.length - 1, Math.max(0, Math.round(scrollRatio * (ticks.length - 1))));
  }, [ticks.length, scrollRatio]);

  const jump = useCallback(
    (i: number) => {
      const tick = ticks[i];
      if (!tick) return;
      onScrubTo(tick.index, 'click');
      setCursor(i);
      setOpen(false);
      clearTimers();
      railRef.current?.focus();
    },
    [ticks, onScrubTo],
  );

  // Keep the keyboard cursor visible inside the flyout.
  useEffect(() => {
    if (!open || cursor === null) return;
    const el = panelRef.current?.querySelector<HTMLElement>(`[data-tick-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      clearTimers();
      setCursor((c) => {
        const base = c ?? (activeIndex >= 0 ? activeIndex : 0);
        return e.key === 'ArrowDown' ? Math.min(ticks.length - 1, base + 1) : Math.max(0, base - 1);
      });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = cursor ?? activeIndex;
      if (target >= 0) jump(target);
    } else if (e.key === 'Escape') {
      setOpen(false);
      clearTimers();
      railRef.current?.focus();
    }
  };

  if (ticks.length === 0) return null;
  const dots = ticks.slice(0, MAX_DOTS);
  const overflow = ticks.length > MAX_DOTS;

  return (
    <div
      className={clsx('relative shrink-0 w-[22px] h-full z-20', className)}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={railRef}
        type="button"
        className="absolute right-[3px] top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 p-2 rounded-lg border-none bg-transparent text-inherit cursor-pointer hover:bg-[var(--color-hover)] focus-visible:outline-1 focus-visible:outline-[var(--color-primary-border)]"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tScrub('scrubber.aria')}
        onClick={() => {
          clearTimers();
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
      >
        {dots.map((t, i) => (
          <span
            key={t.id}
            className={clsx(
              'w-1 h-1 rounded-full bg-[var(--color-text-muted)] transition-opacity duration-100',
              i === activeIndex ? 'opacity-100' : 'opacity-55',
            )}
          />
        ))}
        {overflow && <span className="w-[2px] h-2 rounded-full bg-[var(--color-text-muted)] opacity-40" />}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label={tScrub('scrubber.listAria')}
          className="absolute right-full mr-1.5 top-1/2 -translate-y-1/2 w-[260px] max-h-[calc(100%-24px)] overflow-y-auto p-1 flex flex-col bg-[var(--color-bg-elevated)] border border-[var(--color-border-default)] rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          {ticks.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              data-tick-index={i}
              className={clsx(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md border-none text-left text-xs cursor-pointer',
                i === activeIndex
                  ? 'bg-[var(--color-primary-soft)] text-[var(--color-text-primary)]'
                  : 'bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]',
              )}
              onClick={() => jump(i)}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="flex-1 min-w-0 truncate">{t.summary || t.title || tScrub('scrubber.message')}</span>
              {t.timestamp != null && (
                <span className="shrink-0 text-2xs tabular-nums text-[var(--color-text-muted)]">
                  {new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
