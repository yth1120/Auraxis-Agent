/**
 * NestedActivityList.tsx — 子代理的子步骤（内联在父项详情里）。
 *
 * 数据来源是**真实的**子代理事件流：主进程在子代理 spawn 时就订阅了
 * `agent:event:<id>`，进度落在 `useAgentStore.agents[].log`。
 * 关联方式也是事实而非猜测：`Agent` 工具入参里的 `_agentId`（query-engine 注入）
 * 与 `AgentInfo.parentAgentId` 两条都认。
 */
import { memo, useMemo } from 'react';
import { useT } from '../../i18n';
import type { ActivityItem as ActivityItemModel } from '../../types/activity';
import { agentLogToActivities } from '../../core/activity/fromAgentLog';
import { useAgentStore } from '../../stores/useAgentStore';
import { activityIsExpanded, useActivityStore } from '../../stores/useActivityStore';
import ActivityItem from './ActivityItem';

export interface NestedActivityListProps {
  parent: ActivityItemModel;
}

function childAgentId(parent: ActivityItemModel): string | undefined {
  const injected = parent.input?._agentId;
  return typeof injected === 'string' && injected ? injected : undefined;
}

export default memo(function NestedActivityList({ parent }: NestedActivityListProps) {
  const t = useT();
  const overrides = useActivityStore((s) => s.overrides);
  const toggleExpanded = useActivityStore((s) => s.toggleExpanded);
  const agentId = childAgentId(parent);
  const child = useAgentStore((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined));

  const items = useMemo(
    () => agentLogToActivities(child?.log, parent.runId, parent.id),
    [child?.log, parent.runId, parent.id],
  );

  if (!agentId) return null;
  if (items.length === 0) {
    // 子代理还没产出步骤：如实说明它在运行，而不是显示一个空列表。
    return (
      <p className="m-0 pl-5 text-2xs text-text-muted">
        {child ? t('activity.nested.pending') : t('activity.nested.missing')}
      </p>
    );
  }

  return (
    <div className="flex flex-col pl-5 border-l border-border-dim" data-nested-parent={parent.id}>
      {items.map((item) => (
        <ActivityItem
          key={item.id}
          item={item}
          expanded={activityIsExpanded(item.id, item.status, child?.status === 'running', overrides)}
          onToggle={toggleExpanded}
        />
      ))}
    </div>
  );
});
