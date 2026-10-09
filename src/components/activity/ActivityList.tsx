/**
 * ActivityList.tsx — 有序 Activity 列表。
 *
 * 顶层以 `aggregateActivities` 产出的**段**为单位：
 *   · `single` 段 → 直接一行 `ActivityItem`；
 *   · `aggregate` 段（连续 ≥3 个同类已完成操作）→ 一行聚合头，展开后是**真实的**那几行。
 *
 * 批次（`stepGroupId`）从前是顶层的一种分组，现在不再出现在这里 —— 那是"同一轮 LLM
 * 并行派发"的实现细节，用户读的是"agent 做了什么"。展开聚合段看到的就是原始顺序。
 *
 * 长任务（已结束且段数超过 `FOLD_THRESHOLD`）把最早的段折成一行，展开仍是真实段。
 *
 * 折叠策略（用户手动优先）：运行中 / 等确认默认展开，结束默认收缩，用户点过听用户的
 * （`activityIsExpanded`，键是段 key / 项 id，**不新增 store 字段**）。
 */
import { memo, useRef } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { CaretRight as RightOutlined, Clock as ClockIcon } from '@/components/common/icons';
import { useT } from '../../i18n';
import type { ActivityRun, ActivityStatus } from '../../types/activity';
import type { PermissionRequest } from '../../types/advanced';
import { selectRootItems } from '../../core/activity/model';
import { aggregateActivities, foldLongHistory, type ActivitySegment } from '../../core/activity/aggregate';
import { presentAggregate } from '../../core/activity/presentation';
import { activityIsExpanded, useActivityStore } from '../../stores/useActivityStore';
import { shouldAnimateIn } from '../../core/activity/entrance';
import { ToolIcon } from '../agent/toolIcons';
import StateDot from '../common/StateDot';
import ActivityItem from './ActivityItem';
import NestedActivityList from './NestedActivityList';

export interface ActivityListProps {
  run: ActivityRun;
  /**
   * 权限请求原始对象（Activity 项 id → 请求）。由 `AgentRun` 注入 —— 审批卡片需要
   * `oldContent` / `timestamp` 这些 Activity 项里没有的字段，重建会丢信息。
   */
  permissions?: ReadonlyMap<string, PermissionRequest>;
}

/** 可折叠的头：聚合段与"被折叠的历史"共用（它们是同一件事：一段被收起来的真实步骤）。 */
function SegmentHeader({
  icon,
  title,
  summary,
  status,
  open,
  onToggle,
  testId,
}: {
  icon: ReactNode;
  title: string;
  summary: string;
  status: ActivityStatus;
  open: boolean;
  onToggle: () => void;
  testId: string;
}) {
  const animateIn = useRef(shouldAnimateIn(testId)).current;
  return (
    <div
      className={clsx('flex items-center gap-2 h-6 cursor-pointer select-none', animateIn && 'ax-activity-in')}
      data-segment={testId}
      data-status={status}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span
        className={clsx(
          'flex items-center justify-center w-4 shrink-0 text-2xs text-text-muted transition-transform duration-200 ease-in',
          open && 'rotate-90',
        )}
      >
        <RightOutlined />
      </span>
      {status === 'running' ? <StateDot state="ongoing" /> : icon}
      <span className="text-xs font-medium text-text-secondary leading-none">{title}</span>
      {summary && (
        <>
          <span className="ax-tool-row-sep" aria-hidden />
          <span className="ax-tool-row-summary text-xs">{summary}</span>
        </>
      )}
    </div>
  );
}

export default memo(function ActivityList({ run, permissions }: ActivityListProps) {
  const t = useT();
  const overrides = useActivityStore((s) => s.overrides);
  const toggleExpanded = useActivityStore((s) => s.toggleExpanded);
  const runLive = run.status === 'running' || run.status === 'waiting' || run.status === 'pending';
  const segments = aggregateActivities(selectRootItems(run));
  const folded = runLive ? null : foldLongHistory(segments);
  const foldedOpen = activityIsExpanded('folded', 'completed', false, overrides);

  /** 子代理的子步骤内联在它自己的行下面（内容由这里注入，见 ActivityItem 的 nested 说明）。 */
  const nestedFor = (item: ActivitySegment['items'][number]) =>
    item.type === 'sub_agent' ? <NestedActivityList parent={item} /> : undefined;

  /** 审批卡片要的是原始请求对象，不是从项里重建的残缺副本。 */
  const permissionFor = (item: ActivitySegment['items'][number]) =>
    item.type === 'permission' ? permissions?.get(item.id) : undefined;

  const renderItem = (item: ActivitySegment['items'][number]) => (
    <ActivityItem
      key={item.id}
      item={item}
      expanded={activityIsExpanded(item.id, item.status, runLive, overrides)}
      onToggle={toggleExpanded}
      nested={nestedFor(item)}
      permissionRequest={permissionFor(item)}
    />
  );

  const renderSegment = (seg: ActivitySegment) => {
    if (seg.kind === 'single') return renderItem(seg.items[0]);
    const { title, summary } = presentAggregate(seg);
    const open = activityIsExpanded(seg.key, seg.status, runLive, overrides);
    const failed = seg.items.some((i) => i.status === 'failed');
    return (
      <div key={seg.key} data-segment={seg.key}>
        <SegmentHeader
          icon={
            <ToolIcon toolName={seg.items[0]?.toolName as never} className={failed ? 'text-danger' : 'text-success'} />
          }
          title={title}
          summary={summary}
          status={seg.status}
          open={open}
          onToggle={() => toggleExpanded(seg.key, open)}
          testId={seg.key}
        />
        {open && <div className="flex flex-col pl-4 ml-2 border-l border-border-dim">{seg.items.map(renderItem)}</div>}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-0 my-1.5">
      {folded && (
        <div data-segment="folded">
          <SegmentHeader
            icon={<ClockIcon className="text-text-muted" />}
            title={t('activity.aggregate.folded', { n: folded.older.length })}
            summary=""
            status="completed"
            open={foldedOpen}
            onToggle={() => toggleExpanded('folded', foldedOpen)}
            testId="folded"
          />
          {foldedOpen && (
            <div className="flex flex-col pl-4 ml-2 border-l border-border-dim">{folded.older.map(renderSegment)}</div>
          )}
        </div>
      )}
      {(folded ? folded.recent : segments).map(renderSegment)}
    </div>
  );
});
