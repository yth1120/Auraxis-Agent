import { useState } from 'react';
import { BookmarkSimple, CaretDown, FileText } from '@/components/common/icons';
import clsx from 'clsx';
import type { ContextDisclosure } from '@/types/chat';
import { useT, type I18nKey } from '../../i18n';

const ROLE_LABEL: Record<ContextDisclosure['source'], I18nKey> = {
  instructions: 'disclosure.instructions',
  memory: 'disclosure.memory',
  workspace: 'disclosure.workspace',
};

/**
 * Injected-context disclosure （上下文注入披露): a quiet row that
 * tells the user which producer (AGENTS.md / 记忆库) contributed context.
 */
export default function DisclosureRow({ data }: { data: ContextDisclosure }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Icon = data.source === 'memory' ? BookmarkSimple : FileText;

  return (
    <div className="my-1 w-full max-w-[var(--content-max-width,880px)] mx-auto px-0.5">
      <button
        type="button"
        className="flex items-center gap-2 h-8 w-full px-3 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-left cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)]"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('disclosure.aria', { role: t(ROLE_LABEL[data.source]), producer: data.producer })}
      >
        <Icon size={14} className="shrink-0 text-text-muted" />
        <span className="shrink-0 text-xs font-medium text-text-primary">{t(ROLE_LABEL[data.source])}</span>
        <span className="shrink-0 text-2xs px-1.5 py-0.5 rounded-full bg-[var(--color-bg-inset)] text-text-muted">
          {data.producer}
        </span>
        <span className="flex-1 min-w-0 truncate text-2xs text-text-muted">{data.detail ?? ''}</span>
        <CaretDown
          size={12}
          className={clsx('shrink-0 text-text-faint transition-transform duration-150', open && 'rotate-180')}
        />
      </button>
      {open && data.content && (
        <div className="mt-1 max-h-[141px] overflow-y-auto rounded-lg border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] px-3 py-2 text-2xs text-text-muted leading-relaxed whitespace-pre-wrap break-words">
          {data.content}
        </div>
      )}
      {open && !data.content && (
        <div className="mt-1 rounded-lg border border-[var(--color-border-dim)] bg-[var(--color-bg-secondary)] px-3 py-2 text-2xs text-text-muted">
          {t('disclosure.note')}
        </div>
      )}
    </div>
  );
}
