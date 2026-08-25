import { useCallback } from 'react';
import { ArrowSquareOut, Eye, FileCode, FolderOpen } from '@/components/common/icons';
import { useAppStore } from '@/stores/useAppStore';
import { message } from 'antd';
import { useT } from '../../i18n';

const MAX_CHIPS = 8;
const PREVIEW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

/**
 * Turn-tail deliverables （产物清单）: files created or
 * modified by the agent, rendered as clickable chips that open with the OS.
 */
export default function DeliverablesRow({
  files,
  onPreview,
}: {
  files: string[];
  onPreview?: (filePath: string) => void;
}) {
  const t = useT();
  const unique = [...new Set(files.filter((f) => typeof f === 'string' && f.trim()))];

  const open = useCallback(
    async (filePath: string) => {
      try {
        const r = await window.electronAPI?.shell?.openPath(filePath);
        if (r && !r.ok) message.error(r.error || t('deliverables.openFailed'));
      } catch {
        message.error(t('deliverables.openFailed'));
      }
    },
    [t],
  );

  const openInPanel = useCallback((filePath: string) => {
    useAppStore.getState().requestOpenFile(filePath);
  }, []);

  if (unique.length === 0) return null;

  const shown = unique.slice(0, MAX_CHIPS);
  const rest = unique.length - shown.length;

  return (
    <div className="my-1.5 flex items-start gap-1.5 w-full max-w-[var(--content-max-width,880px)] mx-auto px-0.5">
      <span className="shrink-0 flex items-center gap-1 mt-[2px] text-2xs text-text-muted">
        <FileCode size={14} />
        {t('deliverables.title')}
      </span>
      <div className="flex flex-wrap gap-1 min-w-0">
        {shown.map((p) => {
          const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
          const previewable = onPreview && PREVIEW_EXTENSIONS.has(ext);
          return (
            <span key={p} className="flex items-center gap-0.5">
              <button
                type="button"
                className="flex items-center gap-1 h-6 max-w-[220px] pl-2 pr-1.5 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-2xs text-text-secondary cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)] hover:text-text-primary"
                onClick={() => openInPanel(p)}
                title={t('deliverables.openInPanel', { path: p })}
                aria-label={t('deliverables.openInPanel', { path: basename(p) })}
              >
                <FolderOpen size={12} className="shrink-0 text-text-muted" />
                <span className="truncate">{basename(p)}</span>
              </button>
              <button
                type="button"
                className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-text-muted cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)] hover:text-text-primary"
                onClick={() => void open(p)}
                title={t('deliverables.openSystem', { name: basename(p) })}
                aria-label={t('deliverables.openSystem', { name: basename(p) })}
              >
                <ArrowSquareOut size={12} />
              </button>
              {previewable && (
                <button
                  type="button"
                  className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-text-muted cursor-pointer transition-colors duration-150 hover:border-[var(--color-border-strong)] hover:text-primary"
                  onClick={() => onPreview!(p)}
                  title={t('deliverables.preview', { name: basename(p) })}
                  aria-label={t('deliverables.preview', { name: basename(p) })}
                >
                  <Eye size={12} />
                </button>
              )}
            </span>
          );
        })}
        {rest > 0 && (
          <span className="flex items-center h-6 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted">
            +{rest}
          </span>
        )}
      </div>
    </div>
  );
}
