/** context-manager-utils.ts — pure context helpers. */
import type { LoopMessage } from './agent-loop';
import type { AtomicGroup } from './context-manager-types';
import { estimateTokens } from './agent-loop';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function toolCallFn(toolCall: Record<string, unknown>): Record<string, unknown> {
  return isRecord(toolCall.function) ? toolCall.function : toolCall;
}

export function parsedToolArgs(fn: Record<string, unknown>): Record<string, unknown> {
  const raw = fn.arguments;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(raw) ? raw : {};
}

/** Number of prefix messages locked at the head (system prompt). */

export const HEAD_LOCK_COUNT = 1;
export const TAIL_LOCK_COUNT = 6;

/** Number of tail messages locked at the end (short-term working memory). */

export function buildAtomicGroups(body: LoopMessage[]): AtomicGroup[] {
  const groups: AtomicGroup[] = [];
  let i = 0;

  while (i < body.length) {
    const msg = body[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // ── Tool-call group: assistant + its tool results ──
      const pendingIds = new Set<string>();
      for (const tc of msg.tool_calls) {
        if (typeof tc.id === 'string') pendingIds.add(tc.id);
      }

      const groupStart = i;
      i++; // consume the assistant message

      // Collect tool results until all pending IDs are resolved
      while (i < body.length && pendingIds.size > 0) {
        const next = body[i];
        if (next.role === 'tool' && next.tool_call_id && pendingIds.has(next.tool_call_id)) {
          pendingIds.delete(next.tool_call_id);
          i++;
        } else if (next.role === 'tool' && next.tool_call_id && !pendingIds.has(next.tool_call_id)) {
          // Tool result for an ID we don't own — belongs to a different (earlier?) group.
          // Defensive: close this group; the orphan tool gets its own group.
          break;
        } else {
          // User message, text-only assistant, injected system message, etc.
          // These are NOT part of this tool-call group.
          break;
        }
      }

      const groupMessages = body.slice(groupStart, i);
      groups.push({
        messages: groupMessages,
        startIndex: groupStart,
        endIndex: i,
        estimatedTokens: estimateTokens(groupMessages),
        isToolCallGroup: true,
        hasUnresolvedCalls: pendingIds.size > 0,
      });
    } else {
      // ── Simple group: stand-alone message ──
      groups.push({
        messages: [msg],
        startIndex: i,
        endIndex: i + 1,
        estimatedTokens: estimateTokens([msg]),
        isToolCallGroup: false,
        hasUnresolvedCalls: false,
      });
      i++;
    }
  }

  return groups;
}

/**
 * Find safe truncation boundaries in a message array.
 *
 * A safe boundary is an index AFTER which truncation can occur without
 * leaving orphaned tool_call references. With atomic groups, boundaries
 * are at the end of each group (endIndex).
 *
 * Maintained for backward compatibility with existing tests and callers.
 */

export function countCompleteRounds(messages: LoopMessage[]): number {
  const groups = buildAtomicGroups(messages);
  let rounds = 0;
  for (const g of groups) {
    if (g.isToolCallGroup && !g.hasUnresolvedCalls) {
      // A complete tool-call round (assistant + all tool results)
      rounds++;
    } else if (!g.isToolCallGroup) {
      const m = g.messages[0];
      // Only text-only assistants mark a round boundary (matches old behavior)
      if (m && m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0)) {
        rounds++;
      }
    }
  }
  return rounds;
}

/**
 * Find the truncation index within the body that keeps `keepRounds`
 * complete interaction rounds at the tail.
 *
 * Returns the body-relative truncation index.
 * body.slice(truncIdx) retains the last `keepRounds` complete rounds.
 */
