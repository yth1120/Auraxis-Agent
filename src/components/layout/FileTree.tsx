import { useCallback, useState, useEffect } from 'react';
import { Tooltip, Popconfirm, Input, message } from 'antd';
import {
  CaretRight as RightOutlined,
  Folder as FolderOutlined,
  FolderOpen as FolderOpenOutlined,
  FileText as FileTextOutlined,
  File as FileOutlined,
  Code as CodeOutlined,
  FileImage as FileImageOutlined,
  GearSix as SettingOutlined,
  ArrowClockwise as ReloadOutlined,
  FolderPlus as FolderAddOutlined,
  FilePlus as FileAddOutlined,
  PencilSimple as EditOutlined,
  Trash as DeleteOutlined,
} from '@/components/common/icons';
import LoadingState from '../common/LoadingState';
import type { DirectoryEntry } from '../../types/electron-api';
import type { FileActivity } from '../../types/chat';
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useT, type I18nKey } from '../../i18n';

/* ── Agent activity badges (state-aware tree) ─────────── */
const STATUS_BADGE: Record<FileActivity, { textKey: I18nKey; color: string }> = {
  reading: { textKey: 'ft.read', color: '#111418' },
  editing: { textKey: 'ft.edit', color: '#f59e0b' },
  modified: { textKey: 'ft.modified', color: '#10b981' },
  created: { textKey: 'ft.created', color: '#10b981' },
  deleted: { textKey: 'ft.deleted', color: '#ef4444' },
};

function StatusBadge({ activity }: { activity: FileActivity }) {
  const t = useT();
  const cfg = STATUS_BADGE[activity];
  return (
    <span
      className="ml-[6px] text-2xs leading-[14px] px-[5px] rounded-full font-semibold text-white shrink-0"
      style={{ background: cfg.color }}
    >
      {t(cfg.textKey)}
    </span>
  );
}

/* ── File icon mapping ───────────────────────────────── */

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.vue',
  '.svelte',
]);
const CONFIG_EXTS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp']);
const DOC_EXTS = new Set(['.md', '.txt', '.mdx', '.rst']);

function fileIcon(name: string, isDir: boolean) {
  if (isDir) return null;
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (CODE_EXTS.has(ext)) return <CodeOutlined className="text-2xs text-faint" />;
  if (CONFIG_EXTS.has(ext)) return <SettingOutlined className="text-2xs text-faint" />;
  if (IMAGE_EXTS.has(ext)) return <FileImageOutlined className="text-2xs text-faint" />;
  if (DOC_EXTS.has(ext)) return <FileTextOutlined className="text-2xs text-faint" />;
  return <FileOutlined className="text-2xs text-faint" />;
}

/* ── Types ────────────────────────────────────────────── */

interface ActiveOp {
  type: 'createFile' | 'createFolder' | 'rename';
  parentPath: string;
  oldName?: string;
}

/* ── FileTree root ────────────────────────────────────── */

interface FileTreeProps {
  /** Called when a file row is clicked (right-panel 文件 tab preview). */
  onFileSelect?: (path: string) => void;
}

export default function FileTree({ onFileSelect }: FileTreeProps) {
  const t = useT();
  const tree = useFileTreeStore((s) => s.tree);
  const loading = useFileTreeStore((s) => s.loading);
  const error = useFileTreeStore((s) => s.error);
  const fetchTree = useFileTreeStore((s) => s.fetchTree);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const fileStatus = useFileTreeStore((s) => s.fileStatus);
  const projectRoot = useSettingsStore((s) => s.projectPath);

  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [activeOp, setActiveOp] = useState<ActiveOp | null>(null);
  const [inputValue, setInputValue] = useState('');

  const refresh = useCallback(() => {
    if (projectRoot) fetchTree(projectRoot);
  }, [projectRoot, fetchTree]);

  /* ── CRUD handlers ─────────────────────────────────── */

  const handleDelete = useCallback(
    async (targetPath: string) => {
      const result = await window.electronAPI?.file.delete(targetPath, projectRoot ?? undefined);
      if (result?.ok) {
        message.success(t('ft.deletedMsg', { name: targetPath.split(/[/\\]/).pop() ?? '' }));
        refresh();
      } else {
        message.error(result?.error || t('ft.deleteFailed'));
      }
    },
    [refresh, projectRoot, t],
  );

  const handleStartRename = useCallback((targetPath: string, name: string) => {
    setActiveOp({ type: 'rename', parentPath: targetPath, oldName: name });
    setInputValue(name);
  }, []);

  const handleStartCreate = useCallback(
    (parentPath: string, type: 'createFile' | 'createFolder') => {
      // Ensure parent is expanded
      if (!expandedPaths.has(parentPath)) {
        toggleExpand(parentPath);
      }
      setActiveOp({ type, parentPath });
      setInputValue('');
    },
    [expandedPaths, toggleExpand],
  );

  const handleFinishOp = useCallback(async () => {
    if (!activeOp || !projectRoot || !inputValue.trim()) {
      setActiveOp(null);
      setInputValue('');
      return;
    }

    const sep = projectRoot.includes('\\') ? '\\' : '/';
    const newPath = `${activeOp.parentPath}${sep}${inputValue.trim()}`;

    try {
      if (activeOp.type === 'rename' && activeOp.oldName) {
        const oldPath = `${activeOp.parentPath}${sep}${activeOp.oldName}`;
        const result = await window.electronAPI?.file.rename(oldPath, newPath, projectRoot ?? undefined);
        if (!result?.ok) {
          message.error(result?.error || t('ft.renameFailed'));
        }
      } else if (activeOp.type === 'createFolder') {
        const result = await window.electronAPI?.file.createFolder(newPath, projectRoot ?? undefined);
        if (!result?.ok) {
          message.error(result?.error || t('ft.createFolderFailed'));
        }
      } else if (activeOp.type === 'createFile') {
        const result = await window.electronAPI?.file.createFile(newPath, projectRoot ?? undefined);
        if (!result?.ok) {
          message.error(result?.error || t('ft.createFileFailed'));
        }
      }
    } finally {
      setActiveOp(null);
      setInputValue('');
      refresh();
    }
  }, [activeOp, inputValue, projectRoot, refresh, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleFinishOp();
      if (e.key === 'Escape') {
        setActiveOp(null);
        setInputValue('');
      }
    },
    [handleFinishOp],
  );

  /* ── Auto-fetch on mount and when projectRoot changes ── */
  useEffect(() => {
    if (projectRoot) fetchTree(projectRoot);
  }, [projectRoot, fetchTree]);

  /* ── Render helpers ────────────────────────────────── */

  const renderActions = useCallback(
    (entryPath: string, entryName: string, isDir: boolean) => {
      if (hoveredPath !== entryPath || activeOp) return null;
      return (
        <span className="flex items-center gap-1.5 shrink-0 ml-auto">
          {isDir && (
            <>
              <Tooltip title={t('ft.newFile')} placement="top">
                <button
                  className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStartCreate(entryPath, 'createFile');
                  }}
                >
                  <FileAddOutlined style={{ fontSize: 10 }} />
                </button>
              </Tooltip>
              <Tooltip title={t('ft.newFolder')} placement="top">
                <button
                  className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStartCreate(entryPath, 'createFolder');
                  }}
                >
                  <FolderAddOutlined style={{ fontSize: 10 }} />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip title={t('ft.rename')} placement="top">
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => {
                e.stopPropagation();
                handleStartRename(entryPath, entryName);
              }}
            >
              <EditOutlined style={{ fontSize: 10 }} />
            </button>
          </Tooltip>
          <Popconfirm
            title={isDir ? t('ft.deleteDirTitle') : t('ft.deleteFileTitle')}
            onConfirm={(e) => {
              e?.stopPropagation();
              handleDelete(entryPath);
            }}
            onCancel={(e) => {
              e?.stopPropagation();
            }}
            okText={t('ft.delete')}
            cancelText={t('ft.cancel')}
            okButtonProps={{
              danger: true,
              type: 'primary',
              style: { color: '#fff' },
            }}
          >
            <button
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <DeleteOutlined style={{ fontSize: 10 }} />
            </button>
          </Popconfirm>
        </span>
      );
    },
    [hoveredPath, activeOp, handleStartCreate, handleStartRename, handleDelete, t],
  );

  /* ── Recursive tree node ───────────────────────────── */

  const renderNode = useCallback(
    (entry: DirectoryEntry, depth: number) => {
      const isExpanded = expandedPaths.has(entry.path);
      const indent = depth * 12;

      // Inline input for new items or rename
      if (activeOp && activeOp.parentPath === entry.path && activeOp.type !== 'rename') {
        // Creating new file/folder — show inline input as a child node
        // (handled below when rendering children)
      }

      const isRenaming = activeOp?.type === 'rename' && activeOp?.parentPath === entry.path;

      const nodeBaseClasses =
        'flex items-center gap-0.5 w-full py-[3px] px-2 border-none bg-transparent text-secondary text-xs cursor-pointer text-left transition-colors duration-150 ease-out leading-[1.6] min-h-6 overflow-hidden relative hover:bg-[var(--color-hover)]';

      if (entry.isDirectory) {
        return (
          <div key={entry.path}>
            <div
              className={nodeBaseClasses}
              style={{ paddingLeft: 8 + indent }}
              onMouseEnter={() => setHoveredPath(entry.path)}
              onMouseLeave={() => setHoveredPath(null)}
              onClick={() => toggleExpand(entry.path)}
            >
              <span
                className={`inline-flex shrink-0 items-center justify-center w-3 h-3 text-2xs text-faint transition-transform duration-normal ease-out ${isExpanded ? 'rotate-90' : ''}`}
              >
                <RightOutlined />
              </span>
              <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-faint">
                {isExpanded ? <FolderOpenOutlined /> : <FolderOutlined />}
              </span>
              {isRenaming ? (
                <Input
                  size="small"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onBlur={handleFinishOp}
                  onKeyDown={handleKeyDown}
                  className="!h-5 !text-2xs !px-1 flex-1 min-w-0"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">{entry.name}</span>
              )}
              {renderActions(entry.path, entry.name, true)}
            </div>
            {isExpanded && entry.children && (
              <div>
                {activeOp &&
                  activeOp.parentPath === entry.path &&
                  (activeOp.type === 'createFile' || activeOp.type === 'createFolder') && (
                    <div className={nodeBaseClasses} style={{ paddingLeft: 8 + indent + 12 }}>
                      <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-faint">
                        {activeOp.type === 'createFolder' ? (
                          <FolderOutlined />
                        ) : (
                          fileIcon(inputValue || 'new.ts', false)
                        )}
                      </span>
                      <Input
                        size="small"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onBlur={handleFinishOp}
                        onKeyDown={handleKeyDown}
                        placeholder={activeOp.type === 'createFolder' ? t('ft.folderName') : t('ft.fileName')}
                        className="!h-5 !text-2xs !px-1 flex-1 min-w-0"
                        autoFocus
                      />
                    </div>
                  )}
                {entry.children.map((child) => renderNode(child, depth + 1))}
              </div>
            )}
          </div>
        );
      }

      return (
        <div
          key={entry.path}
          className={nodeBaseClasses}
          style={{ paddingLeft: 8 + indent + 12 }}
          onMouseEnter={() => setHoveredPath(entry.path)}
          onMouseLeave={() => setHoveredPath(null)}
          onClick={() => {
            if (!isRenaming) onFileSelect?.(entry.path);
          }}
          title={entry.path}
        >
          <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-faint">
            {fileIcon(entry.name, false)}
          </span>
          {isRenaming ? (
            <Input
              size="small"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={handleFinishOp}
              onKeyDown={handleKeyDown}
              className="!h-5 !text-2xs !px-1 flex-1 min-w-0"
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Tooltip title={entry.path} placement="right" mouseEnterDelay={0.6}>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap flex-1">{entry.name}</span>
            </Tooltip>
          )}
          {fileStatus[entry.path] && <StatusBadge activity={fileStatus[entry.path]} />}
          {renderActions(entry.path, entry.name, false)}
        </div>
      );
    },
    [
      expandedPaths,
      toggleExpand,
      activeOp,
      inputValue,
      fileStatus,
      handleFinishOp,
      handleKeyDown,
      onFileSelect,
      renderActions,
      t,
    ],
  );

  /* ── Empty / loading states ────────────────────────── */

  const btnBase =
    'inline-flex items-center gap-1 mt-2 px-3.5 py-1.5 text-xs rounded-md cursor-pointer transition-colors duration-150 ease-out';
  const selectBtn = `${btnBase} border border-primary-border bg-transparent text-text-primary hover:bg-primary-soft`;
  const refreshBtn =
    'flex items-center justify-center w-[22px] h-[22px] border-none bg-transparent text-muted rounded-md cursor-pointer text-xs shrink-0 transition-colors duration-150 ease-out hover:bg-primary-soft hover:text-primary';

  if (!projectRoot) {
    return (
      <div className="flex flex-col items-center justify-center p-8 px-4 text-center h-full gap-1.5">
        <FolderAddOutlined className="text-3xl text-faint mb-1" />
        <p className="text-sm font-normal text-secondary m-0">{t('ft.noProject')}</p>
        <p className="text-2xs text-muted m-0">{t('ft.noProjectHint')}</p>
      </div>
    );
  }

  if (loading && !tree) {
    return <LoadingState label={t('ft.loading')} className="h-full" />;
  }

  if (error && !tree) {
    return (
      <div className="flex flex-col items-center justify-center p-8 px-4 text-center h-full gap-1.5">
        <p className="text-xs text-text-secondary m-0">{error}</p>
        <button className={selectBtn} onClick={refresh}>
          <ReloadOutlined /> {t('ft.retry')}
        </button>
      </div>
    );
  }

  if (!tree || !tree.children || tree.children.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 px-4 text-center h-full gap-1.5">
        <p className="text-2xs text-muted m-0">{t('ft.empty')}</p>
        <div className="flex items-center gap-2 mt-1">
          <button className={selectBtn} onClick={refresh}>
            <ReloadOutlined /> {t('ft.refresh')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="file-tree flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <span className="text-2xs font-semibold text-muted uppercase tracking-[0.05em] overflow-hidden text-ellipsis whitespace-nowrap flex-1">
          {tree.name}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <Tooltip title={t('ft.refreshTip')} placement="top">
            <button className={refreshBtn} onClick={refresh}>
              <ReloadOutlined />
            </button>
          </Tooltip>
        </span>
      </div>
      <div className="tree-scroll flex-1 overflow-y-auto overflow-x-hidden pb-2">
        {tree.children.map((child) => renderNode(child, 0))}
      </div>
    </div>
  );
}
