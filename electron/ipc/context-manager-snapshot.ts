/** context-manager-snapshot.ts — atomic-group safe truncation algorithm. */
import { matchesPlanTask, estimateTokens } from './agent-loop';
import type { LoopMessage, TaskPlan } from './agent-loop';
import { buildAtomicGroups, HEAD_LOCK_COUNT, TAIL_LOCK_COUNT } from './context-manager-utils';
import { devLog } from './shared';
import type { AtomicGroup } from './context-manager-types';
import { toolCallFn, parsedToolArgs } from './context-manager-utils';

export const SNIP_COMPACT_TOKEN_BUDGET = 60_000;

/** Check whether an atomic group contains a critical Read call for a plan task. */
function groupContainsCriticalRead(group: AtomicGroup, plan: TaskPlan): boolean {
  for (const msg of group.messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const fn = toolCallFn(tc);
      if (fn.name !== 'Read') continue;
      const args = parsedToolArgs(fn);
      if (typeof args.file_path === 'string' && args.file_path && matchesPlanTask(args.file_path, plan)) {
        return true;
      }
    }
  }
  return false;
}

/** Verify no orphaned tool_calls exist in a message array. */
function findOrphanedToolCalls(messages: LoopMessage[]): Set<string> {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (typeof tc.id === 'string') open.add(tc.id);
      }
    }
    if (m.role === 'tool' && m.tool_call_id) {
      open.delete(m.tool_call_id);
    }
  }
  return open;
}

/**
 * Atomic-Group Safe Truncation — the core algorithm.
 *
 * Guarantees:
 *   1. messages[0] (system prompt) is NEVER removed.
 *   2. The last TAIL_LOCK_COUNT messages are NEVER removed (short-term memory).
 *   3. Messages between head-lock and tail-lock form the "body".
 *   4. The body is partitioned into atomic groups. Groups are removed from
 *      the oldest end, ALWAYS as complete units — NEVER split.
 *   5. If removal would create orphaned tool_calls, the entire operation
 *      is rolled back (defensive safety fallback).
 *   6. Critical Read results matching pending plan tasks are rescued.
 */
export function snipCompact(
  messages: LoopMessage[],
  maxTokens: number = SNIP_COMPACT_TOKEN_BUDGET,
  plan?: TaskPlan | null,
): { truncated: LoopMessage[]; removed: LoopMessage[] } {
  if (messages.length === 0) return { truncated: [], removed: [] };
  const totalLen = messages.length;
  const minLenForTruncation = HEAD_LOCK_COUNT + TAIL_LOCK_COUNT;
  if (totalLen <= minLenForTruncation) {
    return { truncated: [...messages], removed: [] };
  }

  const head = messages.slice(0, HEAD_LOCK_COUNT);
  const tail = messages.slice(-TAIL_LOCK_COUNT);
  const bodyStart = HEAD_LOCK_COUNT;
  const bodyEnd = totalLen - TAIL_LOCK_COUNT;
  if (bodyEnd <= bodyStart) {
    return { truncated: [...messages], removed: [] };
  }

  const body = messages.slice(bodyStart, bodyEnd);
  const headTokens = estimateTokens(head);
  const tailTokens = estimateTokens(tail);
  const budgetForBody = maxTokens - headTokens - tailTokens;
  const groups = buildAtomicGroups(body);
  if (groups.length === 0) {
    return { truncated: [...messages], removed: [] };
  }

  const totalBodyTokens = groups.reduce((sum, g) => sum + g.estimatedTokens, 0);
  if (totalBodyTokens <= budgetForBody) {
    return { truncated: [...messages], removed: [] };
  }

  const keptGroups: AtomicGroup[] = [];
  let keptTokens = 0;
  let firstRemovedGroupIndex = groups.length;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const group = groups[gi];
    const wouldExceed = keptTokens + group.estimatedTokens > budgetForBody;
    if (wouldExceed && keptGroups.length > 0) {
      firstRemovedGroupIndex = gi + 1;
      break;
    }
    if (wouldExceed && keptGroups.length === 0) {
      keptGroups.unshift(group);
      keptTokens += group.estimatedTokens;
      continue;
    }
    keptGroups.unshift(group);
    keptTokens += group.estimatedTokens;
  }

  const removedMessages: LoopMessage[] = [];
  for (let gi = 0; gi < firstRemovedGroupIndex; gi++) {
    removedMessages.push(...groups[gi].messages);
  }

  if (plan && removedMessages.length > 0 && firstRemovedGroupIndex > 0) {
    const rescuedGroups: AtomicGroup[] = [];
    const stillRemovedGroups: AtomicGroup[] = [];
    for (let gi = 0; gi < firstRemovedGroupIndex; gi++) {
      if (groupContainsCriticalRead(groups[gi], plan)) {
        rescuedGroups.push(groups[gi]);
      } else {
        stillRemovedGroups.push(groups[gi]);
      }
    }
    if (rescuedGroups.length > 0) {
      const rescuedMsgs = rescuedGroups.flatMap((g) => g.messages);
      const stillRemovedMsgs = stillRemovedGroups.flatMap((g) => g.messages);
      const keptMsgs = keptGroups.flatMap((g) => g.messages);
      const truncated = [...head, ...rescuedMsgs, ...keptMsgs, ...tail];
      const orphans = findOrphanedToolCalls(truncated);
      if (orphans.size > 0) {
        console.error(
          `[ContextManager] CRITICAL RESCUE SAFETY VIOLATION: ${orphans.size} orphans ` +
            `after rescue. IDs: ${[...orphans].join(', ')}. Falling back to no truncation.`,
        );
        return { truncated: [...messages], removed: [] };
      }
      devLog(
        `[ContextManager] CRITICAL RESCUE: ${rescuedMsgs.length} messages rescued ` +
          `from truncation (matched pending plan tasks).`,
      );
      return { truncated, removed: stillRemovedMsgs };
    }
  }

  const keptMsgs = keptGroups.flatMap((g) => g.messages);
  const truncated = [...head, ...keptMsgs, ...tail];
  const orphans = findOrphanedToolCalls(truncated);
  if (orphans.size > 0) {
    console.error(
      `[ContextManager] SAFE-TRUNCATE SAFETY VIOLATION: ${orphans.size} orphaned tool_calls ` +
        `after truncation. IDs: ${[...orphans].join(', ')}. Falling back to no truncation.`,
    );
    return { truncated: [...messages], removed: [] };
  }
  return { truncated, removed: removedMessages };
}
