import clsx from 'clsx';
import { CircleNotch } from './icons';

interface LoadingStateProps {
  label?: string;
  compact?: boolean;
  className?: string;
}

export default function LoadingState({ label, compact = false, className }: LoadingStateProps) {
  return (
    <div
      className={clsx('flex items-center justify-center gap-2 text-text-muted', compact ? 'py-3' : 'py-8', className)}
    >
      <CircleNotch size={14} className="ax-spin text-primary shrink-0" />
      {label ? <span className="text-xs leading-[18px]">{label}</span> : null}
    </div>
  );
}
