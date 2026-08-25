import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Segmented, message } from 'antd';
import { useT } from '../../i18n';
import { useSettingsStore } from '../../stores/useSettingsStore';
import InlineEmpty from '../common/InlineEmpty';

type Scope = 'global' | 'project' | 'folder';

interface FolderEntry {
  relPath: string;
  hasOverride: boolean;
  hasAgents: boolean;
}

/**
 * Instructions pane — global AGENTS.md + project-root + folder-level AGENTS.md.
 * Matches the loader precedence (global → root → nested folders).
 */
export default function ProjectRulesPane() {
  const t = useT();
  const projectPath = useSettingsStore((s) => s.projectPath);
  const [scope, setScope] = useState<Scope>('global');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('.');
  const [customFolder, setCustomFolder] = useState('');
  const [targetPath, setTargetPath] = useState('');

  const folderOptions = useMemo(() => {
    const list = folders.length > 0 ? [...folders] : [];
    if (projectPath && !list.some((f) => f.relPath === '.')) {
      list.unshift({ relPath: '.', hasOverride: false, hasAgents: false });
    }
    return list;
  }, [folders, projectPath]);

  const loadFolders = useCallback(async () => {
    if (!projectPath) {
      setFolders([]);
      return;
    }
    try {
      const result = await window.electronAPI?.instructions?.listProject(projectPath);
      setFolders(result?.ok && result.data ? result.data : []);
    } catch {
      setFolders([]);
    }
  }, [projectPath]);

  const loadContent = useCallback(
    async (nextScope: Scope, folderRel = selectedFolder) => {
      setLoading(true);
      try {
        if (nextScope === 'global') {
          const result = await window.electronAPI?.instructions?.getGlobal();
          if (result?.ok && result.data) {
            setContent(result.data.content);
            setTargetPath(result.data.path);
          } else {
            setContent('');
            setTargetPath('');
          }
          return;
        }
        if (!projectPath) {
          setContent('');
          setTargetPath('');
          return;
        }
        const rel = nextScope === 'project' ? '.' : folderRel || '.';
        const result = await window.electronAPI?.instructions?.get(projectPath, rel);
        if (result?.ok && result.data) {
          setContent(result.data.content);
          setTargetPath(result.data.path);
        } else {
          setContent('');
          setTargetPath('');
        }
      } catch {
        setContent('');
        setTargetPath('');
      } finally {
        setLoading(false);
      }
    },
    [projectPath, selectedFolder],
  );

  const loadContentRef = useRef(loadContent);
  loadContentRef.current = loadContent;

  useEffect(() => {
    void loadFolders();
    void loadContentRef.current(scope);
  }, [projectPath, scope, loadFolders]);

  const save = async () => {
    setSaving(true);
    try {
      let ok = false;
      let error = '';
      if (scope === 'global') {
        const r = await window.electronAPI?.instructions?.setGlobal(content);
        ok = !!r?.ok;
        error = r?.error || '';
      } else if (projectPath) {
        const rel = scope === 'project' ? '.' : selectedFolder || '.';
        const r = await window.electronAPI?.instructions?.set(projectPath, rel, content);
        ok = !!r?.ok;
        error = r?.error || '';
      } else {
        error = t('settings.projectRules.needProject');
      }
      if (ok) {
        message.success(t('settings.projectRules.saved'));
        void loadFolders();
      } else {
        message.error(error || t('settings.projectRules.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const openFolder = async (rel: string) => {
    setSelectedFolder(rel);
    await loadContent('folder', rel);
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="m-0 text-lg font-semibold text-text-primary tracking-[-0.01em]">
          {t('settings.projectRules.title')}
        </h2>
        <p className="m-0 mt-1 text-xs text-text-muted leading-[1.6]">{t('settings.projectRules.desc')}</p>
      </div>

      <Segmented
        value={scope}
        onChange={(v) => {
          const next = v as Scope;
          setScope(next);
          void loadContent(next);
        }}
        options={[
          { label: t('settings.instructions.global'), value: 'global' },
          { label: t('settings.instructions.project'), value: 'project' },
          { label: t('settings.instructions.folder'), value: 'folder' },
        ]}
      />

      {scope === 'folder' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {folderOptions.map((f) => (
              <button
                key={f.relPath}
                className={`px-2.5 h-7 rounded-lg text-xs font-medium border-none cursor-pointer ${
                  selectedFolder === f.relPath
                    ? 'bg-primary-soft text-text-primary'
                    : 'bg-[var(--color-bg-secondary)] text-text-secondary hover:text-text-primary'
                }`}
                onClick={() => void openFolder(f.relPath)}
                title={f.hasOverride ? 'AGENTS.override.md' : f.hasAgents ? 'AGENTS.md' : undefined}
              >
                {f.relPath === '.' ? t('settings.instructions.projectRoot') : f.relPath}
                {(f.hasOverride || f.hasAgents) && <span className="ml-1 opacity-60">●</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              size="small"
              value={customFolder}
              onChange={(e) => setCustomFolder(e.target.value)}
              placeholder={t('settings.instructions.folderPlaceholder')}
              className="!w-64"
            />
            <Button
              size="small"
              disabled={!customFolder.trim()}
              onClick={() => void openFolder(customFolder.trim().replace(/^[\\/]+/, ''))}
            >
              {t('settings.instructions.loadFolder')}
            </Button>
          </div>
        </div>
      )}

      {scope !== 'global' && !projectPath ? (
        <InlineEmpty description={t('settings.projectRules.needProject')} compact />
      ) : (
        <>
          <textarea
            className="w-full h-64 resize-y rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] p-3 font-mono text-xs text-text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('settings.projectRules.empty')}
            aria-label={t('settings.projectRules.title')}
            spellCheck={false}
          />
          <div className="flex items-center gap-2">
            <Button type="primary" loading={saving} onClick={save}>
              {t('settings.projectRules.save')}
            </Button>
            {loading && <span className="text-2xs text-text-faint">{t('settings.projectRules.loading')}</span>}
            {targetPath && (
              <span className="ml-auto text-2xs text-text-faint font-mono truncate max-w-[320px]" title={targetPath}>
                {targetPath}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
