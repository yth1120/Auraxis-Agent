/**
 * fromAgentLog.ts — 子代理的日志 → Activity 列表（纯函数）。
 *
 * 聊天区里的 `Agent` 工具调用会产生一个真实存在的子代理（主进程已订阅
 * `agent:event:<id>`），它的进度落在 `useAgentStore` 的 `log` 上（`AgentLogEntry[]`）。
 * 子步骤要内联展示，就必须换成同一套 Activity 词表 —— 但**不重写展示层**：
 * 类型仍由 `activityTypeForTool` 判、标题摘要仍由 `presentActivity` 出。
 *
 * 这里刻意只保留"用户看得懂的步骤"（工具与错误），跳过文本/思考/迭代标记：
 * 子代理的最终文本由父项的结果摘要承担，重复列一遍只会把嵌套列表撑长。
 */
import type { ActivityItem, ActivityStatus } from '../../types/activity';
import { activityTypeForTool } from './presentation';
import type { AgentLogEntry } from '../../types/agent';

function statusOfEntry(entry: AgentLogEntry): ActivityStatus {
  switch (entry.type) {
    case 'tool_start':
      return 'running';
    case 'tool_end':
      return 'completed';
    case 'tool_error':
      return 'failed';
    default:
      return 'completed';
  }
}

/** 子代理日志 → 嵌套 Activity（`parentId` 指向父项）。 */
export function agentLogToActivities(
  entries: readonly AgentLogEntry[] | undefined,
  runId: string,
  parentId: string,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  const byCallId = new Map<string, number>();
  for (const entry of entries ?? []) {
    if (entry.type !== 'tool_start' && entry.type !== 'tool_end' && entry.type !== 'tool_error') continue;
    const id = entry.toolCallId ? `${parentId}:${entry.toolCallId}` : `${parentId}:${entry.timestamp}`;
    const item: ActivityItem = {
      id,
      runId,
      parentId,
      type: activityTypeForTool(entry.toolName, entry.input),
      status: statusOfEntry(entry),
      sourceEvent: entry.type,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.stepGroupId ? { stepGroupId: entry.stepGroupId } : {}),
      startedAt: entry.timestamp,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.input ? { input: entry.input } : {}),
      ...(entry.output !== undefined ? { output: entry.output } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.summary ? { summaryFacts: entry.summary } : {}),
      ...(entry.streamOutput ? { liveOutput: entry.streamOutput } : {}),
    };
    // 同一 toolCallId 的 end/error **原地合并** start：子代理日志里它们是独立条目。
    //
    // 合并的语义是「start 带意图、end 带结果」：类型与入参只在 start 上有
    // （end 条目通常不带 input），直接覆盖会把 `npm test` 从 test 退化成 terminal ——
    // 所以结果字段取新的，意图字段保留旧的。
    const existing = entry.toolCallId ? byCallId.get(entry.toolCallId) : undefined;
    if (existing !== undefined) {
      const started = out[existing];
      out[existing] = {
        ...item,
        startedAt: started.startedAt,
        type: started.type,
        ...(started.input ? { input: started.input } : {}),
        ...(started.liveOutput && !item.liveOutput ? { liveOutput: started.liveOutput } : {}),
      };
    } else {
      if (entry.toolCallId) byCallId.set(entry.toolCallId, out.length);
      out.push(item);
    }
  }
  return out;
}
