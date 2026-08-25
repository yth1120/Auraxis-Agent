import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input, Modal } from 'antd';
import type { InputRef } from 'antd';
import { MagnifyingGlass as SearchOutlined } from '@/components/common/icons';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { buildCommandItems, parseTreePaths } from './CommandPaletteItems';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [fileHits, setFileHits] = useState<
    { name: string; path: string; isDirectory: boolean; snippet?: string; matchType?: 'name' | 'content' }[]
  >([]);
  const inputRef = useRef<InputRef | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // 命令面板也承担「打开文件」：拉取项目文件树供搜索。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const projectPath = useSettingsStore.getState().projectPath;
    if (!projectPath) {
      setFilePaths([]);
      return;
    }
    window.electronAPI?.context
      ?.getFileStructure(projectPath)
      .then((result) => {
        if (!cancelled && result.ok && result.data) setFilePaths(parseTreePaths(result.data).slice(0, 200));
      })
      .catch(() => {
        if (!cancelled) setFilePaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 文件内容搜索：查询 >=2 字符时按内容/文件名搜索项目（防抖 250ms）。
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const projectPath = useSettingsStore.getState().projectPath;
    if (q.length < 2 || !projectPath) {
      setFileHits([]);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI?.file
        ?.search(q, projectPath)
        .then((result) => setFileHits(result.ok ? (result.data ?? []) : []))
        .catch(() => setFileHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, query]);

  // Esc must close the palette even before the input gains focus — the global
  // app shortcut handler skips Escape while an input is focused, so relying on
  // antd's panel-level keydown alone is timing-dependent.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const items = useMemo(
    () => buildCommandItems({ filePaths, fileHits, onClose, t }),
    [onClose, t, filePaths, fileHits],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items
      .map((item) => {
        let score = 0;
        const title = item.title.toLowerCase();
        const description = item.description.toLowerCase();
        const search = item.searchText.toLowerCase();
        if (title === q) score += 100;
        else if (title.startsWith(q)) score += 60;
        else if (title.includes(q)) score += 40;
        else if (search.includes(q)) score += 20;
        else if (description.includes(q)) score += 10;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }, [items, query]);

  useEffect(() => {
    setSelected(0);
  }, [filtered]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        filtered[selected]?.action();
      } else if (event.key === 'Escape') {
        onClose();
      }
    },
    [filtered, selected, onClose],
  );

  const modal = (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      centered
      className="command-palette-modal"
      transitionName=""
      maskTransitionName=""
      styles={{ mask: { background: 'var(--glass-mask)' }, body: { padding: 0 } }}
    >
      <div className="pt-4 px-4">
        <Input
          ref={inputRef}
          prefix={<SearchOutlined className="text-muted" />}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          bordered={false}
          size="large"
          className="text-lg"
        />
      </div>
      <div className="max-h-[320px] overflow-y-auto p-2 pb-4">
        {filtered.length === 0 ? (
          <div className="text-center p-6 text-muted text-sm">{t('palette.empty')}</div>
        ) : (
          filtered.map((item, index) => {
            const prefix = item.id.split('-')[0] ?? '';
            const groupKey =
              prefix === 'cmd'
                ? t('palette.group.commands')
                : prefix === 'agent'
                  ? t('palette.group.agents')
                  : prefix === 'session'
                    ? t('palette.group.sessions')
                    : prefix === 'settings'
                      ? t('palette.group.settings')
                      : prefix === 'file'
                        ? t('palette.group.files')
                        : t('palette.group.shortcuts');
            const showHeader = index === 0 || filtered[index - 1]?.id.split('-')[0] !== prefix;
            return (
              <Fragment key={item.id}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-text-faint tracking-[0.06em] uppercase">
                    {groupKey}
                  </div>
                )}
                <div
                  onClick={item.action}
                  onMouseEnter={() => setSelected(index)}
                  className={clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors duration-fast ease-out',
                    index === selected ? 'bg-accent-soft' : 'hover:bg-accent-soft',
                  )}
                >
                  <span className="text-lg text-secondary w-[22px] text-center shrink-0">{item.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary">{item.title}</div>
                    <div className="text-2xs text-muted mt-1">{item.description}</div>
                  </div>
                  {item.shortcut && (
                    <span className="font-mono text-2xs text-muted bg-primary-soft py-1 px-2 rounded-md whitespace-nowrap">
                      {item.shortcut}
                    </span>
                  )}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      <div className="border-t border-dim p-2 px-4 flex gap-4 text-2xs text-muted">
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">↑↓</kbd> {t('palette.nav')}
        </span>
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">Enter</kbd> {t('palette.select')}
        </span>
        <span>
          <kbd className="bg-primary-soft px-1.5 py-0.5 rounded-md">Esc</kbd> {t('palette.close')}
        </span>
      </div>
    </Modal>
  );

  return createPortal(modal, document.body);
}
