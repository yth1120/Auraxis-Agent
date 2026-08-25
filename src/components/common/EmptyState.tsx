import type { ReactNode } from 'react';
import clsx from 'clsx';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
  className?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center px-6 py-12 text-center',
        compact && '!px-4 !py-6',
        className,
      )}
    >
      {icon && <div className="mb-3 opacity-75 [&_svg]:w-11 [&_svg]:h-11 [&_svg]:text-accent">{icon}</div>}
      <h3 className="font-heading text-lg font-semibold text-primary m-0 mb-1.5 tracking-tight">{title}</h3>
      <p className="text-sm text-muted m-0 mb-5 max-w-80 leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <button
          className="inline-flex items-center gap-2 h-8 bg-accent text-on-accent border-none rounded-md cursor-pointer font-body text-sm font-medium px-4 transition-colors duration-normal ease-out hover:bg-accent-hover"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
