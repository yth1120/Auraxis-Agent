import { getExtensionColor } from '../../constants/extensionColors';
import { ChatTeardropDots as ChatIcon } from '@/components/common/icons';
import { useT } from '../../i18n';
import clsx from 'clsx';

interface MentionDropdownProps {
  items: string[];
  sessions?: { id: string; title: string }[];
  selected: number;
  position?: 'center' | 'center-flow' | 'bottom';
  onSelect: (item: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onHover: (idx: number) => void;
}

function getFileIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const color = getExtensionColor(ext);
  const label = ext.slice(0, 2).toUpperCase() || '?';
  return (
    <span
      className="w-5 h-5 rounded-md flex items-center justify-center text-2xs font-bold font-body shrink-0 text-text-on-accent"
      style={{ background: color }}
    >
      {label}
    </span>
  );
}

function getDirAndName(filePath: string) {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash < 0) return { dir: '', name: filePath };
  return {
    dir: filePath.slice(0, lastSlash),
    name: filePath.slice(lastSlash + 1),
  };
}

export default function MentionDropdown({
  items,
  sessions = [],
  selected,
  position,
  onSelect,
  onSelectSession,
  onHover,
}: MentionDropdownProps) {
  const t = useT();
  if (items.length === 0 && sessions.length === 0) return null;

  return (
    <div
      className={clsx(
        'mention-dropdown absolute left-[-6px] right-[-6px] bg-[var(--color-bg-elevated)] rounded-card overflow-hidden z-[100] max-h-[260px] flex flex-col border border-[var(--color-border-dim)] shadow-[var(--shadow-md)]',
        position === 'center' || position === 'center-flow' ? 'top-[calc(100%+6px)]' : 'bottom-[calc(100%+6px)]',
      )}
    >
      <div className="overflow-y-auto flex-1">
        {sessions.map((s, idx) => (
          <div
            key={`session-${s.id}`}
            className={[
              'px-3 py-2 cursor-pointer text-text-secondary font-body text-sm flex items-center gap-2',
              'transition-colors duration-150',
              idx === selected ? 'bg-primary-soft text-primary' : 'hover:bg-primary-soft hover:text-primary',
            ].join(' ')}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelectSession?.(s.id);
            }}
            onMouseEnter={() => onHover(idx)}
          >
            <span className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <ChatIcon size={12} />
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              <strong>{s.title || t('mention.untitled')}</strong>
              <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 11 }}>{t('mention.session')}</span>
            </span>
          </div>
        ))}
        {items.map((item, idx) => {
          const globalIdx = sessions.length + idx;
          const { dir, name } = getDirAndName(item);
          return (
            <div
              key={item}
              className={[
                'px-3 py-2 cursor-pointer text-text-secondary font-body text-sm flex items-center gap-2',
                'transition-colors duration-150',
                globalIdx === selected ? 'bg-primary-soft text-primary' : 'hover:bg-primary-soft hover:text-primary',
              ].join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
              onMouseEnter={() => onHover(globalIdx)}
            >
              {getFileIcon(item)}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                <strong>{name}</strong>
                {dir && <span style={{ opacity: 0.5, marginLeft: 6, fontSize: 11 }}>{dir}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 flex items-center gap-3 text-2xs text-text-faint border-t border-border-dim">
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            ↑↓
          </kbd>{' '}
          {t('nav.navigate')}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            ↵
          </kbd>{' '}
          {t('nav.select')}
        </span>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center justify-center min-w-[16px] p-1 rounded-[5px] bg-bg-inset text-xs text-text-muted border border-border-dim">
            Esc
          </kbd>{' '}
          {t('nav.cancel')}
        </span>
      </div>
    </div>
  );
}
