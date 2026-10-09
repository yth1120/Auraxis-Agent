import { useCallback, useEffect, useState } from 'react';
import { Tooltip, Popconfirm, Input } from 'antd';
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
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useT } from '../../i18n';
import { useFileTreeActions } from './useFileTreeActions';

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
  if (CODE_EXTS.has(ext)) return <CodeOutlined className="text-2xs text-text-faint" />;
  if (CONFIG_EXTS.has(ext)) return <SettingOutlined className="text-2xs text-text-faint" />;
  if (IMAGE_EXTS.has(ext)) return <FileImageOutlined className="text-2xs text-text-faint" />;
  if (DOC_EXTS.has(ext)) return <FileTextOutlined className="text-2xs text-text-faint" />;
  return <FileOutlined className="text-2xs text-text-faint" />;
}

/* ── FileTree root ────────────────────────────────────── */

interface FileTreeProps {
  /** Called when a file row is clicked (right-panel 文件 tab preview). */
  onFileSelect?: (path: string) => void;
}

export default function FileTree({ onFileSelect }: FileTreeProps) {
  const t = useT();
  const loading = useFileTreeStore((s) => s.loading);
  const error = useFileTreeStore((s) => s.error);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const pendingCreate = useFileTreeStore((s) => s.pendingCreate);
  const consumeCreate = useFileTreeStore((s) => s.consumeCreate);
  const projectRoot = useSettingsStore((s) => s.projectPath);
  const {
    tree,
    hoveredPath,
    setHoveredPath,
    activeOp,
    inputValue,
    setInputValue,
    refresh,
    handleDelete,
    handleStartRename,
    handleStartCreate,
    handleFinishOp,
    handleKeyDown,
  } = useFileTreeActions(t);
  /**
   * 行内操作按钮平时只在 hover 时出现，但**确认气泡打开时必须钉住**。
   *
   * 原因：`Popconfirm` 的气泡是挂在 body 上的 portal，位置在行**外面**。鼠标要从行里
   * 走向「确认删除」，必然先离开行 → 行的 onMouseLeave 清掉 hoveredPath →
   * `renderActions` 返回 null → 触发按钮被**卸载** → 挂在它上面的 Popconfirm 跟着关掉。
   * 表现就是"手还没点到，删除面板就没了"。
   *
   * 钉住而不是改成常驻：常驻会让每一行都挂着五个按钮，密而吵；hover + 打开期间锁住，
   * 既保持清单干净，又让鼠标走得到气泡。
   */
  const [pinnedPath, setPinnedPath] = useState<string | null>(null);

  // 右栏头部 `+` 发起的「新建」请求：消费一次即清空，避免重复触发。
  // 请求可能早于组件挂载（用户在别的模块上点的），所以它存在 store 里。
  useEffect(() => {
    if (!pendingCreate) return;
    handleStartCreate(pendingCreate.parentPath, pendingCreate.type);
    consumeCreate();
  }, [pendingCreate, handleStartCreate, consumeCreate]);

  /* ── Render helpers ────────────────────────────────── */

  const renderActions = useCallback(
    (entryPath: string, entryName: string, isDir: boolean) => {
      if ((hoveredPath !== entryPath && pinnedPath !== entryPath) || activeOp) return null;
      return (
        <span className="flex items-center gap-1.5 shrink-0 ml-auto">
          {isDir && (
            <>
              <Tooltip title={t('ft.newFile')} placement="top">
                <button
                  aria-label={t('ft.newFile')}
                  className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
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
                  aria-label={t('ft.newFolder')}
                  className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
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
              aria-label={t('ft.rename')}
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
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
            // 气泡打开期间钉住本行按钮，鼠标才能从行里走到气泡上（见 pinnedPath 说明）。
            onOpenChange={(open) => setPinnedPath(open ? entryPath : null)}
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
              aria-label={t('ft.delete')}
              className="flex items-center justify-center w-5 h-5 border-none bg-transparent text-text-faint rounded-md cursor-pointer transition-colors duration-150 ease-out hover:bg-[var(--color-hover)] hover:text-text-primary"
              onClick={(e) => e.stopPropagation()}
            >
              <DeleteOutlined style={{ fontSize: 10 }} />
            </button>
          </Popconfirm>
        </span>
      );
    },
    [hoveredPath, pinnedPath, activeOp, handleStartCreate, handleStartRename, handleDelete, t],
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
        'flex items-center gap-0.5 w-full py-[3px] px-2 border-none bg-transparent text-text-secondary text-xs cursor-pointer text-left transition-colors duration-150 ease-out leading-[1.6] min-h-6 overflow-hidden relative hover:bg-[var(--color-hover)]';

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
                className={`inline-flex shrink-0 items-center justify-center w-3 h-3 text-2xs text-text-faint transition-transform duration-200 ease-out ${isExpanded ? 'rotate-90' : ''}`}
              >
                <RightOutlined />
              </span>
              <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-text-faint">
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
                      <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-text-faint">
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
          <span className="text-xs w-4 shrink-0 inline-flex items-center justify-center text-text-faint">
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
          {renderActions(entry.path, entry.name, false)}
        </div>
      );
    },
    [
      expandedPaths,
      toggleExpand,
      activeOp,
      inputValue,
      handleFinishOp,
      handleKeyDown,
      onFileSelect,
      renderActions,
      setHoveredPath,
      setInputValue,
      t,
    ],
  );

  /* ── Empty / loading states ────────────────────────── */

  const btnBase =
    'inline-flex items-center gap-1 mt-2 px-3.5 py-1.5 text-xs rounded-md cursor-pointer transition-colors duration-150 ease-out';
  const selectBtn = `${btnBase} border border-primary-border bg-transparent text-text-primary hover:bg-primary-soft`;
  const refreshBtn =
    'flex items-center justify-center w-[22px] h-[22px] border-none bg-transparent text-text-muted rounded-md cursor-pointer text-xs shrink-0 transition-colors duration-150 ease-out hover:bg-primary-soft hover:text-primary';

  if (!projectRoot) {
    return (
      <div className="flex flex-col items-center justify-center p-8 px-4 text-center h-full gap-1.5">
        <FolderAddOutlined className="text-3xl text-text-faint mb-1" />
        <p className="text-sm font-normal text-text-secondary m-0">{t('ft.noProject')}</p>
        <p className="text-2xs text-text-muted m-0">{t('ft.noProjectHint')}</p>
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
        <p className="text-2xs text-text-muted m-0">{t('ft.empty')}</p>
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
        <span className="text-2xs font-semibold text-text-muted uppercase tracking-[0.05em] overflow-hidden text-ellipsis whitespace-nowrap flex-1">
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
