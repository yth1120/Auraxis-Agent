import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { message } from 'antd';
import { ArrowsClockwise, ShieldCheck } from '@/components/common/icons';
import DiffView from '../permissions/DiffView';
import { useAgentStore } from '@/stores/useAgentStore';
import { useAppStore } from '@/stores/useAppStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { backfillComposer } from '@/utils/backfillComposer';
import { buildFileFollowUpInstruction } from '@/utils/fileFollowUp';
import { countDiffChanges } from '@/utils/unifiedDiff';
import type { WorkspaceFileDiff } from '@/types/electron-api';

interface FileReview {
  diff: WorkspaceFileDiff;
  added: number;
  removed: number;
  churn: number;
}

/**
 * Agentic review surface: change summary,
 * recommended review order (by churn), inline diff per file, and one-click
 * "让 Agent 审查" follow-up. All local — no GitHub dependency.
 */
export default function ReviewPanel() {
  const t = useT();
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agentStatus = useAgentStore((s) => s.agents.find((a) => a.id === s.currentAgentId)?.status);
  const agentProjectRoot = useAgentStore((s) => s.agents.find((a) => a.id === s.currentAgentId)?.projectRoot);
  const settingsProjectPath = useSettingsStore((s) => s.projectPath);
  const projectPath = agentProjectRoot || settingsProjectPath;
  const [diffs, setDiffs] = useState<WorkspaceFileDiff[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);

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

  const settled = agentStatus === 'completed' || agentStatus === 'error' || agentStatus === 'stopped';
  useEffect(() => {
    fetchDiffs();
  }, [fetchDiffs, settled]);

  const files = useMemo<FileReview[]>(
    () =>
      diffs
        .filter((d) => !d.skipped)
        .map((d) => {
          const { added, removed } = countDiffChanges(d.oldContent || '', d.newContent || '');
          return { diff: d, added, removed, churn: added + removed };
        })
        .sort((a, b) => b.churn - a.churn),
    [diffs],
  );

  useEffect(() => {
    if (selected >= files.length) setSelected(0);
  }, [files.length, selected]);

  const totals = useMemo(
    () =>
      files.reduce((acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }), {
        added: 0,
        removed: 0,
      }),
    [files],
  );
  const maxChurn = Math.max(1, ...files.map((f) => f.churn));
  const current = files[selected];

  const revertFile = async (d: WorkspaceFileDiff) => {
    if (!currentAgentId || !projectPath) return;
    const r = await window.electronAPI?.undo?.revertSessionFile(currentAgentId, d.path, projectPath);
    if (!r?.ok) {
      message.error(r?.error || t('diff.revertFailed'));
      return;
    }
    message.success(t('diff.reverted', { path: d.path }));
    useAppStore.getState().incrementFileTreeVersion();
    await fetchDiffs();
  };

  const revertAll = async () => {
    if (!currentAgentId || !projectPath || files.length === 0) return;
    let reverted = 0;
    for (const f of files) {
      const r = await window.electronAPI?.undo?.revertSessionFile(currentAgentId, f.diff.path, projectPath);
      if (r?.ok) reverted += 1;
    }
    message.success(t('diff.revertedN', { n: reverted }));
    useAppStore.getState().incrementFileTreeVersion();
    await fetchDiffs();
  };

  const reviewAll = () => {
    if (!currentAgentId || files.length === 0) return;
    const summary = files.map((f) => `- ${f.diff.path}: +${f.added} / -${f.removed}`).join('\n');
    backfillComposer(
      `请审查当前任务的全部变更（${files.length} 个文件，+${totals.added} / -${totals.removed} 行）：\n\n${summary}\n\n请按优先级指出问题：回归风险、缺失测试、安全问题、可读性，并给出具体修复建议（P0 问题必须先修）。`,
      currentAgentId,
    );
  };

  const smallBtn =
    'text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default';

  return (
    <div className="flex flex-col h-full w-full bg-transparent overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-dim)] shrink-0">
        <span className="flex items-center gap-1.5 font-semibold text-xs text-secondary">
          <ShieldCheck size={14} className="text-primary" />
          {t('review.title')}
          {files.length > 0 &&
            ` · ${t('review.fileSummary', { n: files.length, added: totals.added, removed: totals.removed })}`}
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default"
            onClick={() => void revertAll()}
            disabled={!settled || files.length === 0}
            title={t('diff.revertAllTip')}
          >
            {t('diff.revertAll')}
          </button>
          <button
            type="button"
            className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default"
            onClick={reviewAll}
            disabled={files.length === 0}
            title={t('review.askAgentTip')}
          >
            {t('review.askAgent')}
          </button>
          <button
            type="button"
            className="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-muted text-sm cursor-pointer transition-colors duration-fast ease-out enabled:hover:bg-[var(--color-hover)] enabled:hover:text-secondary disabled:opacity-40 disabled:cursor-default"
            onClick={fetchDiffs}
            disabled={!currentAgentId || loading}
            title={t('review.refresh')}
          >
            <ArrowsClockwise className={loading ? 'ax-spin' : undefined} />
          </button>
        </span>
      </div>

      {!currentAgentId ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-muted">{t('review.empty')}</div>
      ) : files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-muted">
          {loading ? t('review.loading') : diffs.length > 0 ? t('review.binary') : t('review.unchanged')}
        </div>
      ) : (
        <>
          <div className="px-3 pt-2 pb-1 text-2xs font-semibold text-text-muted tracking-wide shrink-0">
            {t('review.files')}
          </div>
          <ul className="list-none m-0 py-1 max-h-[34%] overflow-y-auto border-b border-[var(--color-border-dim)] shrink-0">
            {files.map((f, i) => {
              const slash = f.diff.path.lastIndexOf('/');
              const name = slash >= 0 ? f.diff.path.slice(slash + 1) : f.diff.path;
              const dir = slash >= 0 ? f.diff.path.slice(0, slash) : '';
              return (
                <li key={f.diff.path}>
                  <button
                    type="button"
                    className={clsx(
                      'flex items-center gap-2 w-full py-[3px] px-3 border-none bg-transparent text-xs text-left cursor-pointer overflow-hidden transition-colors duration-fast ease-out',
                      'hover:bg-[var(--color-hover)]',
                      i === selected && 'bg-[var(--color-bg-inset)]',
                    )}
                    onClick={() => setSelected(i)}
                    title={f.diff.path}
                  >
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="flex items-baseline gap-[6px] min-w-0">
                        <span className="font-mono whitespace-nowrap shrink-0 text-text-primary">{name}</span>
                        {dir && (
                          <span className="font-mono text-2xs text-muted whitespace-nowrap overflow-hidden text-ellipsis">
                            {dir}
                          </span>
                        )}
                      </span>
                      <span className="inline-block h-[3px] w-24 rounded-full bg-[var(--color-bg-inset)] overflow-hidden">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${Math.max(4, Math.round((f.churn / maxChurn) * 100))}%` }}
                        />
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-1.5 text-2xs tabular-nums">
                      <span className="text-[var(--color-success)]">+{f.added}</span>
                      <span className="text-danger">-{f.removed}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto p-[10px]">
              {current ? (
                <DiffView
                  oldContent={current.diff.oldContent || ''}
                  newContent={current.diff.newContent || ''}
                  fileName={current.diff.path}
                />
              ) : null}
            </div>
            <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-t border-[var(--color-border-dim)]">
              <span className="text-2xs text-text-muted">{t('review.orderHint')}</span>
              <span className="flex items-center gap-1">
                {settled && (
                  <button type="button" className={smallBtn} onClick={() => void revertFile(current.diff)}>
                    {t('diff.revert')}
                  </button>
                )}
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() =>
                    current &&
                    backfillComposer(
                      buildFileFollowUpInstruction(
                        current.diff.path,
                        current.diff.oldContent || '',
                        current.diff.newContent || '',
                      ),
                      currentAgentId,
                    )
                  }
                >
                  {t('review.continueFile')}
                </button>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
