import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Check } from '@/components/common/icons';

interface PresetPanelProps {
  /** a11y label for the menu role. */
  ariaLabel: string;
  title: string;
  /** Current selection, shown as quiet text on the header right. */
  current?: string;
  subtitle?: string;
  popDirection: 'up' | 'down';
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Shared popup shell for the composer preset pickers (execution tier & run
 * permission): a quiet minimal card — title + current value, hairline
 * dividers, tight option rows and a slim settings footer.
 */
export default function PresetPanel({
  ariaLabel,
  title,
  current,
  subtitle,
  popDirection,
  children,
  footer,
}: PresetPanelProps) {
  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      className={clsx(
        'flex flex-col w-[260px] p-1.5 bg-[var(--color-bg-elevated)] border border-[var(--color-border-dim)] rounded-[14px]',
        'shadow-[0_10px_32px_-8px_rgba(20,24,30,0.14)]',
        'opacity-0 translate-y-1',
        popDirection === 'down'
          ? 'animate-[smartPanelInDown_0.16s_ease_forwards]'
          : 'animate-[smartPanelInUp_0.16s_ease_forwards]',
      )}
    >
      <div className="flex items-baseline justify-between gap-3 px-2.5 pt-2 pb-1">
        <span className="text-[13px] leading-[18px] font-semibold text-text-primary tracking-[0.01em]">{title}</span>
        {current && <span className="min-w-0 truncate text-[11px] leading-[16px] text-text-muted">{current}</span>}
      </div>

      {subtitle && <p className="m-0 px-2.5 pb-1.5 text-[11px] leading-[15px] text-text-faint">{subtitle}</p>}

      <div className="mx-2 h-px bg-[var(--color-border-dim)]" />

      <div className="flex flex-col gap-0.5 px-1 py-1">{children}</div>

      {footer && (
        <>
          <div className="mx-2 h-px bg-[var(--color-border-dim)]" />
          <div className="flex flex-col gap-0.5 px-1 pt-1 pb-1">{footer}</div>
        </>
      )}
    </div>
  );
}

interface PresetOptionRowProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}

/** One preset row: plain icon, single-line title, check on active.
 *  Details live in the native tooltip (title) to keep the panel quiet. */
export function PresetOptionRow({ active, icon, label, title, onClick }: PresetOptionRowProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      title={title}
      className={clsx(
        'group flex items-center gap-2.5 w-full min-h-[36px] px-2.5 py-1 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-100',
        active ? 'bg-primary-soft' : 'hover:bg-[var(--color-hover)]',
      )}
      onClick={onClick}
    >
      <span
        className={clsx(
          'flex flex-none items-center justify-center w-4 shrink-0 transition-colors duration-100',
          active ? 'text-primary' : 'text-text-muted group-hover:text-text-secondary',
        )}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate text-[13px] leading-[18px] font-medium text-text-primary">{label}</span>
      {active && <Check size={14} className="shrink-0 text-primary" />}
    </button>
  );
}
