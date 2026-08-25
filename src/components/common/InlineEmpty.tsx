import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Tray } from './icons';

interface InlineEmptyProps {
  description?: string;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}

export default function InlineEmpty({ description, icon, compact = false, className }: InlineEmptyProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-1.5 text-center',
        compact ? 'py-5 px-4' : 'py-8 px-4',
        className,
      )}
    >
      <span className="text-faint [&_svg]:w-5 [&_svg]:h-5">{icon ?? <Tray size={20} />}</span>
      {description ? <p className="m-0 text-xs leading-[1.6] text-muted max-w-72">{description}</p> : null}
    </div>
  );
}
