import { useState } from 'react';
import { Archive, CaretDown } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { CompactionData } from '@/types/chat';

/**
 * Compaction checkpoint row: a folded "上下文已压缩" marker sits
 * at its position in the message flow — it never replaces the transcript.
 */
export default function CompactionRow({ data }: { data: CompactionData }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const saved = data.tokensSaved ?? Math.max(0, data.tokensBefore - data.tokensAfter);

  return (
    <div className="my-1 w-full max-w-[var(--content-max-width,880px)] mx-auto px-0.5">
      <button
        type="button"
        className="flex items-center gap-2 h-8 w-full px-3 rounded-lg bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] text-left cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('compact.aria')}
      >
        <Archive size={14} className="shrink-0 text-text-muted" />
        <span className="shrink-0 text-xs font-medium text-text-primary">{t('compact.title')}</span>
        <span className="flex-1 min-w-0 truncate text-2xs text-text-muted">
          {data.messagesRemoved != null
            ? t('compact.summary', { n: data.messagesRemoved, tokens: saved.toLocaleString() })
            : t('compact.freedOnly', { tokens: saved.toLocaleString() })}{' '}
          · {Math.round(data.tokensBefore / 1000)}K → {Math.round(data.tokensAfter / 1000)}K
        </span>
        <CaretDown
          size={12}
          className={clsx('shrink-0 text-text-faint transition-transform duration-150', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="mt-1 rounded-lg border border-[var(--color-border-dim)] bg-[var(--color-bg-inset)] px-3 py-2 text-2xs text-text-muted leading-relaxed flex flex-col gap-0.5">
          {data.messagesRemoved != null && <span>{t('compact.replaced', { n: data.messagesRemoved })}</span>}
          <span>{t('compact.freed', { n: saved.toLocaleString() })}</span>
          <span>
            {t('compact.range', {
              before: data.tokensBefore.toLocaleString(),
              after: data.tokensAfter.toLocaleString(),
            })}
          </span>
          <span className="text-text-faint">{t('compact.note')}</span>
        </div>
      )}
    </div>
  );
}
