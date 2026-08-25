import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { useAppStore } from '@/stores/useAppStore';

export interface ContextGroup {
  key: string;
  icon: ReactNode;
  label: string;
  items: string[];
}

interface ContextManifestProps {
  groups: ContextGroup[];
  /** Token estimates keyed by full file path (from file:estimateTokens). */
  fileTokens?: Record<string, number | null>;
  /** Largest token count — used to scale the mini bars. */
  maxFileTokens?: number;
}

/**
 * Context transparency: a glanceable manifest of what the agent mounted this
 * turn — files touched, searches, commands, network calls. Presentational;
 * WorkspaceInspector aggregates the data from the latest assistant turn.
 */
export default function ContextManifest({ groups, fileTokens, maxFileTokens }: ContextManifestProps) {
  const t = useT();
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  if (nonEmpty.length === 0) return null;

  const fmtTokens = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
  const basename = (p: string) => p.split(/[/\\]/).pop() || p;

  return (
    <section className="px-4 py-3 mb-3 rounded-xl bg-[var(--color-bg-secondary)]" aria-label={t('ctx.title')}>
      <header className="flex items-center justify-between mb-2">
        <span className="text-2xs font-semibold text-muted tracking-wide">{t('ctx.title')}</span>
        <span className="flex gap-[6px]">
          {nonEmpty.map((g) => (
            <span
              key={g.key}
              className="inline-flex items-center gap-[3px] text-2xs tabular-nums px-[6px] py-[1px] rounded-full bg-[var(--color-bg-inset)] text-secondary"
              title={`${g.label} · ${g.items.length}`}
            >
              <span className="text-2xs">{g.icon}</span>
              {g.items.length}
            </span>
          ))}
        </span>
      </header>
      <div className="flex flex-col gap-1">
        {nonEmpty.map((g) => (
          <details key={g.key} className="rounded-md">
            <summary className="flex items-center gap-[6px] px-2 py-[5px] rounded-md cursor-pointer text-xs text-primary [&::-webkit-details-marker]:hidden hover:bg-[var(--color-hover)]">
              <span className="text-xs">{g.icon}</span>
              <span className="flex-1">{g.label}</span>
              <span className="text-2xs tabular-nums text-muted">{g.items.length}</span>
            </summary>
            <ul className="list-none m-0 p-[2px_0_4px_26px] flex flex-col gap-[2px]">
              {g.items.slice(0, 50).map((it, i) => {
                const isFile = g.key === 'files';
                const tokens = isFile && fileTokens ? fileTokens[it] : undefined;
                return (
                  <li key={`${g.key}-${i}`} className="flex items-center gap-2 min-w-0">
                    {isFile ? (
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left text-xs font-mono text-muted whitespace-nowrap overflow-hidden text-ellipsis rounded-md px-1 -mx-1 border-none bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
                        title={t('ctx.openInPanel', { path: it })}
                        onClick={() => useAppStore.getState().requestOpenFile(it)}
                      >
                        {basename(it)}
                      </button>
                    ) : (
                      <span
                        className="flex-1 min-w-0 text-xs font-mono text-muted whitespace-nowrap overflow-hidden text-ellipsis"
                        title={it}
                      >
                        {it}
                      </span>
                    )}
                    {tokens !== undefined && (
                      <span className="shrink-0 flex items-center gap-1.5 text-2xs text-text-muted tabular-nums">
                        <span className="inline-block h-1 w-10 rounded-full bg-[var(--color-bg-inset)] overflow-hidden align-middle">
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{
                              width: `${
                                maxFileTokens && tokens != null
                                  ? Math.min(100, Math.round((tokens / maxFileTokens) * 100))
                                  : tokens == null
                                    ? 0
                                    : 100
                              }%`,
                            }}
                          />
                        </span>
                        {tokens == null ? t('ctx.unestimable') : fmtTokens(tokens)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
