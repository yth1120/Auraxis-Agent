import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import { message, Modal } from 'antd';
import { ArrowsClockwise } from '@/components/common/icons';
import LoadingState from '../common/LoadingState';
import DiffView from '../permissions/DiffView';
import { useAgentStore } from '@/stores/useAgentStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useAppStore } from '@/stores/useAppStore';
import { backfillComposer } from '@/utils/backfillComposer';
import { buildFileFollowUpInstruction } from '@/utils/fileFollowUp';
import { countDiffChanges } from '@/utils/unifiedDiff';
import type { WorkspaceFileDiff } from '@/types/electron-api';

interface DiffPanelProps {
  tabId: string;
}

/** 变更比较范围：本次任务（会话基线）/ 未提交 / 整分支。 */
type DiffScope = 'session' | 'uncommitted' | 'branch';

/** 预览弹窗能显示的类型（真正能不能读由主进程 `file:readPreview` 决定）。 */
const RENDERABLE_EXT = /\.(png|jpe?g|gif|webp|svg|pdf)$/i;

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
  /** 变更比较范围：本次任务（会话基线）/ 未提交 / 整分支。 */
  const [scope, setScope] = useState<DiffScope>('session');
  const [scopeError, setScopeError] = useState<string | null>(null);
  /**
   * 图片 / PDF 预览。原先挂在「产物」面板上——那个面板已并入本面板（列的是同一批
   * 改动文件，而这里信息更全：有 diff、有 revert），所以它的能力跟着搬过来了。
   * 这也是全应用**唯一**能正确显示这两类文件的地方（「文件」面板的预览按纯文本读，
   * 图片会显示成乱码）。
   *
   * 这份扩展名表说明的是"这个弹窗能显示什么"，不是主进程白名单的副本：
   * 真正的门禁仍在 `file:readPreview`。
   */
  const [preview, setPreview] = useState<{ path: string; mime: string; base64: string } | null>(null);

  const fetchDiffs = useCallback(async () => {
    // 整分支/未提交只需要项目路径；本次任务还需要 agent 会话基线。
    if (!projectPath || (scope === 'session' && !currentAgentId)) {
      setDiffs([]);
      return;
    }
    setLoading(true);
    setScopeError(null);
    try {
      if (scope === 'session') {
        const api = window.electronAPI?.undo;
        if (!api?.getSessionDiffs || !currentAgentId) {
          setDiffs([]);
          return;
        }
        const r = await api.getSessionDiffs(currentAgentId, projectPath);
        if (!r.ok) setScopeError(r.error || t('diff.scopeFailed'));
        setDiffs(r.ok && r.data ? r.data : []);
      } else {
        const api = window.electronAPI?.git;
        if (!api?.diffScope) {
          setDiffs([]);
          return;
        }
        const r = await api.diffScope(scope, projectPath);
        // 非 git 仓库等情况：给出原因，而不是静默显示「没有变更」。
        if (!r.ok) setScopeError(r.error || t('diff.scopeFailed'));
        setDiffs(r.ok && r.data ? r.data : []);
      }
    } catch {
      setScopeError(t('diff.scopeFailed'));
      setDiffs([]);
    } finally {
      setLoading(false);
    }
  }, [currentAgentId, projectPath, scope, t]);

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

  /**
   * 执行视图的「查看 Diff」把**那个文件**带过来：列表加载/刷新后选中它，
   * 而不是让用户自己在一堆变更里再找一遍。
   */
  const openFileRequest = useAppStore((s) => s.openFileRequest);
  useEffect(() => {
    if (!openFileRequest || openFileRequest.target !== 'diff') return;
    const idx = diffs.findIndex((d) => d.path === openFileRequest.path);
    if (idx >= 0) setSelected(idx);
  }, [openFileRequest, diffs]);

  const current = diffs[selected];
  // 回滚/继续这些动作只对「本次任务」口径成立：未提交/整分支的差异不是本会话的产物。
  const sessionScoped = scope === 'session';
  const actionable = sessionScoped && settled && diffs.length > 0 && !busy;

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
    if (!currentAgentId || !sessionScoped) return;
    backfillComposer(buildFileFollowUpInstruction(d.path, d.oldContent ?? '', d.newContent ?? ''), currentAgentId);
  };

  /** 一键让 Agent 审查全部变更（原「审查」面板的独有能力，已合并进变更面板）。 */
  const reviewAll = () => {
    if (!currentAgentId || diffs.length === 0) return;
    let added = 0;
    let removed = 0;
    const summary = diffs
      .map((d) => {
        const counts = countDiffChanges(d.oldContent ?? '', d.newContent ?? '');
        added += counts.added;
        removed += counts.removed;
        return `- ${d.path}: +${counts.added} / -${counts.removed}`;
      })
      .join('\n');
    backfillComposer(
      `请审查当前任务的全部变更（${diffs.length} 个文件，+${added} / -${removed} 行）：\n\n${summary}\n\n请按优先级指出问题：回归风险、缺失测试、安全问题、可读性，并给出具体修复建议（P0 问题必须先修）。`,
      currentAgentId,
    );
  };

  const gitBtn =
    'flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-muted text-sm cursor-pointer transition-colors duration-150 ease-out enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default';
  const smallBtn =
    'text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer enabled:hover:bg-[var(--color-hover)] enabled:hover:text-text-secondary disabled:opacity-40 disabled:cursor-default';

  /** 打开图片 / PDF 预览（见上方 `preview` 的说明）。 */
  const openPreview = async (filePath: string) => {
    const api = window.electronAPI?.file;
    if (!api?.readPreview) return;
    try {
      const r = await api.readPreview(filePath, projectPath || undefined);
      if (!r.ok || !r.data) {
        if (r.error) message.error(r.error);
        return;
      }
      setPreview(r.data);
    } catch {
      message.error(t('preview.failed'));
    }
  };

  const copyPath = (filePath: string) => {
    void navigator.clipboard?.writeText(filePath).then(() => message.success(t('artifacts.copied')));
  };

  return (
    <div className="flex flex-col h-full w-full bg-transparent overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-dim)] shrink-0">
        <span className="font-semibold text-xs text-text-secondary">
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
            className={smallBtn}
            onClick={reviewAll}
            disabled={diffs.length === 0}
            title={t('review.askAgentTip')}
          >
            {t('review.askAgent')}
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

      {/* 比较范围切换：对齐 Codex 桌面端变更面板的「未提交 / 整分支 / 最近一轮」。 */}
      <div className="flex items-center gap-0.5 px-2 pb-2 shrink-0" role="tablist" aria-label={t('diff.scopeLabel')}>
        {(
          [
            ['session', 'diff.scopeSession'],
            ['uncommitted', 'diff.scopeUncommitted'],
            ['branch', 'diff.scopeBranch'],
          ] as const
        ).map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={scope === value}
            title={t(labelKey)}
            onClick={() => setScope(value)}
            className={clsx(
              'h-6 px-2 rounded-full border-none text-2xs font-medium cursor-pointer transition-colors duration-150 ease-out',
              scope === value
                ? 'bg-[var(--color-primary-soft)] text-text-primary'
                : 'bg-transparent text-text-muted hover:bg-[var(--color-hover)] hover:text-text-secondary',
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {!currentAgentId && sessionScoped ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-text-muted">{t('diff.empty')}</div>
      ) : !projectPath ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-text-muted">{t('diff.empty')}</div>
      ) : scopeError ? (
        <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-text-muted text-center">
          {scopeError}
        </div>
      ) : diffs.length === 0 ? (
        loading ? (
          <LoadingState label={t('diff.loading')} />
        ) : (
          <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-text-muted">
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
                      'flex items-baseline gap-[6px] flex-1 min-w-0 py-2 px-3 border-none bg-transparent text-xs text-left cursor-pointer overflow-hidden transition-colors duration-150 ease-out',
                      'hover:bg-[var(--color-hover)]',
                      i === selected && 'bg-[var(--color-bg-inset)]',
                    )}
                    onClick={() => setSelected(i)}
                    title={d.path}
                  >
                    <span className="font-mono whitespace-nowrap shrink-0 text-text-primary">{name}</span>
                    {dir && (
                      <span className="font-mono text-2xs text-text-muted whitespace-nowrap overflow-hidden text-ellipsis">
                        {dir}
                      </span>
                    )}
                  </button>
                  {/* 悬停才显形，避免挤占本就不宽的行（原「产物」面板的惯例）。
                      图片 / PDF 的预览是全应用独一份的能力，随面板合并搬到这里。 */}
                  <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
                    {RENDERABLE_EXT.test(d.path) && (
                      <button
                        type="button"
                        className={smallBtn}
                        onClick={() => void openPreview(d.path)}
                        title={t('artifacts.preview')}
                      >
                        {t('artifacts.preview')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={smallBtn}
                      onClick={() => copyPath(d.path)}
                      title={t('artifacts.copyPath')}
                    >
                      {t('artifacts.copyPath')}
                    </button>
                  </span>
                  {sessionScoped && settled && (
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
              <div className="flex-1 flex items-center justify-center p-8 px-4 text-xs text-text-muted">
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

      {/* 图片 / PDF 预览：全应用唯一能正确显示这两类文件的地方 */}
      <Modal
        open={Boolean(preview)}
        onCancel={() => setPreview(null)}
        footer={null}
        centered
        width={720}
        transitionName=""
        maskTransitionName=""
        title={preview ? preview.path.split(/[/\\]/).pop() : ''}
      >
        {preview?.mime.startsWith('image/') ? (
          <img
            src={`data:${preview.mime};base64,${preview.base64}`}
            alt={preview.path}
            className="block max-w-full max-h-[70vh] mx-auto"
          />
        ) : preview?.mime === 'application/pdf' ? (
          <iframe
            src={`data:application/pdf;base64,${preview.base64}`}
            title={preview.path}
            className="w-full h-[70vh] border-0"
          />
        ) : null}
      </Modal>
    </div>
  );
}
