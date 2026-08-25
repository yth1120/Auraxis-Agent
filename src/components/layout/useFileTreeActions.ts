import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import type { I18nKey } from '../../i18n';
import { useFileTreeStore } from '../../stores/useFileTreeStore';
import { useSettingsStore } from '../../stores/useSettingsStore';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export type FileTreeActiveOp =
  | { type: 'rename'; parentPath: string; oldName: string }
  | { type: 'createFile'; parentPath: string }
  | { type: 'createFolder'; parentPath: string };

export function useFileTreeActions(t: Translate) {
  const tree = useFileTreeStore((s) => s.tree);
  const fetchTree = useFileTreeStore((s) => s.fetchTree);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const toggleExpand = useFileTreeStore((s) => s.toggleExpand);
  const projectRoot = useSettingsStore((s) => s.projectPath);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [activeOp, setActiveOp] = useState<FileTreeActiveOp | null>(null);
  const [inputValue, setInputValue] = useState('');

  const refresh = useCallback(() => {
    if (projectRoot) fetchTree(projectRoot);
  }, [projectRoot, fetchTree]);

  useEffect(() => {
    if (projectRoot) fetchTree(projectRoot);
  }, [projectRoot, fetchTree]);

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
      if (!expandedPaths.has(parentPath)) toggleExpand(parentPath);
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
    const separator = projectRoot.includes('\\') ? '\\' : '/';
    const newPath = `${activeOp.parentPath}${separator}${inputValue.trim()}`;
    try {
      if (activeOp.type === 'rename' && activeOp.oldName) {
        const oldPath = `${activeOp.parentPath}${separator}${activeOp.oldName}`;
        const result = await window.electronAPI?.file.rename(oldPath, newPath, projectRoot ?? undefined);
        if (!result?.ok) message.error(result?.error || t('ft.renameFailed'));
      } else if (activeOp.type === 'createFolder') {
        const result = await window.electronAPI?.file.createFolder(newPath, projectRoot ?? undefined);
        if (!result?.ok) message.error(result?.error || t('ft.createFolderFailed'));
      } else if (activeOp.type === 'createFile') {
        const result = await window.electronAPI?.file.createFile(newPath, projectRoot ?? undefined);
        if (!result?.ok) message.error(result?.error || t('ft.createFileFailed'));
      }
    } finally {
      setActiveOp(null);
      setInputValue('');
      refresh();
    }
  }, [activeOp, inputValue, projectRoot, refresh, t]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter') void handleFinishOp();
      if (event.key === 'Escape') {
        setActiveOp(null);
        setInputValue('');
      }
    },
    [handleFinishOp],
  );

  return {
    tree,
    hoveredPath,
    setHoveredPath,
    activeOp,
    setActiveOp,
    inputValue,
    setInputValue,
    refresh,
    handleDelete,
    handleStartRename,
    handleStartCreate,
    handleFinishOp,
    handleKeyDown,
  };
}
