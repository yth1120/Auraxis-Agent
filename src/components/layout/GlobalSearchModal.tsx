import { useEffect, useRef, useState } from 'react';
import { Modal } from 'antd';
import clsx from 'clsx';
import { ChatTeardropDots, ChatCircle, MagnifyingGlass, Robot, X } from '@/components/common/icons';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { getContentText } from '../../types/chat';
import { t, useI18nStore, useT } from '../../i18n';

interface SearchResult {
  type: 'chat' | 'agent' | 'session';
  id: string;
  title: string;
  snippet: string;
  ts: number;
  score: number;
}

function relativeSearchTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  const d = new Date(ts);
  return new Intl.DateTimeFormat(useI18nStore.getState().locale === 'en-US' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(d);
}

export default function GlobalSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tPanel = useT();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [open]);

  const openResult = (r: SearchResult) => {
    onClose();
    setResults([]);
    setQuery('');
    setIndex(-1);
    const app = useAppStore.getState();
    app.setActiveToolView('none');
    if (r.type === 'session' || r.type === 'chat') {
      app.setSidebarMode('chat');
      useChatStore.getState().switchSession(r.id);
    } else {
      const surface = useAgentStore.getState().agents.find((a) => a.id === r.id)?.surface ?? 'code';
      app.setSidebarMode(surface === 'work' ? 'work' : 'code');
      useAgentStore.getState().setCurrentAgent(r.id);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
      centered
      closable={false}
      className="global-search-modal"
      transitionName=""
      maskTransitionName=""
      destroyOnHidden
      styles={{ mask: { background: 'var(--glass-mask)' }, body: { padding: 0 } }}
    >
      <div className="flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border-dim)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-lg)]">
        <div className="flex items-center gap-3 shrink-0 h-14 px-4 border-b border-[var(--color-border-dim)]">
          <MagnifyingGlass size={18} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            id="global-search-input"
            type="search"
            placeholder={tPanel('search.placeholder')}
            value={query}
            onChange={(e) => {
              const q = e.target.value;
              const current = ++seq.current;
              setQuery(q);
              setIndex(-1);
              if (timer.current) clearTimeout(timer.current);
              if (!q.trim()) {
                setResults([]);
                seq.current++;
                return;
              }
              timer.current = setTimeout(() => {
                const ql = q.trim().toLowerCase();
                const local = useSessionStore
                  .getState()
                  .sessions.filter(
                    (s) =>
                      s.title.toLowerCase().includes(ql) ||
                      s.messages.some((m) => getContentText(m.content).toLowerCase().includes(ql)),
                  )
                  .slice(0, 6)
                  .map((s) => {
                    const last = s.messages[s.messages.length - 1];
                    return {
                      type: 'session' as const,
                      id: s.id,
                      title: s.title,
                      snippet: last ? getContentText(last.content).replace(/\s+/g, ' ').slice(0, 90) : '',
                      ts: s.updated,
                      score: 1,
                    };
                  });
                const fts = window.electronAPI?.fts?.search;
                if (fts) {
                  void fts(q, 8)
                    .then((r) => {
                      if (current !== seq.current) return;
                      setResults([...local, ...(r.ok && r.data ? r.data : [])]);
                      setIndex(0);
                    })
                    .catch(() => {
                      if (current === seq.current) setResults(local);
                    });
                } else {
                  setResults(local);
                  setIndex(0);
                }
              }, 250);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (results.length ? (i + 1) % results.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
              } else if (e.key === 'Enter') {
                const target = results[index >= 0 ? index : 0];
                if (target) openResult(target);
              } else if (e.key === 'Escape') {
                onClose();
                (e.target as HTMLInputElement).blur();
              }
            }}
            style={{ borderRadius: 0 }}
            className="flex-1 min-w-0 h-full rounded-none bg-transparent text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {query.trim() && (
            <span className="shrink-0 text-2xs text-text-faint tabular-nums">
              {tPanel('search.results', { n: results.length })}
            </span>
          )}
          {query && (
            <button
              type="button"
              aria-label={tPanel('search.clear')}
              className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full text-text-muted hover:text-text-primary hover:bg-[var(--color-hover)]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                seq.current++;
                setQuery('');
                setResults([]);
                setIndex(-1);
              }}
            >
              <X size={10} weight="bold" />
            </button>
          )}
        </div>
        <div className="min-h-[200px] max-h-[400px] overflow-y-auto p-2">
          {!query.trim() ? (
            <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-10 text-center">
              <span className="flex items-center justify-center w-12 h-12 text-text-faint">
                <MagnifyingGlass size={20} />
              </span>
              <span className="text-sm font-medium text-text-secondary">{tPanel('search.start')}</span>
              <span className="text-2xs text-text-faint leading-[1.6]">{tPanel('search.scope')}</span>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2.5 px-4 py-10 text-center">
              <span className="flex items-center justify-center w-12 h-12 text-text-faint">
                <MagnifyingGlass size={20} />
              </span>
              <span className="text-sm font-medium text-text-secondary">{tPanel('search.noResults')}</span>
              <span className="text-2xs text-text-faint leading-[1.6]">{tPanel('search.tryAgain')}</span>
            </div>
          ) : (
            <div role="listbox" aria-label={tPanel('search.placeholder')} className="flex flex-col gap-2">
              {(['session', 'chat', 'agent'] as const).map((group) => {
                const groupItems = results.filter((r) => r.type === group);
                if (groupItems.length === 0) return null;
                const groupLabel =
                  group === 'session'
                    ? tPanel('search.groupSession')
                    : group === 'chat'
                      ? tPanel('search.groupChat')
                      : 'Code';
                return (
                  <div key={group} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1">
                      <span className="text-2xs font-semibold text-text-faint tracking-[0.06em]">{groupLabel}</span>
                      <span className="text-2xs text-text-faint tabular-nums">{groupItems.length}</span>
                    </div>
                    {groupItems.map((r, gi) => {
                      const idx = results.indexOf(r);
                      const icon =
                        group === 'session' ? (
                          <ChatTeardropDots size={14} weight="regular" />
                        ) : group === 'chat' ? (
                          <ChatCircle size={14} weight="regular" />
                        ) : (
                          <Robot size={14} weight="regular" />
                        );
                      const iconCls =
                        group === 'session'
                          ? 'text-[var(--color-violet)]'
                          : group === 'chat'
                            ? 'text-[var(--color-primary)]'
                            : 'text-[var(--color-violet)]';
                      return (
                        <button
                          key={`${group}-${r.id}-${gi}`}
                          type="button"
                          role="option"
                          aria-selected={idx === index}
                          className={clsx(
                            'flex items-center gap-3 w-full h-11 px-3 rounded-lg text-left cursor-pointer transition-colors duration-100',
                            idx === index ? 'bg-primary-soft' : 'hover:bg-[var(--color-hover)]',
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            openResult(r);
                          }}
                          onMouseEnter={() => setIndex(idx)}
                        >
                          <span className={`shrink-0 flex items-center justify-center w-8 h-8 ${iconCls}`}>{icon}</span>
                          <span className="min-w-0 flex-1 flex flex-col gap-[2px]">
                            <span className="flex items-baseline gap-2 min-w-0">
                              <span className="flex-1 min-w-0 text-sm font-medium text-text-primary truncate">
                                {r.title}
                              </span>
                              <span className="shrink-0 text-2xs text-text-faint tabular-nums">
                                {relativeSearchTime(r.ts)}
                              </span>
                            </span>
                            {r.snippet && <span className="text-xs text-text-muted truncate">{r.snippet}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4 shrink-0 h-10 px-4 border-t border-[var(--color-border-dim)] text-2xs text-text-faint">
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-md bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] text-2xs font-medium text-text-secondary">
              ↑↓
            </kbd>
            {tPanel('search.upDown')}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-md bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] text-2xs font-medium text-text-secondary">
              Enter
            </kbd>
            {tPanel('search.enter')}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-md bg-[var(--color-bg-inset)] border border-[var(--color-border-dim)] text-2xs font-medium text-text-secondary">
              Esc
            </kbd>
            {tPanel('search.esc')}
          </span>
        </div>
      </div>
    </Modal>
  );
}
