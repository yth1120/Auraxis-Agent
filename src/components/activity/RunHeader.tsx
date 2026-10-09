/**
 * RunHeader.tsx — Run 的状态与动态摘要。
 *
 * 摘要**全部来自真实字段**（`stats` / `completedAt` / `terminal.reason`），没有一个是写死的：
 *   执行中   ● Working      6 步 · 18s
 *   完成     ✓ Completed    8 步 · 42s · 3 个文件
 *   有错误   ⚠ Completed    9 步 · 32s · 1 个错误
 *   失败     ✕ Failed       …
 *   中止     ⊘ Cancelled    停在 12s（用户停止 / 超时 / 连接中断）
 *
 * 运行中每 500ms 走一次时钟：**只为了让"已耗时"这三个字继续走**，
 * 不参与任何状态推导（状态永远由真实终态或流状态决定）。
 */
import { memo, useEffect, useState } from 'react';
import clsx from 'clsx';
import { useT } from '../../i18n';
import type { ActivityRun } from '../../types/activity';
import type { RunTerminal } from '../../core/activity/model';
import { formatDuration } from '../../core/activity/format';
import StateDot, { type StateDotState } from '../common/StateDot';
import { useChatStore } from '../../stores/useChatStore';

export interface RunHeaderProps {
  run: ActivityRun;
  terminal?: RunTerminal;
}

function runDotState(run: ActivityRun): StateDotState {
  switch (run.status) {
    case 'running':
    case 'waiting':
    case 'pending':
      return 'ongoing';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'completed':
      return run.stats.errors > 0 ? 'warning' : 'done';
    default:
      return 'done';
  }
}

/** 终止原因用用户的话说清楚 —— "已取消"三个字分不出是用户停的还是断了。 */
function terminalReasonKey(
  reason: RunTerminal['reason'],
): 'activity.run.reasonStopped' | 'activity.run.reasonTimeout' | 'activity.run.reasonDisconnected' {
  if (reason === 'timeout') return 'activity.run.reasonTimeout';
  if (reason === 'disconnected') return 'activity.run.reasonDisconnected';
  return 'activity.run.reasonStopped';
}

export default memo(function RunHeader({ run, terminal }: RunHeaderProps) {
  const t = useT();
  const live = run.status === 'running' || run.status === 'waiting' || run.status === 'pending';
  const [tick, setTick] = useState(0);
  // 轮次进度：只属于**正在跑的这一轮**（chat store 里存的是当前请求的值，
  // 历史 Run 借它显示就会张冠李戴），所以用 `live` 门控；刷新后取不到就是 null，
  // 界面不显示，而不是编一个上限。
  const currentIteration = useChatStore((s) => (live ? s.currentIteration : null));
  const maxIterations = useChatStore((s) => (live ? s.maxIterations : null));

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [live]);
  void tick;

  const elapsed = run.completedAt !== undefined ? run.completedAt - run.startedAt : Date.now() - run.startedAt;

  const label =
    run.status === 'running' || run.status === 'pending'
      ? t('activity.run.working')
      : run.status === 'waiting'
        ? t('activity.run.waiting')
        : run.status === 'failed'
          ? t('activity.run.failed')
          : run.status === 'cancelled'
            ? t('activity.run.cancelled')
            : run.stats.errors > 0
              ? t('activity.run.completedWithErrors')
              : t('activity.run.completed');

  const parts: string[] = [formatDuration(Math.max(0, elapsed))];
  if (run.stats.filesChanged > 0) parts.push(t('activity.run.files', { n: run.stats.filesChanged }));
  if (run.stats.errors > 0) parts.push(t('activity.run.errors', { n: run.stats.errors }));
  // 这两个数早就算好了却从没显示过（子代理 / 终端次数）—— 用户判断"这轮干了多少事"要靠它们。
  if (run.stats.subAgents > 0) parts.push(t('activity.run.subAgents', { n: run.stats.subAgents }));
  if (run.stats.terminals > 0) parts.push(t('activity.run.terminals', { n: run.stats.terminals }));

  const summaryText = t('activity.run.summary', { n: run.stats.actions, detail: parts.join(' · ') });

  // 这一行在窄主列（右栏拖满时主区只剩 480px，正文列仅 ~388px）下曾会**折行**：
  // 三个文本 span 都没有收缩约束，flex 会按比例把它们压窄、中文逐字断行，
  // 整行从 1 行涨到 2-3 行、状态点被顶到中间。改成「固定段不收缩 + 摘要段单独省略」：
  // 永远单行，被省略的那段用 title 兜住完整信息。
  return (
    <div className="flex items-center gap-2 py-0.5 min-w-0 select-none" data-run-status={run.status}>
      <StateDot state={runDotState(run)} />
      <span
        className={clsx(
          'shrink-0 whitespace-nowrap text-xs font-medium',
          run.stats.errors > 0 ? 'text-warning' : live ? 'text-primary' : 'text-text-secondary',
        )}
      >
        {label}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-2xs text-text-muted [font-variant-numeric:tabular-nums]"
        title={summaryText}
      >
        {summaryText}
      </span>
      {currentIteration !== null && maxIterations !== null && (
        <span className="shrink-0 whitespace-nowrap text-2xs text-text-muted [font-variant-numeric:tabular-nums]">
          · {t('activity.run.round', { n: currentIteration, max: maxIterations })}
        </span>
      )}
      {run.status === 'cancelled' && terminal?.reason && (
        <span className="min-w-0 max-w-[45%] truncate text-2xs text-text-muted">
          · {t(terminalReasonKey(terminal.reason))}
        </span>
      )}
    </div>
  );
});
