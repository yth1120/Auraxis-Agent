import { useEffect, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { message } from 'antd';
import { ArrowUUpLeft as UndoOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useUndoStore } from '../../stores/useUndoStore';
import { useT } from '../../i18n';

export default function UndoToast() {
  const t = useT();
  const undos = useUndoStore((s) => s.undos);
  const undoLast = useUndoStore((s) => s.undoLast);
  const [showMenu, setShowMenu] = useState(false);

  const handleUndo = useCallback(async () => {
    const entry = await undoLast();
    if (entry) {
      message.success(t('undo.undone', { desc: entry.description }));
    }
    setShowMenu(false);
  }, [undoLast, t]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable))
          return;
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo]);

  if (undos.length === 0) return null;

  const recent = undos[undos.length - 1];
  const items = [...undos].reverse().slice(0, 5);

  const btn = (
    <div className={clsx('fixed bottom-10 right-6 z-[1000]', '[animation:slideUpSubtle_0.3s_var(--ease-out)]')}>
      {showMenu && items.length > 1 && (
        <div className="absolute bottom-full right-0 mb-2 bg-[var(--color-bg-elevated)] rounded-card p-1 min-w-[240px] overflow-hidden border border-[var(--color-border-dim)] shadow-[var(--shadow-md)]">
          {items.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-accent-soft hover:text-text-primary"
              onClick={() => {
                useUndoStore.getState().undoById(u.id);
                message.success(t('undo.undone', { desc: u.description }));
                setShowMenu(false);
              }}
            >
              <UndoOutlined className="text-base opacity-75" />
              <span>{u.description}</span>
            </div>
          ))}
        </div>
      )}
      <button
        className="inline-flex items-center gap-2 bg-elevated border border-dim rounded-md py-2 px-4 font-body text-sm font-medium text-text-primary cursor-pointer transition-colors duration-normal ease-out shadow-md hover:border-accent-border"
        onClick={handleUndo}
        onContextMenu={(e) => {
          e.preventDefault();
          setShowMenu((p) => !p);
        }}
      >
        <UndoOutlined className="text-base text-accent" />
        {undos.length > 1 ? t('undo.undoN', { n: undos.length }) : t('undo.undo')}
        <span className="text-xs text-muted ml-1 max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
          {recent?.description}
        </span>
      </button>
    </div>
  );

  return createPortal(btn, document.body);
}
