import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { message } from 'antd';
import { ArrowsClockwise } from '@/components/common/icons';
import LoadingState from '../common/LoadingState';
import DiffView from '../permissions/DiffView';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useAppStore } from '@/stores/useAppStore';
import { backfillComposer } from '@/utils/backfillComposer';
import { buildFileFollowUpInstruction } from '@/utils/fileFollowUp';
import type { WorkspaceFileDiff } from '@/types/electron-api';

interface DiffPanelProps {
  tabId: string;
}

/**
 * 任务变更 review surface: per-file accept / revert / continue, plus
 * accept-all (workspace merge) and revert-all (back to task baseline).
 */
export default function DiffPanel({ tabId: _tabId }: DiffPanelProps) {
  const t = useT();
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agentStatus = useAgentStore((s) => s.agents.find((a) => a.id === s.currentAgentId)?.status);
  const projectPath = useSettingsStore((s) => s.projectPath);
  const [diffs, setDiffs] = useState<WorkspaceFileDiff[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchDiffs = useCallback(async () => {
    const api = window.electronAPI?.undo;
    if (!currentAgentId || !projectPath || !api?.getSessionDiffs) {
      setDiffs([]);
      return;
    }
    setLoading(true);
    try {
      const r = await api.getSessionDiffs(currentAgentId, projectPath);
      setDiffs(r.ok && r.data ? r.data : []);
    } catch {
      setDiffs([]);
    } finally {
      setLoading(false);
    }
  }, [currentAgentId, projectPath]);

  // Refetch on mount, on agent switch, and when the task settles (the sandbox
  // stops mutating once the run ends, so that's when the diff is meaningful).
  const settled = agentStatus === 'completed' || agentStatus === 'error' || agentStatus === 'stopped';
  useEffect(() => {
    fetchDiffs();
  }, [fetchDiffs, settled]);

  // Keep selection within bounds when the list changes.
  useEffect(() => {
    if (selected >= diffs.length) setSelected(0);
  }, [diffs.length, selected]);

  const current = diffs[selected];
  const actionable = settled && diffs.length > 0 && !busy;

  const revertFile = async (d: WorkspaceFileDiff) => {
    if (!currentAgentId || !projectPath) return;
    setBusy(true);
    try {
      const r = await window.electronAPI?.undo?.revertSessionFile(currentAgentId, d.path, projectPath);
      if (!r?.ok) {
        message.error(r?.error || t('diff.revertFailed'));
        return;
      }
      message.success(t('diff.reverted', { path: d.path }));
      useAppStore.getState().incrementFileTreeVersion();
      await fetchDiffs();
    } finally {
      setBusy(false);
    }
  };

  const revertAll = async () => {
    if (!currentAgentId || !projectPath || diffs.length === 0) return;
    setBusy(true);
    try {
      let okCount = 0;
      for (const d of diffs) {
        const r = await window.electronAPI?.undo?.revertSessionFile(currentAgentId, d.path, projectPath);
        if (r?.ok) okCount += 1;
      }
      message.success(t('diff.revertedN', { n: okCount }));
      useAppStore.getState().incrementFileTreeVersion();
      await fetchDiffs();
    } finally {
      setBusy(false);
    }
  };

  const continueFile = (d: WorkspaceFileDiff) => {
    if (!currentAgentId) return;
    backfillComposer(buildFileFollowUpInstruction(d.path, d.oldContent ?? '', d.newContent ?? ''), currentAgentId);
  };

  const gitBtn =
    'flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-muted text-sm cursor-pointer transition-colors duration-fast ease-out enabled:hover:bg-[var(--color-hover)] enabled:hover:text-secondary disabled:opacity-40 disabled:cursor-default';
  const smallBtn =
    'text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default';

  return (
    <div className="flex flex-col h-full w-full bg-transparent overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-dim)] shrink-0">
        <span className="font-semibold text-xs text-secondary">
          {t('diff.title')}
          {diffs.length > 0 && ` · ${t('diff.fileCount', { n: diffs.length })}`}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default"
            onClick={() => void revertAll()}
            disabled={!actionable}
            title={t('diff.revertAllTip')}
          >
            {t('diff.revertAll')}
          </button>
          <button
            type="button"
            className={gitBtn}
            onClick={fetchDiffs}
            disabled={!currentAgentId || loading}
            title={t('diff.refresh')}
          >
            <ArrowsClockwise className={loading ? 'ax-spin' : undefined} />
          </button>
        </span>
      </div>

      {!currentAgentId ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-muted">{t('diff.empty')}</div>
      ) : diffs.length === 0 ? (
        loading ? (
          <LoadingState label={t('diff.loading')} />
        ) : (
          <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-muted">
            {t('diff.unchanged')}
          </div>
        )
      ) : (
        <>
          <ul className="list-none m-0 py-1 max-h-[30%] overflow-y-auto border-b border-[var(--color-border-dim)] shrink-0">
            {diffs.map((d, i) => {
              const slash = d.path.lastIndexOf('/');
              const name = slash >= 0 ? d.path.slice(slash + 1) : d.path;
              const dir = slash >= 0 ? d.path.slice(0, slash) : '';
              return (
                <li key={d.path} className="group flex items-center gap-1">
                  <button
                    type="button"
                    className={clsx(
                      'flex items-baseline gap-[6px] flex-1 min-w-0 py-2 px-3 border-none bg-transparent text-xs text-left cursor-pointer overflow-hidden transition-colors duration-fast ease-out',
                      'hover:bg-[var(--color-hover)]',
                      i === selected && 'bg-[var(--color-bg-inset)]',
                    )}
                    onClick={() => setSelected(i)}
                    title={d.path}
                  >
                    <span className="font-mono whitespace-nowrap shrink-0 text-text-primary">{name}</span>
                    {dir && (
                      <span className="font-mono text-2xs text-muted whitespace-nowrap overflow-hidden text-ellipsis">
                        {dir}
                      </span>
                    )}
                  </button>
                  {settled && (
                    <span className="flex items-center gap-0.5 pr-2 shrink-0">
                      <button type="button" className={smallBtn} disabled={busy} onClick={() => void revertFile(d)}>
                        {t('diff.revert')}
                      </button>
                      <button
                        type="button"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() => continueFile(d)}
                        title={t('diff.continueTip')}
                      >
                        {t('diff.continue')}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="flex-1 overflow-auto p-[10px]">
            {current?.skipped ? (
              <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-muted">
                {current.skipped === 'binary' ? t('diff.binary') : t('diff.tooLarge')}
              </div>
            ) : current ? (
              <DiffView
                oldContent={current.oldContent || ''}
                newContent={current.newContent || ''}
                fileName={current.path}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
