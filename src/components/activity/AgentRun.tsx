/**
 * AgentRun.tsx — 一轮 Assistant Run 的执行视图（挂在 AssistantMessage 内）。
 *
 * 与最终回答的关系：**同属一条 assistant 消息**。Run 头 + 有序步骤在上，
 * 最终回答在下（由 `AssistantMessage` 负责渲染文本），两者视觉上是一个整体，
 * 不再像从前那样把计划 / 上下文 / 权限拆成四五条独立消息飘在旁边。
 *
 * 数据来源：`message` 本身就是唯一事实（toolCalls / plan / compaction / disclosure），
 * 紧随其后的合成消息作为 `followers` 传入；展开态与真实终态来自 `useActivityStore`。
 * **本组件不持有任何执行状态**。
 */
import { memo, useMemo } from 'react';
import type { Message } from '../../types/chat';
import { useActivityStore, messageToActivityRun } from '../../stores/useActivityStore';
import type { RunMessage } from '../../core/activity/model';
import type { BrowserAnnotation } from '../../types/browser';
import type { PermissionRequest } from '../../types/advanced';
import RunHeader from './RunHeader';
import ActivityList from './ActivityList';

export interface AgentRunProps {
  message: Message;
  /** 紧随其后、属于本轮的合成消息（注入 / 压缩 / 权限）。 */
  followers?: RunMessage[];
  /** 上一条用户消息带来的页面标注（本轮的输入之一）。 */
  annotations?: readonly BrowserAnnotation[];
}

/** `Message` 是 `RunMessage` 的结构超集，收窄后交给纯派生函数。 */
function toRunMessage(message: Message): RunMessage {
  return message as unknown as RunMessage;
}

export default memo(function AgentRun({ message, followers, annotations }: AgentRunProps) {
  // 只订阅派生用得到的两个切片；展开态由 ActivityList 自己订阅（避免整棵 Run 因展开而重算）。
  const runTerminal = useActivityStore((s) => s.runTerminal);
  const approvals = useActivityStore((s) => s.approvals);

  const runMessage = toRunMessage(message);
  const runFollowers = useMemo(() => followers ?? [], [followers]);

  /**
   * 权限请求的**原始对象**，按 Activity 项 id（= 那条权限消息的 id）索引。
   *
   * Activity 项只带 `toolName/input`，而审批卡片需要 `oldContent`（Write/Edit 的
   * diff 复核）与 `timestamp`（倒计时）—— 从项里重建会丢掉这些，等于给用户看一张
   * 残缺的卡片。所以由这里注入真实对象（沿用 nested 的注入模式，避免 import 环）。
   */
  const permissions = useMemo(() => {
    const map = new Map<string, PermissionRequest>();
    for (const f of runFollowers) {
      if (f.permissionRequest) map.set(f.id, f.permissionRequest);
    }
    return map;
  }, [runFollowers]);

  // `Date.now()` 在回调内取值：它只用于"已耗时"的初值，运行中由 RunHeader 的时钟推进，
  // 不参与状态推导，因此不该出现在依赖里（放进去反而会每帧重算整棵 Run）。
  const run = useMemo(
    () =>
      messageToActivityRun(runMessage, runFollowers, { runTerminal, approvals, ...(annotations ? { annotations } : {}) }, Date.now()),
    [runMessage, runFollowers, runTerminal, approvals, annotations],
  );

  if (run.items.length === 0) return null;

  return (
    <div className="my-1">
      <RunHeader run={run} terminal={runTerminal[message.id]} />
      <ActivityList run={run} permissions={permissions} />
    </div>
  );
});
