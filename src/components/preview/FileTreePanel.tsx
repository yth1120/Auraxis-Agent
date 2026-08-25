import { errorText } from '../../../electron/errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import clsx from 'clsx';
import FileTree from '../layout/FileTree';
import { ArrowSquareOut, Copy, ExternalLink, FileText, Folder, MagnifyingGlass, X } from '@/components/common/icons';
import LoadingState from '../common/LoadingState';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useAppStore } from '@/stores/useAppStore';
import { useT } from '../../i18n';
import type { DirectoryEntry } from '../../types/electron-api';

interface FileTreePanelProps {
  tabId?: string;
  /**
   * 'tabs' (right panel): fixed 文件树 tab + independent file tabs.
   * 'embedded' (main-area tab): tree + bottom preview, no tab strip.
   */
  variant?: 'tabs' | 'embedded';
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

export default function FileTreePanel({ tabId: _tabId, variant = 'tabs' }: FileTreePanelProps) {
  const tPanel = useT();
  const isTabs = variant === 'tabs';
  const projectRoot = useSettingsStore((s) => s.projectPath);
  const tree = useFileTreeStore((s) => s.tree);
  const openFileRequest = useAppStore((s) => s.openFileRequest);
  const fileTabs = useAppStore((s) => s.fileTabs);
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const [file, setFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');

  const openInVSCode = async () => {
    if (!window.electronAPI?.shell) {
      message.warning(tPanel('wb.vscode.desktopOnly'));
      return;
    }
    if (!projectRoot) {
      message.warning(tPanel('wb.vscode.noProject'));
      return;
    }
    try {
      const result = await window.electronAPI.shell.openInVSCode(projectRoot);
      if (!result.ok) message.error(result.error || tPanel('wb.vscode.openFailed'));
    } catch {
      message.error(tPanel('wb.vscode.openFailed2'));
    }
  };

  const openFile = useCallback(
    async (path: string) => {
      setFile(path);
      setLoading(true);
      try {
        const r = await window.electronAPI?.file.read(path, projectRoot ?? undefined);
        setContent(r?.ok ? (r.data ?? '') : tPanel('ftp.readFailed', { error: String(r?.error ?? '') }));
      } catch (e: unknown) {
        setContent(tPanel('ftp.readFailed', { error: String(errorText(e)) }));
      } finally {
        setLoading(false);
      }
    },
    [projectRoot, tPanel],
  );

  useEffect(() => {
    // Project switch clears the stale preview.
    setFile(null);
    setContent('');
  }, [projectRoot]);

  // Tabs mode: load the active file tab whenever it changes.
  useEffect(() => {
    if (!isTabs) return;
    if (!activeFilePath) {
      setFile(null);
      setContent('');
      return;
    }
    void openFile(activeFilePath);
  }, [isTabs, activeFilePath, openFile]);

  // Cross-panel file linkage (产物/概览/时间线) opens/activates a file tab.
  useEffect(() => {
    if (!isTabs || !openFileRequest) return;
    useAppStore.getState().openFileTab(openFileRequest.path);
    useAppStore.getState().clearOpenFileRequest();
  }, [isTabs, openFileRequest]);

  const selectFile = useCallback(
    (path: string) => {
      if (isTabs) {
        useAppStore.getState().openFileTab(path);
      } else {
        void openFile(path);
      }
    },
    [isTabs, openFile],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !tree?.children) return [];
    const out: { path: string; name: string; dir: string }[] = [];
    const walk = (entries: DirectoryEntry[] | undefined) => {
      if (!entries || out.length >= 100) return;
      for (const e of entries) {
        if (e.isDirectory) {
          walk(e.children);
        } else if (e.name.toLowerCase().includes(q)) {
          const sepIdx = Math.max(e.path.lastIndexOf('/'), e.path.lastIndexOf('\\'));
          out.push({
            path: e.path,
            name: e.name,
            dir: sepIdx > 0 ? e.path.slice(0, sepIdx) : '',
          });
          if (out.length >= 100) return;
        }
      }
    };
    walk(tree.children);
    return out;
  }, [query, tree]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && matches[0]) selectFile(matches[0].path);
    if (e.key === 'Escape') {
      setQuery('');
      (e.target as HTMLInputElement).blur();
    }
  };

  const copyContent = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      message.success(tPanel('ftp.copied'));
    } catch {
      message.error(tPanel('ftp.copyFailed'));
    }
  };

  const renderPreview = (embedded: boolean) => (
    <div
      className={clsx(
        'min-h-0 flex flex-col',
        embedded ? 'shrink-0 h-[42%] border-t border-[var(--color-border-dim)]' : 'flex-1 border-t-0',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0">
        <span className="flex-1 min-w-0 text-xs font-medium text-text-primary truncate" title={file ?? ''}>
          {basename(file ?? '')}
        </span>
        <button
          type="button"
          className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
          onClick={() => void copyContent()}
          title={tPanel('ftp.copyTip')}
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
          onClick={() => {
            void window.electronAPI?.shell.openFileInVSCode(file ?? '').then((r) => {
              if (r && !r.ok) message.error(r.error || tPanel('ftp.openVSCodeFailed'));
            });
          }}
          title={tPanel('ftp.openVSCode')}
        >
          <ArrowSquareOut size={14} />
        </button>
        <button
          type="button"
          className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
          onClick={() => {
            void window.electronAPI?.shell.openPath(file ?? '');
          }}
          title={tPanel('ftp.openSystem')}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 pb-3">
        {loading ? (
          <LoadingState label={tPanel('ftp.loading')} compact />
        ) : (
          <pre className="m-0 text-xs leading-[1.6] font-mono text-[var(--color-text-secondary)] whitespace-pre break-words">
            {content}
          </pre>
        )}
      </div>
    </div>
  );

  const renderTreeBody = () => (
    <>
      <div className="shrink-0 px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <MagnifyingGlass
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={tPanel('ftp.filterPlaceholder')}
              aria-label={tPanel('ftp.filterAria')}
              className="w-full h-8 pl-8 pr-8 rounded-full bg-[var(--color-bg-inset)] border border-transparent text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-full text-[var(--color-text-muted)] cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)] hover:text-[var(--color-text-primary)]"
                onClick={() => setQuery('')}
                title={tPanel('ftp.clearFilter')}
                aria-label={tPanel('ftp.clearFilter')}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-bg-inset)] text-text-muted cursor-pointer border-none hover:bg-[var(--color-hover)] hover:text-text-primary"
            onClick={openInVSCode}
            title={tPanel('wb.vscode')}
            aria-label={tPanel('wb.vscode')}
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
      {query.trim() ? (
        matches.length === 0 ? (
          <div className="flex-1 min-h-0 flex items-center justify-center px-6 pb-8">
            <p className="text-2xs text-[var(--color-text-muted)] text-center">{tPanel('ftp.noMatch')}</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
            {matches.map((m) => (
              <button
                key={m.path}
                type="button"
                onClick={() => selectFile(m.path)}
                title={m.path}
                className="flex items-center gap-2 w-full px-2.5 py-2 rounded-lg text-left cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)] transition-colors duration-150"
              >
                <FileText size={14} className="shrink-0 text-[var(--color-text-faint)]" />
                <span className="min-w-0 flex-1 flex flex-col gap-[1px]">
                  <span className="block text-xs text-[var(--color-text-secondary)] truncate">{m.name}</span>
                  <span className="block text-2xs text-[var(--color-text-faint)] truncate">{m.dir}</span>
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileTree onFileSelect={selectFile} />
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full w-full bg-[var(--color-bg-primary)] overflow-hidden">
      {isTabs && (
        <div
          className="shrink-0 flex items-center gap-1 px-2 pt-1.5 pb-1.5 overflow-x-auto [scrollbar-width:none] border-b border-[var(--color-border-dim)]"
          role="tablist"
          aria-label={tPanel('ftp.openTabs')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={!activeFilePath}
            className={clsx(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border-none bg-transparent cursor-pointer shrink-0 transition-colors duration-150',
              !activeFilePath
                ? 'bg-[var(--color-bg-elevated)] text-text-primary font-medium'
                : 'text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
            )}
            onClick={() => useAppStore.getState().setActiveFilePath(null)}
          >
            <Folder size={14} className={!activeFilePath ? 'text-primary' : 'text-faint'} />
            {tPanel('ftp.fileTree')}
          </button>
          {fileTabs.map((t) => {
            const active = t.path === activeFilePath;
            return (
              <span
                key={t.path}
                role="tab"
                aria-selected={active}
                className={clsx(
                  'flex items-center gap-0.5 h-7 pl-2 pr-1 rounded-md cursor-pointer shrink-0 min-w-0 transition-colors duration-150',
                  active ? 'bg-[var(--color-bg-elevated)]' : 'hover:bg-[var(--color-hover)]',
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5 min-w-0 flex-1 h-full border-none bg-transparent cursor-pointer"
                  onClick={() => useAppStore.getState().setActiveFilePath(t.path)}
                  title={t.path}
                >
                  <FileText size={14} className={clsx('shrink-0', active ? 'text-primary' : 'text-faint')} />
                  <span
                    className={clsx(
                      'truncate text-xs max-w-[130px]',
                      active ? 'text-text-primary font-medium' : 'text-text-muted',
                    )}
                  >
                    {t.name}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${tPanel('ftp.closeTip')} ${t.name}`}
                  title={tPanel('ftp.closeTip')}
                  className="flex items-center justify-center w-4 h-4 rounded-md text-faint cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)] hover:text-text-primary shrink-0"
                  onClick={() => useAppStore.getState().closeFileTab(t.path)}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {isTabs && activeFilePath ? (
        renderPreview(false)
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {renderTreeBody()}
          {!isTabs && file && renderPreview(true)}
        </div>
      )}
    </div>
  );
}
