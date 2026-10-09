/**
 * ActivityItem.tsx — 一行 Activity（图标 + 标题 + 摘要 + 耗时 + 动作），可展开看详情。
 *
 * 复用既有的 `ax-tool-row*` 样式（24px 单行、无底色、hover 才露 chevron）——
 * 那套视觉本来就是为"执行步骤"设计的，重写一套只会让新旧两处长得不一样。
 */
import { memo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Tooltip } from 'antd';
import {
  ArrowClockwise as ReloadOutlined,
  CaretDown as CaretDownOutlined,
  Check as CheckIcon,
  Copy as CopyIcon,
  Stop as StopOutlined,
} from '@/components/common/icons';
import { useT } from '../../i18n';
import type { ActivityItem as ActivityItemModel, ActivityStatus } from '../../types/activity';
import type { PermissionRequest } from '../../types/advanced';
import { factsChip, presentActivity } from '../../core/activity/presentation';
import { formatDuration } from '../../core/activity/format';
import { liveOutputStats } from '../../core/activity/liveOutput';
import { copyableText } from '../../core/activity/format';
import { shouldAnimateIn } from '../../core/activity/entrance';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import StateDot, { type StateDotState } from '../common/StateDot';
import { ToolIcon } from '../agent/toolIcons';
import ActivityDetail from './ActivityDetail';

/** Activity 状态 → 状态点。cancelled/pending/skipped 用 warning 而不是 error：
 *  它们不是"失败"，用红色报错会误导（用户自己取消的步骤不该看起来像出错）。 */
function dotState(status: ActivityStatus): StateDotState {
  switch (status) {
    case 'running':
    case 'waiting':
      return 'ongoing';
    case 'completed':
      return 'done';
    case 'failed':
      return 'error';
    default:
      return 'warning';
  }
}

/** 真实 ± 行数芯片（改动过大时 `truncated` 为真，那时不猜数字，整个芯片不画）。 */
function DiffChip({ diff }: { diff: ActivityItemModel['diff'] }) {
  if (!diff || diff.truncated || (diff.added <= 0 && diff.removed <= 0)) return null;
  return (
    <span className="ax-tool-row-summary-suffix">
      <span className="text-success">+{diff.added}</span> <span className="text-danger">-{diff.removed}</span>
    </span>
  );
}

/**
 * 一行上的动作簇。
 *
 * 单独一个组件有两个原因：把十几个条件从 `ActivityItem` 里挪出去（否则它的圈复杂度
 * 会顶破 `lint:budget` 的 30），以及让"哪些动作真的能到"这件事只有一个判据 ——
 * Chat 模式没有终端抽屉与右面板，那里画按钮就是死点。
 */
function ActivityActions({
  item,
  running,
  failed,
  canExpand,
  expanded,
  hasPanels,
  isTerminal,
  liveLines,
}: {
  item: ActivityItemModel;
  running: boolean;
  failed: boolean;
  canExpand: boolean;
  expanded: boolean;
  hasPanels: boolean;
  /** 终端族（含 test/build）：只有它们才有"到终端里去看"这回事。 */
  isTerminal: boolean;
  liveLines: number;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copyText = copyableText(item);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(copyText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* 剪贴板被拒：不谎报"已复制" */
      },
    );
  };
  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.requestId || !item.toolCallId) return;
    void window.electronAPI?.ai.abortTool(item.requestId, item.toolCallId);
  };
  const handleRetry = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.requestId || !item.toolCallId || !item.toolName) return;
    useChatStore.getState().retryTool(item.requestId, item.toolCallId, item.toolName);
  };
  const handleViewDiff = (e: React.MouseEvent) => {
    e.stopPropagation();
    const path = item.diff?.path;
    if (!path) return;
    // 请求里带目标面板：只调 setRightPanelView 会被 `openFileRequest` 的联动 effect
    // 覆盖回文件树（此前"查看 Diff"因此永远看不到 diff）。
    useAppStore.getState().setRightPanelView('diff');
    useAppStore.getState().requestOpenFile(path, 'diff');
  };
  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    const path = typeof item.input?.file_path === 'string' ? item.input.file_path : item.diff?.path;
    if (path) useAppStore.getState().requestOpenFile(path);
  };
  const handleOpenTerminal = (e: React.MouseEvent) => {
    e.stopPropagation();
    useAppStore.getState().setActiveToolView('terminal');
  };
  const toolPath = typeof item.input?.file_path === 'string' ? item.input.file_path : undefined;

  return (
    <span className="ax-tool-row-actions">
      {running && liveLines > 0 && (
        <span className="text-2xs text-text-muted font-mono [font-variant-numeric:tabular-nums]">
          {t('activity.live.lines', { n: liveLines })}
        </span>
      )}
      {item.durationMs !== undefined && (
        <span className="text-2xs text-text-muted font-mono [font-variant-numeric:tabular-nums]">
          {formatDuration(item.durationMs)}
        </span>
      )}
      {running && item.toolCallId && (
        <Tooltip title={t('activity.action.stop')} placement="top">
          <button
            type="button"
            aria-label={t('activity.action.stop')}
            className="ax-tool-row-link"
            onClick={handleStop}
          >
            <StopOutlined size={14} />
          </button>
        </Tooltip>
      )}
      {failed && item.requestId && (
        <Tooltip title={t('activity.action.retry')} placement="top">
          <button
            type="button"
            aria-label={t('activity.action.retry')}
            className="ax-tool-row-link"
            onClick={handleRetry}
          >
            <ReloadOutlined size={14} />
          </button>
        </Tooltip>
      )}
      {copyText && (
        <Tooltip title={t(copied ? 'activity.action.copied' : 'activity.action.copy')} placement="top">
          <button
            type="button"
            aria-label={t('activity.action.copy')}
            className="ax-tool-row-link"
            onClick={handleCopy}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </Tooltip>
      )}
      {hasPanels && isTerminal && (
        <button type="button" className="ax-tool-row-link" onClick={handleOpenTerminal}>
          {t('activity.action.openTerminal')}
        </button>
      )}
      {hasPanels && (item.diff?.path || toolPath) && (
        <>
          {item.diff?.path && !item.diff.truncated && (
            <button type="button" className="ax-tool-row-link" onClick={handleViewDiff}>
              {t('activity.action.viewDiff')}
            </button>
          )}
          <button type="button" className="ax-tool-row-link" onClick={handleOpenFile}>
            {t('activity.action.openFile')}
          </button>
        </>
      )}
      {canExpand && <CaretDownOutlined size={14} className={clsx('text-text-muted', expanded && 'rotate-180')} />}
    </span>
  );
}

export interface ActivityItemProps {
  item: ActivityItemModel;
  expanded: boolean;
  onToggle: (key: string, currentlyOpen: boolean) => void;
  /**
   * 嵌套内容（子代理的子步骤）。由上层注入而不是在这里 import ——
   * 直接在组件里 import NestedActivityList 会与它形成 import 环（`check:cycles` 有预算 0）。
   */
  nested?: React.ReactNode;
  /**
   * 权限类型项对应的**原始请求对象**（由 `AgentRun` 经 ActivityList 注入）。
   * 只有 `permission` 类型会有；审批卡片需要它才能显示 diff 复核与倒计时。
   */
  permissionRequest?: PermissionRequest;
}

export default memo(function ActivityItem({ item, expanded, onToggle, nested, permissionRequest }: ActivityItemProps) {
  const t = useT();
  const { title, summary, detailKind } = presentActivity(item);
  const running = item.status === 'running';
  const failed = item.status === 'failed';
  const liveLines = running ? liveOutputStats(item.liveOutput).lines : 0;
  const metricChip = factsChip(item);
  /** 只画**真的能到**的动作：Chat 模式没有终端抽屉与右面板，那些按钮会是死点。 */
  const hasPanels = useAppStore((s) => s.sidebarMode) !== 'chat';
  // 入场动画只播一次：首次渲染这个 id 时判定，重渲染/重挂载都不再播（见 entrance.ts）。
  const animateIn = useRef(shouldAnimateIn(item.id)).current;

  // 折叠时把失败原因提到摘要行 —— 用户不该为了看到"为什么失败"还要展开一次。
  const failureLine = failed && item.error ? item.error.split('\n')[0] : null;
  const summaryText = failureLine ?? summary;
  const canExpand = detailKind !== 'permission' || Boolean(item.input);

  return (
    <div
      className={clsx('ax-tool-row', animateIn && 'ax-activity-in')}
      data-state={item.status}
      data-activity={item.type}
    >
      <div
        className={clsx('ax-tool-row-head', running && 'ax-tool-row-running')}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${title}${summaryText ? `: ${summaryText}` : ''}`}
        onClick={() => canExpand && onToggle(item.id, expanded)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && canExpand) {
            e.preventDefault();
            onToggle(item.id, expanded);
          }
        }}
      >
        <span className="sr-only">{t(`activity.status.${item.status}` as 'activity.status.running')}</span>
        <span className="ax-tool-row-leading">
          <span className="ax-tool-row-icon">
            <StateDot state={dotState(item.status)} />
          </span>
          <span className="ax-tool-row-chevron ax-tool-row-chevron-hover">
            <ToolIcon toolName={item.toolName as never} size={14} />
          </span>
        </span>
        <span className="ax-tool-row-title">{title}</span>
        {summaryText && (
          <>
            <span className="ax-tool-row-sep" aria-hidden />
            <span className={clsx('ax-tool-row-summary', failureLine && 'ax-tool-row-error')} title={summaryText}>
              {summaryText}
            </span>
          </>
        )}
        {metricChip && <span className="ax-tool-row-summary-suffix text-text-faint">{metricChip}</span>}
        <DiffChip diff={item.diff} />
        <ActivityActions
          item={item}
          running={running}
          failed={failed}
          canExpand={canExpand}
          expanded={expanded}
          hasPanels={hasPanels}
          isTerminal={detailKind === 'terminal'}
          liveLines={liveLines}
        />
      </div>
      {expanded && (
        <div className="flex flex-col gap-1 pb-1 pl-5">
          <ActivityDetail item={item} permissionRequest={permissionRequest} />
          {nested}
        </div>
      )}
    </div>
  );
});
