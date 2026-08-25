import React from 'react';
import clsx from 'clsx';

interface SettingItemProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  noBorder?: boolean;
}

export default function SettingItem({ title, description, children, noBorder }: SettingItemProps) {
  return (
    <div
      className={clsx(
        'grid grid-cols-[minmax(150px,1fr)_minmax(220px,320px)] gap-6 items-center py-2.5',
        'max-[720px]:grid-cols-1 max-[720px]:gap-2',
        noBorder && 'pb-0',
      )}
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary leading-[1.4]">{title}</span>
        {description && <span className="text-xs leading-[1.4] text-muted">{description}</span>}
      </div>
      <div className="flex justify-end w-full max-[720px]:justify-start">{children}</div>
    </div>
  );
}
